/**
 * pickEcosystem/live -- the SOAK HEARTBEAT (capstone P5): the live system run for as long as you like, every fault
 * once per cycle, judged the way lite-pick's own soak is judged (decisions/0014-soak-redesign.md).
 *
 *   node --expose-gc test/heartbeat.mjs          (npm run heartbeat; the nightly runs HB_DURATION=30m)
 *
 * One CYCLE (~24 s; seconds from the cycle's start; the flaky step waits for w1's breaker -- up to FLAKY_CAP_S --
 * and everything after it shifts by that wait):
 *   0     traffic resumes          2.2  steady p99 read (the last full second, faults not yet started)
 *   2.2   kill w2                  4.2  flaky w1          7.2  heal w1        8.2  hang w4
 *   11.2  crash w5                 12.2 crash loop w6     15.2 reset w6
 *   16.2  slow w3 + PeakEWMA       18.2 heal w3, then all ten strategies (0.4 s each; engine B for three of them)
 *   22.2  back to P2C / engine A   23.2 CHECKPOINT
 * The failing faults never overlap (with `tries: 2`, two at once can legitimately lose a request -- test/smoke.mjs).
 * CHECKPOINT: offer nothing, wait for every request to settle, force GC until retention drains, then sample.
 *
 * HARD invariants, every cycle (a breach FAILs the run at the end of that cycle):
 *   failed     no request failed this cycle
 *   accounted  arrived = ok + failed + shed + drained, nothing in flight, every inflight counter 0
 *   eligible   all 8 workers up, eligible, breaker closed, none escalated
 *   faults     kill / hang / crash each restarted their worker; the flaky worker's breaker opened; the crash
 *              loop escalated (and reset brought it back -- `eligible`)
 *   retention  every worker transport ever spawned and every worker scope ever built is tracked (lite-leak); after
 *              GC at most 8 + 8 live + 16 slack remain (the replaced ones are collected)
 * DRIFT gates, from lite-pick's soak (benchmark/soak/gates.mjs -- the same classes, constants and test), over the
 * post-warmup cycles (first GATE_N vs last GATE_N; active from 2 * GATE_N + WARMUP_CYCLES = 11 cycles):
 *   heap       post-GC heap: late median <= early median x HEAP_MULT + HEAP_SLACK_MB
 *   p99        steady p99: late median <= early x LAT_P99_MULT + 1 ms AND an exact one-sided Mann-Whitney
 *              p < MW_ALPHA (one noisy cycle does not fail it)
 * Verdict: PASS (0) | FAIL (1) | bad config (2) | INCONCLUSIVE (3: fewer cycles than the gates need -- no
 * evidence, no PASS). One `heartbeat: BREACH <family> ...` line per failure. A JSONL stream (header with
 * provenance, one record per cycle, a summary) goes to HB_OUT (default out/heartbeat.jsonl).
 *
 * Config (env; an unknown HB_* or a bad value exits 2):
 *   HB_DURATION  e.g. 30m, 3h (cycles start until it has passed)    HB_CYCLES  stop after N cycles
 *                (neither: 11 cycles, the smallest conclusive run)
 *   HB_WORKERS   real (worker_threads, the default) | virtual (virtual workers on a virtual clock: fast, the teeth)
 *   HB_RATE      offered req/s (default 800 real, 2000 virtual)     HB_OUT  the JSONL path
 *   HB_MUSTFAIL  a planted defect for test/heartbeat-teeth.mjs: leak | slowleak | lose | stuck | p99 | nobreaker
 */

import { mkdirSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { createLeakTracker } from '@zakkster/lite-leak';
import { EarlyLate, mwOneSidedP, HEAP_MULT, HEAP_SLACK_MB, LAT_P99_MULT, MW_ALPHA } from '../../../benchmark/soak/gates.mjs';
import { GATE_N, WARMUP_CYCLES } from '../../../benchmark/soak/config.mjs';
import { bootKernel, STRATEGIES, ENGINE_A, ENGINE_B, EV_BREAKER, EV_ESCALATE } from '../kernel.js';
import { nodeSetSpawn } from '../nodeworker.js';
import { bootVirtual } from '../virtual.js';
import { S_ARRIVED, S_OK, S_FAILED, S_SHED, S_DRAINED, S_FAILOVER } from '../stats.js';
import { B_CLOSED } from '../fleet.js';
import { CTL_LEN, CTL_SLOW } from '../job.js';

const LIVE = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA = 1;
const N_WORKERS = 8;
const RETAIN_SLACK = 16;
const P99_ADD_MS = 1;
const MIN_CONCLUSIVE = 2 * GATE_N + WARMUP_CYCLES;
const KNOWN = ['HB_DURATION', 'HB_CYCLES', 'HB_WORKERS', 'HB_RATE', 'HB_OUT', 'HB_MUSTFAIL'];
const MUSTFAIL = ['leak', 'slowleak', 'lose', 'stuck', 'p99', 'nobreaker'];
const NOOP = function () {};
const say = (s) => process.stderr.write('heartbeat: ' + s + '\n');

/* ------------------------------------------------------------------------------ config ---- */

function editDistance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d.push([i]); for (let j = 1; j <= b.length; j++) d[i].push(i === 0 ? j : 0); }
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
}

function badConfig(msg) { say('BAD CONFIG -- ' + msg); process.exit(2); }

function readConfig(env) {
    for (const k of Object.keys(env)) {
        if (!k.startsWith('HB_') || KNOWN.includes(k)) continue;
        let best = KNOWN[0];
        for (const c of KNOWN) if (editDistance(k, c) < editDistance(k, best)) best = c;
        badConfig('unknown setting ' + k + ' (did you mean ' + best + '?)');
    }
    const workers = env.HB_WORKERS === undefined ? 'real' : env.HB_WORKERS;
    if (workers !== 'real' && workers !== 'virtual') badConfig('HB_WORKERS must be real or virtual, got ' + JSON.stringify(workers));
    let durationMs = 0, cycles = 0;
    if (env.HB_DURATION !== undefined) {
        const m = /^(\d+)(s|m|h)$/.exec(env.HB_DURATION);
        if (!m || Number(m[1]) <= 0) badConfig('HB_DURATION must look like 90s, 30m or 3h, got ' + JSON.stringify(env.HB_DURATION));
        durationMs = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2]];
    }
    if (env.HB_CYCLES !== undefined) {
        if (!/^[1-9]\d*$/.test(env.HB_CYCLES)) badConfig('HB_CYCLES must be a positive integer, got ' + JSON.stringify(env.HB_CYCLES));
        cycles = Number(env.HB_CYCLES);
    }
    if (durationMs === 0 && cycles === 0) cycles = MIN_CONCLUSIVE;
    let rate = workers === 'real' ? 800 : 2000;
    if (env.HB_RATE !== undefined) {
        if (!/^[1-9]\d*$/.test(env.HB_RATE) || Number(env.HB_RATE) > 20000) badConfig('HB_RATE must be an integer in 1..20000, got ' + JSON.stringify(env.HB_RATE));
        rate = Number(env.HB_RATE);
    }
    const mustfail = env.HB_MUSTFAIL === undefined ? null : env.HB_MUSTFAIL;
    if (mustfail !== null && !MUSTFAIL.includes(mustfail)) badConfig('HB_MUSTFAIL must be one of ' + MUSTFAIL.join(', ') + ', got ' + JSON.stringify(mustfail));
    const out = resolve(env.HB_OUT || resolve(LIVE, 'out', 'heartbeat.jsonl'));
    return { workers, durationMs, cycles, rate, mustfail, out };
}

/* -------------------------------------------------------------------------- provenance ---- */

