/**
 * @zakkster/lite-pick -- benchmark report + drift check (M6, accounting site 13).
 *
 *     node --expose-gc benchmark/Report.mjs            # emit results.json + render README
 *     node benchmark/Report.mjs --render               # re-render README from results.json
 *     node benchmark/Report.mjs --verify               # bench:verify -- drift check (teeth)
 *
 * Two jobs (RESEARCH section 3, reproducibility machinery):
 *   (a) EMIT results.json -- stamp Node version / CPU model / OS / every PRNG seed alongside
 *       the measured numbers, and render the README fenced numbers from it.
 *   (b) VERIFY -- re-check every README fenced number so a hand-edit fails CI. ALGORITHMIC
 *       numbers (balance peak-gap, disruption remap %) are recomputed FRESH and compared
 *       EXACT; TIMING numbers (GC pauses) are compared to results.json within +/-15% (a
 *       fresh timing run is noisy, so the stored run is the reference -- teeth without flake).
 *
 * README numbers live inside `<!-- bench:ID -->` ... `<!-- /bench:ID -->` fences; this file
 * is the sole writer of what is between them. Requires --expose-gc for the GC lane (emit).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { P2cBalancer, RoundRobinBalancer, Prng, VERSION } from '../Pick.js';
import { SEEDS } from './Matrix.mjs';
import { measureGcBlastRadius } from './GcBlastRadius.mjs';
import { measureDisruption } from './Disruption.mjs';
import { measureFairness } from './Fairness.mjs';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const RESULTS = fileURLToPath(new URL('./results.json', import.meta.url));
const TIMING_TOLERANCE = 0.15; // +/-15% band for timing numbers (algorithmic is exact)

// --- deterministic (algorithmic) measurements -- recomputed fresh in verify -------------

/** The P2C balance anchor: peak-gap vs the random foil + the ln ln n ceiling, seeded. */
function measureBalance() {
    const k = 32; // mean load (balls per bin)
    const rows = [];
    for (const n of [64, 1024, 4096]) {
        const el = new Uint8Array(n); el.fill(1);
        const picks = k * n;
        const p2cLoad = new Uint32Array(n);
        const p2c = new P2cBalancer(n, el, p2cLoad, SEEDS.p2c);
        for (let i = 0; i < picks; i++) p2cLoad[p2c.pick()]++;
        const rndLoad = new Uint32Array(n);
        const rng = new Prng(SEEDS.p2c);
        for (let i = 0; i < picks; i++) rndLoad[rng.nextBelow(n)]++;
        let p2cMax = 0, rndMax = 0;
        for (let i = 0; i < n; i++) {
            if (p2cLoad[i] > p2cMax) p2cMax = p2cLoad[i];
            if (rndLoad[i] > rndMax) rndMax = rndLoad[i];
        }
        const ceiling = 4 * (Math.log(Math.log(n)) / Math.LN2) + 4;
        rows.push({ n, p2cGap: p2cMax - k, rndGap: rndMax - k, ceiling });
    }
    return rows;
}

// --- REAL npm competitor baseline (pinned devDeps) -- stamped into results.json ----------
// The three incumbents are OLD/CommonJS; load them via createRequire and time a comparable
// pick loop -- and, apples-to-apples, the lite-pick counterpart strategy through the SAME
// timeLoop on the SAME n=1024 pool. If a competitor refuses to load it becomes a labeled
// 'unavailable' row (NOT silently dropped) so the gap is disclosed. The framing is strictly
// PARITY -- ops/ms side by side, NEVER "faster"/"Nx": a trivial foil ties an honest strategy
// on raw throughput, so the wins are the contract + balance + tail, claimed elsewhere.

const COMPETITOR_N = 1024;
const COMPETITOR_OPS = 500000;

function timeLoop(step) {
    let sink = 0;
    for (let i = 0; i < COMPETITOR_OPS; i++) sink = (sink + (step() | 0)) | 0; // warmup
    const t0 = performance.now();
    for (let i = 0; i < COMPETITOR_OPS; i++) sink = (sink + (step() | 0)) | 0;
    void sink;
    return COMPETITOR_OPS / (performance.now() - t0);
}

