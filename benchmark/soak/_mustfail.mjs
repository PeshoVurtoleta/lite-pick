/**
 * @zakkster/lite-pick soak -- MUST-FAIL controls THROUGH THE PRODUCTION PATH.
 *
 *   node benchmark/soak/_mustfail.mjs
 *
 * A gate that cannot fail is not a gate -- and a control that trips only when it calls hot.mjs /
 * quality.mjs directly proves nothing about the PRODUCTION gate. So every control here PATCHES ONE
 * LINE of a scratch copy of Pick.js (a kernel mutant) and drives it through the REAL main.mjs ->
 * computeGates via the SOAK_KERNEL seam, asserting the run exits 1 AND the breach names the right
 * gate. A clean copy is the pass-control (exit 0). Nothing here calls the gate modules directly.
 *
 * MUSTFAIL_ONLY=<regex> runs only the controls whose name matches (NOT a SOAK_ key, so the soak's own
 * fail-closed config never sees it). The full battery is the gate: the nightly splits it into two jobs,
 * '^(?!PL |ML )' and '^(PL|ML) ', whose union is every control. An empty selection is an error.
 *
 * MUSTFAIL_LIST=1 builds every control (so every patch anchor is resolved -- a stale anchor throws, exit 1)
 * but RUNS nothing: it prints one JSON line per control, { name, run, status, spec, mode, lanes }, in
 * well under a second. test/SoakTeeth.test.js reads it to prove every gate / oracle / pool assertion /
 * SOAK_MUSTFAIL mode in teeth.mjs has a control (audit 2026-09-29, burst 9b).
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_ACTIVE_CYCLES } from './config.mjs';

// Every control runs exactly the active floor (2N + warm-up cycles), so its drift gates are ACTIVE.
const CYC = String(MIN_ACTIVE_CYCLES);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PICK = readFileSync(join(ROOT, 'Pick.js'), 'utf8');
const POOL = readFileSync(join(ROOT, 'Pool.js'), 'utf8');
const REAL_PICK_URL = pathToFileURL(join(ROOT, 'Pick.js')).href;   // scratch Pool imports the REAL kernel
const TMP = mkdtempSync(join(tmpdir(), 'litepick-mutant-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
// Children run on THIS node binary (so `PATH=<node22>/bin node _mustfail.mjs` tests node 22 end to end),
// each bounded by a timeout (a hung child is a MISS, never a hung battery). PL/ML take ~16 min each.
const NODE = process.execPath;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const NODE_FLAGS = ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];

const RR_ANCHOR = '        const cap = this._cap, el = this._eligible;\n        let i = this._cursor;';
const RR_INJECT = (body) =>
    '        const cap = this._cap, el = this._eligible;\n        this.__c = (this.__c | 0) + 1; ' + body + '\n        let i = this._cursor;';

function patch(src, from, to) {
    let n = 0, i = 0;
    while ((i = src.indexOf(from, i)) !== -1) { n++; i += from.length; }
    if (n !== 1) throw new Error('anchor not unique (' + n + '): ' + from.slice(0, 40));
    return src.replace(from, to);
}

// Replace EVERY occurrence -- for a line the P2C and PeakEWMA picks share verbatim. The mutant runs on
// ONE lane only, so patching the sibling class's identical line is harmless.
function patchAll(src, from, to, expect) {
    let n = 0, i = 0;
    while ((i = src.indexOf(from, i)) !== -1) { n++; i += from.length; }
    if (n !== expect) throw new Error('expected ' + expect + ' occurrences, found ' + n + ': ' + from.slice(0, 40));
    return src.split(from).join(to);
}

const ONLY = process.env.MUSTFAIL_ONLY ? new RegExp(process.env.MUSTFAIL_ONLY) : null;
const want = (name) => !ONLY || ONLY.test(name);
if (process.env.MUSTFAIL_LIST !== undefined && process.env.MUSTFAIL_LIST !== '1') {
    process.stderr.write("MUSTFAIL_LIST='" + process.env.MUSTFAIL_LIST + "' -- did you mean 1?\n");
    process.exit(2);
}
const LIST = process.env.MUSTFAIL_LIST === '1';

let idx = 0;
function writeMutant(src, name) {
    const p = join(TMP, 'kernel-' + (idx++) + '-' + name + '.js');
    writeFileSync(p, src);
    return p;
}

/** Run main.mjs through the mutant kernel; return { status, stderr }. */
function runSoak(kernelPath, env) {
    const full = Object.assign({}, process.env, {
        SOAK_KERNEL: kernelPath,
        SOAK_OUT: join(TMP, 'run-' + (idx++) + '.jsonl'),
    }, env);
    return runMain(full);
}

/** Run main.mjs with `env`; { status, stderr } on EVERY exit. spawnSync, not execFileSync: an exit-0 run
 * must keep its stderr too (the report-only NOTE lines a control asserts are on stderr). A child killed
 * by a signal reports status -1. */
function runMain(env) {
    const r = spawnSync(NODE, NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_TIMEOUT_MS });
    return { status: r.status === null ? -1 : r.status, stderr: String(r.stderr || '') };
}

/** A Pool.js mutant (Pool.js is byte-frozen; patch a SCRATCH copy driven via SOAK_POOL). The scratch's
 * relative './Pick.js' import is rewritten to the REAL kernel URL so it still uses the real balancer. */
function patchPool(from, to, expect) {
    const want = expect || 1;
    const rewired = POOL.replace("from './Pick.js'", "from '" + REAL_PICK_URL + "'");
    let n = 0, i = 0;
    while ((i = rewired.indexOf(from, i)) !== -1) { n++; i += from.length; }
    if (n !== want) throw new Error('pool anchor count ' + n + ' != ' + want + ': ' + from.slice(0, 40));
    return rewired.split(from).join(to);
}

/** Run main.mjs through a mutant POOL (clean kernel), returns { status, stderr }. */
function runSoakPool(poolPath, env) {
    const full = Object.assign({}, process.env, { SOAK_POOL: poolPath, SOAK_OUT: join(TMP, 'run-' + (idx++) + '.jsonl') }, env);
    return runMain(full);
}

const out = [];
let allOk = true;
/** LIST mode: describe the control instead of running it. `run` is what the exit status belongs to: main
 *  (main.mjs through a mutant/mode), cfg (main.mjs config parse), report (SoakReport.mjs on a stream). */
