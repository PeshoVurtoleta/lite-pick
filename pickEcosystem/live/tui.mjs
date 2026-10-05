#!/usr/bin/env node
/**
 * pickEcosystem/live -- Pool Scope's TERMINAL UI on the LIVE system (capstone P2).
 *
 * The same renderer as the simulated Pool Scope (demo/pool-scope/tui-render.mjs), the same snapshot and the
 * same five pathology detectors -- fed by the running kernel through LiveDriver instead of a simulation, plus
 * the live system's own panel: every worker's state (up / out / breaker / down / escalated) and restarts, and
 * the DECISION STREAM (failover reroutes "w1 -> w2", breaker flips, restarts, escalations).
 *
 *   interactive  node tui.mjs [--strategy p2c] [--rate 2000]          real worker_threads, ~12 Hz
 *     keys: 1-9,0 strategy  n next  e engine A/B  w select worker  k kill  s slow  f flaky  h hang  c crash
 *           l crash loop  x heal  r reset  +/- rate  t the guided tour (tour.js)  q shutdown (the orchestrator)
 *   scripted     node tui.mjs --frames N [--script 2:kill:2,3:slow:3] [--tour] [--strategy s] [--rate r] [--real]
 *                (script times are seconds since boot; frames start after ~1.6 s of warm-up)
 *                renders N frames to stdout and exits; VIRTUAL workers on a virtual clock by default, so the
 *                frames are deterministic (how it is tested); --real uses worker_threads.
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { LitePickSnapshot } from '../../demo/pool-scope/snapshot.mjs';
import { Detectors } from '../../demo/pool-scope/detectors.mjs';
import {
    Renderer, RESET, BOLD, SHOW, HIDE, ALT_ON, ALT_OFF, CLR_SCREEN,
    C_GREEN, C_AMBER, C_RED, C_CYAN, C_TEXT, C_DIM, C_FAINT,
} from '../../demo/pool-scope/tui-render.mjs';
import { bootKernel, STRATEGIES, ENGINE_A, ENGINE_B, STREAM_CAP } from './kernel.js';
import { nodeSetSpawn } from './nodeworker.js';
import { bootVirtual } from './virtual.js';
import { LiveDriver } from './driver.js';
import { workerState, WS_TAG, WS_TONE, eventText, eventTone } from './narrate.js';
import { FAULT_KEYS, rateUp, rateDown, applyFault } from './surface.js';
import { TourPlayer } from './tour.js';

const FRAME_MS = 84;            // ~12 Hz
const STREAM_LINES = 5;       // structural events shown
const REROUTE_LINES = 2;      // newest failover reroutes shown
const TONE_ANSI = [C_GREEN, C_AMBER, C_RED, C_CYAN];   // narrate.js TONE_OK / WARN / BAD / INFO

/** LiveDriver + the terminal-only panel and footer the shared renderer asks for. */
class TuiDriver extends LiveDriver {
    constructor(kernel, t0) {
        super(kernel);
        this.t0 = t0;
        this.sel = 0;
        this.note = '';
        this.controlsHelp = '  [1-9,0] strategy [n] next [e] engine  [w] worker  [k]ill [s]low [f]laky [h]ang ' +
            '[c]rash crash[l]oop  [x] heal [r]eset  [+/-] rate  [t] tour  [q] shutdown';
        this.tour = new TourPlayer(kernel);
    }

    _cell(i) {
        const ws = workerState(this.k, i);
        const mark = i === this.sel ? C_CYAN + '>' : ' ';
        return mark + C_DIM + 'w' + i + ' ' + TONE_ANSI[WS_TONE[ws]] + '\u25cf ' + WS_TAG[ws].padEnd(5) + C_FAINT + 'r' +
            this.k.fleet.restarts[i] + RESET + ' ';
    }

    _event(lane, idx) {
        const t = ((lane.time[idx] - this.t0) / 1000).toFixed(2).padStart(7) + 's  ';
        const type = lane.type[idx], p = lane.payload[idx];
        return C_FAINT + t + TONE_ANSI[eventTone(type, p)] + eventText(type, p) + RESET;
    }

    _lane(lane, lines, NL) {
        let out = '';
        const m = lane.count < lines ? lane.count : lines;
        for (let j = 0; j < m; j++) out += '  ' + this._event(lane, (lane.head - 1 - j + STREAM_CAP) % STREAM_CAP) + NL;
        return out;
    }

