/**
 * @zakkster/lite-pick soak -- the release-time A/B RUNNER (research/soak-release-ab.md, #8b).
 *
 *   npm run soak:ab -- --prev 1.1.0 [--rounds 10] [--seed N] [--order-seed N]
 *                      [--out-dir DIR] [--accept FILE] [--aa]
 *   npm run soak:ab -- --a-dir DIR --b-dir DIR [...]        (local control mode; NOT RELEASE EVIDENCE)
 *
 * It owns the SIDE EFFECTS the pure analyser (ab-analyse.mjs) refuses to: packing the two kernels
 * (ab-pack.mjs), spawning the K rounds of A/B soak processes in a balanced seeded order, parsing their
 * JSONL streams, and the exit code. The statistics and the FAIL/PASS/INCONCLUSIVE rule live entirely in
 * ab-analyse.mjs; this file adds only the provenance, the process orchestration and the stream checks.
 *
 * Shape (D3-D9):
 *   - A = the previous registry release (integrity-checked three ways); B = npm pack of the tree,
 *     Pick.js/Pool.js == parity.json, VERSION == package.json. Both loaded through SOAK_KERNEL/SOAK_POOL
 *     from equal-length sibling paths <out>/A/package and <out>/B/package.
 *   - One CALIBRATION process per side (self-calibrating the hotOps batch), then every round PINS
 *     max(N_A, N_B) per lane+metric via SOAK_HOTOPS_N so a slower B cannot time a different batch.
 *   - K rounds, balancedOrder(K, orderSeed): one A and one B process each, one fixed workload SOAK_SEED.
 *   - Per process, per kernel lane: the median hotOps over the MEASURED cycles (cycle >= warmupCycles).
 *   - Verdict: FAIL (any B process failed its own soak, or a gated comparison FAILs), else INCONCLUSIVE
 *     (any precondition failed, stream problem, batch-length mismatch, A not PASS, or a comparison
 *     INCONCLUSIVE), else PASS. Exit 0 / 1 / 3; 2 for bad configuration. Fail closed on everything.
 *
 * The runner REFUSES to run with any SOAK_* already in its environment (exit 2): the sides' env is built
 * here, and an inherited SOAK_* would silently change what a process runs. Zero runtime deps.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchRelease, packTree, hashUnpacked } from './ab-pack.mjs';
import { analyse, validateAcceptance, balancedOrder, METRICS, KERNEL_LANES } from './ab-analyse.mjs';
import { medianOf, exitCodeFor } from './gates.mjs';
import { editDistance } from './config.mjs';

// The ten kernel lanes, in roster order, come from the PURE analyser (ab-analyse.mjs, which imports
// gates.mjs only) so the roster has a single source and the acceptance file validates against the SAME
// list the runner compares. The runner stays kernel-AGNOSTIC -- it loads kernels from tarballs, never the
// tree -- so it must not import lanes.mjs (which would pull in the in-tree Pick.js via kernel.mjs).

const CHILD_FLAGS = ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];
const MAIN = fileURLToPath(new URL('./main.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_ACCEPT = fileURLToPath(new URL('./ab-accept.json', import.meta.url));

const PROC_TIMEOUT_MS = 10 * 60 * 1000;   // per-process hard cap (research 5.5)
const ROUNDS_MIN = 8;                      // the exact MW floor at 20 comparisons is K=6; 8 leaves room (D7)
const ROUNDS_MAX = 40;
const DEFAULT_ROUNDS = 10;
const DEFAULT_SEED = 0xC0FFEE >>> 0;       // the soak's own default workload seed (config.mjs, D4)
const DEFAULT_ORDER_SEED = 0;

const KNOWN_FLAGS = [
    '--prev', '--rounds', '--seed', '--order-seed', '--out-dir', '--accept', '--aa', '--a-dir', '--b-dir', '--help',
];
const VALUE_FLAGS = new Set(['--prev', '--rounds', '--seed', '--order-seed', '--out-dir', '--accept', '--a-dir', '--b-dir']);

function die(code, msg) { process.stderr.write('soak:ab: ' + msg + '\n'); process.exit(code); }

// editDistance is the soak's one shared Levenshtein (config.mjs, exported for exactly this reuse); the
// runner keeps no private copy. config.mjs is a zero-dep, zero-import cold module, so the Node 18
// no-install CLI path (exit-2 arg checks) still loads nothing from node_modules.
function didYouMean(flag) {
    let best = null, bestD = Infinity;
    for (const k of KNOWN_FLAGS) { const d = editDistance(flag, k); if (d < bestD) { bestD = d; best = k; } }
    return bestD <= Math.max(2, (flag.length / 3) | 0) ? best : null;
}

const USAGE =
    'soak:ab -- release-time relative soak A/B (#8b)\n' +
    '  --prev <version>    the previous registry release (A side); required unless --a-dir/--b-dir\n' +
    '  --rounds <n>        rounds per side, ' + ROUNDS_MIN + '..' + ROUNDS_MAX + ' (default ' + DEFAULT_ROUNDS + ')\n' +
    '  --seed <uint32>     the one fixed workload seed (default 0x' + DEFAULT_SEED.toString(16) + ')\n' +
    '  --order-seed <n>    the balanced-order shuffle seed (default ' + DEFAULT_ORDER_SEED + ')\n' +
    '  --out-dir <dir>     where plan.json / streams/ / analysis.json are written\n' +
    '  --accept <file>     per-version acceptance file (default benchmark/soak/ab-accept.json if present)\n' +
    '  --aa                A/A control: use the registry release for BOTH sides\n' +
    '  --a-dir <dir>       control mode: an already-unpacked package dir for A (NOT RELEASE EVIDENCE)\n' +
    '  --b-dir <dir>       control mode: an already-unpacked package dir for B (NOT RELEASE EVIDENCE)\n' +
    '  --help              this message\n';

function parseUint(name, raw) {
    if (!/^\d+$/.test(raw)) die(2, name + " '" + raw + "' must be a non-negative integer");
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) die(2, name + " '" + raw + "' out of range [0, 4294967295]");
    return v >>> 0;
}

function parseArgs(argv) {
    const a = {
        prev: null, rounds: DEFAULT_ROUNDS, seed: DEFAULT_SEED, orderSeed: DEFAULT_ORDER_SEED,
        outDir: null, accept: null, aa: false, aDir: null, bDir: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--help' || v === '-h') { process.stdout.write(USAGE); process.exit(0); }
        if (v === '--aa') { a.aa = true; continue; }
        if (VALUE_FLAGS.has(v)) {
            const val = argv[i + 1];
            if (val === undefined || val === '' || val.startsWith('--')) die(2, v + ' needs a value');
            i++;
            if (v === '--prev') a.prev = val;
            else if (v === '--rounds') {
                if (!/^\d+$/.test(val)) die(2, "--rounds '" + val + "' must be an integer");
                const n = Number(val);
                if (n < ROUNDS_MIN || n > ROUNDS_MAX) die(2, '--rounds ' + n + ' out of range [' + ROUNDS_MIN + ', ' + ROUNDS_MAX + ']');
                a.rounds = n;
            }
            else if (v === '--seed') a.seed = parseUint('--seed', val);
            else if (v === '--order-seed') a.orderSeed = parseUint('--order-seed', val);
            else if (v === '--out-dir') a.outDir = val;
            else if (v === '--accept') a.accept = val;
            else if (v === '--a-dir') a.aDir = val;
            else if (v === '--b-dir') a.bDir = val;
            continue;
        }
        if (v.startsWith('--')) { const s = didYouMean(v); die(2, 'unknown flag ' + v + (s ? ' -- did you mean ' + s + '?' : '')); }
        die(2, 'unexpected argument ' + v);
    }
    // Mode resolution + mutual exclusion.
    const control = a.aDir !== null || a.bDir !== null;
    if (control) {
        if (a.aDir === null || a.bDir === null) die(2, '--a-dir and --b-dir must be given together (control mode)');
        if (a.prev !== null) die(2, '--prev cannot be combined with --a-dir/--b-dir (control mode has no registry side)');
        if (a.aa) die(2, '--aa cannot be combined with --a-dir/--b-dir');
        a.mode = 'control';
    } else if (a.aa) {
        if (a.prev === null) die(2, '--aa needs --prev (the registry release used for both sides)');
        a.mode = 'aa';
    } else {
        if (a.prev === null) die(2, '--prev <version> is required (or --a-dir/--b-dir for a control run)');
        a.mode = 'release';
    }
    return a;
}

/** Spawn one soak process. Returns { exit, signal, timedOut }. Writes its JSONL to streamPath. */
function runProcess({ dir, pin, seed, streamPath }) {
    const env = Object.assign({}, process.env, {
        SOAK_SMOKE: '1',
        SOAK_TIERS: 'kernel',
        SOAK_SEED: String(seed >>> 0),
        SOAK_KERNEL: join(dir, 'Pick.js'),
        SOAK_POOL: join(dir, 'Pool.js'),
        SOAK_OUT: streamPath,
    });
    if (pin) env.SOAK_HOTOPS_N = pin;
    const r = spawnSync(process.execPath, CHILD_FLAGS.concat([MAIN]), {
        cwd: REPO_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: PROC_TIMEOUT_MS,
    });
    // Persist the child's stderr next to its stream: a baseline that CANNOT run (e.g. a pre-setWeights
    // kernel: "setWeights is not a function") leaves its real cause on disk for the INCONCLUSIVE report,
    // rather than only an exit code. Best-effort; a timed-out child may have written nothing.
    const errText = String(r.stderr || '');
    if (errText.length) { try { writeFileSync(streamPath + '.err', errText); } catch (e) { /* best effort */ } }
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    const exit = r.status === null ? (r.signal ? 128 : -1) : r.status;
    return { exit, signal: r.signal || null, timedOut };
}

