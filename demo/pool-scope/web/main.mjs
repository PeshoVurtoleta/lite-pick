/**
 * Pool Scope -- web/main.mjs : the BROWSER renderer (PS3 deliverable 2).
 *
 * The "richer pitch" render target for the SAME live decision-monitor as the TUI. It REUSES the
 * renderer-agnostic bricks unchanged -- driver.mjs (the traffic engine over the real ten lite-pick
 * balancers), snapshot.mjs (the SoA ring scene model), detectors.mjs (the five pathology detectors),
 * siblings.mjs (the optional lite-sketch / lite-adaptive peer layer) -- and swaps ONLY the renderer:
 * the TUI paints ANSI to a terminal, this paints a served browser page with @zakkster/lite-charts.
 *
 * Same DATA PATH as the TUI: on a throttled ~12 Hz tick it runs driver.tick() x3, snapshot.build(),
 * detectors.evaluate() -- all pre-allocated, zero-alloc (the bricks' discipline). Only the RENDER layer
 * (chart data arrays, DOM textContent, canvas paints) allocates, which is fine. State is lite-signal
 * signals; a single effect() keyed on a render-version signal redraws the DOM panels + the charts read
 * the same version in their data thunks (one shared reactive registry -- lite-charts loads via esm.sh
 * with ?external=@zakkster/lite-signal so it shares THIS module's lite-signal instance).
 *
 * Lego thesis: the fingerprint HERO is a hand-rolled canvas (it needs the bar + mean/sigma band +
 * weight-ghost OVERLAY at pixel fidelity lite-charts bars do not compose); heat / fairness / killer-graph
 * ride lite-charts kernels (heatmap / area+line / scatter). Every chart is created behind a try/catch and
 * degrades to a small canvas fallback so the page ALWAYS loads live with no uncaught console error.
 */

import { Driver, STRATEGIES } from '../driver.mjs';
import { LitePickSnapshot } from '../snapshot.mjs';
import { Detectors, UNFAIR_GINI } from '../detectors.mjs';
import { LATENCY_BACKING, DETECTOR_BACKING, HOTKEY_BACKING } from '../siblings.mjs';
import { signal, effect } from '@zakkster/lite-signal';

/* --------------------------------------------------------------------- constants + palette ---- */

const CAP = 12;
const TICKS_PER_FRAME = 3;
const FRAME_MS = 80;                       // ~12.5 Hz data tick (matches the TUI cadence)
const FRAME_SECONDS = TICKS_PER_FRAME * 0.001;
const HEAT_COLS = 48;                      // worker x time columns (newest at the right)
const KILLER_MAX = 96;                     // killer-graph trailing scatter depth
const SCALE_FLOOR = 20;                    // heat colour scale floor so an overloaded cell reads red
const FP_MEAN_MULT = 2.3;                  // fingerprint full-scale = live-mean load x this
const FP_SCALE_FLOOR = 4;

const COL = {
    bg1: '#0d1117', bg2: '#131922', bg3: '#1a2230', line: '#232b38',
    text: '#eae8e4', dim: '#c6c9d0', faint: '#9ca2ae',
    green: '#5fe39f', amber: '#f5b942', red: '#f87171', magenta: '#e879a8', cyan: '#7dd3fc',
};