    extraPanel(rule, NL) {
        const k = this.k;
        const s = k.stats.snapshot();
        const n = k.cfg.workers;
        let out = rule + NL;
        out += BOLD + C_DIM + 'FLEET ' + RESET + C_FAINT + 'engine ' + C_TEXT + (k.engine.mode === ENGINE_A ? 'A (zero-alloc)' : 'B (/pool)') +
            C_FAINT + '  offered ' + C_TEXT + k.traffic.rate + '/s' + C_FAINT + '  ok ' + C_TEXT + s.ok +
            C_FAINT + '  failed ' + (s.failed ? C_RED : C_TEXT) + s.failed + C_FAINT + '  failover ' + C_TEXT + s.failover +
            C_FAINT + '  in flight ' + C_TEXT + k.engine.pending() + RESET + NL;
        let row = '  ';
        for (let i = 0; i < n; i++) {
            row += this._cell(i);
            if (i % 4 === 3) { out += row + NL; row = '  '; }
        }
        if (row !== '  ') out += row + NL;
        if (this.tour.active && this.tour.caption) {
            out += BOLD + C_CYAN + 'TOUR ' + this.tour.progress + ' ' + RESET + C_TEXT + this.tour.caption + RESET + NL;
        }
        out += BOLD + C_DIM + 'DECISIONS ' + RESET + C_FAINT + '(newest first)' + (this.note ? '   ' + C_CYAN + this.note : '') + RESET + NL;
        const st = k.stream.structural;
        if (st.count === 0) out += C_FAINT + '  (quiet -- inject a fault)' + RESET + NL;
        out += this._lane(st, STREAM_LINES, NL);
        const rr = k.stream.reroute;
        out += BOLD + C_DIM + 'REROUTES ' + RESET + C_FAINT + rr.count + ' failovers so far' + RESET + NL;
        out += this._lane(rr, REROUTE_LINES, NL);
        return out;
    }
}

/** The data path the badge reports: beginFrame + snapshot.build + detectors.evaluate, on throwaway instances. */
function measureDataPath(kernel) {
    const d = new LiveDriver(kernel);
    const sn = new LitePickSnapshot(kernel.cfg.workers);
    const dt = new Detectors(kernel.cfg.workers);
    for (let i = 0; i < 400; i++) { d.beginFrame(FRAME_MS / 1000); sn.build(d); dt.evaluate(sn); }
    if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
    const before = process.memoryUsage().heapUsed;
    const N = 5000;
    for (let i = 0; i < N; i++) { d.beginFrame(FRAME_MS / 1000); sn.build(d); dt.evaluate(sn); }
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const per = (process.memoryUsage().heapUsed - before) / N;
    return per > 0 ? per : 0;
}

function argVal(argv, name, def) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def; }

/* -------------------------------------------------------------------------------- scripted ---- */

async function runScripted(argv) {
    const frames = (argVal(argv, '--frames', '24') | 0) || 24;
    const config = { strategy: argVal(argv, '--strategy', 'p2c'), rate: Number(argVal(argv, '--rate', 2000)) };
    const script = argVal(argv, '--script', '').split(',').filter(Boolean).map((x) => {
        const [sec, kind, w] = x.split(':');
        return { at: Number(sec) * 1000, kind, w: Number(w) };
    });
    let kernel, step;
    if (argv.indexOf('--real') >= 0) {
        kernel = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now: () => performance.now(), timers: 'real', config });
        step = (ms) => new Promise((r) => setTimeout(r, ms));
    } else {
        const v = await bootVirtual(config);
        kernel = v.kernel;
        step = v.run;
    }
    const t0 = kernel.engine.now();
    const drv = new TuiDriver(kernel, t0);
    const snap = new LitePickSnapshot(kernel.cfg.workers);
    const det = new Detectors(kernel.cfg.workers);
    const rend = new Renderer(kernel.cfg.workers);
    const dataBpo = measureDataPath(kernel);
    await step(1000);                                   // warm the rings
    for (let f = 0; f < 6; f++) { await step(FRAME_MS); drv.beginFrame(FRAME_MS / 1000); snap.build(drv); det.evaluate(snap); }
    process.stdout.write('pool-scope LIVE scripted -- ' + (argv.indexOf('--real') >= 0 ? 'real threads' : 'virtual workers') +
        ' strategy=' + config.strategy + ' rate=' + config.rate + ' frames=' + frames + '  data-path=' + dataBpo.toFixed(2) + ' B/op\n');
    if (argv.indexOf('--tour') >= 0) drv.tour.start(kernel.engine.now());
    let shownStrategy = kernel.balancers.name;
    for (let f = 0; f < frames; f++) {
        await step(FRAME_MS);
        const el = kernel.engine.now() - t0;
        while (script.length && script[0].at <= el) { const s = script.shift(); await applyFault(kernel, s.kind, s.w); }
        drv.tour.tick(kernel.engine.now());
        if (kernel.balancers.name !== shownStrategy) { shownStrategy = kernel.balancers.name; rend.beginMorph(); det.reset(); }
        drv.beginFrame(FRAME_MS / 1000);
        snap.build(drv);
        det.evaluate(snap);
        process.stdout.write('\n' + C_FAINT + '=== frame ' + f + ' @ ' + (el / 1000).toFixed(2) + 's ===' + RESET + '\n');
        process.stdout.write(rend.render(snap, det, drv, f, dataBpo, false));
    }
    // The orchestrator waits for every in-flight request to settle; on virtual workers that needs the clock to
    // keep moving, so step it while the shutdown runs (on real threads `step` just waits).
    let code = null;
    kernel.shutdown({ deadlineMs: 5000 }).then((c) => { code = c; }, () => { code = -1; });
    for (let j = 0; j < 2000 && code === null; j++) await step(5);
    // Exit in the write callback: a bare process.exit() right after large writes into a PIPE drops the tail.
    process.stdout.write('\npool-scope LIVE: done (' + frames + ' frames); shutdown exit code ' + code + '\n', () => process.exit(0));
}

