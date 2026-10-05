/**
 * pickEcosystem/live -- allocation and retention gates (P1 spec). Run with --expose-gc (the npm script does).
 *
 *   A1  engine A's WHOLE steady state -- every 1 ms step: traffic arrivals, picks, posts, replies, feedback,
 *       the 20 Hz fleet tick (health probes, breakers, the eligibility writer), event-bus emits -- allocates
 *       < 8 B per request, measured as an allocation RATE (scavenges at a pinned 1 MB young generation, the
 *       PerfGate method; test/rate-probe.mjs). Measured: 0 scavenges over 1.9M requests (Node 26), 2 one-off
 *       (Node 22). Virtual workers, so Node's MessagePort cost (~1.1-1.4 KB/job, disclosed in
 *       lite-worker-pool) is not in the window.
 *   A2  engine B (/pool + submit) measured the same way and PRINTED (~2.9 KB/request); it must read
 *       > 100 B/request -- the control that proves A1's instrument sees allocation.
 *   R1  1000 supervised kill/respawn cycles: every replaced worker transport is collected (finalization
 *       residual <= 16 beyond the 8 live ones) -- control: pinning them trips the gate.
 *   R2  200 scope rebuilds (reset): every old worker scope is collected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLeakTracker } from '@zakkster/lite-leak';
import { bootVirtual } from './harness.mjs';

const NOOP = function () {};

async function settleHard() {
    for (let i = 0; i < 10; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 15)); }
}

const PROBE = fileURLToPath(new URL('./rate-probe.mjs', import.meta.url));

/** Scavenges between the probe's markers at a pinned 1 MB young generation, and the requests served. */
function rate(mode, steps) {
    const out = execFileSync(process.execPath,
        ['--trace-gc', '--min-semi-space-size=1', '--max-semi-space-size=1', PROBE, mode, String(steps)],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const a = out.indexOf('MARK-A'), b = out.indexOf('MARK-B');
    const scavenges = (out.slice(a, b).match(/Scavenge/g) || []).length;
    const requests = Number(/REQ (\d+)/.exec(out)[1]);
    return { scavenges, requests, bytesPerRequest: (scavenges * 1048576) / requests };
}

test('A1 engine A: the whole steady state allocates < 8 B per request (scavenge count) -- A2 engine B is the control', () => {
    const a = rate('A', 480000);
    process.stderr.write('  engine A: ' + a.scavenges + ' scavenges over ' + a.requests + ' requests (<= ' +
        a.bytesPerRequest.toFixed(2) + ' B/request)\n');
    assert.ok(a.requests > 900000, 'requests in the window: ' + a.requests);
    assert.ok(a.bytesPerRequest < 8, 'engine A allocates ' + a.bytesPerRequest.toFixed(2) + ' B/request');
    const b = rate('B', 30000);
    process.stderr.write('  engine B: ' + b.scavenges + ' scavenges over ' + b.requests + ' requests (~' +
        b.bytesPerRequest.toFixed(0) + ' B/request)\n');
    assert.ok(b.bytesPerRequest > 100, 'the control: engine B must show its per-request allocation');
});

async function killCycles(pin) {
    const { createVirtualWorkers } = await import('../vworker.js');
    const tracker = createLeakTracker({ name: 'pick-ecosystem-respawn' });
    const sink = [];
    const lpOpts = {};
    const { kernel: k, hub, run } = await bootVirtual({ maxRestarts: 100000, restartWindowMs: 1, rate: 200 }, lpOpts);
    const spawn0 = hub.spawn;
    let tag = 0;
    // Track every transport the set builds from here on (respawns).
    k.set._spawn = function (spec) {
        const tr = spawn0(spec);
        tracker.track(tr, NOOP, tag++);
        if (pin) sink.push(tr);
        return tr;
    };
    for (let c = 0; c < 1000; c++) {
        k.fault(c % 8, 'kill');
        await run(60);
    }
    const restarts = Array.from(k.fleet.restarts).reduce((a, b) => a + b, 0);
    await settleHard();
    return { live: tracker.size(), restarts, createVirtualWorkers };
}

test('R1 1000 supervised kill/respawn cycles: every replaced transport is collected -- control: pinned', async () => {
    const r = await killCycles(false);
    assert.equal(r.restarts, 1000);
    assert.ok(r.live <= 8 + 16, 'residual ' + r.live + ' (8 live workers + slack 16)');
    const c = await killCycles(true);
    assert.ok(c.live > 900, 'pinned transports must stay live: ' + c.live);
});

test('R2 200 scope rebuilds: every old worker scope is collected', async () => {
    const tracker = createLeakTracker({ name: 'pick-ecosystem-scopes' });
    const { kernel: k, run } = await bootVirtual({ rate: 200 });
    for (let c = 0; c < 200; c++) {
        const i = c % 8;
        tracker.track(k.fleet.scopes[i], NOOP, c);
        const p = k.reset(i);
        await run(20);
        await p;
    }
    await run(200);
    await settleHard();
    assert.ok(tracker.size() <= 16, 'residual scopes ' + tracker.size());
    assert.deepEqual(Array.from(k.balancers.shared.up), new Array(8).fill(1));
});