const G0 = [0x5f, 0xe3, 0x9f], G1 = [0xf5, 0xb9, 0x42], G2 = [0xf8, 0x71, 0x71];
/** green -> amber -> red ramp along t in [0,1]; the reading IS the hue (btop idiom). */
function ramp(t) {
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    let a, b, u;
    if (t < 0.5) { a = G0; b = G1; u = t * 2; } else { a = G1; b = G2; u = (t - 0.5) * 2; }
    const r = (a[0] + (b[0] - a[0]) * u) | 0;
    const g = (a[1] + (b[1] - a[1]) * u) | 0;
    const bl = (a[2] + (b[2] - a[2]) * u) | 0;
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

/* ------------------------------------------------------------------------- cached DOM refs ---- */

const $ = (id) => document.getElementById(id);
const $stage = $('stage');
const $tabs = $('tabs');
const $headWorkers = $('head-workers');
const $headStrategy = $('head-strategy');
const $headLive = $('head-live');
const $headInflight = $('head-inflight');
const $headThr = $('head-thr');
const $headLat = $('head-lat');
const $headAlloc = $('head-alloc');
const $backDet = $('back-det');
const $backLat = $('back-lat');
const $backHk = $('back-hk');
const $backRender = $('back-render');
const $alarm = $('alarm');
const $alarmText = $('alarm-text');
const $alarmSub = $('alarm-sub');
const $badges = $('badges');
const $strategySelect = $('strategy-select');
const $btnNext = $('btn-next');
const $hotkeysPanel = $('hotkeys-panel');
const $hotkeysList = $('hotkeys-list');
const $hkBacking = $('hk-backing');
const $wtableBody = $('wtable-body');
const $wtable = $('wtable');
const $inspector = $('inspector');
const $giniGauge = $('gini-gauge');

/* ------------------------------------------------------------------------- brick instances ---- */

let drv = new Driver(CAP);
drv.setStrategy('p2c');
const snap = new LitePickSnapshot(CAP);
const det = new Detectors(CAP);

// Pre-allocated scratch reused across frames (kept off the alloc path).
const hotKeyBuf = new Int32Array(6);

/* ---------------------------------------------------------------------------- state signals --- */

const sStrategy = signal('p2c');
const sSelected = signal(-1);              // selected worker index for the inspector, -1 = none
const sSort = signal('load');              // worker table sort key
const sTick = signal(0);                   // render-version: bumped each data frame -> redraws everything

const activeInjectors = new Set();         // for the control-button pressed state (display only)
let killIdx = 1;                            // next worker index a `kill` inject marks down (steps +2)

/* ------------------------------------------------------- backing indicators (lego thesis) ----- */

function paintBacking(el, label, live) {
    el.textContent = label;
    el.className = 'b ' + (live ? 'live' : 'fallback');
}
paintBacking($backDet, DETECTOR_BACKING, DETECTOR_BACKING === 'lite-adaptive');
paintBacking($backLat, LATENCY_BACKING, LATENCY_BACKING === 'lite-sketch');
paintBacking($backHk, HOTKEY_BACKING, HOTKEY_BACKING === 'lite-adaptive');
$hkBacking.textContent = '(' + HOTKEY_BACKING + ')';
$headWorkers.textContent = String(CAP);
// The data path is 0-alloc by construction (pre-allocated typed rings, SMI clock, masked head, in-place
// percentile sort). The browser has no reliable per-op heap probe; the exact 0 is proven by the TUI's
// gc-settled measurement + test/torture.mjs. State it honestly rather than fake a live number.
$headAlloc.innerHTML = '<span class="ok">data 0 B/op</span> (pre-alloc rings)';

/* =============================================================================================
 * CHART LAYER -- lite-charts kernels with per-panel canvas fallbacks (all guarded).
 * Each panel object exposes update(): it either drives its lite-charts data (via the shared render
 * signal read in the data thunk) or paints its fallback canvas.
 * ============================================================================================= */

let charts = null;                          // the lite-charts module, or null if it failed to load

// ---- reusable chart data arrays (render layer; rebuilt each frame) --------------------------
const heatData = [];                        // {x:'t0'..t47, y:'w0'..w11, v}
const lorenzData = [];                      // {x, y} cumulative-population vs cumulative-share
const killerData = [];                      // {x:p50, y:picks/sec} trailing ring

// ---- fallback canvases (created lazily when a chart cannot mount) ---------------------------
function makeCanvas(host) {
    const c = document.createElement('canvas');
    c.className = 'fallback';
    host.textContent = '';
    host.appendChild(c);
    return c;
}
function fitCanvas(c) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = c.clientWidth || c.parentElement.clientWidth || 600;
    const h = c.clientHeight || c.parentElement.clientHeight || 220;
    const pw = (w * dpr) | 0, ph = (h * dpr) | 0;
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
}

/* -------- FINGERPRINT: hand-rolled canvas hero (bar + mean/sigma band + weight-ghost) -------- */