/** Parse one JSONL stream into records; { records, header, summary, cycles, problems:[...] }. */
function parseStream(path) {
    const problems = [];
    let records;
    try {
        const text = readFileSync(path, 'utf8').trim();
        records = text.length ? text.split('\n').map((l) => JSON.parse(l)) : [];
    } catch (e) {
        return { records: [], header: null, summary: null, cycles: [], problems: ['stream unreadable/truncated: ' + String(e && e.message ? e.message : e)] };
    }
    const headers = records.filter((r) => r.type === 'header');
    const summaries = records.filter((r) => r.type === 'summary');
    const fatals = records.filter((r) => r.type === 'fatal');
    const cycles = records.filter((r) => r.type === 'cycle');
    if (headers.length !== 1) problems.push('expected exactly one header, got ' + headers.length);
    if (summaries.length !== 1) problems.push('expected exactly one summary, got ' + summaries.length);
    if (fatals.length !== 0) problems.push('stream carries a fatal record');
    return { records, header: headers[0] || null, summary: summaries[0] || null, cycles, problems };
}

/** Per-process: median hotOps per lane over the MEASURED cycles (cycle index >= warmupCycles). */
function reduceSamples(parsed) {
    const warmup = parsed.header && parsed.header.config ? (parsed.header.config.warmupCycles | 0) : 1;
    const byLane = {};
    for (const lane of KERNEL_LANES) byLane[lane] = { dense: [], sparse: [], latD: [], latS: [] };
    for (const c of parsed.cycles) {
        if (c.tier !== 'kernel') continue;
        if (!(c.cycle >= warmup)) continue;
        const slot = byLane[c.lane];
        if (!slot) continue;
        if (typeof c.hotOpsDense === 'number') slot.dense.push(c.hotOpsDense);
        if (typeof c.hotOpsSparse === 'number') slot.sparse.push(c.hotOpsSparse);
        // report-only: the per-cycle hot-path latency p99 (c.latency / c.latencySparse), never gated.
        if (c.latency && typeof c.latency.p99 === 'number') slot.latD.push(c.latency.p99);
        if (c.latencySparse && typeof c.latencySparse.p99 === 'number') slot.latS.push(c.latencySparse.p99);
    }
    const med = (arr) => (arr.length ? medianOf(arr, arr.length) : undefined);
    const samples = {};
    for (const lane of KERNEL_LANES) {
        const s = byLane[lane];
        samples[lane] = {
            hotOpsDense: s.dense.length ? medianOf(s.dense, s.dense.length) : undefined,
            hotOpsSparse: s.sparse.length ? medianOf(s.sparse, s.sparse.length) : undefined,
            latencyP99Dense: med(s.latD),
            latencyP99Sparse: med(s.latS),
        };
    }
    return samples;
}

