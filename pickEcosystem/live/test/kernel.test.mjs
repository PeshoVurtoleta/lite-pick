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
 *   G8 switch    for BOTH engines: cycling all ten strategies under load conserves inflight (BoundedLoad's
 *                total stays in lockstep: assertConsistent), a key routes to one endpoint after switching to
 *                ConsistentHash (affinity survives the switch), and every count returns to 0 at quiescence.
 *                control: HEAD's engine B pins /pool to the old balancer (INCONSISTENT at quiesce); the M15
 *                kernel switch without rebindPool loses key affinity (one key spreads across endpoints).
 *   G9 engine B  the /pool engine serves the same scene and survives a kill.
 *   G10 F2       the repo's WORKING-TREE lite-pick passes G1 + G2 (a kernel change cannot silently break the
 *                capstone).
 *   G11 shutdown halts  a clean shutdown (exit 0) and a hung-step DEADLINE (2) BOTH halt the kernel: no cron
 *                tick fires afterwards and every worker is gone / force-terminated.  control (each): a noop
 *                `halt` keeps the workers up and the cron ticking.
 *   G12 lost probe  a worker that CRASHES on its HalfOpen probe (a no-verdict reply) does not strand itself
 *                ineligible: the probe is released, the supervisor restarts it, the next probe closes the
 *                breaker.  control: HEAD / the mutant leave it stuck HalfOpen (bState 2, up 0).
 *   G13 admission  for BOTH engines, a 5x overload (34000 req/s, 5x the ~6833 virtual capacity) sheds the
 *                excess (shed > 0) with NO failed request and NO breaker event -- the overload is refused, not
 *                mistaken for a fault; at half capacity (3400 req/s) nothing is shed.  control: HEAD (no
 *                admission, no capacity classification) turns the overload into failed requests.
 *   Boundary cases (final QA): G11 halt (duplicate / nested halt a no-op, halted only after dispose, a throwing
 *                dispose does not latch -- controls: no try/finally, halted-before-dispose, HEAD); G13 admission
 *                at exactly capacity (cap-1 admits, cap sheds -- control: `>` for `>=`, HEAD); live 0 -> 1 under
 *                overload (control: the pre-fix admission without `live !== 0`, HEAD); strategy + engine switches
 *                under overload (control: HEAD); calibrate.js capacity vs measured saturation (control: an
 *                estimate that ignores speed, HEAD).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as treeLp from '../../../Pick.js';
import * as treePool from '../../../Pool.js';
import { bootVirtual } from './harness.mjs';
import { STRATEGIES, ENGINE_A, ENGINE_B, EV_BREAKER } from '../kernel.js';
import { B_CLOSED, B_OPEN, B_HALF } from '../fleet.js';
import { S_OK, S_FAILED, S_SHED, S_DRAINED } from '../stats.js';
import { estimateCapacity, measureThroughput } from '../calibrate.js';

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

// G8 body, run once per engine: cycle all ten strategies under load (counts conserved every step), then a
// key-affinity probe on ConsistentHash (the forwarder must route by key after the switch -- M15, the kernel
// switch without rebindPool, strands engine B on the previous channel and fails this), then a switch to
// BoundedLoad while requests are in flight (its owned total is seeded from inflight at the switch; the
// forwarder's note(-1) must reach the CURRENT balancer or the seeded total never drains -- HEAD's engine B,
// which pins /pool to the old balancer, leaves it INCONSISTENT at quiescence).
async function g8(k, run, engineMode) {
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    await run(300);
    for (let round = 0; round < 2; round++) {
        for (const name of STRATEGIES) {
            k.setStrategy(name);
            k.balancers.lb.assertConsistent();
            await run(150);
            k.balancers.lb.assertConsistent();
        }
    }

    // --- key-affinity probe: one key, one endpoint (keyed pick survives the switch) -----------------
    k.setStrategy('consistenthash');
    k.traffic.admitting = false;
    for (let j = 0; j < 400 && k.engine.pending() > 0; j++) await run(5);   // quiesce so 32 fit one worker
    assert.equal(k.engine.pending(), 0, 'drained before the affinity probe');
    const seen = new Set();
    const od = k.fleet.onDispatch.bind(k.fleet);
    k.fleet.onDispatch = (i) => { seen.add(i); return od(i); };
    for (let q = 0; q < 32; q++) k.engine.request(0x1234567);
    await run(20);
    k.fleet.onDispatch = od;
    assert.equal(seen.size, 1, 'one key routes to exactly one endpoint, seen=' + JSON.stringify([...seen]));

    // --- switch to BoundedLoad with requests in flight, then quiesce ---------------------------------
    k.traffic.admitting = true;
    for (let j = 0; j < 400 && sum(Array.from(k.balancers.shared.inflight)) === 0; j++) await run(1);
    assert.ok(sum(Array.from(k.balancers.shared.inflight)) > 0, 'in flight before the BoundedLoad switch');
    k.setStrategy('boundedload');
    k.traffic.stop();
    await run(2000);
    const s = k.stats.snapshot();
    k.balancers.lb.assertConsistent();
    assert.equal(k.balancers.lb.describe().total, 0, 'BoundedLoad noted total back to 0');
    assert.equal(sum(Array.from(k.balancers.shared.inflight)), 0);
    assert.equal(k.engine.pending(), 0);
    assert.equal(s.ok + s.failed + s.shed + s.drained, s.arrived);
    assert.equal(s.failed, 0);
}

