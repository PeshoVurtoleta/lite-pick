/**
 * @zakkster/lite-pick soak -- family-specialized, allocation-free hot steps (audit 1.4, 1.8).
 *
 * Replaces the old inflight++/coin-flip random walk with four monomorphic step functions, one per
 * lane FAMILY, each 0 B/op: every double lives in a typed-array slot (the DES clock in des.mjs), the
 * only values crossing into Pick.js are SMIs (a 30-bit key, an SMI service sample, an SMI monotonic
 * clock). A HotCtx carries the pre-resolved locals so the loop body allocates nothing.
 *
 * The B/op probe (measureBytesPerOp) reads V8 used_heap_size deltas over a segment, subtracts an
 * empty-loop bias, and returns null on a negative delta (a GC ran mid-window). The pick loop is timed
 * by the caller with a monotonic accumulator between checkpoints, never per pick (no per-pick clock
 * call, so the clock cannot box).
 */

import v8 from 'node:v8';
import { Prng } from './kernel.mjs';
import { EventQueue } from './des.mjs';
import { FAMILY, KEYS, KEY_MASK, PICK_NONE } from './lanes.mjs';

// When the latency lane's monotonic clock crosses this it may box into a HeapNumber field; the
// hotAlloc gate excludes such boxingRegime segments (it is expected, not a leak).
export const SMI_LIMIT = 1 << 30;

/** Build the per-lane-cycle hot context (COLD). `built` is the lane.make() result. */
export function makeHotCtx(lane, built, seed, cap, queueCap, meanUs, lognormal) {
    const family = lane.family;
    const needQueue = family === FAMILY.LOAD || family === FAMILY.LATENCY ||
        (family === FAMILY.KEYED && lane.notes);
    let queue = null;
    if (needQueue) {
        queue = new EventQueue(queueCap);
        const qrng = new Prng((seed ^ 0x51A17ED) >>> 0);
        const conc = Math.min(queueCap, Math.max(1, cap >> 1));
        queue.reset(qrng, built.inflight, conc, meanUs, lognormal, cap);
    }
    return {
        family,
        notes: !!lane.notes,
        b: built.b,
        eligible: built.eligible,
        inflight: built.inflight,
        weights: built.weights,
        cap,
        rng: new Prng((seed ^ 0x9E3779B1) >>> 0),
        queue,
        keys: KEYS,
        keyMask: KEY_MASK,
        keyPos: 0,
        now: 0,          // SMI monotonic clock for the latency lane
        lastPick: PICK_NONE,
        keyHash: 0,
    };
}

// --- the four hot steps. Each mutates ctx typed slots + SMI fields only. 0 B/op. ------------------

export function hotPlain(ctx) {
    ctx.lastPick = ctx.b.pick();
}

export function hotLoad(ctx) {
    const q = ctx.queue;
    if (q.full()) {
        const node = q.pop();
        if (node >= 0 && ctx.inflight[node] > 0) ctx.inflight[node]--;
    }
    const p = ctx.b.pick();
    if (p !== PICK_NONE) {
        ctx.inflight[p]++;
        q.pushCompletion(p);
    }
    ctx.lastPick = p;
}

export function hotLatency(ctx) {
    const q = ctx.queue;
    if (q.full()) {
        const svc = q.hSvc[0];             // SMI service of the imminent completion
        const node = q.pop();
        if (node >= 0) {
            if (ctx.inflight[node] > 0) ctx.inflight[node]--;
            ctx.b.recordRtt(node, svc, ctx.now);   // SMI args -- no box
        }
    }
    ctx.now = ctx.now + 1 + ctx.rng.nextBelow(1024);   // SMI monotonic tick
    const p = ctx.b.pick(ctx.now);
    if (p !== PICK_NONE) {
        ctx.inflight[p]++;
        q.pushCompletion(p);
    }
    ctx.lastPick = p;
}

export function hotKeyed(ctx) {
    ctx.keyPos = (ctx.keyPos + 1) & ctx.keyMask;
    const key = ctx.keys[ctx.keyPos];      // SMI 30-bit key
    ctx.keyHash = key;
    if (ctx.notes) {
        const q = ctx.queue;
        if (q.full()) {
            const node = q.pop();
            if (node >= 0 && ctx.inflight[node] > 0) { ctx.inflight[node]--; ctx.b.note(node, -1); }
        }
        const p = ctx.b.pick(key);
        if (p !== PICK_NONE) {
            ctx.inflight[p]++;
            ctx.b.note(p, 1);
            q.pushCompletion(p);
        }
        ctx.lastPick = p;
    } else {
        ctx.lastPick = ctx.b.pick(key);
    }
}