/** The hotOps batch lengths a calibration process chose (max over its cycles, per lane+metric). */
function calibLengths(parsed) {
    const out = {};
    for (const lane of KERNEL_LANES) out[lane] = { dense: 0, sparse: 0 };
    for (const c of parsed.cycles) {
        if (c.tier !== 'kernel') continue;
        const slot = out[c.lane];
        if (!slot) continue;
        if (c.hotOpsDenseN > slot.dense) slot.dense = c.hotOpsDenseN;
        if (c.hotOpsSparseN > slot.sparse) slot.sparse = c.hotOpsSparseN;
    }
    return out;
}

/** Stream-level problems (D9): reason!=end, incomplete lane x cycle grid, exit != exitCodeFor(verdict). */
function streamProblems(parsed, exit) {
    const probs = parsed.problems.slice();
    const sum = parsed.summary;
    if (!sum) return probs;
    if (sum.reason !== 'end') probs.push("summary.reason is '" + sum.reason + "', not 'end'");
    // Complete kernel grid: every kernel lane must carry a cycle record for every cycle index ANY kernel
    // lane carries (summary.cyclesRun counts lane-cycles, not cycle indices -- do not use it here).
    const allCycles = new Set();
    const perLane = new Map();
    for (const lane of KERNEL_LANES) perLane.set(lane, new Set());
    for (const c of parsed.cycles) {
        if (c.tier !== 'kernel') continue;
        allCycles.add(c.cycle);
        const s = perLane.get(c.lane);
        if (s) s.add(c.cycle);
    }
    if (allCycles.size === 0) probs.push('incomplete grid: no kernel cycle records');
    for (const lane of KERNEL_LANES) {
        const s = perLane.get(lane);
        for (const cyc of allCycles) {
            if (!s.has(cyc)) { probs.push('incomplete grid: missing ' + lane + ' cycle ' + cyc); break; }
        }
    }
    if (exit !== exitCodeFor(sum.verdict)) probs.push('exit ' + exit + ' != exitCodeFor(' + sum.verdict + ')=' + exitCodeFor(sum.verdict));
    return probs;
}

