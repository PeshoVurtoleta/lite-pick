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

// ConsistentHash rebuild disruption bound (S14): the largest share of OTHER keys a weight-0 rebuild may
// move. Calibrated -- see test/SoakHash.test.js and the decisions/0014 S14 amendment for how it was made.
export const CH_REBUILD_MOVED_MAX = 0.08;
// The last oracle pass's raw statistic, for the calibration tool (_calibrate-s14.mjs) and tests: [0] the
// ConsistentHash rebuild's moved share of other keys (-1 if not evaluated), [1] the WeightedRandom max |z|
// (-1 if not evaluated). Module scratch: 0-alloc.
export const _oracleStat = new Float64Array(2);
const PROP_MIN_LIVE = 8;   // the ConsistentHash properties need a real pool (see oracleStickiness)

/** ONE argmin index for LeastConn/SED/NQ on the given live state (the lowest; the oracle accepts the whole set). */
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

/**
 * Is `p` in the argmin SET for this lane's score (S14)? Ties are allowed: the kernel's tie order is
 * unspecified (a rotating tie-break is planned for 1.1), and production least-connections does not
 * promise "lowest index" either (NGINX round-robins tied servers, HAProxy too). `best` is one argmin
 * (expectedIndex); p qualifies iff it is a candidate with the SAME score. Scores compare by integer
 * cross-multiplication -- (inf_p + 1) * w_best === (inf_best + 1) * w_p -- never by float equality.
 * No candidate (best < 0) -> only PICK_NONE qualifies (fail closed).
 */
function inArgminSet(name, p, best, el, inf, wt) {
    if (best < 0) return p < 0;
    if (p < 0 || !el[p]) return false;
    if (name === 'LeastConn') return inf[p] === inf[best];
    if (!(wt[p] > 0)) return false;
    if (name === 'NQ' && inf[best] === 0) return inf[p] === 0;   // never-queue: ANY idle candidate
    return (inf[p] + 1) * wt[best] === (inf[best] + 1) * wt[p];
}

