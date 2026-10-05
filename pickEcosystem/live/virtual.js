/**
 * pickEcosystem/live -- boot the kernel over VIRTUAL workers on a virtual clock, and run it (the deterministic
 * mode used by the tests and by tui.mjs --frames).
 * `lp` defaults to the pinned @zakkster/lite-pick; pass the repo's working tree to test it instead (F2).
 */
import * as pinnedLp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { bootKernel } from './kernel.js';
import { createVirtualWorkers } from './vworker.js';

export const flush = () => new Promise((r) => setImmediate(r));

export async function bootVirtual(config, opts) {
    const o = opts || {};
    const hub = createVirtualWorkers();
    let booted = null, failed = null;
    bootKernel({
        lp: o.lp || pinnedLp, poolMod: o.poolMod || poolMod, wp, spawn: hub.spawn, now: hub.now, config,
        later: (fn) => setImmediate(fn),
    }).then((k) => { booted = k; }, (e) => { failed = e; });
    for (let k = 0; k < 200 && booted === null && failed === null; k++) { hub.advance(hub.now() + 1); await flush(); }
    if (failed) throw failed;
    if (booted === null) throw new Error('kernel did not boot');
    const kernel = booted;
    /** Advance the system `ms` virtual milliseconds in 1 ms steps (cron fires on its own cadences). */
    async function run(ms) {
        const end = hub.now() + ms;
        for (let t = Math.floor(hub.now()) + 1; t <= end; t++) {
            hub.advance(t);
            kernel.tick(t);
            if (t % 10 === 0) await flush();
        }
        await flush();
    }
    return { kernel, hub, run };
}