const fpCanvas = makeCanvas($('host-fingerprint'));

function drawFingerprint() {
    const { ctx, w, h } = fitCanvas(fpCanvas);
    ctx.clearRect(0, 0, w, h);
    const pad = 8, base = h - 16;
    const plotH = base - pad;
    // live weight sum + mean/std of live inflight (mean-relative scale, TUI-parity).
    let sumW = 0, meanLoad = 0, liveN = 0;
    for (let i = 0; i < CAP; i++) if (snap.wEligible[i]) { sumW += drv.weights[i]; meanLoad += snap.wInflight[i]; liveN++; }
    meanLoad = liveN > 0 ? meanLoad / liveN : 0;
    let sig = 0;
    for (let i = 0; i < CAP; i++) if (snap.wEligible[i]) { const d = snap.wInflight[i] - meanLoad; sig += d * d; }
    sig = liveN > 0 ? Math.sqrt(sig / liveN) : 0;
    let fpScale = meanLoad * FP_MEAN_MULT;
    if (fpScale < FP_SCALE_FLOOR) fpScale = FP_SCALE_FLOOR;
    const yOf = (v) => base - Math.min(1, v / fpScale) * plotH;
    const colW = (w - pad * 2) / CAP;
    const barW = colW * 0.62;
    // +-1 sigma band
    if (liveN > 0) {
        ctx.fillStyle = 'rgba(125,211,252,0.08)';
        const yHi = yOf(meanLoad + sig), yLo = yOf(meanLoad - sig);
        ctx.fillRect(pad, yHi, w - pad * 2, Math.max(1, yLo - yHi));
    }
    // bars + weight-ghost outline
    for (let i = 0; i < CAP; i++) {
        const x = pad + i * colW + (colW - barW) / 2;
        if (!snap.wEligible[i]) {
            ctx.fillStyle = COL.faint;
            ctx.fillRect(x, base - 1, barW, 1);
            continue;
        }
        const v = snap.wInflight[i];
        const yb = yOf(v);
        ctx.fillStyle = ramp(v / fpScale);
        ctx.fillRect(x, yb, barW, base - yb);
        // weight-ghost: where a weight-proportional load would sit (dotted outline).
        const ghost = sumW > 0 ? (drv.weights[i] / sumW) * (meanLoad * liveN) : 0;
        const yg = yOf(ghost);
        ctx.strokeStyle = 'rgba(156,162,174,0.55)';
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(x, yg, barW, Math.max(0.5, base - yg));
        ctx.setLineDash([]);
    }
    // mean line
    ctx.strokeStyle = COL.dim; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, yOf(meanLoad)); ctx.lineTo(w - pad, yOf(meanLoad)); ctx.stroke();
    ctx.setLineDash([]);
    // worker index axis
    ctx.fillStyle = COL.faint; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'center';
    for (let i = 0; i < CAP; i++) ctx.fillText(String(i % 10), pad + i * colW + colW / 2, h - 3);
}

/* -------- HEAT: lite-charts heatmap (worker x time), canvas fallback -------- */

const heatHost = $('host-heat');
let heatChart = null, heatFallback = null;

function buildHeatData() {
    heatData.length = 0;
    const scale = snap.maxLoad > SCALE_FLOOR ? snap.maxLoad : SCALE_FLOOR;
    for (let wI = 0; wI < CAP; wI++) {
        for (let c = 0; c < HEAT_COLS; c++) {
            const k = HEAT_COLS - 1 - c;               // newest at the right
            let v = 0;
            if (k < snap.frames && snap.eligAt(wI, k)) v = snap.loadAt(wI, k);
            heatData.push({ x: 't' + c, y: 'w' + wI, v: v / scale });
        }
    }
}

