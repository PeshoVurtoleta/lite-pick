/**
 * pickEcosystem/live -- the REAL-THREAD smoke run (P1 spec gates): the kernel over node:worker_threads on the
 * real clock, every fault once, then the orchestrator shutdown. Prints "ok" and exits 0, or names the failed
 * check and exits 1. Run by `npm run smoke` (and lite-pick's CI).
 *
 * The run RATE is MEASURED, not hard-coded: a throwaway PROBE kernel is offered more than it can take and its
 * saturating throughput (`okPerS`, proven by the probe shedding) is this host's real capacity. The smoke then
 * runs at HALF that (headroom: a single fault loses no request), or at `SMOKE_OVERLOAD x okPerS` to prove the
 * admission path sheds under overload. If the probe never saturates (a host faster than the cap, or a broken
 * clock), the smoke fails CLOSED (exit 2) rather than guess. Env is allow-listed: an unknown SMOKE_* var is a
 * typo, not a silent default (exit 2 with a did-you-mean).
 *
 * Faults are serialized -- each held until its worker is back in rotation (up and breaker closed) so at most
 * one is active at a time. A fault MAY lose requests while it is active; those in-window failures are counted
 * and printed, not gated. The gate is narrower: NO request fails OUTSIDE a fault window, and (below capacity)
 * NOTHING is shed over the whole run. The slow fault loses nothing, so it opens no window: the strategy
 * switches and shutdown that follow it are held to the steady-state gate (0 failed, 0 shed).
 *   kill w2 | flaky w1 (+ heal) | hang w4 | crash w5 | crash loop w6 (+ reset) | slow w3 + PeakEWMA | BoundedLoad.
 * (Under PeakEWMA a failing worker is avoided by its penalty before its breaker can trip -- the strategy doing
 * its job. The flaky breaker is sampled on w1's OWN bState: a fixed window is a coin flip at CI rates -- see the
 * poll below, kept verbatim from the 2026-10-05 nightly fix.)
 * After shutdown (real threads): every worker thread is terminated (live 0) and the cron stops (no tick over 500 ms).
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { bootKernel } from '../kernel.js';
import { nodeSetSpawn } from '../nodeworker.js';
import { B_CLOSED } from '../fleet.js';
import { calibrateUnitsPerMs, estimateCapacity, measureThroughput } from '../calibrate.js';

const S_FAILED = 2;
const S_SHED = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (s) => process.stderr.write(s + '\n');

// ---- env allow-list (fail closed on a typo) ---------------------------------------------------
const ALLOWED = ['SMOKE_RATE', 'SMOKE_OVERLOAD'];
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = d[0]; d[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return d[n];
}
for (const key of Object.keys(process.env)) {
    if (!key.startsWith('SMOKE_') || ALLOWED.indexOf(key) >= 0) continue;
    let best = null, bestD = Infinity;
    for (const a of ALLOWED) { const dd = editDistance(key, a); if (dd < bestD) { bestD = dd; best = a; } }
    log('smoke: unknown env ' + key + (best && bestD <= 4 ? ' (did you mean ' + best + '?)' : ''));
    process.exit(2);
}

// ---- probe: find this host's real saturating throughput ---------------------------------------
async function probeCapacity() {
    const unitsPerMs = calibrateUnitsPerMs(now, 80);
    const k = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now, timers: 'real', config: { rate: 100, unitsPerMs } });
    const start = Math.ceil(2 * estimateCapacity(k.cfg));   // offer well above the ideal cap
    const cap = Math.min(40000, 3 * start);
    let rate = start, okPerS = 0, satRate = 0, shed = 0;
    while (rate <= cap) {
        const r = await measureThroughput(k, { wait: sleep, warmMs: 500, ms: 1000, rate });
        okPerS = r.okPerS;
        if (r.shed > 0) { satRate = rate; shed = r.shed; break; }
        if (rate === cap) break;
        rate = Math.min(cap, rate * 2);
    }
    await k.shutdown({ deadlineMs: 10000 });
    return { okPerS, satRate, shed, start, cap, unitsPerMs };
}

// Validate the two numeric knobs up front: a non-finite or non-positive value is a typo, not a default.
function posNum(key) {
    if (process.env[key] == null) return null;
    const v = Number(process.env[key]);
    if (!(v > 0) || !Number.isFinite(v)) { log('smoke: ' + key + ' must be a finite number > 0 (got ' + process.env[key] + ')'); process.exit(2); }
    return v;
}
const overload = posNum('SMOKE_OVERLOAD');
const rateOverride = posNum('SMOKE_RATE');

const probe = await probeCapacity();
if (probe.satRate === 0 || !(probe.okPerS > 0)) {
    log('smoke: probe never saturated up to ' + probe.cap + ' req/s (okPerS ' + probe.okPerS.toFixed(0) + ') -- cannot measure capacity');
    process.exit(2);
}

const RATE = rateOverride != null
    ? Math.round(rateOverride)
    : overload != null ? Math.round(overload * probe.okPerS) : Math.floor(0.5 * probe.okPerS);
// The traffic generator needs a whole req/s >= 1; a fractional SMOKE_RATE like 0.3 rounds to 0 (no traffic at
// all, a silent vacuous pass), so reject a resolved rate below 1 as a typo, not a default.
if (!(RATE >= 1)) { log('smoke: resolved rate rounds to ' + RATE + ' req/s -- must be an integer >= 1 (SMOKE_RATE=' + process.env.SMOKE_RATE + ')'); process.exit(2); }
log('smoke: host capacity ~' + probe.okPerS.toFixed(0) + ' req/s (saturated at ' + probe.satRate + ' req/s, shed ' +
    probe.shed + '); running at ' + RATE + ' req/s' + (overload != null ? ' (' + overload + 'x overload)' : ''));

// ---- the smoke run ----------------------------------------------------------------------------
// A spawn wrapper that tracks live worker threads (for the post-shutdown check: every thread terminated).
const liveThreads = new Set();
const trackingSpawn = (spec) => {
    const tr = nodeSetSpawn(spec);
    liveThreads.add(tr);
    const term = tr.terminate.bind(tr);
    tr.terminate = () => { liveThreads.delete(tr); return term(); };
    return tr;
};

const k = await bootKernel({ lp, poolMod, wp, spawn: trackingSpawn, now, timers: 'real', config: { rate: RATE, unitsPerMs: probe.unitsPerMs } });
// Count fleet ticks so we can prove the cron stops once the kernel halts (real threads).
const ticks = { n: 0 };
const ftick = k.fleet.tick.bind(k.fleet);
k.fleet.tick = (t) => { ticks.n++; return ftick(t); };

const t0 = now();
const checks = [];
const check = (ok, what) => { checks.push([ok, what]); log((ok ? '  ok   ' : '  FAIL ') + what); };

// Failures inside a fault window are expected and printed, not gated. Below capacity NOTHING sheds at all
// (the shed gate is over the whole run); only in-window failures are tolerated, and only outside a window
// is a failure a defect.
let insideFailed = 0, insideShed = 0, winF = 0, winS = 0;
const winStart = () => { winF = k.stats.c[S_FAILED]; winS = k.stats.c[S_SHED]; };
const winEnd = () => { insideFailed += k.stats.c[S_FAILED] - winF; insideShed += k.stats.c[S_SHED] - winS; };
async function waitRotation(w, maxMs) {
    const t = now();
    while (now() - t < maxMs) {
        if (k.balancers.shared.up[w] === 1 && k.fleet.bState[w] === B_CLOSED) return true;
        await sleep(20);
    }
    return false;
}

// A steady-state gap BETWEEN fault windows: healthy, below capacity, nothing may fail or shed here.
const STEADY = 500;
const DRAIN = 300;   // inside the window, after recovery: let the fault's own in-flight (failovers) settle

await sleep(700);     // warm up: serve clean traffic before the first fault

// kill w2 -------------------------------------------------------------------------------------
winStart();
k.fault(2, 'kill');
const killBack = await waitRotation(2, 8000);
await sleep(DRAIN);
winEnd();
await sleep(STEADY);

// flaky w1 ------------------------------------------------------------------------------------
winStart();
const tFlaky = performance.now();
k.fault(1, 'flaky');
// The breaker opens on 5 failures IN A ROW and `flaky` fails half of w1's jobs (by item hash), so a fixed 3 s window
// is a coin flip at CI's rate (2.2% of runs never see 5 in a row -- found when the nightly heartbeat failed this way,
// 2026-10-05). Hold the fault for at least 3 s and until the breaker has moved, at most 12 s AFTER the fault lands
// (a miss < 1e-6); later steps shift by the extra wait. The anchor is the moment the fault lands (tFlaky), not run
// start: faults now begin after variable recovery waits, so a t0-relative window could drift (this is a deliberate
// change to the poll's ANCHOR only). Keyed on w1's OWN breaker (fleet.bState[1]) -- the breaker event counter counts
// every worker's transitions -- and an early trip already closed again by its half-open probe still counts.
// This poll has no must-fail control of its own HERE (a breaker that never moves cannot be forced through the
// SMOKE_* env allow-list, and an env-free internal mutant is not permitted). The SAME poll logic -- "the flaky
// worker's breaker must move before the cap" -- is proven to have teeth by heartbeat-teeth.mjs's `nobreaker`
// control (the flaky fault never lands -> BREACH), so it is not re-proven here.
let breakerOpened = false;
while (performance.now() - tFlaky < 3000 || (!breakerOpened && performance.now() - tFlaky < 12000)) {
    await new Promise((r) => setTimeout(r, 20));
    if (k.fleet.bState[1] !== B_CLOSED) breakerOpened = true;
}
k.heal(1);
const flakyBack = await waitRotation(1, 8000);
await sleep(DRAIN);
winEnd();
await sleep(STEADY);

// hang w4 -------------------------------------------------------------------------------------
winStart();
k.fault(4, 'hang');
const hangBack = await waitRotation(4, 8000);
await sleep(DRAIN);
winEnd();
await sleep(STEADY);

// crash w5 ------------------------------------------------------------------------------------
winStart();
k.fault(5, 'crash');
const crashBack = await waitRotation(5, 8000);
await sleep(DRAIN);
winEnd();
await sleep(STEADY);

// crash loop w6 -> escalate -> reset ----------------------------------------------------------
winStart();
k.fault(6, 'crashloop');
let escalated6 = false;
const tLoop = now();
while (now() - tLoop < 8000) { if (k.fleet.escalated[6] === 1) { escalated6 = true; break; } await sleep(20); }
await k.reset(6);
const up6 = await waitRotation(6, 8000);
await sleep(DRAIN);
winEnd();
await sleep(STEADY);

// slow w3 + strategy switches -----------------------------------------------------------------
// The slow fault (10x slow w3) is never healed, but below capacity it loses nothing (verified 0/0), so it
// opens NO fault window (finding 4). The two strategy switches and the whole shutdown that follow it are
// therefore held to the steady-state gate (0 failed, 0 shed) -- a window here would swallow a regression in
// the switch or shutdown path.
k.fault(3, 'slow'); k.setStrategy('peakewma');
await sleep(1500);
k.setStrategy('boundedload');
await sleep(1500);

// shutdown ------------------------------------------------------------------------------------
const code = await k.shutdown({ deadlineMs: 10000 });
ticks.n = 0;
await sleep(500);                                   // the cron must not fire again
const postTicks = ticks.n;
const postLive = liveThreads.size;

const s = k.stats.snapshot();
const failedOutside = s.failed - insideFailed;
const shedOutside = s.shed - insideShed;
log('smoke: ' + s.arrived + ' arrivals at ' + RATE + ' req/s over real threads; ok ' + s.ok + ', failed ' + s.failed +
    ' (inside fault windows ' + insideFailed + ', outside ' + failedOutside + '), shed ' + s.shed +
    ' (inside ' + insideShed + ', outside ' + shedOutside + '), failover ' + s.failover +
    ', restarts [' + Array.from(k.fleet.restarts).join(',') + ']');

check(code === 0, 'orchestrator exit code 0 (got ' + code + ')');
check(s.ok + s.failed + s.shed + s.drained === s.arrived, 'every arrival accounted for');
check(failedOutside === 0, 'no request failed outside a fault window (' + failedOutside + ')');
if (overload != null) check(s.shed > 0, 'overload shed requests (' + s.shed + ')');
else check(s.shed === 0, 'nothing shed below capacity over the whole run (' + s.shed + ')');
check(k.fleet.restarts[2] >= 1, 'kill -> worker 2 restarted');
check(killBack, 'kill -> worker 2 back in rotation');
check(breakerOpened, 'flaky -> w1\'s breaker opened');
check(flakyBack, 'heal -> worker 1 back in rotation');
check(k.fleet.restarts[4] >= 1, 'hang -> worker 4 restarted');
check(hangBack, 'hang -> worker 4 back in rotation');
check(k.fleet.restarts[5] >= 1, 'crash -> worker 5 restarted');
check(crashBack, 'crash -> worker 5 back in rotation');
check(escalated6, 'crash loop -> worker 6 escalated');
check(up6, 'reset -> worker 6 back in rotation');
check(postLive === 0, 'every worker thread terminated at exit (' + postLive + ' up)');
check(postTicks === 0, 'the cron stopped after shutdown (' + postTicks + ' ticks in 500 ms)');

const bad = checks.filter((c) => !c[0]);
if (bad.length) { process.exitCode = 1; process.stderr.write('', () => process.exit(1)); }
else process.stdout.write('ok\n', () => process.exit(0));
