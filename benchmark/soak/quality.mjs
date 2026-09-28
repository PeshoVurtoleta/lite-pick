/**
 * @zakkster/lite-pick soak -- selection-quality windows + oracles (audit RECOMMENDATIONS 1.5).
 *
 * A soak that only checks safety (never a down pick, fail-closed IFF) misses SLOW selection drift --
 * the SmoothWRR accumulator drift (H2) and weight-0 picks (H3) that only show over millions of ops.
 * QualityWindow accumulates a per-lane histogram over the last W QUIET picks (no membership/weight
 * change) and, once SETTLE + W quiet picks have passed, evaluates the lane's oracle. Any membership
 * or weight change RESETS the window (the invariant only holds in a quiet regime). A lane-cycle with
 * < 4 completed windows reports insufficientData.
 *
 * HOT PATH: record() is 0 B/op -- typed-array increments, a pow2-masked ring, and an evaluate() that
 * computes with local scalars only (no allocation). clearWindow() zeroes via the ring, never a full
 * cap fill in the timed segment.
 *
 * INCREMENT 1 implements the count-based EXACT/STATISTICAL oracles (RoundRobin, SmoothWRR,
 * WeightedRandom) and the per-pick weight-0 guard (H3). The load/latency/keyed oracles (P2C,
 * LeastConn/SED/NQ, PeakEWMA, ConsistentHash, BoundedLoad) need increment 2's load samplers; their
 * slots are present and report-only (0 violations) so this module's boundary is stable.
 */

export const W_DEFAULT = 8192;      // window length (power of 2). W >= 8192 so that at CAP=256,
                                    // weights 1..8 (S=1152), a weight-1 node's chi-square expected
                                    // count is 8192/1152 = 7.1 >= 5 -- the GOF validity floor.
export const SETTLE_DEFAULT = 256;  // quiet picks skipped before a window starts accumulating
export const MIN_WINDOWS = 4;       // < this -> insufficientData (propagated as INCONCLUSIVE, not PASS)
const Z_P001 = 3.090232306167813;   // normal quantile at 1 - 0.001 (Wilson-Hilferty)

/** REJ_MAX(K): rejection budget for K chi-square windows at p=0.001 (P(Bin(K,0.001)>r) < 1e-9). */
function rejBudget(k) { return 3 + Math.ceil(0.001 * k); }

export class QualityWindow {
    constructor(cap, w, settle) {
        this.cap = cap | 0;
        this.W = (w | 0) || W_DEFAULT;
        this.wMask = this.W - 1;                 // W is a power of 2
        this.settle = (settle | 0) || SETTLE_DEFAULT;
        this.ring = new Uint16Array(this.W);     // node ids of the current window (for exact clear)
        this.hist = new Uint32Array(this.cap);   // per-node pick count in the current window
        this.pos = 0;                            // picks accumulated toward the current window
        this.quiet = 0;                          // consecutive quiet picks since the last reset
        // accumulated over the lane-cycle:
        this.windows = 0;
        this.violations = 0;
        this.weightZero = 0;
        this.rejections = 0;
        this.skipped = 0;
        // armed per lane-cycle:
        this.laneName = '';
        this.weighted = 0;
        this.eligible = null;
        this.weights = null;
    }

    /** Arm for a lane-cycle (COLD). `cap` may be < the constructed cap (tiny lanes); hist/ring are
     *  sized for the max cap and only indices [0, cap) are used. */
    arm(laneName, weighted, eligible, weights, cap) {
        this.laneName = laneName;
        this.weighted = weighted ? 1 : 0;
        this.chbl = (laneName === 'ConsistentHash' || laneName === 'BoundedLoad') ? 1 : 0;
        this.eligible = eligible;
        this.weights = weights;
        if (cap) this.cap = cap | 0;
        this.pos = 0;
        this.quiet = 0;
        this.windows = 0;
        this.violations = 0;
        this.weightZero = 0;
        this.rejections = 0;
        this.skipped = 0;
        this.hist.fill(0);
    }

    /** Membership/weight change -> the window is void. 0 B/op (clears only touched cells). */
    reset() {
        for (let k = 0; k < this.pos; k++) this.hist[this.ring[k]] = 0;
        this.pos = 0;
        this.quiet = 0;
    }

    /** Record one pick of `node` (or PICK_NONE < 0 -> a fail-closed tick, ignored). 0 B/op on the
     *  honest kernel: the O(cap) positive-weight scan runs ONLY on a weight-0 pick, which never happens
     *  on a healthy weighted lane (they fail closed / skip weight-0). */
    record(node) {
        if (node < 0) return;
        // per-pick H3 guard: a weighted lane must NEVER return a weight-0 node. NIT C(a): the "all-zero
        // fallback, not H3" excuse is scoped to ConsistentHash/BoundedLoad ONLY -- their documented
        // all-zero-weights contract is equal distribution. SmoothWRR/WeightedRandom/SED/NQ fail CLOSED on
        // all-zero (PICK_NONE), so a weight-0 pick there is ALWAYS a real violation, never a fallback.
        if (this.weighted && this.weights[node] === 0) {
            if (this.chbl) {
                const wt = this.weights, el = this.eligible, cap = this.cap;
                let hasPos = 0;
                for (let i = 0; i < cap; i++) { if (el[i] && wt[i] > 0) { hasPos = 1; break; } }
                if (hasPos) this.weightZero++;
            } else {
                this.weightZero++;
            }
        }
        this.quiet++;
        if (this.quiet <= this.settle) return;   // still settling
        this.hist[node]++;
        this.ring[this.pos & this.wMask] = node;
        this.pos++;
        if (this.pos >= this.W) {
            this._evaluate();
            for (let k = 0; k < this.W; k++) this.hist[this.ring[k]] = 0;   // clear via ring
            this.pos = 0;
        }
    }