function measureCompetitors() {
    const require = createRequire(import.meta.url);
    const n = COMPETITOR_N;
    const rows = [];
    const timeCompetitor = (pkg, version, wire) => {
        try {
            return { pkg, version, status: 'ok', opsPerMs: timeLoop(wire(require(pkg))) };
        } catch (e) {
            return { pkg, version, status: 'unavailable', error: String(e && e.message || e) };
        }
    };

    // P2C family -- lite-pick P2cBalancer vs load-balancers' P2cBalancer. SAME complexity
    // class (both O(1)/O(d)) -- a TRUE parity comparison.
    {
        const el = new Uint8Array(n).fill(1);
        const inflight = new Uint32Array(n);
        for (let i = 0; i < n; i++) inflight[i] = i & 15;
        const p2c = new P2cBalancer(n, el, inflight, SEEDS.p2c);
        rows.push({
            family: 'P2C (power-of-two-choices)',
            litePick: { strategy: 'P2cBalancer', status: 'ok', opsPerMs: timeLoop(() => p2c.pick()) },
            competitor: timeCompetitor('load-balancers', '1.3.52',
                (m) => { const b = new m.P2cBalancer(n); return () => b.pick(); }),
        });
    }
    // RoundRobin family -- lite-pick RoundRobinBalancer vs loadbalance's roundRobin engine.
    // SAME complexity class (both O(1)) -- a TRUE parity comparison.
    {
        const el = new Uint8Array(n).fill(1);
        const rr = new RoundRobinBalancer(n, el);
        rows.push({
            family: 'RoundRobin',
            litePick: { strategy: 'RoundRobinBalancer', status: 'ok', opsPerMs: timeLoop(() => rr.pick()) },
            competitor: timeCompetitor('loadbalance', '1.0.0', (m) => {
                const arr = []; for (let i = 0; i < n; i++) arr.push(i);
                const e = m.roundRobin(arr); return () => e.pick();
            }),
        });
    }
    // Weighted-random family -- wrr is O(1) weighted-RANDOM. lite-pick's O(1) weighted-random
    // (WeightedRandom, alias table) lands at M10, so its parity cell is a PENDING SKIP, NOT a
    // race against our shipped SmoothWRR (which is O(cap) smooth weighted round-robin -- a
    // different, stronger-smoothness guarantee, and a different complexity class). Pairing
    // those two would be apples-to-oranges. SmoothWRR's own O(cap) throughput is measured by
    // the witness + the throughput matrix; it is NOT force-fit into this parity table. The wrr
    // incumbent stays visible; the honest lite-pick counterpart is disclosed as pending.
    {
        rows.push({
            family: 'Weighted-random',
            litePick: { strategy: 'WeightedRandom', status: 'pending', milestone: 'M10' },
            competitor: timeCompetitor('wrr', '1.0.0', (m) => {
                const entries = []; for (let i = 0; i < n; i++) entries.push({ weight: 1 + (i & 7), item: i });
                const next = m(entries); return () => next();
            }),
        });
    }
    return rows;
}

// --- the fenced-block registry (render + verify share one builder) ----------------------
// buildBlocks(data) returns, per block id: the markdown lines inside the fence AND the
// ordered verify entries -- one entry per NUMBER, in the order the numbers appear. render
// joins the lines; verify parses README numbers and aligns them to entries by position.

function fmt1(x) { return x.toFixed(1); }