function git(args) {
    try { return execFileSync('git', args, { cwd: LIVE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function header(cfg) {
    const pkg = JSON.parse(readFileSync(resolve(LIVE, 'package.json'), 'utf8'));
    return {
        type: 'header', schema: SCHEMA, kind: 'pick-ecosystem-heartbeat', startedAt: new Date().toISOString(),
        git: { sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) ? true : git(['rev-parse', 'HEAD']) === null ? null : false },
        node: process.version, v8: process.versions.v8, platform: process.platform + '/' + process.arch, execArgv: process.execArgv,
        bricks: pkg.dependencies, config: cfg,
        gates: { GATE_N, WARMUP_CYCLES, MIN_CONCLUSIVE, HEAP_MULT, HEAP_SLACK_MB, LAT_P99_MULT, P99_ADD_MS, MW_ALPHA, RETAIN_SLACK },
    };
}

/* ------------------------------------------------------------------------------ the run ---- */

const cfg = readConfig(process.env);
if (typeof globalThis.gc !== 'function') badConfig('run with node --expose-gc (npm run heartbeat does)');
mkdirSync(dirname(cfg.out), { recursive: true });
const fd = openSync(cfg.out, 'w');
const emit = (rec) => writeSync(fd, JSON.stringify(rec) + '\n');
emit(header(cfg));

const config = { rate: cfg.rate, tries: cfg.mustfail === 'lose' ? 1 : 2 };
let k, now, wait;
if (cfg.workers === 'virtual') {
    const v = await bootVirtual(config);
    k = v.kernel;
    now = () => v.hub.now();
    wait = (ms) => v.run(ms);
} else {
    k = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now: () => performance.now(), timers: 'real', config });
    now = () => performance.now();
    wait = (ms) => new Promise((r) => setTimeout(r, ms));
}
const realTick = () => new Promise((r) => setTimeout(r, 15));

// Retention: every transport the set ever spawns, and every worker scope the fleet ever builds.
const tracker = createLeakTracker({ name: 'pick-ecosystem-heartbeat' });
let tag = 0;
const pinned = [];                                  // HB_MUSTFAIL=leak: the defect keeps them alive
const spawn0 = k.set._spawn;
k.set._spawn = function (spec) {
    const tr = spawn0(spec);
    tracker.track(tr, NOOP, tag++);
    if (cfg.mustfail === 'leak') pinned.push(tr);
    return tr;
};
const seenScopes = new WeakSet();
function trackScopes() {
    for (const s of k.fleet.scopes) if (s !== null && !seenScopes.has(s)) { seenScopes.add(s); tracker.track(s, NOOP, tag++); }
}
trackScopes();
if (cfg.mustfail === 'stuck') {
    const respawn0 = k.set.respawn.bind(k.set);
    let armed = false;
    k.set.respawn = (i) => (i === 4 && armed ? new Promise(NOOP) : respawn0(i));   // w4's restart never completes
    setTimeout(() => { armed = true; }, 0);
}
const ballast = [];                                 // HB_MUSTFAIL=slowleak: ~1.5 MB of heap per cycle, never freed

const heapEL = new EarlyLate(GATE_N);
const p99EL = new EarlyLate(GATE_N);
const breaches = [];
const t0 = now();
const wall0 = Date.now();
let cycle = 0, stopReason = 'end', hardFail = false;

function breach(family, detail) {
    const line = 'BREACH ' + family + ' cycle=' + cycle + ' detail=' + detail;
    breaches.push(line);
    say(line);
}

// The flaky step's cap, seconds from the cycle start (see the cycle body).
const FLAKY_CAP_S = 16.2;

async function at(start, s) {
    const due = start + s * 1000;
    const left = due - now();
    if (left > 0) await wait(left);
}

async function checkpoint() {
    k.setRate(0);
    const deadline = now() + 10000;
    while (k.engine.pending() > 0 && now() < deadline) await wait(5);
    trackScopes();
    let last = -1, stable = 0;
    for (let g = 0; g < 40 && stable < 3; g++) {
        globalThis.gc();
        await realTick();
        const h = process.memoryUsage().heapUsed;
        if (Math.abs(h - last) < 64 * 1024 && tracker.size() <= RETAIN_SLACK + 2 * N_WORKERS) stable++; else stable = 0;
        last = h;
    }
    return { heapMB: process.memoryUsage().heapUsed / 1048576, rssMB: process.memoryUsage().rss / 1048576, tracked: tracker.size() };
}

function snapshot() {
    const c = k.stats.c;
    return { arrived: c[S_ARRIVED], ok: c[S_OK], failed: c[S_FAILED], shed: c[S_SHED], drained: c[S_DRAINED], failover: c[S_FAILOVER],
        restarts: Array.from(k.fleet.restarts), breaker: k.events[EV_BREAKER], escalate: k.events[EV_ESCALATE] };
}

function slowAll(factor) {
    const ctl = k.fleet.ctl;
    for (let i = 0; i < N_WORKERS; i++) {
        ctl[i * CTL_LEN + CTL_SLOW] = k.cfg.speeds[i] * factor;
        k.set.control(i, ctl.subarray(i * CTL_LEN, (i + 1) * CTL_LEN));
    }
}

const stopping = { asked: false };
process.on('SIGINT', () => { stopping.asked = true; });
process.on('SIGTERM', () => { stopping.asked = true; });

say('start: ' + cfg.workers + ' workers, ' + cfg.rate + ' req/s, ' +
    (cfg.cycles ? cfg.cycles + ' cycles' : '') + (cfg.cycles && cfg.durationMs ? ' or ' : '') + (cfg.durationMs ? cfg.durationMs / 60000 + ' min' : '') +
    (cfg.mustfail ? ', MUSTFAIL=' + cfg.mustfail : '') + ' -> ' + cfg.out);

for (;;) {
    if (cfg.cycles && cycle >= cfg.cycles) break;
    if (cfg.durationMs && Date.now() - wall0 >= cfg.durationMs) break;
    if (stopping.asked) { stopReason = 'signal'; break; }
    const post = cycle - WARMUP_CYCLES;
    const before = snapshot();
    k.traffic.resync();
    k.setRate(cfg.rate);
    k.setStrategy('p2c');
    if (cfg.mustfail === 'p99' && post >= GATE_N) slowAll(3);   // a regression in the late window
    const start = now();
    await at(start, 2.2);
    const p99 = k.stats.p99;
    if (cfg.mustfail === 'p99' && post >= GATE_N) slowAll(1);
    k.fault(2, 'kill');
    await at(start, 4.2); if (cfg.mustfail !== 'nobreaker') k.fault(1, 'flaky');   // nobreaker: the fault never lands
    // The breaker opens on 5 failures IN A ROW and `flaky` fails half of w1's jobs (by item hash), so a fixed window
    // is a coin flip at low rates: 3 s at 600 req/s is ~225 jobs on w1, and 2.2% of cycles never see 5 in a row
    // (the 2026-10-05 nightly failed this way at cycle 11 of ~75). Hold the fault for at least the 3 s window and
    // until the breaker has moved, at most until FLAKY_CAP_S (~900 jobs at 600 req/s: a miss < 1e-6 per cycle);
    // the rest of the cycle shifts by the extra wait. Not moving by the cap stays a `faults` breach.
    // Keyed on w1's OWN breaker (fleet.bState[1]): the breaker event counter counts every worker's transitions.
    // Sampled from the moment the fault lands: an early trip whose half-open probe already closed it again by 7.2 s
    // still counts.
    let w1Moved = false;
    while (now() - start < 7.2 * 1000 || (!w1Moved && now() - start < FLAKY_CAP_S * 1000)) {
        await wait(20);
        if (k.fleet.bState[1] !== B_CLOSED) w1Moved = true;
    }
    const shift = Math.max(0, (now() - start) / 1000 - 7.2);
    k.heal(1);
    await at(start, 8.2 + shift); k.fault(4, 'hang');
    await at(start, 11.2 + shift); k.fault(5, 'crash');
    await at(start, 12.2 + shift); k.fault(6, 'crashloop');
    await at(start, 15.2 + shift);
    const escalated = k.fleet.escalated[6] === 1;
    const resetDone = k.reset(6);
    await at(start, 16.2 + shift); await resetDone; k.fault(3, 'slow'); k.setStrategy('peakewma');
    await at(start, 18.2 + shift); k.heal(3);
    for (let s = 0; s < STRATEGIES.length; s++) {
        k.setStrategy(STRATEGIES[s]);
        k.setEngine(s >= 3 && s < 6 ? ENGINE_B : ENGINE_A);
        await at(start, 18.2 + shift + 0.4 * (s + 1));
    }
    k.setStrategy('p2c');
    k.setEngine(ENGINE_A);
    await at(start, 23.2 + shift);
    const cp = await checkpoint();
    const after = snapshot();
    if (cfg.mustfail === 'slowleak') { const chunk = []; for (let j = 0; j < 24000; j++) chunk.push({ a: j, b: j * 2, c: null }); ballast.push(chunk); }

    // ---- hard invariants -------------------------------------------------------------------
    const d = (key) => after[key] - before[key];
    if (d('failed') !== 0) breach('failed', d('failed') + ' requests failed this cycle');
    const pending = k.engine.pending();
    let inflight = 0;
    for (let i = 0; i < N_WORKERS; i++) inflight += k.balancers.shared.inflight[i];
    if (after.arrived !== after.ok + after.failed + after.shed + after.drained + pending) breach('accounted', 'arrived ' + after.arrived + ' != ok + failed + shed + drained + pending');
    if (pending !== 0 || inflight !== 0) breach('accounted', 'still in flight at the checkpoint: pending ' + pending + ', inflight ' + inflight);
    const notUp = [];
    for (let i = 0; i < N_WORKERS; i++) {
        if (k.balancers.shared.up[i] !== 1 || k.fleet.escalated[i] || k.fleet.bState[i] !== B_CLOSED) notUp.push('w' + i);
    }
    if (notUp.length) breach('eligible', notUp.join(',') + ' not back in rotation');
    for (const w of [2, 4, 5]) if (after.restarts[w] - before.restarts[w] < 1) breach('faults', 'w' + w + ' was not restarted');
    if (!w1Moved) breach('faults', 'the flaky worker\'s breaker never moved');
    if (!escalated || d('escalate') < 1) breach('faults', 'the crash loop did not escalate');
    if (cp.tracked > 2 * N_WORKERS + RETAIN_SLACK) breach('retention', cp.tracked + ' transports/scopes still alive after GC (limit ' + (2 * N_WORKERS + RETAIN_SLACK) + ')');
    if (!(p99 > 0)) breach('p99', 'no steady p99 (no request completed in the steady window)');

    if (post >= 0) { heapEL.push(cp.heapMB); p99EL.push(p99); }
    const rec = {
        type: 'cycle', cycle, post, t: Math.round(now() - t0), heapMB: +cp.heapMB.toFixed(2), rssMB: +cp.rssMB.toFixed(1), tracked: cp.tracked,
        p99SteadyMs: +p99.toFixed(3), flakyWaitS: +shift.toFixed(2), ok: d('ok'), failed: d('failed'), shed: d('shed'), failover: d('failover'),
        restarts: after.restarts.map((r, i) => r - before.restarts[i]), breaches: breaches.filter((b) => b.indexOf(' cycle=' + cycle + ' ') > 0),
    };
    emit(rec);
    say('cycle ' + cycle + (post < 0 ? ' (warm-up)' : '') + ': ok ' + rec.ok + ', failed ' + rec.failed + ', failover ' + rec.failover +
        ', heap ' + rec.heapMB + ' MB, tracked ' + rec.tracked + ', steady p99 ' + rec.p99SteadyMs + ' ms');
    cycle++;
    if (rec.breaches.length) { hardFail = true; stopReason = 'breach'; break; }
}

/* ----------------------------------------------------------------------------- verdict ---- */

const postCycles = Math.max(0, cycle - WARMUP_CYCLES);
const gates = {};
const active = postCycles >= 2 * GATE_N;
if (active) {
    const he = heapEL.earlyMedian(), hl = heapEL.lateMedian(), hlim = he * HEAP_MULT + HEAP_SLACK_MB;
    gates.heap = { verdict: hl <= hlim ? 'PASS' : 'FAIL', earlyMB: +he.toFixed(2), lateMB: +hl.toFixed(2), limitMB: +hlim.toFixed(2) };
    if (hl > hlim) breach('gate=heap', 'late ' + hl.toFixed(2) + ' MB > limit ' + hlim.toFixed(2) + ' MB (early ' + he.toFixed(2) + ')');
    const pe = p99EL.earlyMedian(), pl = p99EL.lateMedian(), plim = pe * LAT_P99_MULT + P99_ADD_MS;
    const p = mwOneSidedP(p99EL.early, p99EL.earlyCount, p99EL.lateRing, p99EL.lateCount, +1);
    const fail = pl > plim && p < MW_ALPHA;
    gates.p99 = { verdict: fail ? 'FAIL' : 'PASS', earlyMs: +pe.toFixed(3), lateMs: +pl.toFixed(3), limitMs: +plim.toFixed(3), p: +p.toFixed(4) };
    if (fail) breach('gate=p99', 'late ' + pl.toFixed(3) + ' ms > limit ' + plim.toFixed(3) + ' ms (early ' + pe.toFixed(3) + ', p=' + p.toFixed(4) + ')');
}

const code = await k.shutdown({ deadlineMs: cfg.workers === 'virtual' ? 3000 : 10000 });
let verdict;
// There is no run-forever mode: the loop ends on HB_CYCLES or HB_DURATION (default MIN_CONCLUSIVE
// cycles), both checked BEFORE the signal. So stopReason==='signal' is always an EARLY stop -- the run
// did not reach its own end, so even a window with enough cycles is not a PASS: it is INCONCLUSIVE.
const interrupted = stopReason === 'signal';
if (hardFail || breaches.length) verdict = 'FAIL';
else if (code !== 0) { breach('shutdown', 'orchestrator exit code ' + code); verdict = 'FAIL'; }
else if (interrupted) verdict = 'INCONCLUSIVE';
else if (!active) verdict = 'INCONCLUSIVE';
else verdict = 'PASS';
emit({ type: 'summary', verdict, reason: stopReason, cycles: cycle, postCycles, gates, breaches, shutdownCode: code, endedAt: new Date().toISOString() });
closeSync(fd);
if (verdict === 'INCONCLUSIVE' && interrupted) {
    say('INCONCLUSIVE -- run interrupted before its end (signal) after ' + cycle + ' cycles');
} else if (verdict === 'INCONCLUSIVE') {
    say('INCONCLUSIVE -- ' + postCycles + ' post-warm-up cycles; the drift gates need ' + 2 * GATE_N + ' (run at least ' + MIN_CONCLUSIVE + ' cycles)');
}
for (const [name, g] of Object.entries(gates)) say('gate ' + name + ' ' + g.verdict + ' ' + JSON.stringify(g));
say(verdict + ' -- ' + cycle + ' cycles, ' + breaches.length + ' breaches, shutdown exit code ' + code + ' (' + cfg.out + ')');
const exit = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
void pinned;
process.stderr.write('', () => process.exit(exit));