/** The step function for a lane family. */
export function stepFor(family, notes) {
    if (family === FAMILY.PLAIN) return hotPlain;
    if (family === FAMILY.LOAD) return hotLoad;
    if (family === FAMILY.LATENCY) return hotLatency;
    if (family === FAMILY.KEYED) return hotKeyed;
    throw new Error('[soak] unknown family ' + family);
}

// The B/op probe sums the DATA spaces per window -- new_space (transient boxes, still live inside a
// GC-free window), old_space (a retained per-instance leak like this.__log.push), and the large-object
// spaces (an object >= the new-space size limit) -- the three blind spots a new-space-only probe
// missed. It EXCLUDES code_space / map_space / read_only: those grow from JIT compilation, not workload
// allocation, and their ~KB jitter would swamp a sub-1-B/op signal. A window is dropped as NOT GC-free
// when new space shrank (a scavenge) OR the data total shrank (a mark-compact freed old space); else the
// delta is bytes the window ALLOCATED-AND-KEPT-LIVE. Both --min/--max-semi-space-size=4 pin the scale.
function heapProbe() {
    const spaces = v8.getHeapSpaceStatistics();
    let total = 0, newu = 0;
    for (let i = 0; i < spaces.length; i++) {
        const s = spaces[i];
        const nm = s.space_name;
        if (nm === 'new_space' || nm === 'old_space' || nm === 'large_object_space' || nm === 'new_large_object_space' || nm === 'old_large_object_space') {
            total += s.space_used_size;
        }
        if (nm === 'new_space') newu = s.space_used_size;
    }
    return { total, newu };
}

/** Fail closed unless semi-space is pinned to 4MB (both flags), so the B/op scale cannot drift. */
export function assertPinnedFlags() {
    const av = process.execArgv.join(' ');
    const need = ['--min-semi-space-size=4', '--max-semi-space-size=4'];
    for (const f of need) {
        if (av.indexOf(f) === -1) {
            process.stderr.write('soak: FAIL -- B/op probe requires ' + f +
                ' (both --min/--max-semi-space-size=4 pin the scavenge scale); got: ' + av + '\n');
            process.exit(2);
        }
    }
}