/** A control's spec is null, one spec, or an array of specs that must ALL match (one mode, several gates). */
const specsOf = (w) => (w === null || w === undefined ? [] : [].concat(w));
function listed(name, run, env, wantStatus, wantBreach) {
    out.push(JSON.stringify({
        name, run, status: Array.isArray(wantStatus) ? wantStatus : [wantStatus], specs: specsOf(wantBreach),
        mode: (env && env.SOAK_MUSTFAIL) || null, lanes: (env && env.SOAK_LANES) || null,
    }));
}
let lastT = Date.now();   // per-control wall time (the battery's cost is budgeted in the nightly)
/** `wantStatus` is an exit code, or an array of acceptable codes (the alloc NOTE controls: a gross
 *  allocator may ALSO trip the hard gcMajor gate -- correct, but run-length dependent). */
/**
 * S11 (audit 2026-09-29): strict matching. A spec starting with 'soak: ' must be the PREFIX of a stderr
 * line (the NOTE / INCONCLUSIVE lines). Any other spec is a BREACH token spec -- e.g. 'gate=hotOps
 * lane=RoundRobin', 'quality lane=SmoothWRR', 'pool=A4' -- and ONE `soak: BREACH` line must carry every
 * token exactly (before its `detail=`). It never matches a substring of a stack trace or a file name.
 */
function matchWant(stderr, spec) {
    const lines = stderr.split('\n');
    // 'soak: ' (soak NOTE / INCONCLUSIVE), 'soak:report: ' (report ISSUE / verdict) and 'probe: ' (_probe.mjs
    // ok / FAIL) specs: a line prefix.
    if (spec.startsWith('soak: ') || spec.startsWith('soak:report: ') || spec.startsWith('probe: ')) return lines.some((l) => l.startsWith(spec));
    const toks = spec.split(' ').filter(Boolean);
    for (const l of lines) {
        if (!l.startsWith('soak: BREACH ')) continue;
        let head = l.slice('soak: BREACH '.length);
        const d = head.indexOf('detail=');
        if (d !== -1) head = head.slice(0, d);
        const have = head.split(' ').filter(Boolean);
        if (toks.every((t) => hasToken(have, t))) return true;
    }
    return false;
}
/** `k=v` matches a line token `k=v` or `k=a,v,b` (main joins several quality kinds with commas). */
function hasToken(have, t) {
    if (have.indexOf(t) !== -1) return true;
    const eq = t.indexOf('=');
    if (eq === -1) return false;
    const key = t.slice(0, eq + 1), val = t.slice(eq + 1);
    return have.some((h) => h.startsWith(key) && h.slice(key.length).split(',').indexOf(val) !== -1);
}
/** A child that crashed (uncaught exception, main rejection) is a MISS for EVERY control: a crash is
 *  never evidence that a gate tripped (S11: a thrown setTimeout used to "pass" the A7 case). */
const crashedOf = (stderr) => /^soak: CRASH --/m.test(stderr);

/** `wantStatus` is an exit code, or an array of acceptable codes (the alloc NOTE controls: a gross
 *  allocator may ALSO trip the hard gcMajor gate -- correct, but run-length dependent). */
function record(name, r, wantStatus, wantBreach) {
    const now = Date.now(), secs = ((now - lastT) / 1000).toFixed(0);
    lastT = now;
    const statusOk = Array.isArray(wantStatus) ? wantStatus.indexOf(r.status) !== -1 : r.status === wantStatus;
    const breachOk = specsOf(wantBreach).every((sp) => matchWant(r.stderr, sp));
    const crashed = crashedOf(r.stderr);
    const ok = statusOk && breachOk && !crashed;
    if (!ok) allOk = false;
    const firstLine = (r.stderr.match(/^soak: (CRASH|BREACH|FAIL|INCONCLUSIVE) .*/m) || [''])[0].slice(0, 110);
    out.push('  ' + (ok ? 'OK  ' : 'MISS') + ' ' + name.padEnd(34) +
        ' exit=' + r.status + ' want=' + (Array.isArray(wantStatus) ? wantStatus.join('|') : wantStatus) + (wantBreach ? ' [' + specsOf(wantBreach).join(' & ') + ']' : '') + ' ' + secs + 's' +
        (ok ? '' : '  <<< ' + (crashed ? 'CRASHED: ' : '') + (firstLine || 'no breach line')));
}
function control(name, src, env, wantStatus, wantBreach) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'main', env, wantStatus, wantBreach);
    record(name, runSoak(writeMutant(src, name.replace(/[^a-z0-9]/gi, '')), env), wantStatus, wantBreach);
}
// A pool MODE control: clean kernel (PICK), SOAK_MUSTFAIL=<mode>, driven through a pool lane.
function modeControl(name, env, wantStatus, wantBreach) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'main', env, wantStatus, wantBreach);
    record(name, runSoak(writeMutant(PICK, name.replace(/[^a-z0-9]/gi, '')), env), wantStatus, wantBreach);
}
// A pool.js mutant control (SOAK_POOL seam, clean kernel).
function poolControl(name, poolSrc, env, wantStatus, wantBreach) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'main', env, wantStatus, wantBreach);
    const pp = join(TMP, 'pool-' + (idx++) + '-' + name.replace(/[^a-z0-9]/gi, '') + '.js');
    writeFileSync(pp, poolSrc);
    record(name, runSoakPool(pp, env), wantStatus, wantBreach);
}

const A = 20000, Q = 100000;   // alloc mutants can use a short main loop; quality mutants need windows

// --- alloc mutants (RoundRobin.pick), driven through the hotAlloc PROBE -------------------------
// hotAlloc is REPORT-ONLY (S1, audit 2026-09-29: V8 JIT state false-FAILs a correct kernel on Node 22;
// PerfGate owns per-op 0 B/op and is proven against these same mutants). The control now asserts the
// probe still SEES the allocation: a `soak: NOTE -- hotAlloc[RoundRobin]` line. Exit 0, or 1 when a gross
// allocator (M1 320 KB arrays, M2 a growing retained log) ALSO forces a workload major GC -- the hard
// gcMajor gate catching it is correct, but whether it happens depends on the run length.
// They need Q picks: with A the RoundRobin quality windows never fill and the run is (correctly)
// INCONCLUSIVE (S5) -- a FAIL used to mask that.
const NOTE_RR = 'soak: NOTE -- hotAlloc[RoundRobin]';
control('M1 160KB-array/8192', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c & 8191) === 0) { this.__o = new Array(40000); }')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin' }, [0, 1], NOTE_RR);
control('M2 retained-log/8th', patch(PICK, RR_ANCHOR, RR_INJECT('if (!this.__log) this.__log = []; if ((this.__c & 7) === 0) this.__log.push({ a: this.__c });')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin' }, [0, 1], NOTE_RR);
control('M3 64KB-burst/24576', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c % 24576) === 0) { this.__o = new Array(8192); }')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin' }, [0, 1], NOTE_RR);
control('M4 2-field-object/64', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c & 63) === 0) { this.__o = { a: this.__c, b: 0 }; }')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin' }, [0, 1], NOTE_RR);