function drawHeatFallback() {
    const { ctx, w, h } = fitCanvas(heatFallback);
    ctx.clearRect(0, 0, w, h);
    const labW = 26, pad = 4;
    const cellW = (w - labW - pad) / HEAT_COLS;
    const cellH = (h - pad) / CAP;
    const scale = snap.maxLoad > SCALE_FLOOR ? snap.maxLoad : SCALE_FLOOR;
    ctx.font = '9px "JetBrains Mono", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let wI = 0; wI < CAP; wI++) {
        const y = pad + wI * cellH;
        ctx.fillStyle = COL.faint; ctx.fillText('w' + wI, 0, y + cellH / 2);
        for (let c = 0; c < HEAT_COLS; c++) {
            const k = HEAT_COLS - 1 - c;
            const x = labW + c * cellW;
            if (k >= snap.frames || !snap.eligAt(wI, k)) { ctx.fillStyle = COL.bg3; ctx.fillRect(x, y, cellW - 0.5, cellH - 0.5); continue; }
            const v = snap.loadAt(wI, k) / scale;
            ctx.fillStyle = v <= 0 ? COL.bg3 : ramp(v);
            ctx.fillRect(x, y, cellW - 0.5, cellH - 0.5);
        }
    }
}

/* -------- FAIRNESS: lite-charts Lorenz curve + DOM Gini gauge -------- */

const fairHost = $('host-fairness');
let fairChart = null, fairFallback = null;

function buildLorenz() {
    // Lorenz: sort live workers' share ascending, plot cumulative population vs cumulative share.
    lorenzData.length = 0;
    const shares = [];
    for (let i = 0; i < CAP; i++) if (snap.wEligible[i]) shares.push(snap.wShare[i]);
    shares.sort((a, b) => a - b);
    const n = shares.length;
    lorenzData.push({ x: 0, y: 0 });
    if (n > 0) {
        let acc = 0; const total = shares.reduce((s, v) => s + v, 0) || 1;
        for (let i = 0; i < n; i++) { acc += shares[i]; lorenzData.push({ x: (i + 1) / n, y: acc / total }); }
    } else {
        lorenzData.push({ x: 1, y: 1 });
    }
}

function drawFairFallback() {
    const { ctx, w, h } = fitCanvas(fairFallback);
    ctx.clearRect(0, 0, w, h);
    const pad = 22; const px = pad, py = pad, pw = w - pad * 2, ph = h - pad * 2;
    // equality diagonal
    ctx.strokeStyle = COL.faint; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py + ph); ctx.lineTo(px + pw, py); ctx.stroke(); ctx.setLineDash([]);
    // Lorenz curve
    const g = snap.curGini;
    ctx.strokeStyle = g >= UNFAIR_GINI ? COL.red : COL.green; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < lorenzData.length; i++) {
        const p = lorenzData[i];
        const xx = px + p.x * pw, yy = py + ph - p.y * ph;
        if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    ctx.fillStyle = COL.faint; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'left';
    ctx.fillText('population', px, h - 6);
    ctx.save(); ctx.translate(10, py + ph); ctx.rotate(-Math.PI / 2); ctx.fillText('cumulative share', 0, 0); ctx.restore();
}

function drawGiniGauge() {
    const g = snap.curGini;
    const col = g >= UNFAIR_GINI ? COL.red : (g >= UNFAIR_GINI * 0.6 ? COL.amber : COL.green);
    const press = g >= UNFAIR_GINI ? 'MONOPOLY' : (g >= UNFAIR_GINI * 0.6 ? 'SKEWED' : 'BALANCED');
    const pct = Math.max(0, Math.min(100, g * 100));
    $giniGauge.innerHTML =
        '<div style="display:flex;align-items:center;gap:0.6rem;font-size:0.82rem;">' +
        '<span style="color:' + COL.faint + '">gini</span>' +
        '<span style="color:' + col + ';font-weight:700;">' + g.toFixed(3) + '</span>' +
        '<span style="flex:1;height:0.6rem;background:' + COL.bg3 + ';border-radius:2px;overflow:hidden;">' +
        '<span style="display:block;height:100%;width:' + pct + '%;background:' + col + ';"></span></span>' +
        '<span style="color:' + col + ';font-weight:700;letter-spacing:0.05em;">' + press + '</span></div>';
}

/* -------- KILLER GRAPH: lite-charts scatter (throughput vs latency), canvas fallback -------- */

