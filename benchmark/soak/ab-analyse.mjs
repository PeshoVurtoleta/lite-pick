/**
 * @zakkster/lite-pick soak -- the release-time A/B ANALYSER (research/soak-release-ab.md, #8b).
 *
 * A PURE module: no I/O, no process state, no clock. It takes the two sides' per-process samples and
 * decides FAIL / PASS / INCONCLUSIVE per lane x metric, then a run verdict. The runner (SoakAB.mjs,
 * Batch 3) owns packing, spawning, stream parsing and exit codes; this module only does arithmetic.
 *
 * Statistics reused from gates.mjs (the soak's own exact tests -- one source of truth): mwOneSidedP
 * (exact one-sided Mann-Whitney), uDist (its null distribution), medianOf. The only addition there was
 * `export`. This module IMPORTS gates.mjs ONLY (no config/kernel/provenance coupling).
 *
 * Decision rule (D7): s = Hodges-Lehmann = 1 - median of all KxK ratios b/a; C = largest c with
 * P(U <= c-1) <= ALPHA; sU = 1 - r_(C), sL = 1 - r_(KxK+1-C); Holm step-down over FAMILY.
 *   FAIL  : pHolm < ALPHA AND s > T.
 *   PASS  : not FAIL AND sU < R.
 *   else INCONCLUSIVE.
 * With a per-version acceptance bound m (D8): FAIL if pHolm < ALPHA AND sL > m; ACCEPTED if sU < m+(R-T).
 */

import { mwOneSidedP, uDist, medianOf } from './gates.mjs';

// One-line constants, recorded in the output (research 5.4 / D7).
export const T = 0.05;        // tolerance: the smallest slowdown worth FAILing a release for
export const R = 0.15;        // resolution: PASS must rule out a slowdown this large
export const ALPHA = 0.05;    // family-wise significance (Holm)
export const FAMILY = 20;     // 10 kernel lanes x {hotOpsDense, hotOpsSparse}
export const METRICS = Object.freeze(['hotOpsDense', 'hotOpsSparse']);

// The ten kernel lanes the A/B gates, in roster order. The acceptance file is validated against THIS
// list (an unknown lane is an exit-2 error with a did-you-mean hint, never a silently ignored bound),
// and the runner (SoakAB.mjs) imports it so the roster has a single source. FAMILY === lanes x metrics.
export const KERNEL_LANES = Object.freeze([
    'RoundRobin', 'SmoothWRR', 'P2C', 'LeastConn', 'SED', 'NQ',
    'PeakEWMA', 'ConsistentHash', 'BoundedLoad', 'WeightedRandom',
]);

// --- order (D6): a balanced, seeded A/B schedule -----------------------------------------------------

/** mulberry32 PRNG (the same generator the soak's own seams use for reproducible shuffles). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** K rounds, exactly ceil(K/2) 'AB' and the rest 'BA', Fisher-Yates shuffled with mulberry32(seed).
 *  The composition is ALWAYS balanced (so neither side is systematically second); only the positions
 *  are randomized, which turns a drifting machine's second-slot bias back into noise (research 4.1). */