function buildBlocks(data) {
    // Fail closed on a partial results.json (e.g. bench:gc / bench:report never ran) rather
    // than throwing an opaque TypeError mid-render.
    if (!data.gc || !data.gc.litePick || !data.gc.foil) {
        throw new Error('results.json missing gc metric -- run bench:gc (or bench:report) first');
    }
    if (!data.balance || !data.disruption) {
        throw new Error('results.json missing balance/disruption metric -- run bench:report first');
    }
    if (!data.competitors) {
        throw new Error('results.json missing competitors metric -- run bench:report first');
    }
    const blocks = {};

    // bench:balance -- headline #1 (all exact, seeded).
    {
        const lines = [
            '| pool n | P2C peak-gap | random foil peak-gap | ceiling |',
            '| --- | --- | --- | --- |',
        ];
        const entries = [];
        for (const r of data.balance) {
            lines.push('| ' + r.n + ' | ' + r.p2cGap + ' | ' + r.rndGap + ' | ' + fmt1(r.ceiling) + ' |');
            entries.push({ kind: 'exact', value: r.n });
            entries.push({ kind: 'exact', value: r.p2cGap });
            entries.push({ kind: 'exact', value: r.rndGap });
            entries.push({ kind: 'exact', value: Number(fmt1(r.ceiling)) });
        }
        blocks.balance = { lines, entries };
    }

    // bench:gc -- headline #2 (lite-pick 0/0 exact; foil major >=1; pauses timing).
    {
        const g = data.gc;
        const lines = [
            '| lane | major GC | pick B/op | max GC pause (ms) |',
            '| --- | --- | --- | --- |',
            '| lite-pick | ' + g.litePick.major + ' | ' + g.litePick.bpop + ' | ' +
                fmt1(g.litePick.maxPauseMs) + ' |',
            '| allocating foil | ' + g.foil.major + ' | allocates | ' +
                fmt1(g.foil.maxPauseMs) + ' |',
        ];
        const entries = [
            { kind: 'exact', value: g.litePick.major },   // lite-pick major GC
            { kind: 'exact', value: g.litePick.bpop },    // lite-pick pick B/op
            { kind: 'timing', value: Number(fmt1(g.litePick.maxPauseMs)) },
            { kind: 'atLeast', value: g.foil.major, threshold: 1 }, // foil major GC
            { kind: 'timing', value: Number(fmt1(g.foil.maxPauseMs)) },
        ];
        blocks.gc = { lines, entries };
    }

    // bench:disruption -- trust gate. Naive-modulo remap %, the REAL Maglev remap % (measured at
    // M8), and the 1/n ideal -- all exact (seeded keys + deterministic Maglev build).
    {
        const d = data.disruption;
        const labels = ['node removed', 'node added'];
        const lines = [
            '| scale event | naive-modulo remap | ConsistentHash (Maglev) | ideal (1/n) |',
            '| --- | --- | --- | --- |',
        ];
        const entries = [];
        for (let i = 0; i < d.naiveModulo.length; i++) {
            const m = d.naiveModulo[i];
            const c = d.consistentHash[i];
            lines.push('| ' + labels[i] + ' | ' + fmt1(m.remapPct) + '% | ' +
                fmt1(c.remapPct) + '% | ' + fmt1(m.idealPct) + '% |');
            entries.push({ kind: 'exact', value: Number(fmt1(m.remapPct)) });
            entries.push({ kind: 'exact', value: Number(fmt1(c.remapPct)) });
            entries.push({ kind: 'exact', value: Number(fmt1(m.idealPct)) });
        }
        blocks.disruption = { lines, entries };
    }

    // bench:competitors -- throughput PARITY vs the real pinned npm incumbents (timing band).
    // ops/ms side by side, same n=1024 pool, same harness. NO "faster"/"Nx" framing.
    {
        const c = data.competitors;
        const lines = [
            '| family | lite-pick | lite-pick ops/ms | incumbent (npm) | incumbent ops/ms |',
            '| --- | --- | --- | --- | --- |',
        ];
        const entries = [];
        for (const row of c) {
            const lp = row.litePick;
            // lite-pick side: a timed O(1) parity strategy, or a disclosed pending SKIP (M10).
            const lpStrategy = lp.status === 'pending'
                ? lp.strategy + ' -- SKIP, ships ' + lp.milestone
                : lp.strategy;
            const lpCell = lp.status === 'pending' ? '--' : String(Math.round(lp.opsPerMs));
            const inc = row.competitor;
            const incName = inc.pkg + '@' + inc.version;
            const incCell = inc.status === 'ok' ? String(Math.round(inc.opsPerMs)) : 'unavailable';
            lines.push('| ' + row.family + ' | ' + lpStrategy + ' | ' + lpCell +
                ' | ' + incName + ' | ' + incCell + ' |');
            if (lp.status !== 'pending') entries.push({ kind: 'timing', value: Math.round(lp.opsPerMs) });
            if (inc.status === 'ok') entries.push({ kind: 'timing', value: Math.round(inc.opsPerMs) });
        }
        blocks.competitors = { lines, entries };
    }

    return blocks;
}

// --- README fence splice + parse --------------------------------------------------------

function fenceRegion(id) {
    const open = '<!-- bench:' + id + ' -->';
    const close = '<!-- /bench:' + id + ' -->';
    return { open, close };
}

function renderReadme(blocks) {
    let text = readFileSync(README, 'utf8');
    for (const id of Object.keys(blocks)) {
        const { open, close } = fenceRegion(id);
        const oi = text.indexOf(open);
        const ci = text.indexOf(close);
        if (oi === -1 || ci === -1) {
            throw new Error('README missing fence for bench:' + id + ' (' + open + ' .. ' + close + ')');
        }
        const body = '\n\n' + blocks[id].lines.join('\n') + '\n\n';
        text = text.slice(0, oi + open.length) + body + text.slice(ci);
    }
    writeFileSync(README, text);
}

/**
 * Extract the numbers between a fence, in order. Only cells that are PURELY numeric count
 * (optionally with a trailing %), so a digit inside a label -- the `2` in `P2C`, `B/op`,
 * `M8` -- is never mistaken for a value. Cells are the `|`-delimited table fields.
 */
const PURE_NUMBER = /^-?\d+(?:\.\d+)?%?$/;
function parseFenceNumbers(text, id) {
    const { open, close } = fenceRegion(id);
    const oi = text.indexOf(open);
    const ci = text.indexOf(close);
    if (oi === -1 || ci === -1) throw new Error('README missing fence for bench:' + id);
    const body = text.slice(oi + open.length, ci);
    const nums = [];
    for (const line of body.split('\n')) {
        for (const cell of line.split('|')) {
            const c = cell.trim();
            if (PURE_NUMBER.test(c)) nums.push(parseFloat(c));
        }
    }
    return nums;
}