/* ----------------------------------------------------------------------------- interactive ---- */

async function runInteractive(argv) {
    const config = { strategy: argVal(argv, '--strategy', 'p2c'), rate: Number(argVal(argv, '--rate', 2000)) };
    const kernel = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now: () => performance.now(), timers: 'real', config });
    const drv = new TuiDriver(kernel, kernel.engine.now());
    const snap = new LitePickSnapshot(kernel.cfg.workers);
    const det = new Detectors(kernel.cfg.workers);
    const rend = new Renderer(kernel.cfg.workers);
    const dataBpo = measureDataPath(kernel);
    const out = process.stdout, stdin = process.stdin;
    let frame = 0, timer = null, restored = false, stopping = false;

    function restore() {
        if (restored) return;
        restored = true;
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        out.write(RESET + SHOW + ALT_OFF);
    }

    function shutdown(signalCode) {
        if (stopping) return;
        stopping = true;
        drv.note = 'SHUTTING DOWN: draining, settling in-flight requests, retiring workers...';
        kernel.shutdown({ deadlineMs: 10000 }).then((code) => {
            if (timer) clearInterval(timer);
            restore();
            const s = kernel.stats.snapshot();
            out.write('pool-scope LIVE: orchestrator exit code ' + code + ' (0 = clean); served ' + s.ok + ', failed ' + s.failed + '\n');
            process.exit(signalCode !== undefined ? signalCode : code);
        });
    }

    function switchTo(idx) {
        kernel.setStrategy(STRATEGIES[idx]);          // the frame loop sees the change: morph + detector reset
    }

    function onKey(chunk) {
        const s = chunk.toString();
        if (s.charCodeAt(0) === 0x1b) { if (s.length === 1) shutdown(); return; }
        for (let c = 0; c < s.length; c++) {
            const ch = s[c];
            if (ch === 'q' || ch === '\x03') { shutdown(); return; }
            if (stopping) continue;
            if (ch >= '1' && ch <= '9') switchTo(ch.charCodeAt(0) - 49);
            else if (ch === '0') switchTo(9);
            else if (ch === 'n') switchTo((STRATEGIES.indexOf(kernel.balancers.name) + 1) % STRATEGIES.length);
            else if (ch === 'e') kernel.setEngine(kernel.engine.mode === ENGINE_A ? ENGINE_B : ENGINE_A);
            else if (ch === 'w') drv.sel = (drv.sel + 1) % kernel.cfg.workers;
            else if (ch === 't') { if (drv.tour.active) { drv.tour.stop(); drv.note = 'tour stopped'; } else { drv.tour.start(kernel.engine.now()); drv.note = ''; } }
            else if (ch === '+') kernel.setRate(rateUp(kernel.traffic.rate));
            else if (ch === '-') kernel.setRate(rateDown(kernel.traffic.rate));
            else {
                const kind = FAULT_KEYS[ch];
                if (kind) { applyFault(kernel, kind, drv.sel); drv.note = kind + ' -> w' + drv.sel; }
            }
        }
    }

    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));
    process.on('exit', restore);
    out.write(ALT_ON + CLR_SCREEN + HIDE);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    let shownStrategy = kernel.balancers.name;
    timer = setInterval(() => {
        if (!stopping) drv.tour.tick(kernel.engine.now());
        if (kernel.balancers.name !== shownStrategy) { shownStrategy = kernel.balancers.name; rend.beginMorph(); det.reset(); }
        drv.beginFrame(FRAME_MS / 1000);
        snap.build(drv);
        det.evaluate(snap);
        out.write(rend.render(snap, det, drv, frame, dataBpo, true));
        frame++;
    }, FRAME_MS);
}

const argv = process.argv.slice(2);
if (argv.indexOf('--frames') >= 0 || !process.stdout.isTTY) runScripted(argv);
else runInteractive(argv);

void C_RED;