export function balancedOrder(K, seed) {
    if (!(Number.isInteger(K) && K > 0)) throw new RangeError('balancedOrder: K must be a positive integer');
    const nAB = Math.ceil(K / 2);
    const arr = new Array(K);
    for (let i = 0; i < K; i++) arr[i] = i < nAB ? 'AB' : 'BA';
    const rnd = mulberry32(seed >>> 0);
    for (let i = K - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

// --- effect size + confidence bounds (D7) ------------------------------------------------------------

/** All KxK pairwise ratios b/a, ascending. a, b are the per-process medians for one lane x metric. */
function ratiosAsc(a, b) {
    const out = new Array(a.length * b.length);
    let k = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[k++] = b[j] / a[i];
    out.sort((x, y) => x - y);
    return out;
}

/** Hodges-Lehmann slowdown estimate s = 1 - median(b/a) over all KxK pairs. */
export function hlShift(a, b) {
    const r = ratiosAsc(a, b);
    return 1 - medianOf(r, r.length);
}

/** Largest c with P(U <= c-1) <= alpha under the exact null (the HL confidence index). */
export function ciIndex(m, n, alpha) {
    const counts = uDist(m, n);
    let total = 0;
    for (let i = 0; i < counts.length; i++) total += counts[i];
    const limit = alpha * total;
    let partial = 0, c = 0;
    while (c < counts.length) {
        const next = partial + counts[c];   // S(c+1) = sum_{u=0}^{c}
        if (next <= limit) { partial = next; c++; } else break;
    }
    return c;   // largest c with sum_{u=0}^{c-1} <= alpha*total
}

/** s (point), sU (one-sided 95% upper slowdown bound), sL (lower bound) from the ratio order stats. */
export function shiftBounds(a, b, alpha = ALPHA) {
    const r = ratiosAsc(a, b);
    const N = r.length;                 // m*n
    const C = ciIndex(a.length, b.length, alpha);
    const s = 1 - medianOf(r, N);
    const sU = 1 - r[C - 1];            // 1 - r_(C): the smallest ratios -> the largest slowdown
    const sL = 1 - r[N - C];            // 1 - r_(N+1-C)
    return { s, sU, sL, C };
}

// --- multiple comparisons (D7) -----------------------------------------------------------------------

/** Holm-Bonferroni step-down adjusted p-values, returned in the INPUT order. Monotone, capped at 1.
 *  `family` is the comparison count the correction divides over (default pvals.length). The A/B gate
 *  always passes FAMILY (20) so the step-down is over the whole family even if some p-values are the
 *  usable===false placeholder 1 -- never over just the present count (that would weaken the correction). */
export function holm(pvals, family = pvals.length) {
    const n = pvals.length;
    if (!(Number.isInteger(family) && family >= n)) throw new RangeError('holm: family ' + family + ' < ' + n + ' p-values');
    const order = pvals.map((p, i) => i).sort((x, y) => pvals[x] - pvals[y]);
    const adj = new Array(n);
    let running = 0;
    for (let rank = 0; rank < n; rank++) {
        const i = order[rank];
        let v = pvals[i] * (family - rank);
        if (v > 1) v = 1;
        if (v < running) v = running;   // enforce monotonicity along the sorted order
        running = v;
        adj[i] = v;
    }
    return adj;
}

// --- report-only noise stats (D7) --------------------------------------------------------------------

/** Coefficient of variation (population std / |mean|). 0 for < 2 points or a zero mean. */
export function cv(series) {
    const n = series.length;
    if (n < 2) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += series[i];
    const mean = sum / n;
    if (mean === 0) return 0;
    let ss = 0;
    for (let i = 0; i < n; i++) { const d = series[i] - mean; ss += d * d; }
    return Math.sqrt(ss / n) / Math.abs(mean);
}

/** CV of the residuals after removing a least-squares linear trend vs sample index (research 4.1). */
export function detrendedCv(series) {
    const n = series.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += series[i]; sxx += i * i; sxy += i * series[i]; }
    const mean = sy / n;
    if (mean === 0) return 0;
    const denom = n * sxx - sx * sx;
    const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / n;
    let ss = 0;
    for (let i = 0; i < n; i++) { const res = series[i] - (intercept + slope * i); ss += res * res; }
    return Math.sqrt(ss / n) / Math.abs(mean);
}

// --- the verdict (D7, D8) ----------------------------------------------------------------------------

/** stat = { s, sU, sL, pHolm }. `maxSlowdown` = an accepted bound (D8) or null for the default rule.
 *  Returns 'FAIL' | 'PASS' | 'ACCEPTED' | 'INCONCLUSIVE'. Improvements (s <= T) never FAIL. */
export function decide(stat, maxSlowdown = null) {
    const significant = stat.pHolm < ALPHA;
    if (maxSlowdown != null) {
        if (significant && stat.sL > maxSlowdown) return 'FAIL';
        if (stat.sU < maxSlowdown + (R - T)) return 'ACCEPTED';
        return 'INCONCLUSIVE';
    }
    if (significant && stat.s > T) return 'FAIL';
    if (stat.sU < R) return 'PASS';
    return 'INCONCLUSIVE';
}

// --- acceptance file (D8) ----------------------------------------------------------------------------

const ACCEPT_TOP_KEYS = ['schema', 'version', 'entries'];
const ACCEPT_ENTRY_KEYS = ['lane', 'metric', 'maxSlowdown', 'reason'];

/** Tiny Levenshtein (cold) for the did-you-mean hint -- inlined so this module imports gates.mjs ONLY. */
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = d[0];
        d[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
            prev = tmp;
        }
    }
    return d[n];
}
function nearest(word, list) {
    let best = null, bestD = Infinity;
    for (const k of list) { const dd = editDistance(word, k); if (dd < bestD) { bestD = dd; best = k; } }
    return bestD <= 4 ? best : null;
}
function isAscii(s) { return /^[\x20-\x7e]*$/.test(s); }