// G8-B teeth, engine B only -- the per-Pool FORWARDER's three load-bearing properties, each with a mutant
// that passes the cycle + affinity probe above but is caught here:
//   (a) `constructor: lb.constructor` -- the forwarder carries the strategy's static KEYED/LATENCY markers,
//       so Pool keeps its fail-closed key/clock checks. mA (drop the field) leaves the Pool unmarked -> a
//       keyed/latency run is admitted with no key/clock.
//   (b) `recordRtt` guarded by `bal.latency` -- a PeakEWMA run settling AFTER a switch to a non-latency
//       strategy must NOT forward recordRtt to the current balancer (which has no such method). mF (drop the
//       guard) throws LITE_PICK_FEEDBACK on that settle -> a failure that never happened.
//   (c) `pick` fails closed on STALE eligibility -- a run in flight on the pre-switch Pool fails over by the
//       CURRENT eligibility (shared.up), not lb0's frozen copy. The pre-fix forwarder (`return lb.pick(a)`)
//       hands a failover to a worker the fleet has since marked down.
async function g8ForwarderMarkers() {
    const { kernel: k } = await bootVirtual();
    k.setEngine(ENGINE_B);
    k.setStrategy('consistenthash');
    await assert.rejects(k.engine.pool.run(() => 0),
        (e) => e && e.code === 'LITE_PICK_KEY_REQUIRED',
        'consistenthash forwarder requires a key (the strategy marker survives the forwarder)');
    k.setStrategy('peakewma');
    await assert.rejects(k.engine.pool.run(() => 0),
        (e) => e && e.code === 'LITE_PICK_CLOCK_REQUIRED',
        'peakewma forwarder requires a clock (the strategy marker survives the forwarder)');
}

async function g8ForwarderLatencySwitch() {
    const { kernel: k, run } = await bootVirtual();
    k.setEngine(ENGINE_B);
    k.setStrategy('peakewma');
    for (let j = 0; j < 400 && sum(Array.from(k.balancers.shared.inflight)) === 0; j++) await run(1);
    assert.ok(sum(Array.from(k.balancers.shared.inflight)) > 0, 'in flight before switching away from peakewma');
    const failedBefore = k.stats.c[2];
    k.setStrategy('roundrobin');            // latency -> non-latency with runs still settling on the old forwarder
    k.traffic.stop();
    await run(500);
    assert.equal(k.stats.c[2] - failedBefore, 0, 'a peakewma run settling after the switch must not fail (recordRtt guarded by bal.latency)');
    assert.equal(sum(Array.from(k.balancers.shared.inflight)), 0, 'quiesced after the latency switch');
}

