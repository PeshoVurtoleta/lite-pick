/**
 * @zakkster/lite-pick soak -- the release-time A/B MUST-FAIL battery (research/soak-release-ab.md 5.6, #8b).
 *
 *   npm run soak:ab:teeth               the whole battery (serial, ~8 min per gated control locally)
 *   AB_ONLY=AB-SLOW10 npm run ...       one control (ONE at a time -- the proof runs are scheduled idle)
 *   AB_LIST=1 npm run ...               resolve every mutant anchor + print one JSON line each; run nothing
 *
 * A gate that cannot fail is not a gate. Every control here drives the REAL runner (SoakAB.mjs) end to
 * end through its control seam (--a-dir / --b-dir), never the pure analyser (ab-analyse.mjs) alone: the
 * mutant is a scratch copy of the 1.1.0 kernel whose ONLY change is time (a read-only extra scan) or a
 * deliberate own-soak failure, and the assertion is on the runner's exit code, its stderr banner and the
 * per-comparison statistics it wrote to analysis.json.
 *
 * Base kernel (D11): the 1.1.0 REGISTRY tarball (not the tree -- the tree is in flux), its Pick.js
 * sha256 asserted equal to `git show 2a08567:Pick.js` (b07731bb...). AB_BASE=<unpacked package dir>
 * reuses an already-fetched tarball (the scheduled proof runs); without it the tarball is packed here.
 *
 * The mutant writer keeps its counter and sink in integer (Smi) slots on the balancer -- masked to stay
 * below 2^31 and forced with `| 0` -- so a slowdown mutant adds TIME only: a boxed module `let` double
 * would allocate per pick and trip the soak's own hotAlloc FAIL tier, confounding the timing signal.
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchRelease, sha256File } from './ab-pack.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOAKAB = join(HERE, 'SoakAB.mjs');
const NODE = process.execPath;

const PREV = '1.1.0';                                   // the base release (D11)
const BASE_PICK_SHA = 'b07731bb8e1b3a5ed4efac530b84458c283c12f04faae5aaaab156b93ea4540c';   // 1.1.0 Pick.js
const BASE_COMMIT = '2a08567';                          // the commit whose Pick.js IS the 1.1.0 tarball's
const COMPAT_COMMIT = '8c1ecc7';                        // a pre-setWeights kernel: the harness cannot run it (A crashes)
const ROUNDS = (() => {
    const r = process.env.AB_ROUNDS;
    if (r === undefined) return 10;
    if (!/^\d+$/.test(r)) { process.stderr.write("AB_ROUNDS '" + r + "' must be an integer\n"); process.exit(2); }
    return Number(r);
})();

// --- REP = the mutant size (TUNED with single-lane smoke pairs; retuning REP is the ONLY allowed knob
// when a control misses its window after a clean, quiet re-run -- never the decision rule, never the
// windows). Each unit is one extra read-only pass over the CAP=256 arrays on every 8th pick of the lane.
// Tuned 2026-10-06 (single-lane smoke pairs, 1.1.0 base, M4 Pro, CAP=256):
//   SmoothWRR.pick  REP=1 -> s_dense 0.054 / s_sparse 0.081   REP=2 -> 0.113 / 0.151
//                   REP=4 -> 0.204 / 0.251                     REP=5 -> 0.240 / 0.315
//   _kthEligible    REP=8 -> P2C sparse 0.190, PeakEWMA sparse 0.106 (dense untouched: never falls back)
const REP_SLOW20 = 4;     // SmoothWRR.pick gross slowdown, target s in [0.18, 0.30] (dense + sparse)
const REP_SLOW10 = 2;     // SmoothWRR.pick threshold slowdown: dense s in [0.08, 0.13], sparse s in [0.11, 0.20]
                          // (the same fixed extra scan is a LARGER share of the cheaper sparse pick -- both FAIL)
const REP_SPARSE = 8;     // _kthEligible fallback-scan slowdown, sparse lanes only (dense never falls back)

// --- the mutant writer: a single-anchor patch with a uniqueness check (a stale anchor throws) ---------
function patch(src, from, to) {
    let n = 0, i = 0;
    while ((i = src.indexOf(from, i)) !== -1) { n++; i += from.length; }
    if (n !== 1) throw new Error('anchor not unique (' + n + '): ' + from.slice(0, 48));
    return src.replace(from, to);
}

// SLOW: after SmoothWRR's hot-loop preamble (1.1.0 Pick.js:523-524), add REP read-only passes on every
// 8th pick. The counter (`__abn`) is masked below 2^31 (stays a Smi) and the sink (`__abs`) is forced
// with `| 0` end to end -- no HeapNumber, no allocation, pure added time. The sink is a stored field, so
// V8 cannot dead-code-eliminate the scan. SmoothWRR.pick scans all CAP regardless of how many are up, so
// BOTH its dense and sparse hotOps slow -- but NOT by the same fraction: the sparse pick skips the per-node
// credit update for down nodes, so it is cheaper, and the SAME fixed extra scan is a larger share of it
// (s_sparse > s_dense at every REP; see the SLOW10 note in ADR 0017).
const SLOW_ANCHOR =
    '        const cap = this._cap, el = this._eligible, wt = this._weights, cur = this._current;\n' +
    '        let best = -1, bestCur = -Infinity;';
const slowMutant = (rep) => (src) => patch(src, SLOW_ANCHOR,
    '        const cap = this._cap, el = this._eligible, wt = this._weights, cur = this._current;\n' +
    '        this.__abn = (this.__abn + 1) & 0x7fffffff;\n' +
    '        if ((this.__abn & 7) === 0) { let abs = this.__abs | 0; for (let abr = 0; abr < ' + rep + '; abr++) { for (let abj = 0; abj < cap; abj++) { abs = (abs + el[abj] + (wt[abj] | 0)) | 0; } } this.__abs = abs | 0; }\n' +
    '        let best = -1, bestCur = -Infinity;');

// SPARSE: inside the cold fallback scan `_kthEligible` (reached only when the random draw keeps missing --
// a ~95%-down pool), add REP read-only passes. The dense workload almost never falls back, so only the
// lanes whose pick routes through the random draw (P2C, PeakEWMA, WeightedRandom) slow, and only on
// hotOpsSparse. Same Smi-only sink.
const SPARSE_ANCHOR =
    '    b._stats[STAT_FALLBACK_SCANS] += 1;\n' +
    '    const cap = b._cap, el = b._eligible;';
const sparseMutant = (rep) => (src) => patch(src, SPARSE_ANCHOR,
    '    b._stats[STAT_FALLBACK_SCANS] += 1;\n' +
    '    { let abs = b.__abs | 0; const abc = b._cap, abe = b._eligible; for (let abr = 0; abr < ' + rep + '; abr++) { for (let abj = 0; abj < abc; abj++) { abs = (abs + abe[abj]) | 0; } } b.__abs = abs | 0; }\n' +
    '    const cap = b._cap, el = b._eligible;');

// BFAIL: setEligible(i, true) is ignored (a node, once down, never comes back) -- the base BalancerBase
// method, so every lane. The B soak drains eligibility and trips its own freeze / safety invariant ->
// the B process FAILs its own soak -> the A/B verdict is FAIL ("B process"), the only path to exit 1 that
// is not a gated comparison.
const bfailMutant = (src) => patch(src, '        const now = up ? 1 : 0;', '        const now = 0;');

// --- control table ------------------------------------------------------------------------------------
// Each control supplies the A-side and B-side Pick.js (null = the base kernel verbatim) and, for COMPAT,
// a whole replacement package. `expect` is checked against the runner's exit + analysis.json.
function gitShow(spec) { return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' }); }

const CONTROLS = [
    {
        id: 'AB-AA',
        doc: 'B byte-identical to A: the false-alarm control. Must PASS with all 20 comparisons PASS.',
        aPick: null, bPick: null,
        // `maxInconclusive:1` was dead: exit 0 already requires 0 FAIL and 0 INCONCLUSIVE comparisons (one
        // INCONCLUSIVE makes the runner exit 3). Replaced with a MEANINGFUL assertion -- every one of the
        // 20 kernel comparisons must be PASS -- so the control proves the gate verdicts, not just the exit.
        expect: { exit: 0, allPass: 20 },
    },
    {
        id: 'AB-SLOW20',
        doc: 'SmoothWRR.pick +' + REP_SLOW20 + ' scans/8th pick: gross. Must FAIL SmoothWRR dense+sparse, s in [0.18,0.30], nothing else.',
        aPick: null, bPick: slowMutant(REP_SLOW20),
        expect: { exit: 1, failExactly: [['SmoothWRR', 'hotOpsDense'], ['SmoothWRR', 'hotOpsSparse']], sWindow: { lo: 0.18, hi: 0.30 } },
    },
    {
        id: 'AB-SLOW10',
        doc: 'SmoothWRR.pick +' + REP_SLOW10 + ' scan/8th pick: threshold. Must FAIL SmoothWRR dense s in [0.08,0.13] AND sparse s in [0.11,0.20], nothing else.',
        aPick: null, bPick: slowMutant(REP_SLOW10),
        // The same fixed extra scan is a LARGER share of SmoothWRR's cheaper sparse pick (its credit update is
        // skipped for down nodes): single-lane tuning measured s_sparse 0.151 at REP 2 (dense 0.113). That is a
        // REAL >5% slowdown, so the gate must FAIL it too -- each metric gets the window its own effect predicts.
        expect: { exit: 1, failExactly: [['SmoothWRR', 'hotOpsDense'], ['SmoothWRR', 'hotOpsSparse']],
            sWindow: { hotOpsDense: { lo: 0.08, hi: 0.13 }, hotOpsSparse: { lo: 0.11, hi: 0.20 } } },
    },
    {
        id: 'AB-SPARSE',
        doc: '_kthEligible +' + REP_SPARSE + ' scans/call: fallback only. Must FAIL hotOpsSparse in {P2C,PeakEWMA,WeightedRandom}, zero dense.',
        aPick: null, bPick: sparseMutant(REP_SPARSE),
        // Only P2C and PeakEWMA route through _draw -> _kthEligible (WeightedRandom has its own rejection
        // sampler, line 1918), so WR is allowed in the FAIL set but cannot fire; the teeth are P2C+PeakEWMA.
        expect: { exit: 1, failSubsetOf: [['P2C', 'hotOpsSparse'], ['PeakEWMA', 'hotOpsSparse'], ['WeightedRandom', 'hotOpsSparse']], failAtLeast: [['P2C', 'hotOpsSparse'], ['PeakEWMA', 'hotOpsSparse']], noDenseFail: true, failNonEmpty: true },
    },
    {
        id: 'AB-FAST',
        doc: 'A carries the SLOW20 cost, B is clean: an improvement. Must PASS, SmoothWRR dense s <= -0.15.',
        aPick: slowMutant(REP_SLOW20), bPick: null,
        expect: { exit: 0, sAtMost: { lane: 'SmoothWRR', metric: 'hotOpsDense', value: -0.15 } },
    },
    {
        id: 'AB-COMPAT',
        doc: 'A = the pre-setWeights ' + COMPAT_COMMIT + ' kernel the harness cannot run. Must be INCONCLUSIVE (baseline A), ' +
            'the cause recorded as the missing setWeights, and B must NOT be mis-run (B loads the clean base).',
        compat: true,
        // Not just a stderr prefix: prove (a) the INCONCLUSIVE is the BASELINE (A) side, (b) the real cause
        // is the missing setWeights (the A calibration stream/err carries it), (c) B was never mis-run --
        // plan.json shows the A kernel is NOT the base while the B kernel IS exactly the 1.1.0 base.
        expect: { exit: 3, stderrRe: /INCONCLUSIVE -- baseline \(A\) process/,
            aCauseRe: /setWeights/, aKernelNotBase: true, bKernelIsBase: true },
    },
    {
        id: 'AB-BFAIL',
        doc: 'B ignores setEligible(up): the B soak FAILs its OWN run (a graceful soak verdict FAIL, not a crash). ' +
            'Must FAIL ("B process"), the B stream carrying summary verdict FAIL and no fatal, B the mutant not A.',
        aPick: null, bPick: bfailMutant,
        // Prove it is a real own-soak FAIL, not a crash the runner mislabelled: the B stream ends with a
        // SUMMARY verdict FAIL and carries NO fatal record; and plan.json shows B is the mutant (!= base)
        // while A is the clean base -- so the FAIL is B's soak failing, not B mis-run as the broken side.
        expect: { exit: 1, stderrRe: /B process \(calibration\) failed its own soak \(exit 1, verdict FAIL\)/,
            bStreamSoakFail: true, bKernelNotBase: true, aKernelIsBase: true },
    },
];

// --- selection + modes --------------------------------------------------------------------------------
const ONLY = process.env.AB_ONLY || null;
if (process.env.AB_LIST !== undefined && process.env.AB_LIST !== '1') {
    process.stderr.write("AB_LIST='" + process.env.AB_LIST + "' -- did you mean 1?\n");
    process.exit(2);
}
const LIST = process.env.AB_LIST === '1';
const selected = CONTROLS.filter((c) => !ONLY || c.id === ONLY);
if (selected.length === 0) { process.stderr.write('AB_ONLY=' + ONLY + ' selected no control (ids: ' + CONTROLS.map((c) => c.id).join(', ') + ')\n'); process.exit(2); }

// --- base kernel (D11) --------------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'litepick-abteeth-'));
// AB_KEEP=1 keeps the scratch tree (streams, analysis.json) for inspection -- used by the scheduled
// A/A proof run to verify every stream's per-cycle gcMajor / trackerSize / hotBytesPerOp (assertion 5).
const KEEP = process.env.AB_KEEP === '1';
if (!KEEP) process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The 1.1.0 package dir (AB_BASE if given, else packed from the registry here); D11-verified. */
function resolveBaseDir() {
    let dir;
    if (process.env.AB_BASE) {
        if (!existsSync(join(process.env.AB_BASE, 'Pick.js'))) throw new Error('AB_BASE has no Pick.js: ' + process.env.AB_BASE);
        dir = process.env.AB_BASE;
    } else {
        const scratch = join(TMP, 'fetch');
        const out = join(TMP, 'base');
        mkdirSync(scratch, { recursive: true });
        mkdirSync(out, { recursive: true });
        dir = fetchRelease(PREV, scratch, out).dir;
    }
    const got = sha256File(join(dir, 'Pick.js'));
    if (got !== BASE_PICK_SHA) throw new Error('base Pick.js sha256 ' + got + ' != expected 1.1.0 ' + BASE_PICK_SHA);
    // D11 anchor: the tarball bytes ARE the committed kernel's bytes (git show 2a08567:Pick.js).
    const gp = join(TMP, 'git-base-pick.js');
    writeFileSync(gp, gitShow(BASE_COMMIT + ':Pick.js'));
    const gitContentSha = sha256File(gp);
    rmSync(gp, { force: true });
    if (gitContentSha !== BASE_PICK_SHA) throw new Error('git ' + BASE_COMMIT + ':Pick.js sha256 ' + gitContentSha + ' != ' + BASE_PICK_SHA);
    return dir;
}