// --- emit -------------------------------------------------------------------------------

async function emit() {
    if (typeof globalThis.gc !== 'function') {
        throw new Error('Report emit needs --expose-gc: node --expose-gc benchmark/Report.mjs');
    }
    const balance = measureBalance();
    const gc = await measureGcBlastRadius();
    const disruption = measureDisruption();
    const fairness = measureFairness();
    const competitors = measureCompetitors();

    const results = {
        schema: 'lite-pick-bench/1',
        version: VERSION,
        generatedAt: new Date().toISOString(),
        env: {
            node: process.version,
            v8: process.versions.v8,
            cpu: (os.cpus()[0] && os.cpus()[0].model) || 'unknown',
            cores: os.cpus().length,
            arch: process.arch,
            os: os.type() + ' ' + os.release(),
            platform: process.platform,
        },
        seeds: SEEDS,
        results: { balance, gc, disruption, fairness, competitors },
    };
    writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');

    const blocks = buildBlocks({ balance, gc, disruption, fairness, competitors });
    renderReadme(blocks);
    process.stdout.write('bench:report -- wrote results.json (' + results.env.node + ', ' +
        results.env.cpu + ') and rendered ' + Object.keys(blocks).length + ' README fences\n');
}

function render() {
    const stored = JSON.parse(readFileSync(RESULTS, 'utf8'));
    const blocks = buildBlocks(stored.results);
    renderReadme(blocks);
    process.stdout.write('bench:report -- re-rendered README fences from results.json\n');
}

// --- verify (bench:verify -- the teeth) -------------------------------------------------

function approxEqual(a, b, tol) {
    const band = Math.max(Math.abs(b) * tol, 0.5); // absolute floor for sub-ms pauses
    return Math.abs(a - b) <= band;
}

function verify() {
    let stored;
    try {
        stored = JSON.parse(readFileSync(RESULTS, 'utf8'));
    } catch {
        process.stderr.write('bench:verify: FAIL -- results.json missing or unreadable; run `npm run bench:report` first\n');
        process.exit(1);
    }
    // Recompute the ALGORITHMIC blocks FRESH; keep the TIMING blocks (gc, competitors) from
    // results.json -- the stored, machine-independent reference the +/-15% band checks against.
    const refData = {
        balance: measureBalance(),
        disruption: measureDisruption(),
        fairness: measureFairness(),
        gc: stored.results.gc,
        competitors: stored.results.competitors,
    };
    const blocks = buildBlocks(refData);
    const text = readFileSync(README, 'utf8');

    const failures = [];
    for (const id of Object.keys(blocks)) {
        const entries = blocks[id].entries;
        let parsed;
        try { parsed = parseFenceNumbers(text, id); } catch (e) { failures.push(e.message); continue; }
        if (parsed.length !== entries.length) {
            failures.push('bench:' + id + ': README has ' + parsed.length +
                ' numbers, expected ' + entries.length + ' (a number was added or removed)');
            continue;
        }
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const got = parsed[i];
            if (e.kind === 'exact') {
                if (got !== e.value) {
                    failures.push('bench:' + id + '[' + i + ']: README ' + got +
                        ' != fresh ' + e.value + ' (exact)');
                }
            } else if (e.kind === 'atLeast') {
                if (!(got >= e.threshold)) {
                    failures.push('bench:' + id + '[' + i + ']: README ' + got +
                        ' < threshold ' + e.threshold);
                }
            } else { // timing: within +/-15% of the stored reference
                if (!approxEqual(got, e.value, TIMING_TOLERANCE)) {
                    failures.push('bench:' + id + '[' + i + ']: README ' + got +
                        ' outside +/-15% of stored ' + e.value + ' (timing)');
                }
            }
        }
    }

    if (failures.length) {
        process.stderr.write('bench:verify: FAIL -- README fenced numbers drifted from source:\n');
        for (const f of failures) process.stderr.write('  ' + f + '\n');
        process.exit(1);
    }
    process.stdout.write('bench:verify: PASS -- all README fenced numbers match source ' +
        '(algorithmic exact, timing within +/-15%)\n');
}

// --- entry ------------------------------------------------------------------------------

if (import.meta.url === 'file://' + process.argv[1]) {
    const mode = process.argv[2];
    try {
        if (mode === '--verify') verify();
        else if (mode === '--render') render();
        else await emit();
    } catch (e) {
        // Fail closed with a clean message (e.g. a partial results.json) -- no stack trace.
        process.stderr.write('bench:report: FAIL -- ' + (e && e.message ? e.message : String(e)) + '\n');
        process.exit(1);
    }
}