// mP: `pick` forwards to the CURRENT bal.lb instead of the pinned lb0. Pool reads the KEYED/LATENCY markers
// ONCE per run off the forwarder's constructor (= lb0's). A keyed run (consistenthash) that fails over AFTER a
// switch to peakewma still has useKey=true, so Pool drives `pick(key)` -- and mP routes that to the NEW
// peakewma balancer, which reads the ROUTING KEY as its `now` clock argument (D2 (b)/(c): a nonsense time far
// below the real clock). The fix keeps the pick pinned to lb0 (consistenthash), so the new peakewma balancer
// is never handed a key as a clock.
async function g8ForwarderKeyedLatencyPick() {
    const key = 0x1234567;
    const { kernel: k, run } = await bootVirtual();
    k.setEngine(ENGINE_B);
    k.setStrategy('consistenthash');
    await run(300);                                      // warm up: workers come up (shared.up set) before we probe
    k.traffic.admitting = false;
    for (let j = 0; j < 400 && k.engine.pending() > 0; j++) await run(5);   // quiesce: control the one probe run
    const os = k.set.submit.bind(k.set);
    let failFirst = true;                                // fail ONLY attempt 0 so the probe run fails over once
    k.set.submit = (i, seq, o) => failFirst
        ? (failFirst = false, os(i, seq, o).then(() => { const e = new Error('x'); e.code = 'X'; throw e; }))
        : os(i, seq, o);
    // Count attempts (onDispatch fires once per placed attempt): the fix leaves args empty, so without an
    // independent proof the re-pick actually happened the assertion below could pass VACUOUSLY. A failover means
    // >= 2 dispatches for this one request.
    let dispatches = 0;
    const od = k.fleet.onDispatch.bind(k.fleet);
    k.fleet.onDispatch = (i) => { dispatches++; return od(i); };
    k.engine.request(key);                               // dispatches on the consistenthash pool (lb0)
    k.setStrategy('peakewma');                           // switch WHILE the keyed run is in flight on the old pool
    const peak = k.balancers.lb;
    const args = [];
    const origPick = peak.pick.bind(peak);
    peak.pick = (a) => { args.push(a); return origPick(a); };
    await run(100);                                      // attempt 0 settles and the failover re-pick fires here
    k.set.submit = os;
    peak.pick = origPick;
    k.fleet.onDispatch = od;
    assert.ok(dispatches >= 2, 'the failover re-pick actually fired (dispatches=' + dispatches + ')');
    assert.ok(!args.includes(key),
        'the new peakewma balancer is never handed the routing key as a clock reading (args=' + JSON.stringify(args) + ')');
    // Every argument peakewma DOES see must be a clock reading (now x 1e6 ns), orders of magnitude above the key.
    for (const a of args) assert.ok(a > key, 'peakewma pick arg looks like a key, not a clock: ' + a);
}

async function g8ForwarderStaleFailover() {
    const X = 5;
    const { kernel: k, run } = await bootVirtual();
    k.setEngine(ENGINE_B);
    k.setStrategy('roundrobin');
    await run(300);
    k.traffic.stop();
    for (let j = 0; j < 400 && k.engine.pending() > 0; j++) await run(5);
    k.fleet.tick = () => {};                 // freeze the single eligibility writer: X stays down once set
    // Every worker but X fails its attempt, so a run that first lands off X must fail over somewhere.
    const os = k.set.submit.bind(k.set);
    k.set.submit = (i, seq, o) => i === X ? os(i, seq, o)
        : os(i, seq, o).then(() => { const e = new Error('t'); e.code = 'T'; throw e; });
    for (let q = 0; q < 24; q++) k.engine.request(q);
    for (let j = 0; j < 50 && k.engine.pending() === 0; j++) await run(1);
    const pend = k.engine.pending();
    k.setStrategy('roundrobin');            // switch -> a NEW pool; the in-flight runs stay on the old forwarder
    k.balancers.setEligible(X, false);      // X goes down AFTER the switch (lb0 of the old pool never hears it)
    let bad = 0;
    const od = k.fleet.onDispatch.bind(k.fleet);
    k.fleet.onDispatch = (i) => { if (i === X && k.balancers.shared.up[X] === 0) bad++; return od(i); };
    await run(300);
    k.fleet.onDispatch = od;
    k.set.submit = os;
    assert.ok(pend > 0, 'requests in flight at the switch');
    assert.equal(bad, 0, 'no failover to a worker the fleet marked down after the switch, bad=' + bad);
}