let idx = 0;

/** Lay down <dest>/package as a copy of the base with the given Pick.js/Pool.js overrides. */
function layPackage(dest, baseDir, pickSrc, poolSrc) {
    const pkg = join(dest, 'package');
    cpSync(baseDir, pkg, { recursive: true });
    if (pickSrc != null) writeFileSync(join(pkg, 'Pick.js'), pickSrc);
    if (poolSrc != null) writeFileSync(join(pkg, 'Pool.js'), poolSrc);
    return pkg;
}

/** Build the A and B package dirs for a control. Paths <id>/A/package and <id>/B/package: equal length,
 *  the only difference between the two sides is which directory the kernel loads from (research 5.1). */
function buildSides(ctl, baseDir) {
    const root = join(TMP, ctl.id);
    mkdirSync(root, { recursive: true });
    if (ctl.compat) {
        const aDir = layPackage(join(root, 'A'), baseDir, gitShow(COMPAT_COMMIT + ':Pick.js'), gitShow(COMPAT_COMMIT + ':Pool.js'));
        const bDir = layPackage(join(root, 'B'), baseDir, null, null);
        return { aDir, bDir };
    }
    const baseSrc = readFileSync(join(baseDir, 'Pick.js'), 'utf8');
    const aPick = ctl.aPick ? ctl.aPick(baseSrc) : null;
    const bPick = ctl.bPick ? ctl.bPick(baseSrc) : null;
    const aDir = layPackage(join(root, 'A'), baseDir, aPick, null);
    const bDir = layPackage(join(root, 'B'), baseDir, bPick, null);
    return { aDir, bDir };
}

