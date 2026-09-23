/**
 * Pool Scope -- snapshot.mjs : the RENDERER-AGNOSTIC scene model (PS1 deliverable 1).
 *
 *     import { LitePickSnapshot } from './snapshot.mjs';
 *
 * A LitePickSnapshot is the SoA ring-buffer described in design/pool-scope.md section 9: parallel
 * typed arrays, power-of-2 SIZE, masked head, ZERO alloc on append. It reads a live lite-pick
 * balancer's state off the hot path (never calls pick(), never perturbs it) plus the caller-owned
 * arrays a driver exposes, and derives the fairness / latency / per-worker series both the TUI and a
 * later browser target can render from ONE source.
 *
 * Boundary (section 9): lite-pick is a STATELESS SELECTION KERNEL, so there are NO rebalance /
 * migration / queue-age fields here. Per-worker: inflight, rolling share, eligible, weight, cap
 * (BoundedLoad occupancy cap), ewmaCost (PeakEWMA). Fairness: Gini (primary, catches the spread that
 * max-min misses -- 90,90,90,90,90 -> 0 ; 10,10,10,10,90 -> ~0.49). Latency: p50/p95/p99 percentiles,
 * never averages. All math is inlined (PS1 is zero-dep; no lite-sketch / lite-charts here).
 *
 * Hot-path law: every buffer is pre-allocated at construction. build()/append() create no array,
 * object, or closure -- the append is head=(head+1)&(SIZE-1), pure typed-array writes.
 */

/** System-ring depth: a power of two. append() masks the head with SIZE-1. */
export const SIZE = 64;

/** Latency sample ring depth (power of two): percentiles are read over the last LAT_SIZE settles. */
export const LAT_SIZE = 512;

/** Rolling window (frames) the per-worker mean/std/series metrics summarise for the detectors. */
export const WINDOW = 48;

/**
 * Population Gini over the LIVE (eligible) workers' values, via the mean-absolute-difference form
 * G = (sum_i sum_j |xi - xj|) / (2 n sum) -- 0 for a flat spread, -> 1 for a monopoly. O(n^2), n is
 * the pool size (tens), zero-alloc: it writes the live indices into a caller-owned scratch first.
 * @param {Float64Array} value   per-worker magnitude (share or load)
 * @param {Uint8Array} live      1 = eligible (counted), 0 = skipped
 * @param {Int32Array} scratch   pre-allocated index scratch (length >= cap)
 * @param {number} cap
 * @returns {number} Gini in [0, 1]
 */
export function giniLive(value, live, scratch, cap) {
    let n = 0, sum = 0;
    for (let i = 0; i < cap; i++) {
        if (live[i]) { scratch[n++] = i; sum += value[i]; }
    }
    if (n < 2 || sum <= 0) return 0;
    let mad = 0;
    for (let a = 0; a < n; a++) {
        const va = value[scratch[a]];
        for (let b = 0; b < n; b++) {
            const d = va - value[scratch[b]];
            mad += d < 0 ? -d : d;
        }
    }
    return mad / (2 * n * sum);
}

/**
 * LitePickSnapshot -- the pre-allocated scene model. One instance is built once, then build(driver)
 * is called on the ~10 Hz tick to refresh the latest per-worker scalars, recompute the fairness /
 * latency aggregates, and append the frame to the rings. Nothing here mutates the balancer or the
 * caller arrays -- it is a pure READER (never calls pick()).
 */
export class LitePickSnapshot {
    /**
     * @param {number} cap  worker/pool capacity (fixed).
     */
    constructor(cap) {
        this.cap = cap;
        // ---- system SoA ring (design brief section 9) ----------------------
        this.ts = new Float64Array(SIZE);
        this.fairness = new Float32Array(SIZE);   // 1 - gini : 1 = perfectly fair
        this.gini = new Float32Array(SIZE);
        this.throughput = new Float32Array(SIZE);
        this.latP50 = new Float32Array(SIZE);
        this.latP95 = new Float32Array(SIZE);
        this.latP99 = new Float32Array(SIZE);
        this.head = 0;      // append: head=(head+1)&(SIZE-1)
        this.frames = 0;    // valid frame count, saturates at SIZE

        // ---- per-worker time-series rings (row-major w*SIZE + slot) --------
        this.rLoad = new Float32Array(cap * SIZE);    // inflight history (for the heat-strip)
        this.rShare = new Float32Array(cap * SIZE);   // rolling-share history
        this.rElig = new Uint8Array(cap * SIZE);      // eligibility history (flap detection)

        // ---- latest per-worker scalars the builder refreshes each frame ----
        this.wInflight = new Float64Array(cap);
        this.wShare = new Float64Array(cap);          // rolling share, normalised over the live mass
        this.wEligible = new Uint8Array(cap);
        this.wWeight = new Float64Array(cap);
        this.wCap = new Float64Array(cap);            // BoundedLoad cap, else NaN
        this.wEwma = new Float64Array(cap);           // PeakEWMA cost estimate, else NaN

        // ---- rolling per-worker mean/std over WINDOW (for the detectors) ---
        this.mLoad = new Float64Array(cap);
        this.sdLoad = new Float64Array(cap);

        // ---- latest aggregate scalars -------------------------------------
        this.curGini = 0;
        this.curFairness = 1;
        this.curThroughput = 0;
        this.p50 = 0; this.p95 = 0; this.p99 = 0;
        this.live = 0;
        this.totalInflight = 0;
        this.maxLoad = 1;      // running display scale for the bars/heat (>= 1)

        // ---- scratch (pre-allocated, reused; never grows) ------------------
        this._giniScratch = new Int32Array(cap);
        this._lat = new Float64Array(LAT_SIZE);
    }

