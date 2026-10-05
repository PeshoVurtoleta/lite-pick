/**
 * pickEcosystem/live -- the P1 gates (research/capstone-P1-spec.md), over VIRTUAL workers on a virtual clock:
 * every run is deterministic. Each gate has a CONTROL: the same scenario with the mechanism under test turned
 * off by a real configuration knob, which MUST fail the gate's condition.
 *
 *   G1 steady    the default scene serves every request (~2000 req/s), all workers eligible.
 *   G2 kill      a killed worker loses no request (failover), is restarted once by its supervisor and is
 *                eligible again.                                    control: tries 1 -> requests fail.
 *   G3 slow      one worker 10x slower: PeakEWMA's p99 is under half of LeastConn's and a tenth of
 *                RoundRobin's (measured 10.1 / 30.3 / 340 ms).      control: none needed (a comparison).
 *   G4 flaky     a 50%-failing worker trips its breaker (ineligible) with no failed request; after healing,
 *                a HalfOpen probe closes it.                         control: breaker off -> never opens.
 *   G5 hang      a hung job makes the worker ineligible within 600 ms and it is respawned by ~1.1 s, no
 *                failed request.                                     control: hang limits off -> stays eligible.
 *   G6 crash loop  5 restarts, then ESCALATED: ineligible, no failed request; reset(i) brings it back.
 *                                                                    control: a huge budget -> never escalates.
 *   G7 shutdown  the orchestrator drains: no admissions, every in-flight request settles, exit code 0,
 *                every worker gone.
 *   G8 switch    cycling all ten strategies under load conserves inflight (BoundedLoad's total stays in
 *                lockstep: assertConsistent), and every count returns to 0 at quiescence.
 *   G9 engine B  the /pool engine serves the same scene and survives a kill.
 *   G10 F2       the repo's WORKING-TREE lite-pick passes G1 + G2 (a kernel change cannot silently break the
 *                capstone).
 *   G11 deadline a shutdown step that hangs still ends: shutdown() resolves with DEADLINE (2) at the deadline
 *                (the orchestrator calls exit(2) while its own promise waits for the hung step).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as treeLp from '../../../Pick.js';
import * as treePool from '../../../Pool.js';
import { bootVirtual } from './harness.mjs';
import { STRATEGIES, ENGINE_B } from '../kernel.js';

const W = 8;
const sum = (a) => a.reduce((x, y) => x + y, 0);

async function scKill(config, opts) {
    const { kernel: k, run } = await bootVirtual(config, opts);
    await run(500);
    k.fault(2, 'kill');
    await run(1500);
    const s = k.stats.snapshot();
    return { failed: s.failed, failover: s.failover, restarts: k.fleet.restarts[2], up: k.balancers.shared.up[2], ok: s.ok, served2: s.perOk[2] };
}
const killPasses = (r) => r.failed === 0 && r.failover > 0 && r.restarts === 1 && r.up === 1;

async function scSlowP99(strategy) {
    const { kernel: k, run } = await bootVirtual({ strategy });
    await run(1000);
    k.fault(3, 'slow');
    await run(3000);
    return k.stats.p99;
}

async function scFlaky(config) {
    const { kernel: k, run } = await bootVirtual(config);
    await run(500);
    k.fault(1, 'flaky');
    await run(1000);
    const mid = { b: k.fleet.bState[1], up: k.balancers.shared.up[1], failed: k.stats.c[2] };
    k.heal(1);
    await run(3000);
    return { mid, end: { b: k.fleet.bState[1], up: k.balancers.shared.up[1], failed: k.stats.c[2] } };
}

async function scHang(config) {
    const { kernel: k, run } = await bootVirtual(config);
    await run(500);
    k.fault(4, 'hang');
    await run(600);
    const upAt600 = k.balancers.shared.up[4];
    await run(1500);
    return { upAt600, restarts: k.fleet.restarts[4], upEnd: k.balancers.shared.up[4], failed: k.stats.c[2] };
}

async function scCrashLoop(config) {
    const { kernel: k, run } = await bootVirtual(config);
    await run(500);
    k.fault(5, 'crashloop');
    await run(5000);
    const r = { escalated: k.fleet.escalated[5], up: k.balancers.shared.up[5], restarts: k.fleet.restarts[5], failed: k.stats.c[2] };
    return { r, k, run };
}

test('G1 steady: the default scene serves every request', async () => {
    const { kernel: k, run } = await bootVirtual();
    await run(3000);
    const s = k.stats.snapshot();
    assert.deepEqual(Array.from(k.balancers.shared.up), new Array(W).fill(1));
    assert.equal(s.failed, 0);
    assert.equal(s.shed, 0);
    assert.equal(s.ok + k.engine.pending(), s.arrived);
    assert.ok(s.rate > 1800 && s.rate < 2200, 'rate ' + s.rate);
    assert.ok(s.p99 < 20, 'p99 ' + s.p99);
});

test('G2 kill: no request lost, restarted once, eligible again -- control: tries 1 loses requests', async () => {
    const r = await scKill();
    assert.ok(killPasses(r), JSON.stringify(r));
    const c = await scKill({ tries: 1 });
    assert.ok(c.failed > 0 && !killPasses(c), 'without failover the kill must lose requests: ' + JSON.stringify(c));
});

test('G3 slow: PeakEWMA keeps the tail low where LeastConn and RoundRobin do not', async () => {
    const pe = await scSlowP99('peakewma');
    const lc = await scSlowP99('leastconn');
    const rr = await scSlowP99('roundrobin');
    assert.ok(pe < lc / 2, `PeakEWMA p99 ${pe} vs LeastConn ${lc}`);
    assert.ok(pe < rr / 10, `PeakEWMA p99 ${pe} vs RoundRobin ${rr}`);
});

test('G4 flaky: the breaker opens with no failed request, and closes after healing -- control: breaker off', async () => {
    const r = await scFlaky();
    assert.equal(r.mid.b, 1, 'breaker OPEN');
    assert.equal(r.mid.up, 0, 'ineligible while open');
    assert.equal(r.mid.failed, 0, 'failover covered every failed attempt');
    assert.equal(r.end.b, 0, 'closed again after a HalfOpen probe');
    assert.equal(r.end.up, 1);
    const c = await scFlaky({ breakerFailures: 1e9 });
    assert.notEqual(c.mid.b, 1, 'with the breaker off it never opens');
});

test('G5 hang: ineligible within 600 ms, respawned, no failed request -- control: hang limits off', async () => {
    const r = await scHang();
    assert.equal(r.upAt600, 0);
    assert.equal(r.restarts, 1);
    assert.equal(r.upEnd, 1);
    assert.equal(r.failed, 0);
    const c = await scHang({ hungMs: 1e9, hungKillMs: 1e9 });
    assert.equal(c.upAt600, 1, 'without hang detection the hung worker stays eligible');
    assert.equal(c.restarts, 0);
});

test('G6 crash loop: escalated after 5 restarts, kept out, reset brings it back -- control: huge budget', async () => {
    const { r, k, run } = await scCrashLoop();
    assert.equal(r.restarts, 5);
    assert.equal(r.escalated, 1);
    assert.equal(r.up, 0);
    assert.equal(r.failed, 0);
    const before = k.stats.perOk[5];
    const p = k.reset(5);
    await run(200);
    await p;
    await run(500);
    assert.equal(k.balancers.shared.up[5], 1, 'eligible after reset');
    assert.ok(k.stats.perOk[5] > before, 'serving again');
    const c = await scCrashLoop({ maxRestarts: 1000 });
    assert.equal(c.r.escalated, 0, 'with a huge budget it never escalates');
});

test('G7 shutdown: drain, settle every in-flight request, exit 0, workers gone', async () => {
    const { kernel: k, run } = await bootVirtual();
    await run(1000);
    for (let j = 0; j < 20 && k.engine.pending() === 0; j++) await run(1);
    const inFlight = k.engine.pending();
    assert.ok(inFlight > 0, 'requests in flight when shutdown starts');
    let code = null;
    k.shutdown({ deadlineMs: 5000 }).then((c) => { code = c; });
    for (let j = 0; j < 400 && code === null; j++) await run(5);
    assert.equal(code, 0, 'EXITS.OK');
    assert.equal(k.engine.pending(), 0, 'all ' + inFlight + ' in-flight requests settled');
    assert.equal(k.stats.c[2], 0, 'nothing failed');
    assert.equal(k.engine.request(1), false, 'no admission after drain');
    for (let i = 0; i < W; i++) assert.equal(k.set.isReady(i), false);
});

test('G8 switch: all ten strategies under load conserve inflight; quiescence returns everything to 0', async () => {
    const { kernel: k, run } = await bootVirtual();
    await run(300);
    for (let round = 0; round < 2; round++) {
        for (const name of STRATEGIES) {
            k.setStrategy(name);
            k.balancers.lb.assertConsistent();
            await run(150);
            k.balancers.lb.assertConsistent();
        }
    }
    k.traffic.stop();
    await run(2000);
    const s = k.stats.snapshot();
    assert.equal(sum(Array.from(k.balancers.shared.inflight)), 0);
    assert.equal(k.engine.pending(), 0);
    assert.equal(s.ok + s.failed + s.shed + s.drained, s.arrived);
    assert.equal(s.failed, 0);
});

test('G9 engine B (/pool + submit) serves the scene and survives a kill', async () => {
    const { kernel: k, run } = await bootVirtual();
    k.setEngine(ENGINE_B);
    await run(1000);
    k.fault(2, 'kill');
    await run(1500);
    const s = k.stats.snapshot();
    assert.equal(s.failed, 0);
    assert.equal(k.fleet.restarts[2], 1);
    assert.equal(k.balancers.shared.up[2], 1);
    assert.ok(s.ok > 4000);
});

test('G10 (F2): the working-tree lite-pick passes G1 + G2', async () => {
    const opts = { lp: treeLp, poolMod: treePool };
    const r = await scKill(undefined, opts);
    assert.ok(killPasses(r), JSON.stringify(r));
    const { kernel: k, run } = await bootVirtual(undefined, opts);
    await run(2000);
    assert.equal(k.stats.c[2], 0);
    assert.equal(k.stats.snapshot().ok + k.engine.pending(), k.stats.c[0]);
});

test('G11 a hung shutdown step still ends: shutdown() resolves with DEADLINE (2) at the deadline', async () => {
    const { kernel: k, run } = await bootVirtual();
    await run(200);
    k.fleet.shutdownSupervisors = () => new Promise(() => {});      // a step that never completes
    const t = performance.now();
    const code = await k.shutdown({ deadlineMs: 150 });
    assert.equal(code, 2, 'DEADLINE');
    assert.ok(performance.now() - t < 2000, 'resolved at the deadline, not never');
});
