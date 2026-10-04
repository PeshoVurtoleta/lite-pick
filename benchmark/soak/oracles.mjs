/**
 * @zakkster/lite-pick soak -- load / keyed selection-quality oracles (planner T10-11, increment 2a).
 *
 * These run as a COLD, allocation-free pass on the FROZEN post-chaos state (increment-1 B4): they read
 * the caller-owned eligibility / inflight / weights and the balancer's own table, drive controlled
 * picks, and compare each pick to an INDEPENDENT recompute. No closures, no per-op objects (the spirit
 * of the 0-alloc rule; these are not the timed hot loop but stay allocation-free anyway).
 *
 * Each oracle is falsifiable THROUGH main.mjs by a one-line kernel mutant (benchmark/soak/_mustfail.mjs):
 *   - LeastConn/SED/NQ : pick == argmin score (exact index, tie -> lowest, per the kernel). every 64th.
 *   - P2C              : balls-in-bins over 8 trials: the SUM of the gaps (max - mean) <= a limit calibrated
 *                        per live count on the clean kernel (S7), plus a per-trial backstop. live 8..256.
 *   - ConsistentHash   : stickiness -- a key maps to the SAME backend across the epoch while its home is up.
 *   - BoundedLoad      : the pick is the first eligible under ceil((1+eps)(T+1)/live) along the probe,
 *                        else the first eligible (H4). every 64th.
 */

import { CH_PROBE_LIMIT } from './kernel.mjs';

const PASS = 8192;         // controlled picks per load-oracle pass
const KEY_PASS = 2048;     // keys probed per keyed-oracle pass
const MIN_CHECKS = 8;      // < this -> insufficientData (too few argmin samples to conclude)

/** The kernel's exact argmin index for LeastConn/SED/NQ on the given live state (tie -> lowest). */
function expectedIndex(name, el, inf, wt, cap) {
    if (name === 'LeastConn') {
        let best = -1, bestLoad = 0;
        for (let i = 0; i < cap; i++) if (el[i]) { const c = inf[i]; if (best < 0 || c < bestLoad) { best = i; bestLoad = c; } }
        return best;
    }
    if (name === 'NQ') {
        let best = -1, bestScore = Infinity;
        for (let i = 0; i < cap; i++) if (el[i]) { const w = wt[i]; if (w > 0) { if (inf[i] === 0) return i; const s = (inf[i] + 1) / w; if (s < bestScore) { bestScore = s; best = i; } } }
        return best;
    }
    // SED
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < cap; i++) if (el[i]) { const w = wt[i]; if (w > 0) { const s = (inf[i] + 1) / w; if (s < bestScore) { bestScore = s; best = i; } } }
    return best;
}

/** LeastConn/SED/NQ argmin oracle -- every 64th controlled pick must equal the recomputed argmin. */
function oracleArgmin(name, b, el, inf, wt, cap, rng) {
    let checks = 0, viol = 0;
    for (let t = 0; t < PASS; t++) {
        if ((t & 63) === 0) {
            const exp = expectedIndex(name, el, inf, wt, cap);
            const p = b.pick();
            checks++;
            if (p !== exp) viol++;
            if (p >= 0) inf[p]++;
        } else {
            const p = b.pick();
            if (p >= 0) inf[p]++;
        }
        if ((t & 3) === 0) { const d = rng.nextBelow(cap); if (inf[d] > 0) inf[d]--; }   // completions
    }
    return { checks, viol, insufficient: checks < MIN_CHECKS };
}

export const P2C_TRIALS = 8;       // independent balls-in-bins trials per cycle
export const P2C_BALLS_PER_NODE = 32;
export const P2C_MIN_LIVE = 8;

/** The per-trial backstop (audit fix plan 3.4): ceil(log2(ln live)) + 3. Shape from Azar et al. /
 * Berenbrink et al. (healthy gap ~ log2 ln n + O(1)); the +3 is a calibration choice, not a theorem. */
export function p2cTrialCap(live) { return Math.ceil(Math.log2(Math.log(live))) + 3; }