// --- quality mutants, driven through the SmoothWRR / WeightedRandom oracles ----------------------
// M5: SmoothWRR ignores weight in the accumulator -> a PERSISTENT ratio corruption (near-uniform
// instead of weight-proportional), exactly what the |count - W*w/S| <= maxWt+1 drift oracle exists
// for. (A "missing _current reset" mutant is deliberately NOT used: SmoothWRR's -=total step self-
// corrects a transient accumulator offset over a long quiet window, so it is not a lasting defect.)
control('M5 SmoothWRR ignores-weight',
    patch(PICK, '                const c = cur[i] + wt[i];', '                const c = cur[i] + 1;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR' }, 1, 'quality lane=SmoothWRR kind=oracle');
// M6: the H3 weight-0 regression -- BOTH the pick-loop guard AND the setWeight credit-reset removed,
// so a node drained to weight 0 keeps its stale credit and gets returned. The lane-agnostic H3 guard
// (weights[picked]===0) fires; the same guard protects CH/BL (see report note).
control('M6 SmoothWRR weight-0 (H3)',
    patch(
        patch(PICK, '            if (el[i] && wt[i] > 0) {       // eligible AND positive weight: a weight-0 node is never a candidate', '            if (el[i]) {'),
        '        this._current[i] = 0;               // reset credit: a reweighted node holds no stale accumulator', '        /* mutant: setWeight credit-reset removed (H3) */'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR' }, 1, 'quality lane=SmoothWRR kind=weightZero');
// M6b: the SAME H3 defect in ConsistentHash's Maglev build -- a weight-0 backend is given a table
// slot (+1 quota) instead of zero, so it becomes reachable and gets picked. Proves the weight-0 guard
// has teeth on the KEYED lanes too, not only SmoothWRR.
control('M6b CH weight-0 (H3, keyed)',
    patch(PICK, 'const q = Math.floor(wt[b] / total * M);', 'const q = Math.floor(wt[b] / total * M) + 1;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'ConsistentHash' }, 1, 'quality lane=ConsistentHash kind=weightZero');
control('M7 biased WR sampler',
    patch(PICK, '            const cand = u < prob[col] ? col : alias[col];', '            const cand = col;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'WeightedRandom' }, 1, 'quality lane=WeightedRandom kind=chiSquare');
// M7b (S14): every 16th node is picked 10% too often, by a PICK-level bias (any other candidate is
// rejection-redrawn 1 time in 11) -- the alias table stays exact, so the table-reconstruction invariant cannot
// see it, and the window chi-square at ~180 categories has ~2% power per window. The per-category binomial
// pass must catch it.
control('M7b WR every 16th node +10% (pick-level bias)',
    patch(PICK, '            if (el[cand]) return cand;', '            if (el[cand] && ((cand & 15) === 0 || rng.nextBelow(11) !== 0)) return cand;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'WeightedRandom' }, 1, 'quality lane=WeightedRandom kind=oracle');

// --- increment 2a: load / keyed oracles (oracles.mjs), each proven through main ------------------
// M8: P2C returns the WORSE of the two choices -> load balance collapses -> the max-mean bound trips.
control('M8 P2C worst-of-two',
    patch(PICK, 'return this._inflight[b] < this._inflight[a] ? b : a;', 'return this._inflight[b] > this._inflight[a] ? b : a;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'quality lane=P2C kind=oracle');
// M8b / M8c (S7): P2C IGNORES its comparison on 50% / 80% of picks and keeps the first draw -- the
// (1+beta)-choice process, beta 0.5 / 0.2. The old per-trial bound (4 log2 ln n + 4) never caught the 50%
// one; the averaged statistic with the calibrated limit must (research/s7-p2c-oracle-bound.md).
control('M8b P2C ignores the comparison 50%',
    patch(PICK, 'return this._inflight[b] < this._inflight[a] ? b : a;', 'return this._rng.nextBelow(10) < 5 ? a : (this._inflight[b] < this._inflight[a] ? b : a);'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'quality lane=P2C kind=oracle');
control('M8c P2C ignores the comparison 80%',
    patch(PICK, 'return this._inflight[b] < this._inflight[a] ? b : a;', 'return this._rng.nextBelow(10) < 8 ? a : (this._inflight[b] < this._inflight[a] ? b : a);'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'quality lane=P2C kind=oracle');
// M9: LeastConn picks the MOST-loaded eligible node -> the argmin oracle trips. (SED/NQ share the
// identical oracleArgmin path, differing only in the recomputed score; see report note.)
control('M9 LeastConn non-argmin',
    patchAll(PICK, '                if (best < 0 || c < bestLoad) { best = i; bestLoad = c; }', '                if (best < 0 || c > bestLoad) { best = i; bestLoad = c; }', 2),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'LeastConn' }, 1, 'quality lane=LeastConn kind=oracle');
// M9b (S14, a PASS control): LeastConn WITHOUT the 1.1.0 rotation -- every tie goes to the lowest index, the
// 1.0.x rule. Any member of the argmin set is a correct pick, so the argmin-SET oracle must accept it (the
// pre-S14 exact-index oracle could not have accepted the rotation itself).
control('M9b LeastConn ties -> lowest index, no rotation (must PASS)',
    patchAll(PICK, '        const cur = this._cur < cap ? this._cur : 0;', '        const cur = 0;', 3),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'LeastConn' }, 0, null);
// M10: ConsistentHash rotates the start slot per call (in ITS OWN fast path) -> a key no longer
// sticks -> the consecutive-equality stickiness check trips.
// M10: the reviewer's exact mutant -- a slot rotation that advances PER setEligible (this.__ROT++ in
// BalancerBase.setEligible; CH pick starts at (key + __ROT) % M). It keeps every pick eligible (safety
// green) but moves a key's home across membership changes -> the stickiness oracle's flap check trips.
control('M10 CH stickiness break (per-setEligible rotation)',
    patchAll(
        patch(PICK, '    setEligible(i, up) {\n        _vIdx(i, this._cap);', '    setEligible(i, up) {\n        this.__ROT = (this.__ROT | 0) + 1;\n        _vIdx(i, this._cap);'),
        // 1.1.0 B6: the pick doors compute the slot and CH / BL share _pickSlot(slot), so shift it there
        // (((k % M) + r) % M == (k + r) % M: the same mutant as before B6).
        '    _pickSlot(slot) {\n        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed\n',
        '    _pickSlot(slot) {\n        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed\n' + "        slot = (slot + (this.__ROT | 0)) % this._m;\n", 2),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'ConsistentHash' }, 1, 'quality lane=ConsistentHash kind=oracle');
// M11: BoundedLoad drops the +1 that counts the incoming request (the H4 bug) -> under-caps -> the
// reference walk disagrees with the pick.
control('M11 BoundedLoad H4 under-cap',
    patch(PICK, 'let cap = capActive ? (1 + this._eps) * (total + 1) / this._live : 0;     // > 0: total>0, live>0', 'let cap = capActive ? Math.ceil((1 + this._eps) * total / this._live) : 0;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'BoundedLoad' }, 1, ['quality lane=BoundedLoad kind=oracle', 'quality lane=BoundedLoad kind=property']);
// MH1 / MH2 (S14): ConsistentHash design errors the stickiness re-walk cannot see, caught by the stated
// properties. MH1 is MODULO-N HASHING -- the slot depends on the live count, the very thing consistent hashing
// exists to avoid: a flap down-and-up restores the count, so the stickiness flap (2) passes, but marking one
// node down moves every other key (property 3). MH2 makes the Maglev permutation depend on the total weight, so any
// rebuild reshuffles the whole table (property 4: moved share >> CH_REBUILD_MOVED_MAX).
control('MH1 CH modulo-N hashing (slot depends on live)',
    patchAll(PICK, '    _pickSlot(slot) {\n        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed\n',
        '    _pickSlot(slot) {\n        if (this._live === 0) return PICK_NONE;   // whole pool down: fail closed\n' + "        slot = (slot + this._live) % this._m;\n", 2),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'ConsistentHash' }, 1, 'quality lane=ConsistentHash kind=property');
control('MH2 CH rebuild reshuffles (permutation depends on total weight)',
    patch(patch(PICK, '        const offset = new Int32Array(N);', '        const offset = new Int32Array(N); let __t = 0; for (let q = 0; q < N; q++) __t += wt[q];'),
        '            offset[b] = h1 % M;', '            offset[b] = (h1 + __t) % M;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'ConsistentHash' }, 1, 'quality lane=ConsistentHash kind=property');

// M12: PeakEWMA ignores the cost comparison (no latency steering, the H1 black-hole shape) -> the
// busy slow node is no longer avoided and gets ~uniform share -> the slowNode-share oracle trips.
control('M12 PeakEWMA H1 no-steer',
    patch(PICK, '        return costB < costA ? b : a;         // lower cost wins; tie -> the first draw', '        return a;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'PeakEWMA' }, 1, 'quality lane=PeakEWMA kind=oracle');

// M13 (T6 tiny lanes): P2C returns PICK_NONE on a live===1 pool (breaking the cap-1 shortcut). On the
// tiny P2C lane (cap 1 when cycle%3===0) this makes pick() fail closed with a healthy node up -> the
// fail-closed-IFF safety invariant trips at a checkpoint. Proves the tiny cap-1 path is really driven.
control('M13 P2C cap-1 mispick',
    patchAll(PICK, '        if (this._live === 1) return a;       // only one eligible: it is both choices', '        if (this._live === 1) return PICK_NONE;', 2),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'invariants');

// M14 (T16): a ~1-in-97 pick stall that GROWS with a process-global counter, so later cycles are slower
// than early ones -> the p99 tail drifts up across the run -> latencyP99 trips. The stall is rare enough
// that the median (p50 / dense throughput) is barely moved -- it is a TAIL regression.
control('M14 latency tail inflate (growing stall)',
    patch(PICK, RR_ANCHOR, RR_INJECT('globalThis.__L = (globalThis.__L | 0) + 1; if ((globalThis.__L % 97) === 0) { let x = 0; const n = 120 * (1 + (globalThis.__L >> 16)); for (let z = 0; z < n; z++) x += z; this.__s = x; }')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'gate=latencyP99 lane=RoundRobin');

// M15 (NIT B): BoundedLoad note() double-counts -> _total desyncs from the true sum(inflight). The BL
// oracle recomputes total INDEPENDENTLY, so the kernel's wrong cap makes its pick disagree with the
// reference -> trips. (A shared-state oracle reading b._total would be blind to this.)
control('M15 BoundedLoad _total desync',
    patch(PICK, '        const t = this._total + delta;', '        const t = this._total + delta * 2;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'BoundedLoad' }, 1, 'quality lane=BoundedLoad kind=oracle');

// --- burst 9c2 (audit 2026-09-29): the last oracle lanes and the hotAlloc gross tier, as KERNEL mutants. ---
// M17: SED goes weight-blind (score = in-flight + 1, the LeastConn rule) -> the SED argmin oracle, which
// recomputes (inflight + 1) / weight independently, disagrees whenever weights differ. The score line is
// shared verbatim with NQ; the mutant runs on the SED lane only.
control('M17 SED weight-blind score',
    patchAll(PICK, '                    const score = (inf[i] + 1) / w;', '                    const score = inf[i] + 1;', 4),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'SED' }, 1, 'quality lane=SED kind=oracle');
// M18: NQ loses its never-queue shortcut (an idle node no longer wins outright) -> it degenerates to SED and
// queues on a busy node while an idle one exists -> the NQ oracle (first idle, else SED min) trips.
control('M18 NQ never-queue removed',
    patchAll(PICK, '                    if (inf[i] === 0) { this._cur = i + 1; return i; }   // idle: never queue -- take it immediately', '                    /* mutant: idle shortcut removed */', 2),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'NQ' }, 1, 'quality lane=NQ kind=oracle');
// M19: ~2 KB allocated on EVERY RoundRobin pick (dies young, nothing retained) -> every 8192-pick B/op window
// scavenges (>= one 4 MB semi-space) -> the hotAlloc GROSS tier FAILs (the hard part of the report-only
// gate, S1). M1-M4/M16 prove the NOTE tier; this proves the FAIL tier.
control('M19 2KB/pick sustained (hotAlloc gross)',
    patch(PICK, RR_ANCHOR, RR_INJECT('this.__o = new Array(256);')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'gate=hotAlloc lane=RoundRobin');

// --- burst 9c3 (audit 2026-09-29) ---------------------------------------------------------------------
// M20: setEligible(i, true) is ignored (a node, once down, never comes back -- BalancerBase, so every lane
// without its own override). Chaos then drains eligibility, and the freeze self-check (>= 8 positive-weight
// eligible nodes on a weighted lane, or the quality oracles judge a degenerate pool) trips on SED.
control('M20 setEligible up ignored (freeze)',
    patch(PICK, '        const now = up ? 1 : 0;', '        const now = 0;'),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'SED' }, 1, 'invariants lane=SED kind=freeze');

// M16 (NIT1): a periodic allocation RARER than one B/op pass (64KB every 2^20 picks, ~0.0625 B/op = 3x
// the bound). The MIN estimator misses it (it lands in only one pass per cycle, like a one-off), but it
// RECURS every cycle -> the cross-cycle recurrence rule (max(pass1,pass2) > bound in >=2 cycles) trips.
// A genuine one-off (once per process) does NOT recur and correctly does not fire.
control('M16 64KB/2^20 periodic (recurrence)',
    patch(PICK, RR_ANCHOR, RR_INJECT('globalThis.__P20 = (globalThis.__P20 | 0) + 1; if ((globalThis.__P20 & 0xFFFFF) === 0) { this.__o = new Array(8192); }')),
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin' }, [0, 1], NOTE_RR);

// --- POOL LANE teeth (T14-15): each assertion proven by a REAL Pool.js mutant via the SOAK_POOL seam
// (Pool.js stays byte-frozen -- the mutant is a scratch copy). These catch REAL Pool bugs, not harness
// self-injections. The three required harness MODES (poolleak/poolnote/poolunhandled) are also run. ----
const PA = { SOAK_CYCLES: CYC, SOAK_PICKS: String(A) };
// A1: note(+1) on dispatch removed -> b._total stays 0 while inflight grows -> A1 fails IN FLIGHT.
poolControl('MP1 note-removed (A1 totalInflight)',
    patchPool('                    b.note(i, 1);', '                    ;'),
    { ...PA, SOAK_LANES: 'PoolBoundedLoad' }, 1, 'pool=A1 lane=PoolBoundedLoad');
// A2: a settle inflight-- skipped 1/500 -> inflight cells stuck > 0 at quiescence.
poolControl('MP2 settle-skip (A2 quiescence)',
    patchPool('                inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;', '                if (((this.__sk = (this.__sk | 0) + 1) % 500) !== 0) inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A2 lane=PoolP2C');
// A3: a run never settles 1/997 -> the batch deadline trips -> lostRun -> assert3_accounted FAIL.
poolControl('MP3 never-resolving (A3 lost run)',
    patchPool('                out = await fn(i, signal);', '                out = await ((this.__hg = (this.__hg | 0) + 1) % 997 === 0 ? new Promise(() => {}) : fn(i, signal));'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A3 lane=PoolP2C');
// A4/outcome: no failover (break on attempt>0) -> a failover run rejects instead of resolving.
poolControl('MP4 no-failover (outcome)',
    patchPool('                let i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());', '                if (attempt > 0) break;\n                let i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A5 lane=PoolP2C');
// A4/outcome: abort checks disabled -> an aborted run resolves instead of rejecting with the reason.
poolControl('MP4b abort-ignored (outcome)',
    patchPool('if (signal && signal.aborted)', 'if (false && signal.aborted)', 2),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A5 lane=PoolP2C');
// A5: failover reuses a tried endpoint (distinctness broken).
poolControl('MP5 failover-repeat (A5 distinct)',
    patchPool('                if (attempt > 0) {', '                if (attempt > 0) { i = held[0]; } else if (false) {'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A5 lane=PoolP2C');
// A6: Pool retains every instance in a global -> tracker.size() never drains.
poolControl('MP6 pool-retains-self (A6 retention)',
    patchPool('        const b = this._b, inflight = this._inflight;', '        const b = this._b, inflight = this._inflight; (globalThis.__PLEAK = globalThis.__PLEAK || []).push(this);'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A6 lane=PoolP2C');
// A7: Pool creates an unhandled rejection.
poolControl('MP7 pool-unhandled (A7)',
    patchPool('        const o = opts != null ? opts : undefined;', '        const o = opts != null ? opts : undefined; if (((this.__ur = (this.__ur | 0) + 1) % 1000) === 0) Promise.reject(new Error("pool unhandled"));'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A7');
// A8 (S10): Pool's failover scan ignores eligibility -> an attempt lands on a DOWN node. Keyed lanes re-pick
// the same home, so every keyed failover goes through _scanUntried; the audit's mutant exited 0 on all four
// pool lanes before fn checked eligible[i] at dispatch.
poolControl('MP8 scan ignores isEligible (A8 down-dispatch)',
    patchPool('        if (b.isEligible(idx) && tried.indexOf(idx) < 0) return idx;', '        if (tried.indexOf(idx) < 0) return idx;'),
    { ...PA, SOAK_LANES: 'PoolConsistentHash' }, 1, 'pool=A8 lane=PoolConsistentHash');
// A9 (S9): Pool counts every dispatch TWICE in flight and releases it twice -- nets to zero at quiescence
// (A2 blind), but the time-integral of inflight is double the attempt time -> Little's-law identity breaks.
poolControl('MP9 double-counted in-flight (A9 Little)',
    patch(patchPool('                inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;', '                inflight[j] = inflight[j] > 1 ? inflight[j] - 2 : 0;'),
        '                inflight[i] = (inflight[i] + 1) >>> 0;', '                inflight[i] = (inflight[i] + 2) >>> 0;'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool=A9 lane=PoolP2C');
// The three REQUIRED harness modes (also exit 1 through main).
modeControl('MPm1 poolnote mode (A1)', { ...PA, SOAK_LANES: 'PoolBoundedLoad', SOAK_MUSTFAIL: 'poolnote' }, 1, 'pool=A1 lane=PoolBoundedLoad');
modeControl('MPm2 poolleak mode (A2)', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolleak' }, 1, 'pool=A2 lane=PoolP2C');
modeControl('MPm3 poolunhandled mode (A7)', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolunhandled' }, 1, 'pool=A7');

// --- burst 9c (audit 2026-09-29): every SOAK_MUSTFAIL mode proven through main, asserting WHAT it trips.
// These are harness self-injections (weaker than a kernel/Pool mutant, which the controls above are);
// they prove the gate/oracle path the mode targets, and teeth.mjs requires each mode to have one. -------
modeControl('MM1 leak -> retention', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'leak' }, 1, 'retention lane=RoundRobin');
modeControl('MM2 heap -> heap', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'heap' }, 1, 'gate=heap lane=RoundRobin');
// weight0 zeroes the harness weight array, which IS the kernel's: SmoothWRR/SED/NQ read it live, so for them
// it is a legitimate drain (a correct kernel skips the node -- no trip). It bites where the kernel CACHES
// weights: the WeightedRandom alias table (and the CH/BL Maglev table) still routes to the drained node.
modeControl('MM3 weight0 -> weightZero', { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'WeightedRandom', SOAK_MUSTFAIL: 'weight0' }, 1, 'quality lane=WeightedRandom kind=weightZero');
modeControl('MM4 imbalance -> RR quality', { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'imbalance' }, 1, 'quality lane=RoundRobin kind=oracle');
modeControl('MM5 rss -> rss + gcMajor', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'rss' }, 1, ['gate=rss lane=RoundRobin', 'gate=gcMajor lane=RoundRobin']);
modeControl('MM6 poolbadcode -> A4', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolbadcode' }, 1, 'pool=A4 lane=PoolP2C');
modeControl('MM7 poolretain -> A6', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolretain' }, 1, 'pool=A6 lane=PoolP2C');
// phaseskip: the T8 self-check (every applicable chaos phase fired) must FAIL when one never counts.
modeControl('MM8 phaseskip -> phases', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'phaseskip' }, 1, 'phases lane=RoundRobin');
// I3 (S5): a lane whose quality windows never fill (RoundRobin at the 20000-pick floor) is INCONCLUSIVE.
modeControl('I3 quality windows never sufficient', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 3, 'soak: INCONCLUSIVE -- quality windows never sufficient for lane(s): RoundRobin');

// --- config fail-closed cases (audit 1.1): a bad env aborts with exit 2, never a silent 0-picks PASS.
// These run the CLEAN in-tree kernel (config is parsed before the kernel does anything). --------------
function runCfg(env, flags) {
    const full = Object.assign({}, process.env, { SOAK_OUT: join(TMP, 'cfg-' + (idx++) + '.jsonl') }, env);
    try {
        execFileSync(NODE, (flags || NODE_FLAGS).concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: full, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
        return { status: 0, stderr: '' };
    } catch (e) { return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') }; }
}
function cfgCase(name, env, flags) {
    if (!want('CFG ' + name)) return;
    if (LIST) return listed('CFG ' + name, 'cfg', env, 2, null);
    record('CFG ' + name, runCfg(env, flags), 2, null);
}
cfgCase('SOAK_CYCLES=abc', { SOAK_CYCLES: 'abc' });
cfgCase('SOAK_CYCLES=-5', { SOAK_CYCLES: '-5' });
cfgCase('SOAK_CYCLES=2.5', { SOAK_CYCLES: '2.5' });
cfgCase('SOAK_CYCLES=3 (below the floor)', { SOAK_CYCLES: '3' });
cfgCase('SOAK_PICKS=xyz', { SOAK_PICKS: 'xyz' });
cfgCase('SOAK_CYCLE typo (unknown key)', { SOAK_CYCLE: '5' });
cfgCase('CYCLES+DURATION mutually exclusive', { SOAK_CYCLES: CYC, SOAK_DURATION: '1m' });
cfgCase('SOAK_DURATION=45 (no unit)', { SOAK_DURATION: '45' });
cfgCase('SOAK_OUT empty', { SOAK_OUT: '', SOAK_CYCLES: CYC });
cfgCase('unpinned semi-space', { SOAK_CYCLES: CYC }, ['--expose-gc']);

// --- the 1.0.0-revert check (audit 1.5): the ORIGINAL buggy kernel (before the 1.0.1 audit fixes) must
// be CAUGHT by the new quality gates -- the whole point of adding them. git show the pre-fix Pick.js into
// a scratch file and drive the H3 (SmoothWRR/CH weight-0), H4 (BoundedLoad cap) and H1 (PeakEWMA) lanes;
// it must exit 1 on a quality breach. (Pool.js/markers unchanged in the fix, so the kernel-lane soak loads
// the old kernel fine.) The soak reweights keyed lanes through setWeights() (1.1.0 B1), which 1.0.0 lacks:
// REVERT_SHIM supplies what the pre-B1 soak did -- write the owned _weights, then ONE rebuild() -- and fails
// closed if _weights is gone. Without it the run CRASHES on the first allZero phase (a MISS, never a catch).
// ---------------------------------------------------------------------------------------------------------
const REVERT_SHIM = `
ConsistentHashBalancer.prototype.setWeights = function (w) {
    const bw = this._weights;
    if (!(bw instanceof Uint32Array)) throw new Error('REVERT shim: the 1.0.0 kernel exposes no Uint32Array _weights');
    for (let i = 0; i < this.capacity; i++) bw[i] = w[i];
    this.rebuild();
};
`;
if (want('REVERT 1.0.0 kernel (H1/H3/H4)')) {
    const name = 'REVERT 1.0.0 kernel (H1/H3/H4)';
    const env = { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR,BoundedLoad,PeakEWMA' };
    // H3 (SmoothWRR weight-0), H4 (BoundedLoad cap), H1 (PeakEWMA steering): each must be caught by name.
    const REVERT_SPECS = ['quality lane=SmoothWRR kind=weightZero', 'quality lane=BoundedLoad kind=oracle', 'quality lane=PeakEWMA kind=oracle'];
    if (LIST) listed(name, 'main', env, 1, REVERT_SPECS);
    else try {
        const old = execFileSync('git', ['show', '8c1ecc7:Pick.js'], { cwd: ROOT, encoding: 'utf8' });
        if (typeof old !== 'string' || old.indexOf('setWeights(') !== -1) throw new Error('8c1ecc7:Pick.js already has setWeights -- drop REVERT_SHIM');
        const p = writeMutant(old + REVERT_SHIM, 'revert100');
        record(name, runSoak(p, env), 1, REVERT_SPECS);
    } catch (e) {
        allOk = false;
        out.push('  MISS ' + name.padEnd(34) + ' <<< could not run: ' + String(e.message || e).slice(0, 80));
    }
}

// --- S5 (audit 2026-09-29): a run without the evidence to judge is INCONCLUSIVE (exit 3), never PASS. --
// I1: a bounded run interrupted by SIGINT after cycle 1. I2: a duration-bound run too short to reach the
// 2N active floor. Both run the CLEAN in-tree kernel.
function runSoakSigint(env) {
    return new Promise((resolve) => {
        const full = Object.assign({}, process.env, { SOAK_OUT: join(TMP, 'sig-' + (idx++) + '.jsonl') }, env);
        const ch = spawn(NODE, NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
        const killer = setTimeout(() => ch.kill('SIGKILL'), RUN_TIMEOUT_MS);
        ch.on('exit', () => clearTimeout(killer));
        let stderr = '', sent = false;
        ch.stdout.on('data', (d) => { if (!sent && /soak cycle 1:/.test(String(d))) { sent = true; ch.kill('SIGINT'); } });
        ch.stderr.on('data', (d) => { stderr += d; });
        ch.on('exit', (code) => resolve({ status: sent ? (code === null ? -1 : code) : -2, stderr }));
    });
}
const I1_ENV = { SOAK_LANES: 'SED,NQ,SmoothWRR' }, I2_ENV = { SOAK_DURATION: '10s', SOAK_LANES: 'SED,NQ,SmoothWRR' };
if (want('I1 SIGINT after cycle 1')) {
    if (LIST) listed('I1 SIGINT after cycle 1', 'main', I1_ENV, 3, 'soak: INCONCLUSIVE -- run interrupted before its end');
    else record('I1 SIGINT after cycle 1', await runSoakSigint(I1_ENV), 3, 'soak: INCONCLUSIVE -- run interrupted before its end');
}
if (want('I2 SOAK_DURATION=10s')) {
    if (LIST) listed('I2 SOAK_DURATION=10s', 'main', I2_ENV, 3, 'soak: INCONCLUSIVE -- lane SED ran');
    else record('I2 SOAK_DURATION=10s', runSoak(writeMutant(PICK, 'I2'), I2_ENV), 3, 'soak: INCONCLUSIVE -- lane SED ran');
}

// --- S2 (audit 2026-09-29): the timing gates are noise-aware (time-sized batches, N=5, MAD + exact
// one-sided Mann-Whitney). A real, sustained slowdown must still trip THEIR OWN gate: `decay` spins a
// cycle-scaled busy loop inside BOTH timed batches, `decaysparse` inside the sparse batch only. ------------
modeControl('MT1 decay -> hotOps', { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'decay' }, 1, 'gate=hotOps lane=RoundRobin');
modeControl('MT2 decaysparse -> hotOpsSparse', { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'decaysparse' }, 1, 'gate=hotOpsSparse lane=RoundRobin');

// --- S4 (audit 2026-09-29): the harness's own memory is O(lanes). PL: a clean 1500-cycle run (3000
// records) must PASS the heap gate -- the kept record array used to grow the heap ~1 KB/record and FAIL
// it. ML: the same run retaining ~1 KB per lane-cycle (SOAK_MUSTFAIL=slowleak) must FAIL it. ------------
// 70000 picks: the fewest at which the RoundRobin quality windows fill (below it the run is INCONCLUSIVE).
const LONG = { SOAK_CYCLES: '1500', SOAK_PICKS: '70000', SOAK_LANES: 'RoundRobin' };
control('PL clean 1500 cycles (heap flat)', PICK, LONG, 0, null);
modeControl('ML slowleak 1KB/lane-cycle (heap)', { ...LONG, SOAK_MUSTFAIL: 'slowleak' }, 1, 'gate=heap');

// --- pass-control: the CLEAN kernel through the same path must exit 0 ----------------------------
control('P clean kernel (pass-control)', PICK,
    { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0, null);
poolControl('P2 clean pool (pass-control)', patchPool("from '" + REAL_PICK_URL + "'", "from '" + REAL_PICK_URL + "'"),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 0, null);

// --- soak:report pass-controls: a GENUINE (untampered) stream must pass its own integrity check. These
// run SoakReport.mjs on real streams so a report regression (e.g. a smoke/FAIL false-alarm) is caught by
// the teeth battery, not only by the reviewer. ---------------------------------------------------------
function reportControl(name, soakEnv, wantExit) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'report', soakEnv, wantExit, null);
    const stream = join(TMP, 'rep-' + (idx++) + '.jsonl');
    try { execFileSync(NODE, NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: Object.assign({}, process.env, soakEnv, { SOAK_OUT: stream }), stdio: 'ignore', timeout: RUN_TIMEOUT_MS }); } catch { /* the soak itself may exit 1 (a FAIL stream); we only report on its output */ }
    let status = 0, stderr = '';
    try { execFileSync(NODE, ['benchmark/soak/SoakReport.mjs', stream], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: RUN_TIMEOUT_MS }); }
    catch (e) { status = e.status === undefined ? -1 : e.status; stderr = String(e.stderr || ''); }
    record(name, { status, stderr }, wantExit, null);
}
reportControl('RPT clean non-smoke -> integrity OK', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0);
reportControl('RPT clean smoke -> integrity OK', { SOAK_SMOKE: '1', SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0);
// S6: a stream that ran an OVERRIDDEN pool (SOAK_POOL) is not evidence about the shipped code -- the report
// must refuse it (exit 1) unless --allow-override. An identity copy is enough: the override flag is the point.
if (want('RPT overridden pool -> not a release soak')) {
    const pp = join(TMP, 'pool-rpt-identity.js');
    writeFileSync(pp, patchPool("from '" + REAL_PICK_URL + "'", "from '" + REAL_PICK_URL + "'"));
    reportControl('RPT overridden pool -> not a release soak', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_POOL: pp }, 1);
}
reportControl('RPT genuine FAIL stream -> integrity OK', { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'imbalance' }, 0);

// --- S13 (audit 2026-09-29): the hot-path CLEAN probe (_probe.mjs) is part of the battery. PP: the clean tree
// passes it (every lane, the EventQueue and the latency sampler 0 B/op beyond the runtime's clock boxing; no
// major GC; no retention). PM: a sampler that allocates one small object per sampled pick must FAIL it. -----
function probeControl(name, env, wantStatus, wantSpec) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'probe', env, wantStatus, wantSpec);
    const r = spawnSync(NODE, NODE_FLAGS.concat(['benchmark/soak/_probe.mjs']), { cwd: ROOT, env: Object.assign({}, process.env, env), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    record(name, { status: r.status === null ? -1 : r.status, stderr: String(r.stderr || '') }, wantStatus, wantSpec);
}
probeControl('PP clean probe (pass-control)', {}, 0, 'probe: ok');
probeControl('PM sampler allocates -> probe FAIL', { PROBE_MUSTFAIL: 'sampleralloc' }, 1, 'probe: FAIL -- latency sampler adds');

// --- S12 (audit 2026-09-29): soak:report fails CLOSED on a tampered stream or baseline. Each control edits
// a GENUINE stream (generated once per env, cached) and asserts the report exits 1 naming the issue -- the
// untampered streams pass above. `edit(records)` returns the edited record list (seq left as written unless
// the edit is about seq). ----------------------------------------------------------------------------------
const streamCache = new Map();
function genuineStream(env) {
    const key = JSON.stringify(env);
    if (!streamCache.has(key)) {
        const p = join(TMP, 'gen-' + (idx++) + '.jsonl');
        try { execFileSync(NODE, NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: Object.assign({}, process.env, env, { SOAK_OUT: p }), stdio: 'ignore', timeout: RUN_TIMEOUT_MS }); } catch { /* a FAIL stream is still a genuine stream */ }
        streamCache.set(key, p);
    }
    return streamCache.get(key);
}
function editedStream(src, edit) {
    const recs = readFileSync(src, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    const p = join(TMP, 'tamper-' + (idx++) + '.jsonl');
    writeFileSync(p, edit(recs).map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
}
const reseq = (recs) => recs.map((r, i) => Object.assign(r, { seq: i }));   // a CONSISTENT forger renumbers
function runReport(file, extra) {
    const r = spawnSync(NODE, ['benchmark/soak/SoakReport.mjs', file].concat(extra || []), { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    return { status: r.status === null ? -1 : r.status, stderr: String(r.stderr || '') };
}
function tamperControl(name, env, edit, wantSpec, baselineOf, moreArgs, wantStatus = 1) {
    if (!want(name)) return;
    if (LIST) return listed(name, 'report', env, wantStatus, wantSpec);
    const cur = edit ? editedStream(genuineStream(env), edit) : genuineStream(env);
    const extra = (baselineOf ? ['--baseline', baselineOf()] : []).concat(moreArgs || []);
    record(name, runReport(cur, extra), wantStatus, wantSpec);
}
const RPT_ENV = { SOAK_CYCLES: CYC, SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' };
// drop 8 of the 11 cycles of every lane AND delete the two counters that used to be the only cycle check.
tamperControl('RPT S12 dropped cycles + deleted counters', RPT_ENV, (recs) => reseq(recs.filter((r) => !(r.type === 'cycle' && r.cycle >= 3)).map((r) => {
    if (r.type === 'summary') { delete r.rollups; delete r.cyclesRun; } return r;
})), 'soak:report: ISSUE summary.rollups missing');
tamperControl('RPT S12 seq gap', RPT_ENV, (recs) => recs.filter((r, i) => i !== 5), 'soak:report: ISSUE seq: record 5');
tamperControl('RPT S12 fatal after the end', RPT_ENV, (recs) => recs.concat([{ type: 'fatal', seq: recs.length, kind: 'uncaughtException', lane: null, cycle: null, message: 'late crash', stack: null }]),
    'soak:report: INTEGRITY MISMATCH -- re-derived verdict FAIL');
tamperControl('RPT S12 string breaches (no crash)', RPT_ENV, (recs) => recs.map((r) => { if (r.type === 'summary') r.breaches = 'none'; return r; }),
    'soak:report: ISSUE summary.breaches is not an array of strings', null, ['--out', join(TMP, 'tamper.html')]);   // the HTML path used to TypeError
// baseline diffs: a weight-0 regression (totalViolations, not oracle-only violations) and a pool regression.
const WR_ENV = { SOAK_CYCLES: CYC, SOAK_PICKS: String(Q), SOAK_LANES: 'WeightedRandom' };
tamperControl('RPT S12 baseline: weight-0 regression', { ...WR_ENV, SOAK_MUSTFAIL: 'weight0' }, null, 'soak:report: REGRESSION vs baseline', () => genuineStream(WR_ENV));
tamperControl('RPT S12 baseline: pool regression', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolleak' }, null, 'soak:report: REGRESSION vs baseline', () => genuineStream({ ...PA, SOAK_LANES: 'PoolP2C' }));
// Baseline semantics (research/soak-baseline.md, accepted 2026-10-04): timing is REPORT-ONLY (a 2x faster
// baseline only NOTEs), heap FAILs on +5 MB -- but only against a baseline from the same Node major.
const scaleOps = (k) => (recs) => recs.map((r) => { if (r.type === 'cycle' && typeof r.hotOpsDense === 'number') r.hotOpsDense *= k; return r; });
const shiftHeap = (mb) => (recs) => recs.map((r) => { if (r.type === 'cycle' && typeof r.heapUsedMB === 'number') r.heapUsedMB += mb; return r; });
const otherNode = (recs) => recs.map((r) => { if (r.type === 'header') r.node = 'v20.0.0'; return r; });
tamperControl('RPT baseline: timing is report-only', RPT_ENV, null, 'soak:report: NOTE RoundRobin throughput -50.0% vs baseline (report-only',
    () => editedStream(genuineStream(RPT_ENV), scaleOps(2)), null, 0);
tamperControl('RPT baseline: heap +5 MB fails', RPT_ENV, null, 'soak:report: REGRESSION vs baseline',
    () => editedStream(genuineStream(RPT_ENV), shiftHeap(-5)));
tamperControl('RPT baseline: other Node major -> heap not compared', RPT_ENV, null, 'soak:report: NOTE * heap not compared',
    () => editedStream(genuineStream(RPT_ENV), (recs) => otherNode(shiftHeap(-5)(recs))), null, 0);
// A schema bump (S9: 3 -> 4) must not break the nightly: an older-schema baseline is "not compared", exit 0.
tamperControl('RPT baseline: older schema -> not compared', RPT_ENV, null, 'soak:report: NOTE * baseline not compared: schema',
    () => editedStream(genuineStream(RPT_ENV), (recs) => recs.map((r) => { if (r.type === 'header') r.schemaVersion = 3; return r; })), null, 0);
tamperControl('RPT S12 baseline integrity', RPT_ENV, null, 'soak:report: BASELINE INTEGRITY MISMATCH', () => editedStream(genuineStream(RPT_ENV), (recs) => recs.filter((r, i) => i !== 5)));

if (out.length === 0) { allOk = false; out.push('  MISS MUSTFAIL_ONLY=' + process.env.MUSTFAIL_ONLY + ' selected no control'); }
if (LIST) {
    for (const l of out) process.stdout.write(l + '\n');
    process.exit(allOk ? 0 : 1);
}
for (const l of out) process.stdout.write(l + '\n');
process.stdout.write('MUSTFAIL(through main.mjs): ' + (allOk ? 'all controls behaved AS REQUIRED (gates have teeth)' : 'A CONTROL MISBEHAVED -- gate is hollow or over-eager') + '\n');
process.exit(allOk ? 0 : 1);