// --- LIST mode: resolve every anchor (offline: git, no network), run nothing --------------------------
if (LIST) {
    const baseSrc = gitShow(BASE_COMMIT + ':Pick.js');   // identical bytes to the tarball; offline
    const rows = [];
    let ok = true;
    for (const ctl of selected) {
        try {
            if (!ctl.compat) {
                if (ctl.aPick) ctl.aPick(baseSrc);
                if (ctl.bPick) ctl.bPick(baseSrc);
            } else {
                gitShow(COMPAT_COMMIT + ':Pick.js');   // the A kernel exists
            }
            rows.push(JSON.stringify({ id: ctl.id, run: 'ab', rounds: ROUNDS, expect: ctl.expect, doc: ctl.doc }));
        } catch (e) { ok = false; rows.push(JSON.stringify({ id: ctl.id, error: String(e && e.message ? e.message : e) })); }
    }
    // One AWAITED write, then exit HERE (nothing below may run in LIST mode), + an end sentinel
    // (see _mustfail.mjs: a piped macOS stdout is async, and process.exit() drops its queued tail).
    rows.push(JSON.stringify({ end: true, count: rows.length }));
    await new Promise((done) => process.stdout.write(rows.join('\n') + '\n', done));
    process.exit(ok ? 0 : 1);
}