// _p2c[0] = sum of the P2C_TRIALS gaps, [1] = trials whose gap > p2cTrialCap(live), [2] = trials whose
// picks did not ALL land on eligible nodes (a lost or ineligible pick). Module scratch: 0-alloc.
export const _p2c = new Int32Array(3);

// The calibrated limit on the SUM of the P2C_TRIALS gaps, as [first live count, limit] breakpoints (the
// limit holds until the next breakpoint; the last one holds to 256). Made by
//     node benchmark/soak/_calibrate-p2c.mjs --cycles 100000 --jobs 10 --out benchmark/soak/p2c-calibration.json
// on the real P2cBalancer at the soak's shape (cap 256, a random eligible subset per cycle): limit(live) =
// the largest clean sum seen at any live count <= live, + 4 (0.5 on the average gap). That file is the
// evidence; test/SoakP2C.test.js fails if this table and it disagree. The literature gives the SHAPE (gap
// ~ log2 ln n healthy, ~ log n / beta for a (1+beta)-choice P2C); the numbers are our measurement.
export const P2C_SUM_LIMIT = Object.freeze([CALIBRATION_PENDING]);
const P2C_MAX_LIVE = 256;
const _p2cLimit = new Int32Array(P2C_MAX_LIVE + 1).fill(-1);
for (let n = P2C_MIN_LIVE; n <= P2C_MAX_LIVE; n++) for (const [at, v] of P2C_SUM_LIMIT) if (n >= at) _p2cLimit[n] = v;

/** The calibrated sum-of-gaps limit for this live count, or -1 outside the calibrated range (cannot judge). */
export function p2cSumLimit(live) {
    return (live >= P2C_MIN_LIVE && live <= P2C_MAX_LIVE && (live | 0) === live) ? _p2cLimit[live] : -1;
}

/**
 * The ONE P2C trial routine -- the soak oracle and benchmark/soak/_calibrate-p2c.mjs both call it, so
 * the calibration measures exactly the statistic the oracle judges. Each trial: zero the in-flight
 * counts, drop P2C_BALLS_PER_NODE x live picks (no completions), gap = max - mean over the eligible
 * nodes. With every pick on an eligible node the mean is exactly P2C_BALLS_PER_NODE, so the gap is an
 * integer and the sum is exact (no float threshold). Writes _p2c; returns nothing.
 */
export function p2cTrials(b, el, inf, cap, live) {
    const balls = live * P2C_BALLS_PER_NODE;
    const tcap = p2cTrialCap(live);
    let sumGap = 0, over = 0, lost = 0;
    for (let trial = 0; trial < P2C_TRIALS; trial++) {
        for (let i = 0; i < cap; i++) inf[i] = 0;                       // controlled experiment (reuse buffer)
        for (let t = 0; t < balls; t++) { const p = b.pick(); if (p >= 0) inf[p]++; }
        let mx = 0, sum = 0;
        for (let i = 0; i < cap; i++) if (el[i]) { const c = inf[i]; if (c > mx) mx = c; sum += c; }
        if (sum !== balls) { lost++; continue; }
        const gap = mx - P2C_BALLS_PER_NODE;
        sumGap += gap;
        if (gap > tcap) over++;
    }
    _p2c[0] = sumGap; _p2c[1] = over; _p2c[2] = lost;
}

/**
 * P2C balls-in-bins oracle (audit 2026-09-29 S7; research/s7-p2c-oracle-bound.md, option C):
 *   (1) the SUM of the P2C_TRIALS gaps must not exceed the calibrated limit for this live count -- the
 *       averaged statistic that catches a P2C ignoring its comparison on half its picks;
 *   (2) backstop: fewer than 2 trials may exceed p2cTrialCap(live) -- gross breakage, no table needed;
 *   (3) every pick lands on an eligible node (otherwise the gap is meaningless -- fail closed).
 * A live count outside the calibrated table is INSUFFICIENT (cannot judge), never a silent pass.
 */