/** Each round cycle's pinned batch lengths must equal the pin (D3/D9). */
function batchMismatch(parsed, pinMap) {
    for (const c of parsed.cycles) {
        if (c.tier !== 'kernel') continue;
        const p = pinMap[c.lane];
        if (!p) continue;
        if (c.hotOpsDenseN !== p.dense || c.hotOpsSparseN !== p.sparse) {
            return c.lane + ' cycle ' + c.cycle + ' batch ' + c.hotOpsDenseN + '/' + c.hotOpsSparseN + ' != pin ' + p.dense + '/' + p.sparse;
        }
    }
    return null;
}

// Report-only formatters (display boundary only -- never on a hot path).
function signed(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return String(x);
    return (x >= 0 ? '+' : '') + x.toFixed(4);
}
function pct(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return 'n/a';
    return (x * 100).toFixed(2) + '%';
}
function latTxt(x) { return typeof x === 'number' && Number.isFinite(x) ? String(x) : 'n/a'; }

function reportAndExit(res, ctx) {
    // Banners first (always visible).
    if (ctx.controlMode) {
        process.stdout.write('soak:ab: NOT RELEASE EVIDENCE -- control mode (--a-dir/--b-dir): local kernels, not reproducible release evidence\n');
    }
    if (ctx.kernelUnchanged) process.stdout.write('soak:ab: NOTE -- (kernel unchanged: A/A)\n');
    for (const n of res.notes || []) process.stdout.write('soak:ab: NOTE -- ' + n + '\n');

    // Report-only block (D7): latencyP99 A vs B, per-side CV + detrended CV, and improvements. NEVER gates
    // -- it is printed for every verdict and read from the same comparison objects serialised to
    // analysis.json. The tiny and pool lanes are NOT run (kernel tier only), so none appear here.
    if (Array.isArray(res.comparisons) && res.comparisons.length) {
        process.stdout.write('soak:ab: report-only (never gates; kernel lanes only, tiny/pool not run) --\n');
        for (const c of res.comparisons) {
            process.stdout.write('soak:ab:   ' + (c.lane + '/' + c.metric).padEnd(28) +
                ' s=' + signed(c.s) + ' sU=' + signed(c.sU) +
                ' latencyP99 A=' + latTxt(c.latencyP99A) + ' B=' + latTxt(c.latencyP99B) +
                ' cvA/B=' + pct(c.cvA) + '/' + pct(c.cvB) +
                ' dCvA/B=' + pct(c.detrendedCvA) + '/' + pct(c.detrendedCvB) + '\n');
        }
        for (const c of res.comparisons) {
            if (c.improvement) process.stdout.write('soak:ab:   improvement ' + c.lane + '/' + c.metric + ' s=' + signed(c.s) + '\n');
        }
    }

    const tail = ctx.mode + ' prev=' + ctx.prevVersion + ' candidate=' + ctx.candidateVersion +
        ' K=' + ctx.K + ' validRounds=' + (res.validRounds == null ? '-' : res.validRounds) +
        ' lanes=' + KERNEL_LANES.length + ' comparisons=' + (KERNEL_LANES.length * METRICS.length) +
        ' (T=' + res.constants.T + ' R=' + res.constants.R + ' alpha=' + res.constants.ALPHA + ')' +
        ' out=' + ctx.outDir;

    if (res.verdict === 'PASS') {
        process.stdout.write('soak:ab: PASS -- ' + tail + '\n');
    } else if (res.verdict === 'ERROR') {
        for (const r of res.fail) process.stderr.write('soak:ab: ERROR -- ' + r + '\n');
        process.stderr.write('soak:ab: ERROR -- ' + tail + '\n');
    } else if (res.verdict === 'FAIL') {
        for (const r of res.fail) process.stderr.write('soak:ab: FAIL -- ' + r + '\n');
        process.stderr.write('soak:ab: FAIL -- ' + tail + '\n');
    } else {
        for (const r of res.inconclusive) process.stderr.write('soak:ab: INCONCLUSIVE -- ' + r + '\n');
        process.stderr.write('soak:ab: INCONCLUSIVE -- ' + tail + '\n');
    }
    process.exit(res.exitCode);
}

