#!/usr/bin/env node
/**
 * pickEcosystem/live -- the headless system in a terminal, over REAL worker_threads (P1). Prints one line per
 * second; Ctrl-C runs the lite-di-orchestrator shutdown (drain -> settle in-flight -> retire -> exit code).
 *
 *   node run.mjs [--strategy p2c] [--rate 2000] [--seconds N] [--engine A|B] [--fault <sec>:<kind>:<worker>]...
 *
 * kinds: kill, slow, flaky, hang, crash, crashloop, heal, reset.
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { bootKernel, ENGINE_A, ENGINE_B } from './kernel.js';
import { nodeSetSpawn } from './nodeworker.js';
import { calibrateUnitsPerMs } from './calibrate.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : dflt; };
const faults = [];
for (let k = 0; k < args.length; k++) if (args[k] === '--fault') {
    const [sec, kind, w] = args[k + 1].split(':');
    faults.push({ at: Number(sec) * 1000, kind, w: Number(w) });
}
const config = { strategy: opt('strategy', 'p2c'), rate: Number(opt('rate', 2000)) };
const seconds = Number(opt('seconds', 0));

// Real threads: calibrate this host's busy-loop speed so a job is ~1 ms of real CPU here (NOT on virtual paths).
config.unitsPerMs = calibrateUnitsPerMs(() => performance.now(), 80);

const t0 = performance.now();
const kernel = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now: () => performance.now(), timers: 'real', config });
if (opt('engine', 'A') === 'B') kernel.setEngine(ENGINE_B); else kernel.setEngine(ENGINE_A);
const tBoot = performance.now();
process.stdout.write('pickEcosystem live: ' + kernel.cfg.workers + ' worker threads up in ' + (tBoot - t0).toFixed(0) +
    ' ms; strategy ' + kernel.balancers.name + ', ' + kernel.cfg.rate + ' req/s, engine ' + opt('engine', 'A') +
    ', ~' + (config.unitsPerMs / 1000).toFixed(0) + 'k loop units/ms\n');

const B = ['closed', 'OPEN', 'half'];
const tick = setInterval(() => {
    const el = performance.now() - tBoot;
    while (faults.length && faults[0].at <= el) {
        const f = faults.shift();
        if (f.kind === 'reset') kernel.reset(f.w);
        else if (f.kind === 'heal') kernel.heal(f.w);
        else kernel.fault(f.w, f.kind);
        process.stdout.write('  fault: ' + f.kind + ' on worker ' + f.w + '\n');
    }
    const s = kernel.stats.snapshot();
    const fl = kernel.fleet;
    let up = '';
    for (let i = 0; i < kernel.cfg.workers; i++) up += kernel.balancers.shared.up[i] ? (fl.bState[i] ? 'h' : 'U') : (fl.escalated[i] ? 'X' : (fl.bState[i] === 1 ? 'B' : '.'));
    process.stdout.write((el / 1000).toFixed(0).padStart(4) + 's  ' + s.rate.toFixed(0).padStart(5) + ' req/s  p50 ' +
        (s.p50 || 0).toFixed(2) + ' ms  p99 ' + (s.p99 || 0).toFixed(2) + ' ms  ok ' + s.ok + '  failed ' + s.failed +
        '  failover ' + s.failover + '  inflight ' + kernel.engine.pending() + '  workers [' + up + ']  restarts ' +
        Array.from(fl.restarts).reduce((a, b) => a + b, 0) + '\n');
    if (seconds > 0 && el >= seconds * 1000) stop('time');
}, 1000);

let stopping = false;
function stop(why) {
    if (stopping) return;
    stopping = true;
    clearInterval(tick);
    process.stdout.write('shutdown (' + why + '): draining...\n');
    kernel.shutdown({ deadlineMs: 10000 }).then((code) => {
        const s = kernel.stats.snapshot();
        process.stdout.write('exit code ' + code + ' (0 = clean); served ' + s.ok + ', failed ' + s.failed + ', in flight ' + kernel.engine.pending() + '\n');
        process.exit(code);
    });
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