/**
 * Validate a parsed acceptance object against the candidate version. Returns:
 *   { ok, errors:[...], notes:[...], map:{ 'lane\u0000metric': maxSlowdown } }
 * `errors` (non-empty) means the CLI must exit 2 (bad configuration). `null`/undefined `accept` is a
 * valid "no acceptances" input (missing file). A version mismatch is a NOTE (entries ignored, stricter),
 * never an error.
 */
export function validateAcceptance(accept, candidateVersion) {
    const errors = [], notes = [], map = {};
    if (accept === null || accept === undefined) return { ok: true, errors, notes, map };
    if (typeof accept !== 'object' || Array.isArray(accept)) {
        errors.push('acceptance: top level must be an object');
        return { ok: false, errors, notes, map };
    }
    for (const k of Object.keys(accept)) {
        if (ACCEPT_TOP_KEYS.indexOf(k) === -1) {
            const hint = nearest(k, ACCEPT_TOP_KEYS);
            errors.push("acceptance: unknown key '" + k + "'" + (hint ? ' (did you mean ' + hint + '?)' : ''));
        }
    }
    if (accept.schema !== 1) errors.push('acceptance: schema must be 1 (got ' + JSON.stringify(accept.schema) + ')');
    if (typeof accept.version !== 'string') errors.push('acceptance: version must be a string');
    if (!Array.isArray(accept.entries)) errors.push('acceptance: entries must be an array');
    if (errors.length) return { ok: false, errors, notes, map };

    // Version mismatch: ignore the entries (stricter) and NOTE it. Not an error.
    if (accept.version !== candidateVersion) {
        notes.push('acceptance NOTE: version ' + accept.version + ' != candidate ' + candidateVersion +
            ' -- entries ignored (the gate stays strict)');
        return { ok: true, errors, notes, map };
    }

    const seen = Object.create(null);
    for (let e = 0; e < accept.entries.length; e++) {
        const entry = accept.entries[e];
        const where = 'acceptance entry ' + e;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            errors.push(where + ': must be an object'); continue;
        }
        for (const k of Object.keys(entry)) {
            if (ACCEPT_ENTRY_KEYS.indexOf(k) === -1) {
                const hint = nearest(k, ACCEPT_ENTRY_KEYS);
                errors.push(where + ": unknown key '" + k + "'" + (hint ? ' (did you mean ' + hint + '?)' : ''));
            }
        }
        const laneOk = typeof entry.lane === 'string' && KERNEL_LANES.indexOf(entry.lane) !== -1;
        if (typeof entry.lane !== 'string' || entry.lane.length === 0) {
            errors.push(where + ': lane must be a non-empty string');
        } else if (!laneOk) {
            const hint = nearest(entry.lane, KERNEL_LANES);
            errors.push(where + ": unknown lane '" + entry.lane + "'" + (hint ? ' (did you mean ' + hint + '?)' : '') +
                ' -- must be one of the ten kernel lanes');
        }
        if (METRICS.indexOf(entry.metric) === -1) errors.push(where + ": metric must be one of " + METRICS.join(' | '));
        if (typeof entry.maxSlowdown !== 'number' || !(entry.maxSlowdown > T) || !(entry.maxSlowdown <= 0.5)) {
            errors.push(where + ': maxSlowdown must be a number in (' + T + ', 0.5]');
        }
        if (typeof entry.reason !== 'string' || entry.reason.length < 20 || !isAscii(entry.reason)) {
            errors.push(where + ': reason must be ASCII and at least 20 characters');
        }
        if (laneOk && METRICS.indexOf(entry.metric) !== -1) {
            const key = entry.lane + '\u0000' + entry.metric;
            if (seen[key]) errors.push(where + ': duplicate lane+metric ' + entry.lane + '/' + entry.metric);
            seen[key] = true;
            map[key] = entry.maxSlowdown;
        }
    }
    return { ok: errors.length === 0, errors, notes, map };
}

// --- preconditions (D9): everything that makes a run INCONCLUSIVE, never a silent PASS ----------------