const killerHost = $('host-latency');
let killerChart = null, killerFallback = null;

function pushKiller() {
    const x = snap.p50, y = snap.curThroughput;
    if (x === x && y === y) {                 // both finite
        killerData.push({ x, y });
        if (killerData.length > KILLER_MAX) killerData.shift();
    }
}

function drawKillerFallback() {
    const { ctx, w, h } = fitCanvas(killerFallback);
    ctx.clearRect(0, 0, w, h);
    const pad = 30; const px = pad, py = 12, pw = w - pad - 12, ph = h - py - pad;
    let maxX = 1, maxY = 1;
    for (let i = 0; i < killerData.length; i++) { if (killerData[i].x > maxX) maxX = killerData[i].x; if (killerData[i].y > maxY) maxY = killerData[i].y; }
    maxX *= 1.1; maxY *= 1.1;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);
    for (let i = 0; i < killerData.length; i++) {
        const p = killerData[i];
        const xx = px + (p.x / maxX) * pw;
        const yy = py + ph - (p.y / maxY) * ph;
        const age = i / Math.max(1, killerData.length - 1);   // fade the trail (recency = brighter)
        ctx.fillStyle = i === killerData.length - 1 ? COL.cyan : 'rgba(125,211,252,' + (0.15 + age * 0.5).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(xx, yy, i === killerData.length - 1 ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = COL.faint; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'left';
    ctx.fillText('service latency (p50) ->', px, h - 8);
    ctx.save(); ctx.translate(12, py + ph); ctx.rotate(-Math.PI / 2); ctx.fillText('picks/sec ->', 0, 0); ctx.restore();
}

/* ------------------------------------------------------------ lite-charts creation (guarded) --- */

async function initCharts() {
    try {
        charts = await import('@zakkster/lite-charts');
    } catch (e) {
        charts = null;
    }
    const axis = { axisColor: COL.line, labelColor: COL.faint, font: '11px "JetBrains Mono", monospace', background: null };

    // HEAT -- heatmap kernel
    try {
        if (!charts || typeof charts.createHeatmap !== 'function') throw 0;
        heatChart = charts.createHeatmap({
            data: () => { sTick(); return heatData; },
            x: 'x', y: 'y', value: 'v',
            colorFn: (v) => (v <= 0 ? COL.bg3 : ramp(v)),
            cellGap: 0.08, rowHighlight: true, columnHighlight: true,
            labelColor: COL.faint, labelFont: '9px "JetBrains Mono", monospace', background: COL.bg1,
            margin: { top: 6, right: 6, bottom: 6, left: 30 },
        }).mount(heatHost);
    } catch (e) { heatChart = null; heatFallback = makeCanvas(heatHost); }

    // FAIRNESS -- Lorenz via area chart + an equality-diagonal annotation
    try {
        if (!charts || typeof charts.createAreaChart !== 'function') throw 0;
        fairChart = charts.createAreaChart({
            data: () => { sTick(); return lorenzData; },
            x: 'x', y: 'y', color: COL.green, lineWidth: 2,
            xScale: { domain: [0, 1] }, yScale: { domain: [0, 1] },
            grid: { x: false, y: false }, crosshair: false, tooltip: false, legend: false,
            xTitle: 'population', yTitle: 'cumulative share',
            annotations: () => [
                { type: 'line', axis: 'y', value: 0, color: COL.line },
                { type: 'point', x: 0, y: 0, color: COL.faint, radius: 1 },
                { type: 'point', x: 1, y: 1, color: COL.faint, radius: 1 },
            ],
            margin: { top: 10, right: 14, bottom: 34, left: 44 }, ...axis,
        }).mount(fairHost);
    } catch (e) { fairChart = null; fairFallback = makeCanvas(fairHost); }

    // KILLER GRAPH -- scatter kernel
    try {
        if (!charts || typeof charts.createScatterChart !== 'function') throw 0;
        killerChart = charts.createScatterChart({
            data: () => { sTick(); return killerData; },
            x: 'x', y: 'y', color: COL.cyan, markerSize: 3, fillOpacity: 0.7,
            grid: { x: true, y: true, color: COL.line }, crosshair: false, tooltip: false,
            xTitle: 'service latency (p50)', yTitle: 'picks/sec',
            yScale: { zero: true },
            margin: { top: 10, right: 14, bottom: 34, left: 48 }, ...axis,
        }).mount(killerHost);
    } catch (e) { killerChart = null; killerFallback = makeCanvas(killerHost); }

    const anyChart = !!(heatChart || fairChart || killerChart);
    paintBacking($backRender, anyChart ? 'lite-charts' : 'canvas (fallback)', anyChart);
}

/* -------------------------------------------------------------- per-frame chart data refresh --- */

function refreshCharts() {
    buildHeatData();
    buildLorenz();
    pushKiller();
    // Fallback canvases redraw imperatively; lite-charts panels re-extract from sTick() in their thunk.
    if (heatFallback) drawHeatFallback();
    if (fairFallback) drawFairFallback();
    if (killerFallback) drawKillerFallback();
    drawFingerprint();
    drawGiniGauge();
}

/* ================================================================================ DOM panels === */

const BADGE_DEFS = [
    ['osc', 'osc', '∿', (d) => 'OSCILLATION w' + d.oscWorker],
    ['ping', 'ping', '⇄', (d) => 'PING-PONG w' + d.pingA + '/w' + d.pingB],
    ['starv', 'starv', '∅', (d) => 'STARVATION w' + d.starvWorker],
    ['unfair', 'unfair', '⚖', () => 'UNFAIR'],
    ['over', 'over', '▲', (d) => 'OVERLOAD w' + d.overWorker + '=' + d.overLoad],
];

function paintAlarm() {
    if (det.activeCount === 0) {
        $alarm.className = 'alarm nominal';
        $alarmText.textContent = 'SYSTEM NOMINAL';
        $alarmSub.textContent = 'no pathology detected';
        $badges.textContent = '';
        return;
    }
    $alarm.className = 'alarm alert';
    $alarmText.textContent = 'PATHOLOGY DETECTED / ' + det.activeCount;
    $alarmSub.textContent = det.activeCount === 1 ? '1 fault' : det.activeCount + ' faults';
    let html = '';
    for (let i = 0; i < BADGE_DEFS.length; i++) {
        const [flag, cls, glyph, txt] = BADGE_DEFS[i];
        if (det[flag]) html += '<span class="badge ' + cls + '">' + glyph + ' ' + txt(det) + '</span>';
    }
    $badges.innerHTML = html;
}

function paintHeader() {
    $headStrategy.textContent = drv.strategyName;
    $headLive.textContent = snap.live + '/' + CAP;
    $headInflight.textContent = String(snap.totalInflight);
    $headThr.textContent = String(snap.curThroughput | 0);
    const suffix = drv.hasLatSketch ? ' (±1%)' : '';
    $headLat.textContent = snap.p50.toFixed(0) + '/' + snap.p95.toFixed(0) + '/' + snap.p99.toFixed(0) + 'ms' + suffix;
}

// worker row order buffer (reused, avoids per-frame alloc growth beyond the CAP-length array)
const order = new Int32Array(CAP);
function paintTable() {
    const key = sSort.peek();
    for (let i = 0; i < CAP; i++) order[i] = i;
    // small insertion sort over CAP (12) by the chosen key, descending (w ascending).
    const val = (i) => key === 'share' ? snap.wShare[i] : key === 'lat' ? p95Of(i) : key === 'w' ? -i : snap.wInflight[i];
    for (let a = 1; a < CAP; a++) {
        const cur = order[a]; const cv = val(cur); let b = a - 1;
        while (b >= 0 && val(order[b]) < cv) { order[b + 1] = order[b]; b--; }
        order[b + 1] = cur;
    }
    const sel = sSelected.peek();
    let maxLoad = 1;
    for (let i = 0; i < CAP; i++) if (snap.wInflight[i] > maxLoad) maxLoad = snap.wInflight[i];
    let html = '';
    for (let r = 0; r < CAP; r++) {
        const i = order[r];
        const share = (snap.wShare[i] * 100);
        const load = snap.wInflight[i];
        const p95 = p95Of(i);
        const barW = Math.max(1, (load / maxLoad) * 46) | 0;
        const barCol = ramp(load / (maxLoad || 1));
        html += '<tr data-w="' + i + '" data-down="' + (snap.wEligible[i] ? 0 : 1) + '"' +
            (i === sel ? ' aria-selected="true"' : '') + '>' +
            '<td>w' + i + '</td>' +
            '<td>' + share.toFixed(1) + '%</td>' +
            '<td><span class="minibar" style="width:' + barW + 'px;background:' + barCol + '"></span> ' + load + '</td>' +
            '<td>' + (p95 === p95 ? p95.toFixed(0) : '-') + '</td></tr>';
    }
    $wtableBody.innerHTML = html;
}

function p95Of(i) {
    const q = drv.latWorkerQuantile(i, 0.95);
    return q === q ? q : NaN;
}

function paintInspector() {
    const i = sSelected.peek();
    if (i < 0) { $inspector.innerHTML = '<h2>Inspector</h2><div class="empty">select a worker to inspect</div>'; return; }
    const rows = [
        ['worker', 'w' + i],
        ['state', snap.wEligible[i] ? 'up' : 'DOWN'],
        ['weight', String(drv.weights[i])],
        ['inflight', String(snap.wInflight[i])],
        ['share', (snap.wShare[i] * 100).toFixed(1) + '%'],
        ['ewma cost', fmt(drv.ewmaOf(i))],
        ['occupancy cap', fmt(drv.capOf(i))],
        ['p50', fmt(drv.latWorkerQuantile(i, 0.5))],
        ['p95', fmt(drv.latWorkerQuantile(i, 0.95))],
        ['p99', fmt(drv.latWorkerQuantile(i, 0.99))],
    ];
    let html = '<h2>Inspector <span class="hint">w' + i + '</span></h2>';
    for (let r = 0; r < rows.length; r++) html += '<div class="kv"><span class="k">' + rows[r][0] + '</span><span>' + rows[r][1] + '</span></div>';
    $inspector.innerHTML = html;
}
function fmt(v) { return v === v ? (v).toFixed(1) : '-'; }

function paintHotKeys() {
    if (!drv.keyed) { $hotkeysPanel.hidden = true; return; }
    $hotkeysPanel.hidden = false;
    const n = drv.hotKeys(hotKeyBuf);
    const mass = drv.keyMass();
    if (n === 0 || mass <= 0) { $hotkeysList.innerHTML = '<div class="empty">warming up&hellip;</div>'; return; }
    let html = '';
    for (let e = 0; e < n; e++) {
        const key = hotKeyBuf[e];
        const share = drv.keyFreq[key] / mass;
        const wk = drv.keyWorker[key];
        html += '<div class="hk"><span style="color:' + COL.cyan + '">key ' + key + '</span>' +
            '<span class="track"><span class="fill" style="width:' + (share * 100).toFixed(1) + '%"></span></span>' +
            '<span style="color:' + COL.faint + '">' + (share * 100).toFixed(1) + '% → w' + (wk >= 0 ? wk : '?') + '</span></div>';
    }
    $hotkeysList.innerHTML = html;
}

/* ---------------------------------------------------------------- the reactive redraw effect --- */

// One effect keyed on the render-version + the control-state signals: redraws every DOM panel.
// The lite-charts panels re-extract independently off sTick() in their own data thunks.
effect(() => {
    sTick(); sStrategy(); sSelected(); sSort();
    paintHeader();
    paintAlarm();
    paintTable();
    paintInspector();
    paintHotKeys();
});

/* ------------------------------------------------------------------------------ the main loop --- */

// Data path (0-alloc, same as the TUI): begin frame -> tick x3 -> build -> evaluate. Then refresh the
// render layer (chart arrays + canvases) and bump the render-version so the effect + chart thunks fire.
function frame() {
    drv.beginFrame(FRAME_SECONDS);
    for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick();
    snap.build(drv);
    det.evaluate(snap);
    refreshCharts();
    sTick.set(sTick.peek() + 1);
}

/* --------------------------------------------------------------------------------- controls ---- */

function setStrategy(name) {
    if (STRATEGIES.indexOf(name) < 0) return;
    drv.setStrategy(name);
    det.reset();
    sStrategy.set(name);
    $strategySelect.value = name;
}

function inject(kind) {
    if (kind === 'kill') { drv.conc = 150; drv.killWorker(killIdx); killIdx = (killIdx + 2) % CAP; }
    else if (kind === 'overload') drv.overloadSpike((CAP / 2) | 0);
    else if (kind === 'flap') drv.flapStorm((CAP / 3) | 0);
    else if (kind === 'pingpong') drv.forcePingPong(2, CAP - 4);
    else if (kind === 'unfair') drv.makeUnfair();
    else if (kind === 'starve') drv.makeStarve();
    else if (kind === 'hotkeys') drv.makeHotKeys();
    else if (kind === 'reset') {
        const cur = drv.strategyName;
        drv = new Driver(CAP);
        drv.setStrategy(cur);
        det.reset();
        killIdx = 1;
        activeInjectors.clear();
        for (const b of document.querySelectorAll('button.ctl.inject')) b.setAttribute('aria-pressed', 'false');
        return;
    }
    if (kind !== 'reset') {
        activeInjectors.add(kind);
        const b = document.querySelector('button.ctl.inject[data-inject="' + kind + '"]');
        if (b) b.setAttribute('aria-pressed', 'true');
    }
}

// strategy select
for (let i = 0; i < STRATEGIES.length; i++) {
    const o = document.createElement('option');
    o.value = STRATEGIES[i]; o.textContent = (i === 9 ? 0 : i + 1) + '  ' + STRATEGIES[i];
    $strategySelect.appendChild(o);
}
$strategySelect.value = 'p2c';
$strategySelect.addEventListener('change', () => setStrategy($strategySelect.value));
$btnNext.addEventListener('click', () => setStrategy(STRATEGIES[(STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length]));

for (const b of document.querySelectorAll('button.ctl.inject, button.ctl[data-inject]')) {
    b.addEventListener('click', () => inject(b.getAttribute('data-inject')));
}

// scene tabs
$tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-scene]');
    if (!btn) return;
    for (const t of $tabs.querySelectorAll('button')) t.setAttribute('aria-selected', String(t === btn));
    $stage.setAttribute('data-scene', btn.getAttribute('data-scene'));
});

