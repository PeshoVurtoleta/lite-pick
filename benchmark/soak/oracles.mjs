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
 *   - P2C              : max - mean inflight <= 4*log2(ln live) + 4 (balls-in-bins), homogeneous, live>=8.
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

const P2C_TRIALS = 8;   // NIT A: independent balls-in-bins trials/cycle (one trial missed cycle-0 mutants)

/** P2C balls-in-bins bound: over P2C_TRIALS independent trials, max - mean load <= 4*log2(ln live) + 4.
 * A single trial can miss a broken P2C by luck; every trial that exceeds the bound is a violation. */
function oracleP2C(b, el, inf, cap) {
    let live = 0;
    for (let i = 0; i < cap; i++) if (el[i]) live++;
    if (live < 8) return { checks: 0, viol: 0, insufficient: true };   // bound is asymptotic; skip tiny
    const balls = live * 32;
    const bound = 4 * Math.log2(Math.log(live)) + 4;
    let checks = 0, viol = 0;
    for (let trial = 0; trial < P2C_TRIALS; trial++) {
        for (let i = 0; i < cap; i++) inf[i] = 0;                       // controlled experiment (reuse buffer)
        for (let t = 0; t < balls; t++) { const p = b.pick(); if (p >= 0) inf[p]++; }
        let mx = 0, sum = 0;
        for (let i = 0; i < cap; i++) if (el[i]) { const c = inf[i]; if (c > mx) mx = c; sum += c; }
        checks++;
        if ((mx - sum / live) > bound) viol++;
    }
    return { checks, viol, insufficient: false };
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