function oracleP2C(b, el, inf, cap) {
    let live = 0;
    for (let i = 0; i < cap; i++) if (el[i]) live++;
    const limit = p2cSumLimit(live);
    if (limit < 0) return { checks: 0, viol: 0, insufficient: true };
    p2cTrials(b, el, inf, cap, live);
    const viol = (_p2c[0] > limit ? 1 : 0) + (_p2c[1] >= 2 ? 1 : 0) + (_p2c[2] > 0 ? 1 : 0);
    return { checks: P2C_TRIALS, viol, insufficient: false };
}

// BLOCKER 2 / NIT B: pre-allocated oracle scratch (0-alloc, reused across lane-cycles).
const _home = new Int32Array(4096);
const _isHome = new Uint8Array(4096);

/** ConsistentHash stickiness (audit 1.5): a key maps to the SAME backend WHILE ITS HOME IS UP, ACROSS
 * membership changes. Record each key's home at the freeze; flap every NON-HOME eligible node down then
 * up (real setEligible membership churn); re-pick and require an IDENTICAL backend for every key whose
 * home stayed up. A mutant that rotates the slot per setEligible (or per pick) moves home-up keys -> viol.
 * 0-alloc: reuses module scratch (_home / _isHome). */
function oracleStickiness(b, el, keys, keyCount, cap) {
    let checks = 0, viol = 0;
    for (let i = 0; i < cap; i++) _isHome[i] = 0;
    for (let k = 0; k < keyCount; k++) {
        const h = b.pick(keys[k] >>> 0);
        _home[k] = h;
        if (h >= 0) _isHome[h] = 1;   // mark home nodes so we never flap them
    }
    // (1) CONSECUTIVE determinism: a key picked twice back to back must be identical (catches a rotation
    // that advances PER PICK -- the two calls are one apart).
    for (let k = 0; k < keyCount; k++) {
        if (_home[k] < 0) continue;
        const p = b.pick(keys[k] >>> 0);
        checks++;
        if (p !== _home[k]) viol++;
    }
    // (2) ACROSS MEMBERSHIP CHANGES (audit 1.5): flap every eligible NON-HOME node down then back up (real
    // setEligible churn); re-pick and require the identical backend for every home-up key (catches a
    // rotation that advances PER setEligible -- the flaps move it, home stays up).
    for (let i = 0; i < cap; i++) if (el[i] && !_isHome[i]) b.setEligible(i, false);
    for (let i = 0; i < cap; i++) if (el[i] && !_isHome[i]) b.setEligible(i, true);
    for (let k = 0; k < keyCount; k++) {
        if (_home[k] < 0) continue;
        const p = b.pick(keys[k] >>> 0);
        checks++;
        if (p !== _home[k]) viol++;
    }
    return { checks, viol, insufficient: checks < MIN_CHECKS };
}

/** BoundedLoad reference walk (H4): first eligible under cap along the probe, else first eligible. NIT B:
 * `total` and `live` are recomputed INDEPENDENTLY -- total = sum(inflight) over ALL nodes (the kernel's
 * _total contract, note()-maintained and asserted by checkBoundedLoad), live = count of eligible -- NOT
 * read from b._total / b._live, so a kernel that miscounts either is CAUGHT, not masked by shared state.
 * The static Maglev table b._lookup is fine to read (it is the built table, not a live decision). */