// --- run mode -----------------------------------------------------------------------------------------
function runAB(ctl, baseDir) {
    const { aDir, bDir } = buildSides(ctl, baseDir);
    const outDir = join(TMP, ctl.id, 'out');
    mkdirSync(outDir, { recursive: true });
    const env = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('SOAK_') !== 0) env[k] = process.env[k];
    const r = spawnSync(NODE, [SOAKAB, '--a-dir', aDir, '--b-dir', bDir, '--rounds', String(ROUNDS), '--out-dir', outDir],
        { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const exit = r.status === null ? -1 : r.status;
    let analysis = null;
    const ap = join(outDir, 'analysis.json');
    if (existsSync(ap)) { try { analysis = JSON.parse(readFileSync(ap, 'utf8')); } catch { /* left null */ } }
    return { exit, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), analysis, outDir };
}

/** The parsed plan.json (A/B kernel shas, versions), or null if the run never wrote one. */
function readPlan(outDir) {
    const pp = join(outDir, 'plan.json');
    if (!existsSync(pp)) return null;
    try { return JSON.parse(readFileSync(pp, 'utf8')); } catch { return null; }
}
/** Concatenate a calibration stream's records + its captured .err text, for cause/soak-FAIL evidence. */
function readCalib(outDir, side) {
    const sp = join(outDir, 'streams', 'calib-' + side + '.jsonl');
    let records = [], err = '';
    if (existsSync(sp)) {
        try { const t = readFileSync(sp, 'utf8').trim(); records = t.length ? t.split('\n').map((l) => JSON.parse(l)) : []; } catch { /* leave empty */ }
    }
    if (existsSync(sp + '.err')) { try { err = readFileSync(sp + '.err', 'utf8'); } catch { /* ignore */ } }
    return { records, err };
}

