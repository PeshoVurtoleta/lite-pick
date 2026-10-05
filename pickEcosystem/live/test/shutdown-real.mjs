/**
 * pickEcosystem/live -- the P1/P3 shutdown gate over REAL worker_threads (what the terminal and the browser
 * actually run), not the virtual clock. Four scenarios, each with a break control so the gate has teeth:
 *
 *   clean     the orchestrator drains and exits 0; every worker thread is terminated and the cron stops firing.
 *             control: a noop `cron.stop` (+ noop `set.dispose`) -- the cron keeps ticking (MISS).
 *   deadline  a hung shutdown step still ends: exit 2 at the deadline, and the kernel's `halt()` force-terminates
 *             every worker thread (the orchestrator is still blocked on the hung step).
 *             control: a noop `halt` -- the workers stay up at the deadline (MISS).
 *
 * Run: `npm run shutdown:real`. Prints `ok (4 scenarios)` and exits 0 when all four behave; any miss exits 1.
 * HEAD (no `halt`) MISSes the deadline scenario: nothing terminates the workers when a step hangs.
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { bootKernel } from '../kernel.js';
import { nodeSetSpawn } from '../nodeworker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// A spawn wrapper that tracks live worker threads: a transport is live until its terminate() is called
// (idempotent -- kill, dispose and a DEADLINE halt may all fire). live() is the count still up.
function countingSpawn() {
    const liveSet = new Set();
    const spawn = (spec) => {
        const tr = nodeSetSpawn(spec);
        liveSet.add(tr);
        const term = tr.terminate.bind(tr);
        tr.terminate = () => { liveSet.delete(tr); return term(); };
        return tr;
    };
    return { spawn, live: () => liveSet.size };
}

async function boot() {
    const cs = countingSpawn();
    const k = await bootKernel({
        lp, poolMod, wp, spawn: cs.spawn, now, timers: 'real',
        config: { workers: 2, speeds: [1, 1], weights: [1, 1], rate: 500 },
    });
    // Count fleet ticks so we can prove the cron stops once the kernel halts.
    const ticks = { n: 0 };
    const ft = k.fleet.tick.bind(k.fleet);
    k.fleet.tick = (t) => { ticks.n++; return ft(t); };
    return { k, cs, ticks };
}

async function clean(sabotage) {
    const { k, cs, ticks } = await boot();
    await sleep(300);                                   // serve some traffic
    let restore = null;
    if (sabotage) {
        const origStop = k.cron.stop.bind(k.cron);
        k.set.dispose = () => {};
        k.cron.stop = function () { return this; };     // the orchestrator's stop-cron step does nothing
        restore = () => origStop();
    }
    const code = await k.shutdown({ deadlineMs: 5000 });
    ticks.n = 0;
    await sleep(sabotage ? 700 : 400);
    const r = { code, live: cs.live(), ticks: ticks.n };
    if (restore) restore();                             // really stop the (sabotaged) cron before we move on
    return r;
}

async function deadline(sabotage) {
    const { k, cs, ticks } = await boot();
    await sleep(200);
    k.fleet.shutdownSupervisors = () => new Promise(() => {});   // a step that never completes
    if (sabotage) k.halt = () => {};
    const t = now();
    const code = await k.shutdown({ deadlineMs: 1000 });
    const wall = now() - t;
    ticks.n = 0;
    await sleep(sabotage ? 700 : 500);
    const r = { code, live: cs.live(), ticks: ticks.n, wall };
    if (sabotage) { k.cron.stop(); try { k.set.dispose(); } catch { /* ignore */ } }   // cleanup
    return r;
}

function expect(cond, msg) { if (!cond) { console.error('MISS: ' + msg); process.exit(1); } }

const c = await clean(false);
expect(c.code === 0, 'clean exit code ' + c.code + ' (want 0)');
expect(c.live === 0, 'clean left ' + c.live + ' worker threads up (want 0)');
expect(c.ticks === 0, 'clean kept ticking: ' + c.ticks + ' (want 0)');

const cs = await clean(true);
expect(cs.ticks >= 9, 'sabotaged clean should keep ticking, saw ' + cs.ticks);

const d = await deadline(false);
expect(d.code === 2, 'deadline exit code ' + d.code + ' (want 2)');
expect(d.wall < 2000, 'deadline took ' + d.wall.toFixed(0) + ' ms (want < 2000)');
expect(d.live === 0, 'deadline left ' + d.live + ' worker threads up (want 0)');
expect(d.ticks === 0, 'deadline kept ticking: ' + d.ticks + ' (want 0)');

const ds = await deadline(true);
expect(ds.code === 2, 'sabotaged deadline exit code ' + ds.code);
expect(ds.live === 2, 'sabotaged deadline should leave 2 worker threads up, saw ' + ds.live);
expect(ds.ticks >= 9, 'sabotaged deadline should keep ticking, saw ' + ds.ticks);

console.log('ok (4 scenarios)');
process.exit(0);