function oracleBoundedLoad(b, el, inf, keys, keyCount, cap, rng) {
    const M = b._m, lookup = b._lookup, eps = b._eps;
    let checks = 0, viol = 0;
    for (let t = 0; t < keyCount; t++) {
        const key = keys[t] >>> 0;
        // INDEPENDENT recompute: total = sum inflight over ALL nodes (kernel _total contract); live = eligible.
        let total = 0, live = 0;
        for (let i = 0; i < cap; i++) { total += inf[i]; if (el[i]) live++; }
        const capOcc = (total > 0 && live > 0) ? Math.ceil((1 + eps) * (total + 1) / live) : 0;
        let slot = (key >>> 0) % M;
        let firstEligible = -1, ref = -1;
        let i = lookup[slot];
        if (el[i]) { firstEligible = i; if (total === 0 || inf[i] < capOcc) ref = i; }
        for (let p = 0; ref < 0 && p < CH_PROBE_LIMIT; p++) {
            slot++; if (slot >= M) slot = 0;
            i = lookup[slot];
            if (el[i]) { if (firstEligible < 0) firstEligible = i; if (total === 0 || inf[i] < capOcc) { ref = i; break; } }
        }
        if (ref < 0) ref = firstEligible;
        const pick = b.pick(key);
        if (ref >= 0) { checks++; if (pick !== ref) viol++; }
        if (pick >= 0) { inf[pick]++; b.note(pick, 1); }
        if ((t & 3) === 0) { const d = rng.nextBelow(cap); if (inf[d] > 0) { inf[d]--; b.note(d, -1); } }
    }
    return { checks, viol, insufficient: checks < MIN_CHECKS };
}

/** PeakEWMA (H1): a node fed 10x RTT must be steered around -- its pick share after 5*tau <= 0.25/live.
 * Controlled pass on the frozen state: the SLOW node (lowest eligible index) is fed 10ms samples, all
 * others 1ms; `now` stays SMI (bounded). Share measured over the tail (post 5*tau). Mutant: a kernel
 * that ignores RTT keeps picking the slow node -> share >> 0.25/live -> trips. */
function oraclePeakEwma(b, el, inf, cap) {
    let live = 0, slow = -1;
    for (let i = 0; i < cap; i++) if (el[i]) { live++; if (slow < 0) slow = i; }
    if (live < 8 || slow < 0) return { checks: 0, viol: 0, insufficient: true };
    for (let i = 0; i < cap; i++) inf[i] = 0;
    inf[slow] = 4;   // the slow node is a BUSY degraded endpoint (H1): inflight>0 so the busy floor keeps
                     // its cost high instead of decaying toward 0 while idle. We never drain it.
    const tau = b._tau || 1e6;
    let now = 0;
    const warm = 20000, tail = 20000, dt = 400;   // dt*warm = 8e6 ns > 5*tau=5e6; now stays < 2^24 (SMI)
    let slowTail = 0, totalTail = 0;
    for (let t = 0; t < warm + tail; t++) {
        now += dt;
        const p = b.pick(now);
        if (p < 0) continue;
        b.recordRtt(p, p === slow ? 10000000 : 1000000, now);   // 10ms slow, 1ms healthy
        inf[p]++;
        if ((t & 3) === 0) { for (let d = 0; d < cap; d++) if (d !== slow && el[d] && inf[d] > 0 && (d & 7) === (t & 7)) inf[d]--; }
        if (t >= warm) { totalTail++; if (p === slow) slowTail++; }
    }
    if (totalTail < MIN_CHECKS) return { checks: 0, viol: 0, insufficient: true };
    const share = slowTail / totalTail;
    const bound = 0.25 / live;
    return { checks: totalTail, viol: share > bound ? 1 : 0, insufficient: false };
}

/**
 * Run the family oracle for a load/keyed lane on the FROZEN state. Returns { checks, viol, insufficient }.
 * PLAIN lanes (RoundRobin/SmoothWRR/WeightedRandom) are handled by QualityWindow, not here.
 */
export function evaluateOracle(laneName, b, el, inf, wt, keys, keyCount, cap, rng) {
    if (laneName === 'LeastConn' || laneName === 'SED' || laneName === 'NQ') return oracleArgmin(laneName, b, el, inf, wt, cap, rng);
    if (laneName === 'P2C') return oracleP2C(b, el, inf, cap);
    if (laneName === 'PeakEWMA') return oraclePeakEwma(b, el, inf, cap);
    if (laneName === 'ConsistentHash') return oracleStickiness(b, el, keys, keyCount, cap);
    if (laneName === 'BoundedLoad') return oracleBoundedLoad(b, el, inf, keys, keyCount, cap, rng);
    return null;
}