function comps(analysis) { return (analysis && analysis.result && analysis.result.comparisons) || []; }
function find(cs, lane, metric) { return cs.find((c) => c.lane === lane && c.metric === metric) || null; }
const same = (pair, c) => c.lane === pair[0] && c.metric === pair[1];

/** Check the control's expectations; return { ok, lines:[...] } (lines are human-readable evidence). */
function check(ctl, res) {
    const e = ctl.expect, lines = [], fails = [];
    const cs = comps(res.analysis);
    const failing = cs.filter((c) => c.verdict === 'FAIL');
    lines.push('exit=' + res.exit + ' (want ' + e.exit + ')');
    if (res.exit !== e.exit) fails.push('exit ' + res.exit + ' != ' + e.exit);

    if (e.stderrHas && res.stderr.indexOf(e.stderrHas) === -1) fails.push("stderr missing '" + e.stderrHas + "'");
    if (e.stderrRe && !e.stderrRe.test(res.stderr)) fails.push('stderr does not match ' + e.stderrRe);

    if (e.allPass !== undefined) {
        const pass = cs.filter((c) => c.verdict === 'PASS').length;
        const inc = cs.filter((c) => c.verdict === 'INCONCLUSIVE').length;
        lines.push('comparisons=' + cs.length + ' pass=' + pass + ' inconclusive=' + inc + ' fail=' + failing.length);
        if (cs.length !== e.allPass) fails.push('expected ' + e.allPass + ' comparisons, got ' + cs.length);
        if (pass !== cs.length) fails.push('not every comparison PASS (' + pass + '/' + cs.length + ')');
    }

    if (e.aKernelNotBase || e.bKernelIsBase || e.aKernelIsBase || e.bKernelNotBase) {
        const plan = readPlan(res.outDir);
        if (!plan) fails.push('no plan.json to check kernel provenance');
        else {
            const aSha = plan.A && plan.A.pickSha256, bSha = plan.B && plan.B.pickSha256;
            lines.push('plan A.pick=' + shortSha(aSha) + ' B.pick=' + shortSha(bSha) + ' base=' + shortSha(BASE_PICK_SHA));
            if (e.aKernelIsBase && aSha !== BASE_PICK_SHA) fails.push('A kernel ' + shortSha(aSha) + ' != base (A should be the clean base)');
            if (e.aKernelNotBase && aSha === BASE_PICK_SHA) fails.push('A kernel == base (A should be the broken kernel)');
            if (e.bKernelIsBase && bSha !== BASE_PICK_SHA) fails.push('B kernel ' + shortSha(bSha) + ' != base (B mis-run? should be the clean base)');
            if (e.bKernelNotBase && bSha === BASE_PICK_SHA) fails.push('B kernel == base (B should be the mutant)');
        }
    }
    if (e.aCauseRe) {
        const { records, err } = readCalib(res.outDir, 'A');
        const fatal = records.find((r) => r.type === 'fatal');
        const msg = (fatal ? String(fatal.message || '') : '') + ' ' + err;
        lines.push('A cause: ' + (fatal ? fatal.message : '(no fatal record)'));
        if (!e.aCauseRe.test(msg)) fails.push('A failure cause does not match ' + e.aCauseRe + ' (got: ' + msg.trim().slice(0, 120) + ')');
    }
    if (e.bStreamSoakFail) {
        const { records } = readCalib(res.outDir, 'B');
        const summary = records.filter((r) => r.type === 'summary').pop() || null;
        const fatal = records.find((r) => r.type === 'fatal');
        lines.push('B stream: summary verdict=' + (summary ? summary.verdict : 'MISSING') + ' reason=' + (summary ? summary.reason : '-') + ' fatals=' + (fatal ? 1 : 0));
        if (!summary || summary.verdict !== 'FAIL') fails.push('B stream summary not verdict FAIL (an own-soak FAIL is expected)');
        if (summary && summary.reason === 'fatal') fails.push('B stream summary reason is fatal (a crash, not an own-soak FAIL)');
        if (fatal) fails.push('B stream carries a fatal record (a crash, not an own-soak FAIL)');
    }

    if (e.failExactly) {
        for (const want of e.failExactly) {
            const c = find(cs, want[0], want[1]);
            const v = c ? c.verdict : 'MISSING';
            const s = c ? c.s : NaN;
            lines.push(want.join('/') + ' verdict=' + v + ' s=' + fmt(s) + ' sU=' + fmt(c && c.sU) + ' pHolm=' + fmtE(c && c.pHolm));
            if (!c || c.verdict !== 'FAIL') fails.push(want.join('/') + ' not FAIL (' + v + ')');
            else if (e.sWindow) {
                // one window for every metric, or one per metric (keyed by metric name)
                const w = e.sWindow.lo !== undefined ? e.sWindow : e.sWindow[want[1]];
                if (!w) fails.push(want.join('/') + ' has no expected s window');
                else if (!(s >= w.lo && s <= w.hi)) fails.push(want.join('/') + ' s=' + fmt(s) + ' outside [' + w.lo + ',' + w.hi + ']');
            }
        }
        for (const c of failing) if (!e.failExactly.some((p) => same(p, c))) fails.push('unexpected FAIL ' + c.lane + '/' + c.metric + ' s=' + fmt(c.s));
    }

    if (e.failSubsetOf) {
        for (const c of failing) {
            lines.push('FAIL ' + c.lane + '/' + c.metric + ' s=' + fmt(c.s) + ' pHolm=' + fmtE(c.pHolm));
            if (!e.failSubsetOf.some((p) => same(p, c))) fails.push('unexpected FAIL ' + c.lane + '/' + c.metric);
        }
        if (e.noDenseFail && failing.some((c) => c.metric === 'hotOpsDense')) fails.push('a hotOpsDense comparison FAILed');
        if (e.failNonEmpty && failing.length === 0) fails.push('no comparison FAILed (mutant has no teeth at this REP)');
        for (const want of e.failAtLeast || []) {
            const c = find(cs, want[0], want[1]);
            if (!c || c.verdict !== 'FAIL') fails.push(want.join('/') + ' not FAIL (' + (c ? c.verdict : 'MISSING') + ')');
        }
    }

    if (e.sAtMost) {
        const c = find(cs, e.sAtMost.lane, e.sAtMost.metric);
        const s = c ? c.s : NaN;
        lines.push(e.sAtMost.lane + '/' + e.sAtMost.metric + ' s=' + fmt(s) + ' (want <= ' + e.sAtMost.value + ')');
        if (!(s <= e.sAtMost.value)) fails.push(e.sAtMost.lane + '/' + e.sAtMost.metric + ' s=' + fmt(s) + ' not <= ' + e.sAtMost.value);
        if (failing.length) fails.push('an improvement control FAILed a comparison');
    }

    return { ok: fails.length === 0, lines, fails };
}
function fmt(x) { return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(4) : String(x); }
function fmtE(x) { return typeof x === 'number' && Number.isFinite(x) ? x.toExponential(2) : String(x); }
function shortSha(s) { return typeof s === 'string' && s.length >= 8 ? s.slice(0, 8) : String(s); }

const baseDir = resolveBaseDir();
let allOk = true;
for (const ctl of selected) {
    const t0 = Date.now();
    const res = runAB(ctl, baseDir);
    const chk = check(ctl, res);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (!chk.ok) allOk = false;
    process.stdout.write((chk.ok ? 'OK  ' : 'MISS') + ' ' + ctl.id.padEnd(10) + ' ' + secs + 's  ' + chk.lines.join(' | ') + '\n');
    if (!chk.ok) for (const f of chk.fails) process.stdout.write('       <<< ' + f + '\n');
}
if (KEEP) process.stdout.write('AB-TEETH: scratch kept at ' + TMP + ' (AB_KEEP=1)\n');
// await the LAST write (writes are FIFO) before exiting, so a piped macOS stdout keeps every line.
await new Promise((done) => process.stdout.write('AB-TEETH: ' + (allOk ? 'every control behaved AS REQUIRED (the A/B gate has teeth)' : 'A CONTROL MISBEHAVED -- the A/B gate is hollow or over-eager') + '\n', done));
process.exit(allOk ? 0 : 1);