/** True iff `v` is a plain "x.y.z" release (no pre-release / build tag). */
function isRelease(v) { return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v); }
/** semver compare of two release strings: -1 / 0 / 1. */
function cmpVersion(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] < pb[i]) return -1; if (pa[i] > pb[i]) return 1; }
    return 0;
}
/** All procs must report the same value at `path` (dotted) in their header; else a disagreement. */
function headerField(header, path) {
    let v = header;
    for (const part of path.split('.')) { if (v == null) return undefined; v = v[part]; }
    return v;
}

/**
 * Check the run-level preconditions. `manifest` declares the two sides; `procs` is the array of every
 * spawned process's { side:'A'|'B', role:'calib'|'round', exit:int, verdict:string|null, header:obj }.
 * Returns { inconclusive:[reasons], fail:[reasons], validRounds:int }. The caller maps a non-empty
 * `fail` to exit 1, a non-empty `inconclusive` (with no fail) to exit 3.
 */
export function checkProcesses(manifest, procs) {
    const inconclusive = [], fail = [];
    const A = procs.filter((p) => p.side === 'A');
    const B = procs.filter((p) => p.side === 'B');

    // Version preconditions (D9). An A/A control (manifest.aa) legitimately runs the SAME release on both
    // sides, so it requires prev == candidate; a release run requires prev < candidate (strict).
    if (!isRelease(manifest.prevVersion)) inconclusive.push('prev version ' + manifest.prevVersion + ' is not a plain release');
    if (!isRelease(manifest.candidateVersion)) inconclusive.push('candidate version ' + manifest.candidateVersion + ' is not a plain release (pre-release?)');
    if (isRelease(manifest.prevVersion) && isRelease(manifest.candidateVersion)) {
        const c = cmpVersion(manifest.prevVersion, manifest.candidateVersion);
        if (manifest.aa) {
            if (c !== 0) inconclusive.push('A/A control expects prev == candidate (got ' + manifest.prevVersion + ' vs ' + manifest.candidateVersion + ')');
            // the relaxed version rule is only sound if both sides really are the same bytes
            if (manifest.aPickSha !== manifest.bPickSha || manifest.aPoolSha !== manifest.bPoolSha) {
                inconclusive.push('A/A control expects identical kernels on both sides (Pick.js/Pool.js hashes differ)');
            }
        } else if (!(c < 0)) {
            inconclusive.push('prev ' + manifest.prevVersion + ' is not < candidate ' + manifest.candidateVersion);
        }
    }

    // B hashes must be the pinned shipped code (parity.json). A disagreement is INCONCLUSIVE.
    if (manifest.bPickSha !== manifest.parityPickSha) inconclusive.push('B Pick.js hash != parity.json');
    if (manifest.bPoolSha !== manifest.parityPoolSha) inconclusive.push('B Pool.js hash != parity.json');

    // Header agreement across every process (research 5.2 machine sanity). timerFloorNs is report-only.
    const AGREE = ['schemaVersion', 'node', 'v8', 'gitSha', 'os.platform', 'os.arch', 'os.cpuModel', 'os.cpuCount'];
    for (const path of AGREE) {
        const vals = new Set(procs.map((p) => JSON.stringify(headerField(p.header, path))));
        if (vals.size > 1) inconclusive.push('header disagreement on ' + path);
    }
    for (const path of ['execArgv', 'config', 'laneRoster']) {
        const vals = new Set(procs.map((p) => JSON.stringify(headerField(p.header, path))));
        if (vals.size > 1) inconclusive.push('header disagreement on ' + path);
    }

    // Per-side kernel hash + override flags.
    for (const p of A) {
        if (headerField(p.header, 'kernel.pickSha256') !== manifest.aPickSha) inconclusive.push('A process kernel hash != tarball A');
        if (headerField(p.header, 'kernel.poolSha256') !== manifest.aPoolSha) inconclusive.push('A process pool hash != tarball A');
    }
    for (const p of B) {
        if (headerField(p.header, 'kernel.pickSha256') !== manifest.bPickSha) inconclusive.push('B process kernel hash != tarball B');
        if (headerField(p.header, 'kernel.poolSha256') !== manifest.bPoolSha) inconclusive.push('B process pool hash != tarball B');
    }
    for (const p of procs) {
        if (headerField(p.header, 'kernel.kernelOverride') !== true || headerField(p.header, 'kernel.poolOverride') !== true) {
            inconclusive.push((p.side) + ' process did not load from a tarball (override flag not true)');
        }
    }

    // Each A process MUST exit 0 with its own verdict PASS (else the baseline is not comparable).
    for (const p of A) {
        if (p.exit !== 0 || p.verdict !== 'PASS') inconclusive.push('baseline (A) process not PASS (exit ' + p.exit + ', verdict ' + p.verdict + ')');
    }
    // A B process: exit 1 -> FAIL; exit 2/3 -> INCONCLUSIVE; exit 0 must be PASS.
    for (const p of B) {
        if (p.exit === 1) fail.push('B process failed its own soak (exit 1, verdict ' + p.verdict + ')');
        else if (p.exit === 2 || p.exit === 3) inconclusive.push('B process not comparable (exit ' + p.exit + ')');
        else if (p.exit === 0 && p.verdict !== 'PASS') inconclusive.push('B process exit 0 but verdict ' + p.verdict);
        else if (p.exit !== 0) inconclusive.push('B process abnormal exit ' + p.exit);
    }

    // Enough balanced rounds: a round is valid when both its A and B rounds exist and are usable.
    const validRounds = Math.min(A.filter((p) => p.role === 'round' && p.exit === 0).length,
                                 B.filter((p) => p.role === 'round' && p.exit === 0).length);
    if (!Number.isInteger(manifest.K)) inconclusive.push('manifest.K is not an integer (' + manifest.K + ')');
    else if (validRounds < manifest.K) inconclusive.push('fewer than K valid rounds (' + validRounds + ' < ' + manifest.K + ')');

    return { inconclusive, fail, validRounds };
}