test('G8 switch: strategies conserve inflight, key affinity survives the switch, quiescence returns to 0', async (t) => {
    await t.test('engine A', async () => {
        const { kernel: k, run } = await bootVirtual();
        await g8(k, run, ENGINE_A);
    });
    await t.test('engine B', async () => {
        const { kernel: k, run } = await bootVirtual();
        await g8(k, run, ENGINE_B);
    });
    await t.test('engine B forwarder markers (mA)', g8ForwarderMarkers);
    await t.test('engine B forwarder latency switch (mF)', g8ForwarderLatencySwitch);
    await t.test('engine B forwarder keyed->latency failover pick (mP)', g8ForwarderKeyedLatencyPick);
    await t.test('engine B forwarder stale-eligibility failover (stale pick)', g8ForwarderStaleFailover);
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

// A counter wired over fleet.tick, so a test can prove the cron stops firing once the kernel halts.
function countTicks(k) {
    const box = { n: 0 };
    const ft = k.fleet.tick.bind(k.fleet);
    k.fleet.tick = (now) => { box.n++; return ft(now); };
    return box;
}
const liveWorkers = (hub) => hub.slots.filter((t) => t && !t.dead).length;

test('G11 clean: orchestrator exits 0, every worker gone, the cron stops -- control: a noop halt keeps ticking', async () => {
    {
        const { kernel: k, hub, run } = await bootVirtual();
        await run(1000);
        for (let j = 0; j < 20 && k.engine.pending() === 0; j++) await run(1);
        assert.ok(k.engine.pending() > 0, 'in flight at shutdown');
        const ticks = countTicks(k);
        let code = null;
        k.shutdown({ deadlineMs: 5000 }).then((c) => { code = c; });
        for (let j = 0; j < 400 && code === null; j++) await run(5);
        assert.equal(code, 0, 'EXITS.OK');
        assert.equal(k.engine.pending(), 0, 'all in-flight settled');
        ticks.n = 0;
        await run(500);
        assert.equal(liveWorkers(hub), 0, 'every worker gone');
        assert.equal(ticks.n, 0, 'no fleet tick after halt');
    }
    // control: a noop halt leaves the cron ticking (the clean exit still disposes the set via teardown).
    {
        const { kernel: k, run } = await bootVirtual();
        await run(1000);
        k.halt = () => {};
        const ticks = countTicks(k);
        let code = null;
        k.shutdown({ deadlineMs: 5000 }).then((c) => { code = c; });
        for (let j = 0; j < 400 && code === null; j++) await run(5);
        assert.equal(code, 0);
        ticks.n = 0;
        await run(500);
        assert.ok(ticks.n >= 9, 'a noop halt keeps the cron ticking: ' + ticks.n);
    }
});

test('G11 deadline: a hung step exits 2 at the deadline, workers force-terminated, cron stops -- control: noop halt', async () => {
    {
        const { kernel: k, hub, run } = await bootVirtual();
        await run(200);
        k.fleet.shutdownSupervisors = () => new Promise(() => {});      // a step that never completes
        const ticks = countTicks(k);
        const t = performance.now();
        const code = await k.shutdown({ deadlineMs: 150 });
        assert.equal(code, 2, 'DEADLINE');
        assert.ok(performance.now() - t < 2000, 'resolved at the deadline, not never');
        ticks.n = 0;
        await run(500);
        assert.equal(liveWorkers(hub), 0, 'workers force-terminated at the deadline');
        assert.equal(ticks.n, 0, 'halted: no fleet tick after the deadline');
        assert.equal(k.engine.pending(), 0, 'in-flight failed (LWP_DISPOSED)');
    }
    // control: a noop halt leaves the hung-step kernel with its workers up and the cron ticking.
    {
        const { kernel: k, hub, run } = await bootVirtual();
        await run(200);
        k.fleet.shutdownSupervisors = () => new Promise(() => {});
        k.halt = () => {};
        const ticks = countTicks(k);
        const code = await k.shutdown({ deadlineMs: 150 });
        assert.equal(code, 2);
        ticks.n = 0;
        await run(500);
        assert.equal(liveWorkers(hub), W, 'noop halt: workers stay up at the deadline');
        assert.ok(ticks.n >= 9, 'noop halt: the cron keeps ticking: ' + ticks.n);
    }
});

// A worker that crashes on its HalfOpen probe: the probe reply is LWP_WORKER_DOWN (no verdict). The breaker
// must release the probe and stay HalfOpen; the supervisor restarts the worker; the next probe closes it.
async function scLostProbe(engineMode) {
    const { kernel: k, hub, run } = await bootVirtual();
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    await run(500);
    k.fault(1, 'flaky');
    let waited = 0;
    while (k.fleet.bState[1] !== B_OPEN && waited < 3000) { await run(10); waited += 10; }
    assert.equal(k.fleet.bState[1], B_OPEN, 'breaker tripped OPEN by the flaky worker');
    // The breaker trips immediately but eligibility is only written on the next fleet tick, so wait until
    // worker 1 is actually ineligible (up 0) AND its queue has drained -- then the crash we arm next can only
    // be consumed by the HalfOpen PROBE, not by traffic still in flight to it.
    let drain = 0;
    while ((k.balancers.shared.up[1] !== 0 || k.set.load(1) > 0) && drain < 1000) { await run(10); drain += 10; }
    assert.equal(k.balancers.shared.up[1], 0, 'worker 1 ineligible (OPEN) before arming the crash');
    assert.equal(k.set.load(1), 0, 'worker 1 drained before the probe is armed');
    k.heal(1);                 // clear the flaky fault ...
    k.fault(1, 'crash');       // ... but the HalfOpen probe will crash the worker
    let lostProbe = -1;
    const orig = k.fleet.onResult.bind(k.fleet);
    k.fleet.onResult = function (i, ok, code) {
        if (lostProbe < 0 && i === 1 && !ok && code === 'LWP_WORKER_DOWN' && k.fleet.bState[1] === B_HALF) lostProbe = hub.now();
        return orig(i, ok, code);
    };
    let close = -1, w2 = 0, reopened = 0;
    while (w2 < 6000) {
        await run(10); w2 += 10;
        if (lostProbe >= 0 && k.fleet.bState[1] === B_OPEN) reopened++;   // a probeFail verdict would land here for a full cool-down
        if (k.fleet.bState[1] === B_CLOSED && k.balancers.shared.up[1] === 1) { close = hub.now(); break; }
    }
    const s = k.stats.snapshot();
    return {
        lostProbe, close, reopened, coolMs: k.fleet.cfg.breakerCoolMs, restarts: k.fleet.restarts[1], escalated: k.fleet.escalated[1],
        failed: s.failed, bState: k.fleet.bState[1], up: k.balancers.shared.up[1],
    };
}

async function scOverload(engineMode, rate, ms) {
    const { kernel: k, run } = await bootVirtual({ rate });
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    await run(ms);
    const s = k.stats.snapshot();
    return { arrived: s.arrived, ok: s.ok, failed: s.failed, shed: s.shed, breaker: k.events[EV_BREAKER], restarts: sum(Array.from(k.fleet.restarts)) };
}

for (const [label, mode] of [['engine A', ENGINE_A], ['engine B', ENGINE_B]]) {
    test('G13 admission (' + label + '): a 5x overload sheds with no failure or breaker event; half capacity sheds nothing', async () => {
        const over = await scOverload(mode, 34000, 2000);   // 5x the ~6833 req/s virtual capacity
        assert.ok(over.shed > 0, 'the overload was shed: ' + JSON.stringify(over));
        assert.equal(over.failed, 0, 'no overload request was mistaken for a failure: ' + JSON.stringify(over));
        assert.equal(over.breaker, 0, 'the overload tripped no breaker: ' + JSON.stringify(over));
        assert.equal(over.restarts, 0, 'the overload restarted no worker: ' + JSON.stringify(over));
        assert.ok(over.ok >= 12300, 'the admitted share still served the scene: ok ' + over.ok);
        const under = await scOverload(mode, 3400, 2000);   // half capacity: headroom, nothing shed
        assert.equal(under.shed, 0, 'half capacity sheds nothing: ' + JSON.stringify(under));
        assert.equal(under.failed, 0, 'half capacity fails nothing: ' + JSON.stringify(under));
    });
}

// G13 outage: a WHOLE-FLEET outage (live 0) is not capacity -- every arrival must be a real failure, never a
// disguised shed (pre-fix admission `pending >= 0 * slotCap` shed them all, hiding the outage).
async function scOutage(engineMode) {
    const { kernel: k, run } = await bootVirtual({ rate: 2000 });
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    k.fleet.tick = () => {};                              // freeze the eligibility writer: the fleet stays down
    await run(500);
    const f0 = k.stats.c[2], s0 = k.stats.c[4];
    for (let i = 0; i < W; i++) k.balancers.setEligible(i, false);   // live -> 0
    await run(200);
    return { failed: k.stats.c[2] - f0, shed: k.stats.c[4] - s0, live: k.balancers.lb.live };
}

// G13 ran-and-failed under overload: a request that RAN and failed (crash), then met a full queue on failover,
// is a FAILURE, not a shed. The must-fail control is ENGINE B: pre-fix it classed on the final LWP_QUEUE_FULL
// only -> S_FAILED 0 (the `ran` flag now records a non-capacity attempt failure). ENGINE A had no such bug --
// its rRan/rCap already classed a ran-and-failed request S_FAILED -- so the engine-A subtest is a REGRESSION
// GUARD (no failing mutant), not a tooth.
async function scOverloadFault(engineMode) {
    const { kernel: k, run } = await bootVirtual({ rate: 34000 });
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    await run(500);
    const f0 = k.stats.c[2];
    k.fault(5, 'crash');
    await run(1500);
    return { failed: k.stats.c[2] - f0 };
}

for (const [label, mode] of [['engine A', ENGINE_A], ['engine B', ENGINE_B]]) {
    test('G13 outage (' + label + '): a whole-fleet outage fails requests, never sheds them', async () => {
        const r = await scOutage(mode);
        assert.equal(r.live, 0, 'the fleet is down (live 0): ' + JSON.stringify(r));
        assert.ok(r.failed > 0, 'arrivals during the outage are real failures: ' + JSON.stringify(r));
        assert.equal(r.shed, 0, 'an outage is not shed as capacity: ' + JSON.stringify(r));
    });
    test('G13 ran-and-failed (' + label + '): an overload fault surfaces ran-and-failed requests as failures', async () => {
        const r = await scOverloadFault(mode);
        assert.ok(r.failed > 0, 'a ran-and-failed request under overload is S_FAILED, not a disguised shed: ' + JSON.stringify(r));
    });
}

for (const [label, mode] of [['engine A', ENGINE_A], ['engine B', ENGINE_B]]) {
    test('G12 lost probe (' + label + '): a crash-on-probe is released, restarted, and closes', async () => {
        const r = await scLostProbe(mode);
        assert.ok(r.lostProbe >= 0, 'the probe crashed the worker (LWP_WORKER_DOWN while HalfOpen): ' + JSON.stringify(r));
        assert.ok(r.close >= 0, 'the breaker closed again (not stuck HalfOpen): ' + JSON.stringify(r));
        // No verdict on a lost probe (D1): the breaker must NOT go back to Open and sit out another cool-down.
        // A probeFail design closes at ~cool-down + 2 ticks (~2100 ms); the release closes in ~150 ms.
        assert.equal(r.reopened, 0, 'the lost probe sent the breaker back to OPEN: ' + JSON.stringify(r));
        assert.ok(r.close - r.lostProbe < r.coolMs, 'closed within one cool-down of the lost probe: ' + (r.close - r.lostProbe));
        assert.equal(r.restarts, 1, 'the supervisor restarted it exactly once');
        assert.equal(r.escalated, 0, 'no escalation');
        assert.equal(r.failed, 0, 'no failed request (failover covered every attempt)');
        assert.equal(r.bState, B_CLOSED);
        assert.equal(r.up, 1);
    });
}

// ---- boundary cases (session-3 final QA) ------------------------------------------------------------------
// halt(): the kernel's new STOP entry point. Duplicate halt is a no-op (set disposed ONCE); a NESTED halt
// during set.dispose() is a no-op and `halted` is still false while dispose runs (published only after it
// returns -- the page gates Reboot on it); in-flight requests at halt all settle (none stranded, counts
// conserved) and a request after halt is DRAINED, not admitted. A throwing dispose must not latch: `_halting`
// clears in finally, `halted` stays false, and a retry halts for real. Must-fail: kernel.js without the
// try/finally (a retry is a silent no-op) and with `halted` set before dispose (B2 nit).
test('G11 halt boundaries: duplicate / nested halt is a no-op, halted only after dispose, in-flight settles, a throwing dispose does not latch', async () => {
    {
        const { kernel: k, hub, run } = await bootVirtual();
        await run(500);
        for (let j = 0; j < 20 && k.engine.pending() === 0; j++) await run(1);
        const inFlight = k.engine.pending();
        assert.ok(inFlight > 0, 'requests in flight at halt');
        const d0 = k.set.dispose.bind(k.set);
        let disposes = 0, haltedDuring = null;
        k.set.dispose = () => { disposes++; haltedDuring = k.halted; k.halt(); return d0(); };
        k.halt();
        assert.equal(disposes, 1, 'a nested halt during dispose did not re-enter dispose');
        assert.equal(haltedDuring, false, 'halted is published only AFTER set.dispose() returns');
        assert.equal(k.halted, true);
        k.halt();
        k.halt();
        assert.equal(disposes, 1, 'a duplicate halt is a no-op');
        const ticks = countTicks(k);
        await run(500);
        assert.equal(ticks.n, 0, 'no fleet tick after halt');
        assert.equal(liveWorkers(hub), 0, 'every worker gone');
        assert.equal(k.engine.pending(), 0, 'all ' + inFlight + ' in-flight requests settled (none stranded)');
        const dr0 = k.stats.c[S_DRAINED];
        assert.equal(k.engine.request(1), false, 'no admission after halt');
        assert.equal(k.stats.c[S_DRAINED] - dr0, 1, 'a post-halt arrival is DRAINED');
        const s = k.stats.snapshot();
        assert.equal(s.ok + s.failed + s.shed + s.drained, s.arrived, 'every arrival accounted for: ' + JSON.stringify(s));
    }
    {
        const { kernel: k, hub, run } = await bootVirtual();
        await run(200);
        const d0 = k.set.dispose.bind(k.set);
        let calls = 0;
        k.set.dispose = () => { calls++; if (calls === 1) throw new Error('dispose boom'); return d0(); };
        assert.throws(() => k.halt(), /dispose boom/, 'a failed retire propagates to the caller');
        assert.equal(k.halted, false, 'a throwing dispose does not publish halted');
        assert.equal(k._halting, false, 'the re-entry guard is cleared (no latch)');
        k.halt();
        assert.equal(calls, 2, 'a retry after a throwing dispose actually retires the set');
        assert.equal(k.halted, true);
        await run(100);
        assert.equal(liveWorkers(hub), 0);
    }
});

// Admission at the exact boundary, both engines: with the traffic stopped and the fleet idle, arrivals are
// admitted while pending() < live x (slots + queue) and shed from pending() == capacity on (cap-1 admits and
// takes pending to cap; cap and cap+1 shed, pending stays at cap). Must-fail: `>` for `>=` (admits at cap).
for (const [label, mode] of [['engine A', ENGINE_A], ['engine B', ENGINE_B]]) {
    test('G13 admission boundary (' + label + '): pending cap-1 admits, cap and cap+1 shed, every admitted request is served', async () => {
        const { kernel: k, run } = await bootVirtual();
        if (mode === ENGINE_B) k.setEngine(ENGINE_B);
        await run(300);
        k.traffic.stop();
        for (let j = 0; j < 400 && k.engine.pending() > 0; j++) await run(5);
        assert.equal(k.engine.pending(), 0, 'idle before the boundary probe');
        const live = k.balancers.lb.live;
        assert.equal(live, W);
        const cap = live * (k.cfg.slots + k.cfg.queue);
        const c = k.stats.c, shed0 = c[S_SHED], f0 = c[S_FAILED], ok0 = c[S_OK];
        for (let q = 0; q < cap - 1; q++) assert.equal(k.engine.request(q), true, 'admitted below capacity: #' + q);
        assert.equal(k.engine.pending(), cap - 1);
        assert.equal(k.engine.request(cap - 1), true, 'pending == cap-1 admits');
        assert.equal(k.engine.pending(), cap, 'pending reaches exactly capacity');
        assert.equal(c[S_SHED] - shed0, 0, 'nothing shed up to capacity');
        assert.equal(k.engine.request(cap), false, 'pending == cap sheds');
        assert.equal(k.engine.request(cap + 1), false, 'pending == cap (cap+1st arrival) sheds');
        assert.equal(c[S_SHED] - shed0, 2, 'exactly the two over-capacity arrivals are shed');
        assert.equal(k.engine.pending(), cap, 'a shed arrival does not count as pending');
        for (let j = 0; j < 400 && k.engine.pending() > 0; j++) await run(5);
        assert.equal(k.engine.pending(), 0);
        assert.equal(c[S_FAILED] - f0, 0, 'no admitted request failed');
        assert.equal(c[S_OK] - ok0, cap, 'every admitted request was served');
    });
}

// live 0 -> 1 under a 5x overload: during the outage arrivals FAIL (not shed); the moment one worker is eligible
// again admission caps pending at 1 x (slots + queue) and sheds the rest -- no failure, the one worker serves.
// Must-fail: HEAD (no admission: one worker's queue overflows into failed requests).
async function scLiveZeroToOne(engineMode) {
    const { kernel: k, run } = await bootVirtual({ rate: 34000 });
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    k.fleet.tick = () => {};                              // freeze the eligibility writer
    await run(500);
    for (let i = 0; i < W; i++) k.balancers.setEligible(i, false);
    const fo = k.stats.c[S_FAILED], so = k.stats.c[S_SHED];
    await run(200);
    const outage = { failed: k.stats.c[S_FAILED] - fo, shed: k.stats.c[S_SHED] - so };
    const f0 = k.stats.c[S_FAILED], s0 = k.stats.c[S_SHED], ok0 = k.stats.c[S_OK];
    k.balancers.setEligible(0, true);                     // live 0 -> 1 mid-overload
    let maxPending = 0;
    for (let j = 0; j < 100; j++) { await run(10); if (k.engine.pending() > maxPending) maxPending = k.engine.pending(); }
    return {
        outage, live: k.balancers.lb.live, cap: k.cfg.slots + k.cfg.queue, maxPending,
        failed: k.stats.c[S_FAILED] - f0, shed: k.stats.c[S_SHED] - s0, ok: k.stats.c[S_OK] - ok0,
    };
}

// Strategy (and engine) switches DURING a 5x overload: every switch keeps inflight conserved, pending never
// exceeds capacity, nothing fails or trips a breaker, and at quiescence every arrival is accounted for
// (ok + failed + shed + drained == arrived) with all counts back at 0. The second round also flips the ENGINE
// on every switch, so admission sees engine A's table and engine B's promises in flight together.
async function scSwitchOverload(engineMode) {
    const { kernel: k, run } = await bootVirtual({ rate: 34000 });
    if (engineMode === ENGINE_B) k.setEngine(ENGINE_B);
    await run(300);
    const cap = k.balancers.lb.live * (k.cfg.slots + k.cfg.queue);
    let maxPending = 0, e = engineMode;
    for (let round = 0; round < 2; round++) {
        for (const name of STRATEGIES) {
            k.setStrategy(name);
            k.balancers.lb.assertConsistent();
            await run(50);
            k.balancers.lb.assertConsistent();
            if (k.engine.pending() > maxPending) maxPending = k.engine.pending();
            if (round === 1) { e = e === ENGINE_A ? ENGINE_B : ENGINE_A; k.setEngine(e); }
        }
    }
    k.setStrategy('boundedload');
    k.traffic.stop();
    await run(2000);
    k.balancers.lb.assertConsistent();
    const s = k.stats.snapshot();
    return {
        cap, maxPending, arrived: s.arrived, ok: s.ok, failed: s.failed, shed: s.shed, drained: s.drained,
        pending: k.engine.pending(), inflight: sum(Array.from(k.balancers.shared.inflight)),
        total: k.balancers.lb.describe().total, breaker: k.events[EV_BREAKER],
    };
}

for (const [label, mode] of [['engine A', ENGINE_A], ['engine B', ENGINE_B]]) {
    test('G13 live 0 -> 1 (' + label + '): an outage fails, one worker back under overload is capped and shed, not failed', async () => {
        const r = await scLiveZeroToOne(mode);
        assert.ok(r.outage.failed > 0 && r.outage.shed === 0, 'the live-0 outage fails, never sheds: ' + JSON.stringify(r));
        assert.equal(r.live, 1, 'one worker eligible: ' + JSON.stringify(r));
        assert.ok(r.maxPending <= r.cap, 'pending capped at 1 x (slots + queue): ' + JSON.stringify(r));
        assert.ok(r.shed > 0, 'the overload on one worker is shed: ' + JSON.stringify(r));
        assert.equal(r.failed, 0, 'no failure once a worker is back: ' + JSON.stringify(r));
        assert.ok(r.ok > 0, 'the one worker serves: ' + JSON.stringify(r));
    });
    test('G13 switch under overload (' + label + '): strategy + engine switches conserve every count and shed, never fail', async () => {
        const r = await scSwitchOverload(mode);
        assert.ok(r.maxPending <= r.cap, 'pending never exceeds capacity across switches: ' + JSON.stringify(r));
        assert.ok(r.shed > 0, 'the overload was shed: ' + JSON.stringify(r));
        assert.equal(r.failed, 0, 'no switch turned the overload into failures: ' + JSON.stringify(r));
        assert.equal(r.breaker, 0, 'no breaker event: ' + JSON.stringify(r));
        assert.equal(r.ok + r.failed + r.shed + r.drained, r.arrived, 'every arrival accounted for: ' + JSON.stringify(r));
        assert.equal(r.pending, 0);
        assert.equal(r.inflight, 0);
        assert.equal(r.total, 0, 'BoundedLoad total drained to 0');
    });
}

// calibrate.js (P4, new): estimateCapacity is the scene's ideal rate (sum 1000 / (jobMs x speed)); the virtual
// kernel's MEASURED saturating throughput (measureThroughput at 5x) lands within 5% of it and sheds, and at half
// capacity sheds nothing. Boundary: an empty fleet has capacity 0; omitted opts take the documented defaults.
test('G13 capacity: estimateCapacity matches the measured virtual saturation; measureThroughput sees shed only above it', async () => {
    assert.equal(estimateCapacity({ speeds: [], jobMs: 1 }), 0, 'no workers -> capacity 0');
    assert.equal(estimateCapacity({ speeds: [1], jobMs: 1 }), 1000);
    assert.equal(estimateCapacity({ speeds: [1, 2], jobMs: 2 }), 750);
    const { kernel: k, run } = await bootVirtual({ rate: 100 });
    const est = estimateCapacity(k.cfg);
    assert.ok(Math.abs(est - 6833.33) < 0.01, 'the default scene: 6 x 1000 + 500 + 333.3 = ' + est);
    let waited = 0;
    const wait = async (ms) => { waited += ms; await run(ms); };
    const sat = await measureThroughput(k, { wait, rate: Math.round(5 * est) });
    assert.equal(waited, 1500, 'defaults: warmMs 500 + ms 1000');
    assert.ok(sat.shed > 0, 'a 5x offer saturates (sheds): ' + JSON.stringify(sat));
    assert.ok(Math.abs(sat.okPerS - est) / est < 0.05, 'measured saturation within 5% of the estimate: ' + JSON.stringify(sat) + ' vs ' + est);
    const half = await measureThroughput(k, { wait, rate: Math.floor(est / 2) });
    assert.equal(half.shed, 0, 'half capacity sheds nothing: ' + JSON.stringify(half));
    assert.ok(Math.abs(half.okPerS - Math.floor(est / 2)) / est < 0.05, 'half capacity is served: ' + JSON.stringify(half));
});
