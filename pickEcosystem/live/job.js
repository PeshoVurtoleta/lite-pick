/**
 * pickEcosystem/live -- the job every worker runs, and its control-value layout.
 *
 * `jobFn(item, ctl)` is serialized into each worker thread by lite-worker-pool's createWorkerSet, so it must
 * be self-contained (no closure, no import). `ctl` is that worker's control values (WorkerSet.control): the
 * kernel makes a worker slow, flaky, hung or crashing by changing them -- the fault happens INSIDE the real
 * thread, never faked on the main thread.
 *
 *   ctl[CTL_UNITS] work units per job (busy-loop iterations; UNITS_PER_MS ~ 1 ms on the reference machine)
 *   ctl[CTL_SLOW]  slowdown factor (1 = normal, 10 = the "slow x10" fault)
 *   ctl[CTL_FAIL]  fail-fast rate in [0, 1] (a deterministic hash of the item decides)
 *   ctl[CTL_HANG]  ms to busy-wait before the job (0 = none): the "hang" fault
 *   ctl[CTL_CRASH] > 0: the worker dies on its next job (the "crash" fault). In Node the thread exits
 *                  (process.exit: the transport sees the exit). A Web Worker that calls close() would die
 *                  SILENTLY -- the page gets no event, so it would look hung until the hang limit -- so in a
 *                  browser the job fails and an uncaught error is raised right after: the page's Worker gets
 *                  an `error` event, lite-worker reports it, and the set takes the worker down at once.
 */

export const CTL_UNITS = 0;
export const CTL_SLOW = 1;
export const CTL_FAIL = 2;
export const CTL_HANG = 3;
export const CTL_CRASH = 4;
export const CTL_LEN = 5;

/** Busy-loop iterations per millisecond (measured: Node 26.8, Apple silicon; the scene only needs "about"). */
export const UNITS_PER_MS = 180000;

/** True iff `item`'s hash falls under `rate` -- the same decision the worker and the virtual worker make. */
export function failsAt(item, rate) {
    if (!(rate > 0)) return false;
    const h = Math.imul(item | 0, 0x9e3779b1) >>> 0;
    return h / 4294967296 < rate;
}

/** The worker transform (serialized; keep it self-contained -- failsAt is inlined on purpose). */
export function jobFn(item, ctl) {
    var units = ctl.length > 0 ? ctl[0] : 180000;
    var slow = ctl.length > 1 ? ctl[1] : 1;
    if (ctl.length > 4 && ctl[4] > 0) {
        if (typeof process !== "undefined" && process && typeof process.exit === "function") process.exit(3);
        setTimeout(function () { throw new Error("worker crashed"); }, 0);
        throw new Error("worker crashed");
    }
    if (ctl.length > 3 && ctl[3] > 0) { var t0 = Date.now(); while (Date.now() - t0 < ctl[3]) { /* hang */ } }
    if (ctl.length > 2 && ctl[2] > 0) {
        var h = Math.imul(item | 0, 0x9e3779b1) >>> 0;
        if (h / 4294967296 < ctl[2]) throw new Error("fail-fast");
    }
    var x = item, n = units * slow;
    for (var i = 0; i < n; i++) x = (x * 1.0000001 + 1) % 4294967296;
    return x;
}