    /** Slot of the frame `k` steps back (k=0 = most recent). Internal, zero-alloc. */
    _slot(k) {
        return (this.head - 1 - k) & (SIZE - 1);
    }

    /** Per-worker load `k` frames back (k=0 = most recent). Zero-alloc. */
    loadAt(w, k) {
        return this.rLoad[w * SIZE + ((this.head - 1 - k) & (SIZE - 1))];
    }

    /** Per-worker rolling share `k` frames back. Zero-alloc. */
    shareAt(w, k) {
        return this.rShare[w * SIZE + ((this.head - 1 - k) & (SIZE - 1))];
    }

    /** Per-worker eligibility `k` frames back (1/0). Zero-alloc. */
    eligAt(w, k) {
        return this.rElig[w * SIZE + ((this.head - 1 - k) & (SIZE - 1))];
    }

    /**
     * Refresh the latest per-worker scalars + aggregates from the driver, then append one frame to
     * the rings. Reads ONLY (driver getters + balancer getters); never calls pick(). Zero-alloc.
     * @param {object} driver  the traffic engine (owns eligible/inflight/weights + balancer getters)
     */
    build(driver) {
        const cap = this.cap;
        const inflight = driver.inflight;
        const shareDecay = driver.shareDecay;
        let live = 0, total = 0, shareSum = 0, maxLoad = 1;

        // First pass: eligibility + inflight + raw share mass over the LIVE set.
        for (let i = 0; i < cap; i++) {
            const el = driver.isEligible(i) ? 1 : 0;
            this.wEligible[i] = el;
            const inf = inflight[i];
            this.wInflight[i] = inf;
            if (inf > maxLoad) maxLoad = inf;
            if (el) { live++; total += inf; shareSum += shareDecay[i]; }
            this.wWeight[i] = driver.weightOf(i);
            this.wCap[i] = driver.capOf(i);
            this.wEwma[i] = driver.ewmaOf(i);
        }
        // Second pass: normalised rolling share over the live mass (0 for a down/idle worker).
        const inv = shareSum > 0 ? 1 / shareSum : 0;
        for (let i = 0; i < cap; i++) {
            this.wShare[i] = this.wEligible[i] ? shareDecay[i] * inv : 0;
        }
        this.live = live;
        this.totalInflight = total;
        this.maxLoad = maxLoad;

        // Fairness: Gini over the live workers' rolling share (the decision distribution).
        const g = giniLive(this.wShare, this.wEligible, this._giniScratch, cap);
        this.curGini = g;
        this.curFairness = 1 - g;

        // Latency percentiles from the driver's pre-filled ring: copy -> sort in place -> index.
        this._lat.set(driver.latRing);
        this._lat.sort();
        this.p50 = this._lat[LAT_SIZE >> 1];
        this.p95 = this._lat[(LAT_SIZE * 95 / 100) | 0];
        this.p99 = this._lat[(LAT_SIZE * 99 / 100) | 0];

        // Throughput (settles/sec) the driver measured over the frame.
        this.curThroughput = driver.frameSeconds > 0 ? driver.frameSettles / driver.frameSeconds : 0;

        // Append the aggregate frame to the system ring (masked head, zero-alloc).
        const h = this.head;
        this.ts[h] = driver.nowNs;
        this.gini[h] = g;
        this.fairness[h] = this.curFairness;
        this.throughput[h] = this.curThroughput;
        this.latP50[h] = this.p50;
        this.latP95[h] = this.p95;
        this.latP99[h] = this.p99;

        // Append the per-worker frame + refresh the rolling mean/std over WINDOW.
        const win = this.frames + 1 < WINDOW ? this.frames + 1 : WINDOW;
        for (let i = 0; i < cap; i++) {
            const base = i * SIZE;
            this.rLoad[base + h] = this.wInflight[i];
            this.rShare[base + h] = this.wShare[i];
            this.rElig[base + h] = this.wEligible[i];
            // rolling mean/std over the last `win` frames INCLUDING this one.
            let sum = 0;
            for (let k = 0; k < win; k++) sum += this.rLoad[base + ((h - k) & (SIZE - 1))];
            const mean = sum / win;
            let varSum = 0;
            for (let k = 0; k < win; k++) {
                const d = this.rLoad[base + ((h - k) & (SIZE - 1))] - mean;
                varSum += d * d;
            }
            this.mLoad[i] = mean;
            this.sdLoad[i] = Math.sqrt(varSum / win);
        }

        this.head = (h + 1) & (SIZE - 1);
        if (this.frames < SIZE) this.frames++;
    }
}