// worker table: sort + row select
$wtable.querySelector('thead').addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-sort]');
    if (th) sSort.set(th.getAttribute('data-sort'));
});
$wtableBody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-w]');
    if (!tr) return;
    const w = tr.getAttribute('data-w') | 0;
    sSelected.set(sSelected.peek() === w ? -1 : w);
});

// keyboard (mirror the TUI)
globalThis.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k >= '1' && k <= '9') setStrategy(STRATEGIES[k.charCodeAt(0) - 49]);
    else if (k === '0') setStrategy(STRATEGIES[9]);
    else if (k === 'n') setStrategy(STRATEGIES[(STRATEGIES.indexOf(drv.strategyName) + 1) % STRATEGIES.length]);
    else if (k === 'k') inject('kill');
    else if (k === 'o') inject('overload');
    else if (k === 'f') inject('flap');
    else if (k === 'p') inject('pingpong');
    else if (k === 'u') inject('unfair');
    else if (k === 's') inject('starve');
    else if (k === 'r') inject('reset');
});

/* ----------------------------------------------------------------------------------- startup --- */

// Auto-run the healthy scenario on load (design brief: show the app at rest, calm baseline).
await initCharts();
// Warm the rings so the first painted frame is settled (no short-window transient blips).
for (let f = 0; f < 40; f++) { drv.beginFrame(FRAME_SECONDS); for (let t = 0; t < TICKS_PER_FRAME; t++) drv.tick(); snap.build(drv); det.evaluate(snap); }
frame();
setInterval(frame, FRAME_MS);
