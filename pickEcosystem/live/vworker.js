/**
 * pickEcosystem/live -- VIRTUAL-TIME workers: a lite-worker-pool set-mode transport whose workers run on a
 * clock the caller advances. Used by the deterministic tests (and later as the in-page fallback, "never a
 * blank canvas").
 *
 * Each worker is a FIFO server. A job's service time comes from the same control values the real worker
 * reads (job.js): units / UNITS_PER_MS x slow ms, plus the hang time; a fail-fast job replies flagged; a
 * crash flag kills the worker when its next job starts. `advance(t)` delivers every event due by `t` in time
 * order (READY handshakes, replies, deaths), moving `now()` to each event first, so the code under test sees
 * the right clock inside every callback.
 *
 * Allocation: everything is preallocated per transport (rings of `slots` jobs, one cached view per buffer),
 * so steady-state traffic through it allocates nothing -- the kernel's allocation gate measures the kernel,
 * not this double.
 */

import { CTL_UNITS, CTL_SLOW, CTL_FAIL, CTL_HANG, CTL_CRASH, UNITS_PER_MS, failsAt } from './job.js';

const RING = 8;                       // >= lite-worker-pool's max slots
const FAIL_MSG = Object.freeze({ message: 'fail-fast' });

/**
 * @param {{ startupMs?: number, t0?: number }} [opts]
 * @returns {{ spawn: Function, advance: (t: number) => void, now: () => number, slots: object[] }}
 */
export function createVirtualWorkers(opts) {
    const o = opts || {};
    const startupMs = o.startupMs === undefined ? 5 : o.startupMs;
    let vt = o.t0 === undefined ? 1000 : o.t0;
    const slots = [];                 // slots[index] = the CURRENT transport of worker `index`

    function spawn(spec) {
        const tr = {
            index: spec.index,
            ctl: new Float64Array(5),
            readyAt: vt + startupMs,
            readyDone: false,
            dead: false,
            busyUntil: vt,
            bufs: new Array(RING).fill(null),
            views: new Array(RING).fill(null),
            doneAt: new Float64Array(RING),
            kind: new Uint8Array(RING),       // 0 reply, 1 crash
            head: 0,
            count: 0,
            onRaw: null, onErr: null, onPost: null,
        };
        tr.ctl[CTL_UNITS] = UNITS_PER_MS;
        tr.ctl[CTL_SLOW] = 1;
        slots[spec.index] = tr;
        return {
            send(buf) {
                if (tr.dead) return;
                const view = viewOf(tr, buf);
                const c = tr.ctl;
                const start = vt > tr.busyUntil ? vt : tr.busyUntil;
                const k = (tr.head + tr.count) % RING;
                tr.bufs[k] = buf;
                tr.views[k] = view;
                if (c[CTL_CRASH] > 0) {
                    tr.kind[k] = 1;
                    tr.doneAt[k] = start;
                } else {
                    tr.kind[k] = 0;
                    tr.doneAt[k] = start + c[CTL_HANG] + (c[CTL_UNITS] / UNITS_PER_MS) * c[CTL_SLOW];
                }
                tr.busyUntil = tr.doneAt[k];
                tr.count++;
            },
            onRaw(fn) { tr.onRaw = fn; return () => { tr.onRaw = null; }; },
            onError(fn) { tr.onErr = fn; return () => { tr.onErr = null; }; },
            onPost(fn) { tr.onPost = fn; return () => { tr.onPost = null; }; },
            post(type, data) { if (type === 'lwp:ctl') tr.ctl.set(data.length > 5 ? data.subarray(0, 5) : data); },
            terminate() { tr.dead = true; tr.count = 0; },
        };
    }

    // The slot-local view cache: the set ping-pongs the same `slots` buffers, so each is seen once.
    function viewOf(tr, buf) {
        for (let k = 0; k < RING; k++) if (tr.views[k] !== null && tr.views[k].buffer === buf) return tr.views[k];
        return new Float64Array(buf);
    }

    // The earliest pending event across all workers, or Infinity.
    function nextEvent() {
        let best = Infinity;
        for (let s = 0; s < slots.length; s++) {
            const tr = slots[s];
            if (tr === undefined || tr.dead) continue;
            if (!tr.readyDone && tr.readyAt < best) best = tr.readyAt;
            if (tr.count > 0 && tr.doneAt[tr.head] < best) best = tr.doneAt[tr.head];
        }
        return best;
    }

    function deliverAt(t) {
        for (let s = 0; s < slots.length; s++) {
            const tr = slots[s];
            if (tr === undefined || tr.dead) continue;
            if (!tr.readyDone && tr.readyAt === t) {
                tr.readyDone = true;
                if (tr.onPost !== null) tr.onPost('lwp:ready', null);
                return;
            }
            if (tr.count > 0 && tr.doneAt[tr.head] === t) {
                const k = tr.head;
                tr.head = (tr.head + 1) % RING;
                tr.count--;
                const buf = tr.bufs[k];
                const f = tr.views[k];
                tr.bufs[k] = null;
                if (tr.kind[k] === 1) {
                    tr.dead = true;
                    tr.count = 0;
                    if (tr.onErr !== null) tr.onErr(new Error('virtual worker ' + tr.index + ' crashed'));
                    return;
                }
                if (failsAt(f[1], tr.ctl[CTL_FAIL])) {
                    f[2] = 1;
                    if (tr.onPost !== null) tr.onPost('lwp:terr', FAIL_MSG);
                } else {
                    f[2] = 0;
                    f[1] = f[1] + 1;
                }
                if (tr.onRaw !== null) tr.onRaw(buf);
                return;
            }
        }
    }

    function advance(t) {
        for (;;) {
            const e = nextEvent();
            if (e > t) break;
            if (e > vt) vt = e;
            deliverAt(e);
        }
        if (t > vt) vt = t;
    }

    return { spawn, advance, now: () => vt, slots };
}