// --- top-level analysis (D7, D9) ---------------------------------------------------------------------

/** Per-process median hotOps for a lane+metric, over the measured cycles the proc carries in `.samples`:
 *  samples[laneId][metric] is already the per-process median (the runner reduces cycles -> one number). */
function sideMedians(procs, side, laneId, metric) {
    const out = [];
    for (const p of procs) {
        if (p.side !== side || p.role !== 'round') continue;
        const byLane = p.samples && p.samples[laneId];
        const v = byLane ? byLane[metric] : undefined;
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out.push(v);
    }
    return out;
}

/** Report-only: the per-side median latencyP99 for a lane+metric (samples[lane].latencyP99Dense/Sparse,
 *  carried by the runner). Report-only -- it never enters decide(); undefined when no latency was kept. */
function sideLatencyP99(procs, side, laneId, metric) {
    const key = metric === 'hotOpsSparse' ? 'latencyP99Sparse' : 'latencyP99Dense';
    const out = [];
    for (const p of procs) {
        if (p.side !== side || p.role !== 'round') continue;
        const byLane = p.samples && p.samples[laneId];
        const v = byLane ? byLane[key] : undefined;
        if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    if (!out.length) return undefined;
    out.sort((x, y) => x - y);
    return medianOf(out, out.length);
}

/**
 * Full A/B analysis. `manifest` as in checkProcesses plus `.lanes` (the kernel lane ids, in roster order).
 * `procs` carry `.samples` = { laneId: { hotOpsDense, hotOpsSparse } } (per-process medians). `accept` is
 * the parsed acceptance object (or null). Returns a structured result the runner serialises + exits on.
 */
export function analyse(manifest, procs, accept) {
    const pre = checkProcesses(manifest, procs);
    // An A/A control has candidate == prev, so a file pinned to that version would "apply" and could turn an
    // INCONCLUSIVE into ACCEPTED in the A/A tally: acceptances are ignored in aa mode.
    const acc = validateAcceptance(manifest.aa ? null : accept, manifest.candidateVersion);

    const lanes = Array.isArray(manifest.lanes) ? manifest.lanes : [];
    const K = manifest.K;

    // Structural preconditions (D7/D9): fail CLOSED on anything that makes the family or the sample count
    // untrustworthy. An empty/short/over-long lane set, or a K below the MW floor, can NEVER PASS -- a 0- or
    // 2-comparison run is INCONCLUSIVE, not a silent PASS. These also make the run never FAIL (the family it
    // would FAIL against is not the one it was designed for), only INCONCLUSIVE.
    const structural = [];
    const familyCount = lanes.length * METRICS.length;
    if (familyCount !== FAMILY) {
        structural.push('comparison family is ' + familyCount + ' (' + lanes.length + ' lanes x ' +
            METRICS.length + ' metrics), not ' + FAMILY);
    } else if (lanes.some((l, i) => l !== KERNEL_LANES[i])) {
        // the RIGHT twenty: a family of the right size made of the wrong lanes (e.g. one lane ten times) would
        // leave real kernel lanes uncompared, so the lane list must be exactly the kernel roster, in order
        structural.push('lane set is not the kernel roster [' + KERNEL_LANES.join(', ') + '] (got [' + lanes.join(', ') + '])');
    }
    if (!(Number.isInteger(K) && K >= 8)) {
        structural.push('K must be an integer >= 8 (got ' + JSON.stringify(K) + ')');
    }

    const comps = [];   // { lane, metric, a, b, usable, s, sU, sL, p, ... report-only }
    const rawP = [];
    for (const lane of lanes) {
        for (const metric of METRICS) {
            const a = sideMedians(procs, 'A', lane, metric);
            const b = sideMedians(procs, 'B', lane, metric);
            // A comparison is usable ONLY with exactly K per-process medians on each side (D7): a dropped
            // (null/NaN/zero) sample leaves fewer, and a 9-vs-9 decision is INCONCLUSIVE, never a verdict.
            const usable = Number.isInteger(K) && a.length === K && b.length === K;
            const p = usable ? mwOneSidedP(a, a.length, b, b.length, -1) : 1;
            const bounds = usable ? shiftBounds(a, b) : { s: 0, sU: Infinity, sL: 0, C: 0 };
            comps.push({
                lane, metric, a, b, usable, s: bounds.s, sU: bounds.sU, sL: bounds.sL, p,
                // report-only noise + latency fields (D7): computed, serialised, NEVER fed to decide().
                cvA: cv(a), cvB: cv(b), detrendedCvA: detrendedCv(a), detrendedCvB: detrendedCv(b),
                latencyP99A: sideLatencyP99(procs, 'A', lane, metric),
                latencyP99B: sideLatencyP99(procs, 'B', lane, metric),
            });
            rawP.push(p);
        }
    }
    // step-down over the WHOLE family, never the present count; an over-long family is already structurally
    // INCONCLUSIVE, so adjusting over its own size there only keeps the report-only numbers defined
    const adj = holm(rawP, Math.max(FAMILY, rawP.length));
    for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        c.pHolm = adj[i];
        const key = c.lane + '\u0000' + c.metric;
        const maxSlowdown = Object.prototype.hasOwnProperty.call(acc.map, key) ? acc.map[key] : null;
        c.accepted = maxSlowdown;
        c.verdict = c.usable ? decide({ s: c.s, sU: c.sU, sL: c.sL, pHolm: c.pHolm }, maxSlowdown) : 'INCONCLUSIVE';
        c.improvement = c.usable && c.s < -T;   // report-only: a measurable speed-up (never a verdict)
        if (!c.usable) c.reason = 'unusable samples: A n=' + c.a.length + ' B n=' + c.b.length +
            ' (need exactly K=' + JSON.stringify(K) + ' per side)';
    }

    const fail = pre.fail.slice();
    const inconclusive = pre.inconclusive.slice().concat(structural);
    // When the family/K is structurally untrustworthy the per-comparison verdicts are NOT aggregated into
    // the run verdict (a wrong family must never FAIL or PASS a release); the run is INCONCLUSIVE.
    if (!structural.length) {
        for (const c of comps) {
            if (c.verdict === 'FAIL') fail.push('FAIL ' + c.lane + '/' + c.metric + ' s=' + c.s.toFixed(4) + ' pHolm=' + c.pHolm.toExponential(2));
            else if (c.verdict === 'INCONCLUSIVE') inconclusive.push('INCONCLUSIVE ' + c.lane + '/' + c.metric + ' (' + c.reason + ')');
        }
    }
    for (const e of acc.errors) fail.push(e);   // a bad acceptance file is a configuration error (exit 2 upstream)

    // Run verdict + exit code (soak convention: 0 PASS, 1 FAIL, 3 INCONCLUSIVE, 2 bad config).
    let verdict, exitCode;
    if (acc.errors.length) { verdict = 'ERROR'; exitCode = 2; }
    else if (fail.length) { verdict = 'FAIL'; exitCode = 1; }
    else if (inconclusive.length) { verdict = 'INCONCLUSIVE'; exitCode = 3; }
    else { verdict = 'PASS'; exitCode = 0; }

    return {
        verdict, exitCode, comparisons: comps,
        fail, inconclusive, notes: acc.notes.slice(),
        validRounds: pre.validRounds,
        constants: { T, R, ALPHA, FAMILY },
    };
}