function main() {
    // 0) Fail closed: a SOAK_* already in the environment would silently change what a side runs (D5).
    const leaked = Object.keys(process.env).filter((k) => k.indexOf('SOAK_') === 0);
    if (leaked.length) die(2, 'refusing to run with SOAK_* already set: ' + leaked.sort().join(', ') + ' -- the runner builds each side\'s env');

    const opts = parseArgs(process.argv.slice(2));

    // 1) Acceptance file (D8): default path is "none if absent"; an explicit --accept must exist + parse.
    let accept = null;
    const acceptPath = opts.accept || (existsSync(DEFAULT_ACCEPT) ? DEFAULT_ACCEPT : null);
    if (opts.accept && !existsSync(opts.accept)) die(2, 'acceptance file not found: ' + opts.accept);
    if (acceptPath) {
        try { accept = JSON.parse(readFileSync(acceptPath, 'utf8')); }
        catch (e) { die(2, 'acceptance file is not valid JSON (' + acceptPath + '): ' + String(e && e.message ? e.message : e)); }
    }

    // 2) Output tree.
    if (opts.outDir === '') die(2, "--out-dir '' is not a valid path");
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = opts.outDir || join(REPO_ROOT, 'benchmark', 'out', 'soak-ab-' + stamp);
    const scratch = join(outDir, 'scratch');
    const streamsDir = join(outDir, 'streams');
    mkdirSync(streamsDir, { recursive: true });
    mkdirSync(scratch, { recursive: true });

    // 3) Resolve the two sides.
    const t0 = Date.now();
    let A, B, controlMode = false;
    let prevVersion, candidateVersion, parityPickSha, parityPoolSha;
    try {
        if (opts.mode === 'control') {
            controlMode = true;
            A = hashUnpacked('A', opts.aDir);
            B = hashUnpacked('B', opts.bDir);
            prevVersion = '0.0.0'; candidateVersion = '0.0.1';   // neutralise the version/parity preconditions
            parityPickSha = B.pickSha256; parityPoolSha = B.poolSha256;
        } else if (opts.mode === 'aa') {
            A = fetchRelease(opts.prev, scratch, outDir);        // unpacks to <out>/A/package
            // Copy the SAME bytes to an equal-length sibling path <out>/B/package: the only difference
            // between the two sides must be the directory they load from, never the path length (a longer
            // path is itself a measurable difference -- research 5.6). Both sides are the real prev release,
            // recorded verbatim (prev == candidate); checkProcesses admits that for an A/A run (manifest.aa).
            const bDir = join(outDir, 'B', 'package');
            mkdirSync(join(outDir, 'B'), { recursive: true });
            cpSync(A.dir, bDir, { recursive: true });
            B = Object.assign({}, A, { side: 'B', dir: bDir });
            prevVersion = A.version; candidateVersion = A.version;
            parityPickSha = B.pickSha256; parityPoolSha = B.poolSha256;
        } else {
            A = fetchRelease(opts.prev, scratch, outDir);
            B = packTree(REPO_ROOT, scratch, outDir);
            prevVersion = opts.prev; candidateVersion = B.version;
            parityPickSha = B.parityPickSha; parityPoolSha = B.parityPoolSha;
        }
    } catch (e) {
        die(3, 'INCONCLUSIVE -- registry/pack failure: ' + String(e && e.message ? e.message : e));
    }

    const kernelUnchanged = A.pickSha256 === B.pickSha256;
    const ctxBase = {
        mode: opts.mode, controlMode, kernelUnchanged, prevVersion, candidateVersion,
        K: opts.rounds, outDir, constants: { T: 0.05, R: 0.15, ALPHA: 0.05 },
    };

    // 4) Early, pre-run preconditions (release mode only -- control/aa are neutralised by construction).
    const early = [];
    if (opts.mode === 'release') {
        if (A.version !== opts.prev) early.push('A VERSION ' + A.version + ' != --prev ' + opts.prev);
        if (!B.versionMatches) early.push('B VERSION ' + B.version + ' != package.json ' + B.pkgVersion);
        if (!B.parityOk) early.push('B Pick.js/Pool.js sha256 != parity.json (candidate is not the pinned shipped code)');
        if (!/^\d+\.\d+\.\d+$/.test(opts.prev)) early.push('prev ' + opts.prev + ' is not a plain release');
        if (!/^\d+\.\d+\.\d+$/.test(String(candidateVersion || ''))) early.push('candidate ' + candidateVersion + ' is not a plain release (pre-release?)');
        else if (!lessThan(opts.prev, candidateVersion)) early.push('prev ' + opts.prev + ' is not < candidate ' + candidateVersion);
    }

    // 5) Acceptance validation up front (a malformed file is a configuration error -> exit 2).
    const acc = validateAcceptance(accept, candidateVersion);
    if (acc.errors.length) {
        writePlan(outDir, { opts, A, B, prevVersion, candidateVersion, order: null, pin: null, acceptPath, note: 'bad acceptance file' });
        reportAndExit({ verdict: 'ERROR', exitCode: 2, fail: acc.errors, inconclusive: [], notes: acc.notes, validRounds: null, constants: ctxBase.constants }, ctxBase);
    }

    const order = balancedOrder(opts.rounds, opts.orderSeed);
    writePlan(outDir, { opts, A, B, prevVersion, candidateVersion, order, pin: null, acceptPath, note: null });

    // If the early preconditions already decide the run, stop before spending any process time (D9).
    if (early.length) {
        reportAndExit({ verdict: 'INCONCLUSIVE', exitCode: 3, fail: [], inconclusive: early, notes: acc.notes, validRounds: 0, constants: ctxBase.constants }, ctxBase);
    }

    // 6) Calibration: one process per side (seeded order), then pin max(N_A, N_B) per lane+metric.
    const calibOrder = order[0];   // 'AB' -> A first, 'BA' -> B first
    const sideSpec = { A: { dir: A.dir }, B: { dir: B.dir } };
    const calibSides = calibOrder === 'AB' ? ['A', 'B'] : ['B', 'A'];
    const calibParsed = {};
    for (const side of calibSides) {
        const sp = join(streamsDir, 'calib-' + side + '.jsonl');
        const pr = runProcess({ dir: sideSpec[side].dir, pin: null, seed: opts.seed, streamPath: sp });
        const parsed = parseStream(sp);
        calibParsed[side] = { pr, parsed };
        const verdict = parsed.summary ? parsed.summary.verdict : null;
        const probs = streamProblems(parsed, pr.exit);
        if (side === 'A') {
            if (pr.timedOut || pr.exit !== 0 || verdict !== 'PASS' || probs.length) {
                reportAndExit({ verdict: 'INCONCLUSIVE', exitCode: 3, fail: [],
                    inconclusive: ['baseline (A) process (calibration) not PASS (exit ' + pr.exit + ', verdict ' + verdict + ')'].concat(probs.map((p) => 'A calibration stream: ' + p)),
                    notes: acc.notes, validRounds: 0, constants: ctxBase.constants }, ctxBase);
            }
        } else {
            if (pr.exit === 1) {
                reportAndExit({ verdict: 'FAIL', exitCode: 1, fail: ['B process (calibration) failed its own soak (exit 1, verdict ' + verdict + ')'], inconclusive: [], notes: acc.notes, validRounds: 0, constants: ctxBase.constants }, ctxBase);
            }
            if (pr.timedOut || pr.exit !== 0 || verdict !== 'PASS' || probs.length) {
                reportAndExit({ verdict: 'INCONCLUSIVE', exitCode: 3, fail: [],
                    inconclusive: ['B process (calibration) not comparable (exit ' + pr.exit + ', verdict ' + verdict + ')'].concat(probs.map((p) => 'B calibration stream: ' + p)),
                    notes: acc.notes, validRounds: 0, constants: ctxBase.constants }, ctxBase);
            }
        }
    }
    const lenA = calibLengths(calibParsed.A.parsed);
    const lenB = calibLengths(calibParsed.B.parsed);
    const pinMap = {};
    const pinParts = [];
    for (const lane of KERNEL_LANES) {
        const dense = Math.max(lenA[lane].dense, lenB[lane].dense);
        const sparse = Math.max(lenA[lane].sparse, lenB[lane].sparse);
        if (!(dense > 0 && sparse > 0)) {
            reportAndExit({ verdict: 'INCONCLUSIVE', exitCode: 3, fail: [], inconclusive: ['calibration produced no batch length for ' + lane], notes: acc.notes, validRounds: 0, constants: ctxBase.constants }, ctxBase);
        }
        pinMap[lane] = { dense, sparse };
        pinParts.push(lane + ':' + dense + ':' + sparse);
    }
    const pin = pinParts.join(',');
    writePlan(outDir, { opts, A, B, prevVersion, candidateVersion, order, pin: pinMap, acceptPath, note: null });

    // 7) The K rounds. Each round spawns A and B in the round's balanced order.
    const procs = [];
    const runnerFail = [], runnerInconclusive = [];
    for (let r = 0; r < opts.rounds; r++) {
        const sides = order[r] === 'AB' ? ['A', 'B'] : ['B', 'A'];
        for (const side of sides) {
            const name = 'r' + String(r).padStart(2, '0') + '-' + side + '.jsonl';
            const sp = join(streamsDir, name);
            const pr = runProcess({ dir: sideSpec[side].dir, pin, seed: opts.seed, streamPath: sp });
            const parsed = parseStream(sp);
            const probs = streamProblems(parsed, pr.exit);
            const bm = (parsed.summary && !probs.length) ? batchMismatch(parsed, pinMap) : null;
            for (const p of probs) runnerInconclusive.push(side + ' round ' + r + ' stream: ' + p);
            if (bm) runnerInconclusive.push(side + ' round ' + r + ' batch-length mismatch: ' + bm);
            procs.push({
                side, role: 'round', exit: pr.exit,
                verdict: parsed.summary ? parsed.summary.verdict : null,
                header: parsed.header, samples: reduceSamples(parsed),
            });
        }
    }

    // 8) The pure analysis owns the statistics + the D9 process preconditions + the verdict/exit rule.
    const manifest = {
        prevVersion, candidateVersion,
        aPickSha: A.pickSha256, aPoolSha: A.poolSha256,
        bPickSha: B.pickSha256, bPoolSha: B.poolSha256,
        parityPickSha, parityPoolSha,
        K: opts.rounds, lanes: KERNEL_LANES.slice(),
        aa: opts.mode === 'aa',   // A/A control: prev == candidate is expected, not a precondition failure
    };
    const result = analyse(manifest, procs, accept);
    writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({
        manifest, mode: opts.mode, controlMode, kernelUnchanged, pin: pinMap, order,
        wallSec: +((Date.now() - t0) / 1000).toFixed(1), result,
    }, null, 2) + '\n');

    // 9) Merge the runner-level stream/batch preconditions into the analysis verdict (D9 precedence).
    const fail = result.fail.slice().concat(runnerFail);
    const inconclusive = result.inconclusive.slice().concat(runnerInconclusive);
    let verdict, exitCode;
    if (result.exitCode === 2) { verdict = 'ERROR'; exitCode = 2; }
    else if (fail.length) { verdict = 'FAIL'; exitCode = 1; }
    else if (inconclusive.length) { verdict = 'INCONCLUSIVE'; exitCode = 3; }
    else { verdict = 'PASS'; exitCode = 0; }

    reportAndExit({ verdict, exitCode, fail, inconclusive, notes: result.notes, validRounds: result.validRounds, constants: ctxBase.constants, comparisons: result.comparisons }, ctxBase);
}

function lessThan(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] < pb[i]) return true; if (pa[i] > pb[i]) return false; }
    return false;
}

function writePlan(outDir, p) {
    const plan = {
        schema: 1,
        createdAt: new Date().toISOString(),
        mode: p.opts.mode,
        prevVersion: p.prevVersion,
        candidateVersion: p.candidateVersion,
        rounds: p.opts.rounds,
        workloadSeed: p.opts.seed >>> 0,
        orderSeed: p.opts.orderSeed >>> 0,
        order: p.order,
        pin: p.pin,
        acceptPath: p.acceptPath,
        note: p.note || undefined,
        A: { dir: p.A.dir, version: p.A.version, pickSha256: p.A.pickSha256, poolSha256: p.A.poolSha256, integrity: p.A.integrity || null },
        B: { dir: p.B.dir, version: p.B.version, pickSha256: p.B.pickSha256, poolSha256: p.B.poolSha256, integrity: p.B.integrity || null, parityOk: p.B.parityOk, versionMatches: p.B.versionMatches },
    };
    writeFileSync(join(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
}

main();