function meanArr(a) {
    if (!a.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
}

function minArr(a) {
    if (!a.length) return 0;
    let m = a[0];
    for (let i = 1; i < a.length; i++) if (a[i] < m) m = a[i];
    return m;
}

/**
 * Run `windows` windows of `ops` steps; collect the total-heap byte-delta of each GC-FREE window.
 * Window 0 is always dropped (Maglev warm-up). Returns { deltas, gcFree, scavenged }.
 *
 * A window is GC-free only if v8.GCProfiler (synchronous: stop() returns every GC in its span) saw NO
 * collection in it AND the snapshots agree (new space did not shrink, total did not shrink). Snapshots
 * ALONE alias under heavy allocation (audit 2026-09-29, teeth M19): at ~2 KB/op a window runs ~4 scavenges
 * and its end-of-window new-space usage lands below the previous reading only by chance, so ~90% of the
 * windows read "GC-free" with a garbage delta (~54 B/op) and the gross tier never fired. The profiler's own
 * small per-window allocation is the same in every window, so the warm bias (same geometry) absorbs it.
 */
export function sampleWindows(ctx, stepFn, ops, windows) {
    const deltas = [];
    let scavenged = 0;
    const gcp = new v8.GCProfiler();
    let prev = heapProbe();
    for (let w = 0; w < windows; w++) {
        gcp.start();
        for (let i = 0; i < ops; i++) stepFn(ctx);
        const gcs = gcp.stop().statistics.length;
        const cur = heapProbe();
        const dTotal = cur.total - prev.total;
        const gcRan = gcs !== 0 || cur.newu < prev.newu || dTotal < 0;   // any GC, scavenge OR mark-compact
        prev = cur;
        if (w === 0) continue;
        if (gcRan) { scavenged++; continue; }
        deltas.push(dTotal);
    }
    return { deltas, gcFree: deltas.length, scavenged };
}

/**
 * The warm per-window bias: the total-heap bytes a 0-alloc window still shows, dominated by the
 * getHeapSpaceStatistics() object the probe allocates at each window boundary. Measured WARM with the
 * SAME geometry, subtracted per window.
 *
 * Returns the MIN of the GC-free no-op windows -- NOT the mean. The mean (the prior version) is
 * measured at startup during peak JIT tier-up/finalization, so one-off old-space allocations land in a
 * MINORITY of the no-op windows and pull the mean far above the true per-window floor (observed swing
 * 2943..7088 B). Subtracting an inflated bias OVER-subtracts and hides real allocation (a 0.49 B/op
 * mutant read 0). The MIN is the cleanest window = the pure probe floor: it can never exceed the true
 * per-window overhead, so it never over-subtracts and never hides allocation. The workload estimator
 * keeps the MEAN (measureHotBytesPerOp) so a burst in a MINORITY of windows still shows (BLOCKER 2).
 *
 * Returns { bias, floor, spread, gcFree }: `bias` is the MIN, `spread` = max-min of the no-op windows
 * (a noise signal recorded in the header; the caller fails closed on an empty sample).
 */
export function warmBiasBytes(ops, windows) {
    const c = { x: 0 };
    const noopStep = (cc) => { cc.x = (cc.x + 1) | 0; };
    // Extra warmup so JIT tier-up / finalization settles OUT of the sampled windows.
    for (let i = 0; i < ops * 16; i++) noopStep(c);
    const { deltas, gcFree } = sampleWindows(c, noopStep, ops, windows);
    const floor = minArr(deltas);
    const hi = deltas.length ? Math.max.apply(null, deltas) : 0;
    return { bias: floor, floor, spread: hi - floor, gcFree };
}

/**
 * Hot B/op = the MIN over TWO independent passes of (the MEAN of that pass's GC-free windows) minus the
 * warm bias, per op. Within a pass the MEAN (not the median) keeps a burst landing in a MINORITY of
 * windows visible (a median would hide it -- BLOCKER 2). Across the two passes the MIN discriminates a
 * ONE-OFF runtime old-space event (JIT finalization / a lazy tier-up buffer -- it lands in only one pass,
 * so the min excludes it) from a REAL periodic/per-op allocation (period shorter than a pass -- it
 * elevates BOTH means, so the min still catches it). This is what stops the acceptance probe from
 * false-FAILing a clean kernel ~3/7. Returns { bop, gcFree, scavenged }: gcFree === 0 means a pass had
 * EVERY window scavenged, i.e. sustained allocation (>= a semi-space per window) -- the caller FAILs on
 * that, it is never a silent zero.
 */
export function measureHotBytesPerOp(ctx, stepFn, ops, windows, biasBytes) {
    const p1 = sampleWindows(ctx, stepFn, ops, windows);
    const p2 = sampleWindows(ctx, stepFn, ops, windows);
    const scavenged = p1.scavenged + p2.scavenged;
    // Fail closed if EITHER pass was all-scavenged: report gcFree 0 so the caller's scavengedFail fires.
    if (p1.gcFree === 0 || p2.gcFree === 0) return { bop: null, bopPass1: null, bopPass2: null, gcFree: 0, scavenged };
    const gcFree = p1.gcFree + p2.gcFree;
    // NaN-closed per-op: a non-finite net becomes Infinity (gate FAILs, never a NaN pass); a small
    // negative (under-subtraction) clamps to 0.
    const perOp = (mean) => {
        let net = mean - biasBytes;
        if (!Number.isFinite(net)) return Infinity;
        if (net < 0) net = 0;
        return net / ops;
    };
    // Per-pass B/op is exposed so the caller can apply the CROSS-CYCLE recurrence rule: the MIN (bop)
    // hides a periodic allocation whose period is RARER than one pass (it lands in only one pass per
    // cycle, like a one-off) -- but that allocation RECURS every cycle, so max(pass1,pass2) > bound in
    // >=2 post-warmup cycles catches it while a genuine one-off (once per process) does not.
    const bopPass1 = perOp(meanArr(p1.deltas));
    const bopPass2 = perOp(meanArr(p2.deltas));
    return { bop: Math.min(bopPass1, bopPass2), bopPass1, bopPass2, gcFree, scavenged };
}