    /** Evaluate the lane oracle over the full window. 0 B/op (local scalars only). */
    _evaluate() {
        const nm = this.laneName;
        if (nm === 'RoundRobin') { this.windows++; this.violations += this._orRoundRobin(); return; }
        if (nm === 'SmoothWRR') { this.windows++; this.violations += this._orSmoothWRR(); return; }
        if (nm === 'WeightedRandom') { this._orWeightedRandom(); return; }
        // report-only lanes (increment 2 load/latency/keyed oracles): count the window, 0 violations.
        this.windows++;
    }

    // EXACT: RoundRobin distributes W picks over `live` eligible nodes with max-min <= 1.
    _orRoundRobin() {
        const cap = this.cap, el = this.eligible, h = this.hist;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < cap; i++) {
            if (!el[i]) continue;
            const c = h[i];
            if (c < lo) lo = c;
            if (c > hi) hi = c;
        }
        if (hi < 0) return 0;                      // no eligible node observed
        return (hi - lo) > 1 ? 1 : 0;
    }

    // The H2 accumulator-drift detector. Smooth WRR is DETERMINISTIC: over any window the count of a
    // node deviates from the ideal share total*w_i/S by at most its own weight (each round of S picks
    // gives node i exactly w_i picks; a partial trailing round adds < w_i). So the tight, correct
    // bound is |count_i - total*w_i/S| <= maxWt + 1. H2 drift destroys ratios (a node grabs ~100% or
    // is starved), deviating by hundreds -- far above maxWt, so this bound flags it while a healthy
    // window (deviation <= maxWt) passes. The old bound (`live` = 256) was ~9x the largest expected
    // count and could never fire.
    _orSmoothWRR() {
        const cap = this.cap, el = this.eligible, wt = this.weights, h = this.hist;
        let S = 0, total = 0, maxWt = 0;
        for (let i = 0; i < cap; i++) if (el[i]) { S += wt[i]; if (wt[i] > maxWt) maxWt = wt[i]; }
        if (S === 0) return 0;
        for (let i = 0; i < cap; i++) if (el[i]) total += h[i];
        const tol = maxWt + 1;
        for (let i = 0; i < cap; i++) {
            if (!el[i]) continue;
            const exp = total * wt[i] / S;
            const diff = h[i] - exp;
            if (diff > tol || diff < -tol) return 1;
        }
        return 0;
    }

    // STATISTICAL: chi-square goodness-of-fit at p=0.001, Wilson-Hilferty critical value. A window is
    // SKIPPED when it is outside the regime where WeightedRandom is provably proportional: any expected
    // count < 5 (the GOF validity floor), OR sparse eligibility (< half the pool up), where rejection
    // sampling falls back to a documented, non-proportional scan -- not a defect. Rejections beyond the
    // budget over the lane-cycle -> a violation (recorded in snapshot()).
    _orWeightedRandom() {
        const cap = this.cap, el = this.eligible, wt = this.weights, h = this.hist;
        let S = 0, df = 0, total = 0, live = 0;
        for (let i = 0; i < cap; i++) if (el[i]) { live++; if (wt[i] > 0) { S += wt[i]; df++; total += h[i]; } }
        if (S === 0 || df < 8) { this.skipped++; return; }
        if (live * 2 < cap) { this.skipped++; return; }   // sparse -> rejection-sampling fallback regime
        // reject the window if any expected count is < 5 (chi-square validity floor).
        let ok = 1;
        for (let i = 0; i < cap; i++) {
            if (el[i] && wt[i] > 0 && (total * wt[i] / S) < 5) { ok = 0; break; }
        }
        if (!ok) { this.skipped++; return; }
        this.windows++;
        let chi2 = 0;
        for (let i = 0; i < cap; i++) {
            if (!el[i] || wt[i] === 0) continue;
            const exp = total * wt[i] / S;
            const d = h[i] - exp;
            chi2 += (d * d) / exp;
        }
        const k = df - 1;
        // Wilson-Hilferty critical value for chi-square at df=k, upper tail p=0.001.
        const a = 2 / (9 * k);
        const crit = k * Math.pow(1 - a + Z_P001 * Math.sqrt(a), 3);
        if (chi2 > crit) this.rejections++;
    }

    /**
     * Cold snapshot of the lane-cycle quality result. `green` reflects only observed VIOLATIONS.
     * `insufficientData` (windows < MIN_WINDOWS) is reported separately -- the caller propagates it
     * as INCONCLUSIVE, never a silent PASS (BLOCKER 4: green must not hide a chi-square that never ran).
     */
    snapshot() {
        const rejMax = rejBudget(this.windows);
        const rejViolation = this.rejections > rejMax ? 1 : 0;
        const total = this.violations + this.weightZero + rejViolation;
        return {
            windows: this.windows,
            violations: this.violations,
            weightZero: this.weightZero,
            rejections: this.rejections,
            rejMax,
            skipped: this.skipped,
            insufficientData: this.windows < MIN_WINDOWS,
            totalViolations: total,
            green: total === 0,
        };
    }
}