/** LeastConn/SED/NQ argmin oracle -- every 64th controlled pick must be IN the recomputed argmin set. */
function oracleArgmin(name, b, el, inf, wt, cap, rng) {
    let checks = 0, viol = 0;
    for (let t = 0; t < PASS; t++) {
        if ((t & 63) === 0) {
            const exp = expectedIndex(name, el, inf, wt, cap);
            const p = b.pick();
            checks++;
            if (!inArgminSet(name, p, exp, el, inf, wt)) viol++;
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
export const P2C_SUM_LIMIT = Object.freeze([[8, 17], [9, 18], [13, 19], [17, 20], [26, 21], [37, 22], [55, 23], [130, 24]]);
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
const _flap = new Uint8Array(4096);

/** ConsistentHash stickiness (audit 1.5): a key maps to the SAME backend WHILE ITS HOME IS UP, ACROSS
 * membership changes. Record each key's home at the freeze; flap every NON-HOME eligible node down then
 * up (real setEligible membership churn); re-pick and require an IDENTICAL backend for every key whose
 * home stayed up. A mutant that rotates the slot per setEligible (or per pick) moves home-up keys -> viol.
 * 0-alloc: reuses module scratch (_home / _isHome). */
function oracleStickiness(b, el, wt, keys, keyCount, cap, rng) {
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
    // S14 fix: remember WHICH nodes were flapped. The up-loop used to test el[i] -- the shared eligibility it
    // had just cleared -- so nothing came back up and (2) tested "every non-home node down" instead of a flap
    // (and left the pool that way for everything after it).
    for (let i = 0; i < cap; i++) { _flap[i] = el[i] && !_isHome[i] ? 1 : 0; if (_flap[i]) b.setEligible(i, false); }
    for (let i = 0; i < cap; i++) if (_flap[i]) b.setEligible(i, true);
    for (let k = 0; k < keyCount; k++) {
        if (_home[k] < 0) continue;
        const p = b.pick(keys[k] >>> 0);
        checks++;
        if (p !== _home[k]) viol++;
    }
    // PROPERTIES (S14; research/s14-hash-and-tie-oracles.md, decision 2) -- stated, not a re-walk. They
    // describe a real pool: below PROP_MIN_LIVE eligible nodes (the tiny lanes, cap 1-3) a rebuild of a
    // 2-3 entry table legitimately moves most keys, and draining the ONLY positive weight falls back to the
    // documented all-zero table -- so the properties are not evaluated there.
    let propChecks = 0, propViol = 0, live = 0, livePos = 0;
    _oracleStat[0] = -1;
    for (let i = 0; i < cap; i++) if (el[i]) { live++; if (wt && wt[i] > 0) livePos++; }
    if (live < PROP_MIN_LIVE) return { checks, viol, propChecks, propViol, insufficient: checks < MIN_CHECKS };
    // (3) Down-marking is MINIMAL (Karger's monotonicity): mark one HOME node r down; every key whose home
    //     is not r keeps its backend exactly, and no key still lands on r. Measured on the real kernel: 0
    //     other keys moved in 3,000 events at M = 257 / 4099 / 25601. (2) above flaps NON-home nodes, so a
    //     kernel that rebuilds the table over the up nodes on each flap passes (2) -- the rebuild is undone
    //     by the flap back -- and fails here.
    const r = pickHome(el, cap, rng, null);
    if (r >= 0) {
        b.setEligible(r, false);
        for (let k = 0; k < keyCount; k++) {
            if (_home[k] < 0) continue;
            const p = b.pick(keys[k] >>> 0);
            propChecks++;
            if (_home[k] === r ? p === r : p !== _home[k]) propViol++;
        }
        b.setEligible(r, true);
    }
    // (4) A REBUILD is bounded and deterministic: drain one positive-weight home node to weight 0 (one
    //     rebuild): no key may still map to it, and the share of OTHER keys that move must stay within
    //     CH_REBUILD_MOVED_MAX (calibrated -- Maglev's rebuild disruption is not minimal by design, Eisenbud
    //     et al. sec. 3.4; a 1/N bound would be wrong). Restore the weight (one rebuild): the table is a pure
    //     function of the weights, so EVERY key must be back on its original backend.
    const r2 = wt && livePos >= 2 ? pickHome(el, cap, rng, wt) : -1;
    if (r2 >= 0) {
        const w0 = wt[r2];
        b.setWeight(r2, 0);
        let others = 0, moved = 0;
        for (let k = 0; k < keyCount; k++) {
            if (_home[k] < 0) continue;
            const p = b.pick(keys[k] >>> 0);
            propChecks++;
            if (p === r2) propViol++;
            else if (_home[k] !== r2) { others++; if (p !== _home[k]) moved++; }
        }
        _oracleStat[0] = others > 0 ? moved / others : 0;
        if (moved > CH_REBUILD_MOVED_MAX * others) propViol++;
        b.setWeight(r2, w0);
        for (let k = 0; k < keyCount; k++) {
            if (_home[k] < 0) continue;
            propChecks++;
            if (b.pick(keys[k] >>> 0) !== _home[k]) propViol++;
        }
    }
    return { checks, viol, propChecks, propViol, insufficient: checks < MIN_CHECKS };
}

/** A random eligible HOME node (and, with `wt`, one of positive weight), scanning from a random start;
 * -1 if none. Uses _isHome from the caller's pass. */
function pickHome(el, cap, rng, wt) {
    const s = rng.nextBelow(cap);
    for (let k = 0; k < cap; k++) {
        const i = s + k < cap ? s + k : s + k - cap;
        if (el[i] && _isHome[i] && (wt === null || wt[i] > 0)) return i;
    }
    return -1;
}

/** BoundedLoad reference walk (H4): first eligible under cap along the probe, else first eligible. NIT B:
 * `total` and `live` are recomputed INDEPENDENTLY -- total = sum(inflight) over ALL nodes (the kernel's
 * _total contract, note()-maintained and asserted by checkBoundedLoad), live = count of eligible -- NOT
 * read from b._total / b._live, so a kernel that miscounts either is CAUGHT, not masked by shared state.
 * The static Maglev table b._lookup is fine to read (it is the built table, not a live decision). */
function oracleBoundedLoad(b, el, inf, keys, keyCount, cap, rng) {
    const M = b._m, lookup = b._lookup, eps = b._eps, minCap = b.minCap | 0;
    let checks = 0, viol = 0, propChecks = 0, propViol = 0;
    for (let t = 0; t < keyCount; t++) {
        const key = keys[t] >>> 0;
        // INDEPENDENT recompute: total = sum inflight over ALL nodes (kernel _total contract); live = eligible.
        let total = 0, live = 0;
        for (let i = 0; i < cap; i++) { total += inf[i]; if (el[i]) live++; }
        let capOcc = (total > 0 && live > 0) ? Math.ceil((1 + eps) * (total + 1) / live) : 0;
        if (total > 0 && capOcc < minCap) capOcc = minCap;   // the opt-in floor (1.1.0, N4); 0 by default
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
        if (ref < 0) {   // L3 (1.1.0): nothing eligible in the window -> the first eligible in a full forward sweep
            for (let p = 0; p < M; p++) { slot++; if (slot >= M) slot = 0; if (el[lookup[slot]]) { ref = lookup[slot]; break; } }
        }
        const pick = b.pick(key);
        if (ref >= 0) { checks++; if (pick !== ref) viol++; }
        // PROPERTIES (S14), stated from the MTZ definition rather than this oracle's own walk order: the
        // window is the home slot + CH_PROBE_LIMIT slots of the static table; cap counts the incoming
        // request ((1+eps)(T+1)/live, the H4 fix). (P1) home eligible and under cap -> the pick IS home;
        // (P2) some eligible under-cap backend in the window -> the pick is eligible, IN the window, and
        // under cap (any of them -- no order assumed); (P3) none under cap -> the pick is an eligible
        // backend in the window; (P4, L3) none in the window -> an eligible backend from anywhere in the table,
        // PICK_NONE iff no eligible backend owns a slot.
        const home = lookup[(key >>> 0) % M];
        let underExists = 0, eligibleExists = 0, pickInWindow = 0;
        let s2 = (key >>> 0) % M;
        for (let p = 0; p <= CH_PROBE_LIMIT; p++) {
            const j = lookup[s2];
            if (el[j]) { eligibleExists = 1; if (total === 0 || inf[j] < capOcc) underExists = 1; }
            if (j === pick) pickInWindow = 1;
            s2++; if (s2 >= M) s2 = 0;
        }
        propChecks++;
        const pickOk = pick >= 0 && el[pick] && pickInWindow === 1;
        if (el[home] && (total === 0 || inf[home] < capOcc)) { if (pick !== home) propViol++; }
        else if (underExists) { if (!pickOk || !(total === 0 || inf[pick] < capOcc)) propViol++; }
        else if (eligibleExists) { if (!pickOk) propViol++; }
        else {
            let anyInTable = 0;
            for (let t2 = 0; t2 < M; t2++) if (el[lookup[t2]]) { anyInTable = 1; break; }
            if (anyInTable ? !(pick >= 0 && el[pick]) : pick !== -1) propViol++;
        }
        if (pick >= 0) { inf[pick]++; b.note(pick, 1); }
        if ((t & 3) === 0) { const d = rng.nextBelow(cap); if (inf[d] > 0) { inf[d]--; b.note(d, -1); } }
    }
    return { checks, viol, propChecks, propViol, insufficient: checks < MIN_CHECKS };
}

/** PeakEWMA (H1): a node fed 10x RTT must be steered around -- its pick share after 5*tau <= 0.25/live.
 * Controlled pass on the frozen state: the SLOW node (lowest eligible index) is fed 10ms samples, all
 * others 1ms; `now` stays SMI (bounded). Share measured over the tail (post 5*tau). Mutant: a kernel
 * that ignores RTT keeps picking the slow node -> share >> 0.25/live -> trips. */
function oraclePeakEwma(b, el, inf, cap, rng) {
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
        // Completions (S14): one per pick, on a uniformly random busy healthy node (up to 8 draws), so EVERY
        // node drains and arrivals and completions balance. The old pattern drained only nodes with
        // d & 7 in {0, 4} -- 75% of nodes never drained (audit 2026-09-29 S14).
        for (let tries = 0; tries < 8; tries++) { const d = rng.nextBelow(cap); if (d !== slow && el[d] && inf[d] > 0) { inf[d]--; break; } }
        if (t >= warm) { totalTail++; if (p === slow) slowTail++; }
    }
    if (totalTail < MIN_CHECKS) return { checks: 0, viol: 0, insufficient: true };
    const share = slowTail / totalTail;
    const bound = 0.25 / live;
    return { checks: totalTail, viol: share > bound ? 1 : 0, insufficient: false };
}

export const WR_DRAWS = 1 << 22;   // controlled picks per WeightedRandom per-category pass (~40-60 ms)
export const WR_Z_CRIT = 6;        // per-category |z| limit: two-sided 2e-9 per category, < 6e-7 per cycle at 256
const _wrHist = new Uint32Array(4096);

/**
 * WeightedRandom per-category oracle (S14; research/s14-hash-and-tie-oracles.md, decision 3). The window
 * chi-square (quality.mjs) has ~180 categories and 8192 draws: it cannot see a 10% error in one weight
 * (noncentral power ~2% per window). Per-category binomial tests with enough draws can: on the FROZEN
 * state draw WR_DRAWS picks and require, for every eligible positive-weight node, |z| <= WR_Z_CRIT with
 * z = (count - n p) / sqrt(n p (1 - p)), p = w / (eligible positive weight). A 10% error on a weight-1
 * node of 180 gives z ~ 0.1 sqrt(n p) ~ 7; Bonferroni over 256 categories keeps a clean cycle's false
 * alarm < 6e-7. A pick on an ineligible or weight-0 node, or a failed pick, is a violation outright.
 * Skipped (insufficient) when < half the WEIGHT MASS is up: there the kernel's 64 rejection redraws can
 * all miss and it falls back to a documented non-proportional scan (miss chance <= 0.5^64 above half).
 * Allocation-free (module scratch).
 */
function oracleWeightedRandom(b, el, wt, cap) {
    _oracleStat[1] = -1;
    if (!wt) return { checks: 0, viol: 0, insufficient: true };
    let S = 0, Sall = 0, k = 0;
    for (let i = 0; i < cap; i++) { Sall += wt[i]; if (el[i] && wt[i] > 0) { S += wt[i]; k++; } }
    if (k < 2 || S * 2 < Sall) return { checks: 0, viol: 0, insufficient: true };
    for (let i = 0; i < cap; i++) _wrHist[i] = 0;
    let lost = 0;
    for (let t = 0; t < WR_DRAWS; t++) { const p = b.pick(); if (p >= 0) _wrHist[p]++; else lost++; }
    let checks = 0, viol = lost > 0 ? 1 : 0, maxZ = 0;
    const n = WR_DRAWS - lost;
    for (let i = 0; i < cap; i++) {
        if (el[i] && wt[i] > 0) {
            const p = wt[i] / S, e = n * p;
            const z = (_wrHist[i] - e) / Math.sqrt(e * (1 - p));
            checks++;
            const az = z < 0 ? -z : z;
            if (az > maxZ) maxZ = az;
            if (az > WR_Z_CRIT) viol++;
        } else if (_wrHist[i] > 0) viol++;
    }
    _oracleStat[1] = maxZ;
    return { checks, viol, insufficient: false };
}

/**
 * Run the family oracle for a load/keyed lane on the FROZEN state. Returns { checks, viol, insufficient }.
 * PLAIN lanes (RoundRobin/SmoothWRR/WeightedRandom) are handled by QualityWindow, not here.
 */
export function evaluateOracle(laneName, b, el, inf, wt, keys, keyCount, cap, rng) {
    if (laneName === 'LeastConn' || laneName === 'SED' || laneName === 'NQ') return oracleArgmin(laneName, b, el, inf, wt, cap, rng);
    if (laneName === 'P2C') return oracleP2C(b, el, inf, cap);
    if (laneName === 'PeakEWMA') return oraclePeakEwma(b, el, inf, cap, rng);
    if (laneName === 'ConsistentHash') return oracleStickiness(b, el, wt, keys, keyCount, cap, rng);
    if (laneName === 'WeightedRandom') return oracleWeightedRandom(b, el, wt, cap);
    if (laneName === 'BoundedLoad') return oracleBoundedLoad(b, el, inf, keys, keyCount, cap, rng);
    return null;
}
