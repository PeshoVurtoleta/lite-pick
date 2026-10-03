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
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PICK = readFileSync(join(ROOT, 'Pick.js'), 'utf8');
const POOL = readFileSync(join(ROOT, 'Pool.js'), 'utf8');
const REAL_PICK_URL = pathToFileURL(join(ROOT, 'Pick.js')).href;   // scratch Pool imports the REAL kernel
const TMP = mkdtempSync(join(tmpdir(), 'litepick-mutant-'));
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
    try {
        execFileSync('node', NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: full, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
        return { status: 0, stderr: '' };
    } catch (e) {
        return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') };
    }
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
    try {
        execFileSync('node', NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: full, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
        return { status: 0, stderr: '' };
    } catch (e) {
        return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') };
    }
}

const out = [];
let allOk = true;
function record(name, r, wantStatus, wantBreach) {
    const statusOk = r.status === wantStatus;
    const breachOk = !wantBreach || r.stderr.indexOf(wantBreach) !== -1;
    const ok = statusOk && breachOk;
    if (!ok) allOk = false;
    const firstBreach = (r.stderr.match(/soak: FAIL -- .*/g) || [''])[0].slice(0, 90);
    out.push('  ' + (ok ? 'OK  ' : 'MISS') + ' ' + name.padEnd(34) +
        ' exit=' + r.status + ' want=' + wantStatus + (wantBreach ? ' [' + wantBreach + ']' : '') +
        (ok ? '' : '  <<< ' + (firstBreach || 'no breach')));
}
function control(name, src, env, wantStatus, wantBreach) {
    record(name, runSoak(writeMutant(src, name.replace(/[^a-z0-9]/gi, '')), env), wantStatus, wantBreach);
}
// A pool MODE control: clean kernel (PICK), SOAK_MUSTFAIL=<mode>, driven through a pool lane.
function modeControl(name, env, wantStatus, wantBreach) {
    record(name, runSoak(writeMutant(PICK, name.replace(/[^a-z0-9]/gi, '')), env), wantStatus, wantBreach);
}
// A pool.js mutant control (SOAK_POOL seam, clean kernel).
function poolControl(name, poolSrc, env, wantStatus, wantBreach) {
    const pp = join(TMP, 'pool-' + (idx++) + '-' + name.replace(/[^a-z0-9]/gi, '') + '.js');
    writeFileSync(pp, poolSrc);
    record(name, runSoakPool(pp, env), wantStatus, wantBreach);
}

const A = 20000, Q = 100000;   // alloc mutants can use a short main loop; quality mutants need windows

// --- alloc mutants (RoundRobin.pick), driven through the hotAlloc gate --------------------------
control('M1 160KB-array/8192', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c & 8191) === 0) { this.__o = new Array(40000); }')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'hotAlloc[RoundRobin]');
control('M2 retained-log/8th', patch(PICK, RR_ANCHOR, RR_INJECT('if (!this.__log) this.__log = []; if ((this.__c & 7) === 0) this.__log.push({ a: this.__c });')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'hotAlloc[RoundRobin]');
control('M3 64KB-burst/24576', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c % 24576) === 0) { this.__o = new Array(8192); }')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'hotAlloc[RoundRobin]');
control('M4 2-field-object/64', patch(PICK, RR_ANCHOR, RR_INJECT('if ((this.__c & 63) === 0) { this.__o = { a: this.__c, b: 0 }; }')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'hotAlloc[RoundRobin]');

// --- quality mutants, driven through the SmoothWRR / WeightedRandom oracles ----------------------
// M5: SmoothWRR ignores weight in the accumulator -> a PERSISTENT ratio corruption (near-uniform
// instead of weight-proportional), exactly what the |count - W*w/S| <= maxWt+1 drift oracle exists
// for. (A "missing _current reset" mutant is deliberately NOT used: SmoothWRR's -=total step self-
// corrects a transient accumulator offset over a long quiet window, so it is not a lasting defect.)
control('M5 SmoothWRR ignores-weight',
    patch(PICK, '                const c = cur[i] + wt[i];', '                const c = cur[i] + 1;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR' }, 1, 'quality');
// M6: the H3 weight-0 regression -- BOTH the pick-loop guard AND the setWeight credit-reset removed,
// so a node drained to weight 0 keeps its stale credit and gets returned. The lane-agnostic H3 guard
// (weights[picked]===0) fires; the same guard protects CH/BL (see report note).
control('M6 SmoothWRR weight-0 (H3)',
    patch(
        patch(PICK, '            if (el[i] && wt[i] > 0) {       // eligible AND positive weight: a weight-0 node is never a candidate', '            if (el[i]) {'),
        '        this._current[i] = 0;               // reset credit: a reweighted node holds no stale accumulator', '        /* mutant: setWeight credit-reset removed (H3) */'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR' }, 1, 'quality');
// M6b: the SAME H3 defect in ConsistentHash's Maglev build -- a weight-0 backend is given a table
// slot (+1 quota) instead of zero, so it becomes reachable and gets picked. Proves the weight-0 guard
// has teeth on the KEYED lanes too, not only SmoothWRR.
control('M6b CH weight-0 (H3, keyed)',
    patch(PICK, 'const q = Math.floor(wt[b] / total * M);', 'const q = Math.floor(wt[b] / total * M) + 1;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'ConsistentHash' }, 1, 'quality');
control('M7 biased WR sampler',
    patch(PICK, '            const cand = u < prob[col] ? col : alias[col];', '            const cand = col;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'WeightedRandom' }, 1, 'quality');

// --- increment 2a: load / keyed oracles (oracles.mjs), each proven through main ------------------
// M8: P2C returns the WORSE of the two choices -> load balance collapses -> the max-mean bound trips.
control('M8 P2C worst-of-two',
    patch(PICK, 'return this._inflight[b] < this._inflight[a] ? b : a;', 'return this._inflight[b] > this._inflight[a] ? b : a;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'quality');
// M9: LeastConn picks the MOST-loaded eligible node -> the argmin oracle trips. (SED/NQ share the
// identical oracleArgmin path, differing only in the recomputed score; see report note.)
control('M9 LeastConn non-argmin',
    patch(PICK, '                if (best < 0 || c < bestLoad) { best = i; bestLoad = c; }', '                if (best < 0 || c > bestLoad) { best = i; bestLoad = c; }'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'LeastConn' }, 1, 'quality');
// M10: ConsistentHash rotates the start slot per call (in ITS OWN fast path) -> a key no longer
// sticks -> the consecutive-equality stickiness check trips.
// M10: the reviewer's exact mutant -- a slot rotation that advances PER setEligible (this.__ROT++ in
// BalancerBase.setEligible; CH pick starts at (key + __ROT) % M). It keeps every pick eligible (safety
// green) but moves a key's home across membership changes -> the stickiness oracle's flap check trips.
control('M10 CH stickiness break (per-setEligible rotation)',
    patchAll(
        patch(PICK, '    setEligible(i, up) {\n        _vIdx(i, this._cap);', '    setEligible(i, up) {\n        this.__ROT = (this.__ROT | 0) + 1;\n        _vIdx(i, this._cap);'),
        '        let slot = (keyHash >>> 0) % M;', '        let slot = ((keyHash >>> 0) + (this.__ROT | 0)) % M;', 2),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'ConsistentHash' }, 1, 'quality');
// M11: BoundedLoad drops the +1 that counts the incoming request (the H4 bug) -> under-caps -> the
// reference walk disagrees with the pick.
control('M11 BoundedLoad H4 under-cap',
    patch(PICK, 'const cap = capActive ? (1 + this._eps) * (total + 1) / this._live : 0;   // > 0: total>0, live>0', 'const cap = capActive ? Math.ceil((1 + this._eps) * total / this._live) : 0;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'BoundedLoad' }, 1, 'quality');

// M12: PeakEWMA ignores the cost comparison (no latency steering, the H1 black-hole shape) -> the
// busy slow node is no longer avoided and gets ~uniform share -> the slowNode-share oracle trips.
control('M12 PeakEWMA H1 no-steer',
    patch(PICK, '        return costB < costA ? b : a;         // lower cost wins; tie -> the first draw', '        return a;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'PeakEWMA' }, 1, 'quality');

// M13 (T6 tiny lanes): P2C returns PICK_NONE on a live===1 pool (breaking the cap-1 shortcut). On the
// tiny P2C lane (cap 1 when cycle%3===0) this makes pick() fail closed with a healthy node up -> the
// fail-closed-IFF safety invariant trips at a checkpoint. Proves the tiny cap-1 path is really driven.
control('M13 P2C cap-1 mispick',
    patchAll(PICK, '        if (this._live === 1) return a;       // only one eligible: it is both choices', '        if (this._live === 1) return PICK_NONE;', 2),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'P2C' }, 1, 'invariants');

// M14 (T16): a ~1-in-97 pick stall that GROWS with a process-global counter, so later cycles are slower
// than early ones -> the p99 tail drifts up across the run -> latencyP99 trips. The stall is rare enough
// that the median (p50 / dense throughput) is barely moved -- it is a TAIL regression.
control('M14 latency tail inflate (growing stall)',
    patch(PICK, RR_ANCHOR, RR_INJECT('globalThis.__L = (globalThis.__L | 0) + 1; if ((globalThis.__L % 97) === 0) { let x = 0; const n = 120 * (1 + (globalThis.__L >> 16)); for (let z = 0; z < n; z++) x += z; this.__s = x; }')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'latencyP99');

// M15 (NIT B): BoundedLoad note() double-counts -> _total desyncs from the true sum(inflight). The BL
// oracle recomputes total INDEPENDENTLY, so the kernel's wrong cap makes its pick disagree with the
// reference -> trips. (A shared-state oracle reading b._total would be blind to this.)
control('M15 BoundedLoad _total desync',
    patch(PICK, '        const t = this._total + delta;', '        const t = this._total + delta * 2;'),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'BoundedLoad' }, 1, 'quality');

// M16 (NIT1): a periodic allocation RARER than one B/op pass (64KB every 2^20 picks, ~0.0625 B/op = 3x
// the bound). The MIN estimator misses it (it lands in only one pass per cycle, like a one-off), but it
// RECURS every cycle -> the cross-cycle recurrence rule (max(pass1,pass2) > bound in >=2 cycles) trips.
// A genuine one-off (once per process) does NOT recur and correctly does not fire.
control('M16 64KB/2^20 periodic (recurrence)',
    patch(PICK, RR_ANCHOR, RR_INJECT('globalThis.__P20 = (globalThis.__P20 | 0) + 1; if ((globalThis.__P20 & 0xFFFFF) === 0) { this.__o = new Array(8192); }')),
    { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin' }, 1, 'hotAlloc[RoundRobin]');

// --- POOL LANE teeth (T14-15): each assertion proven by a REAL Pool.js mutant via the SOAK_POOL seam
// (Pool.js stays byte-frozen -- the mutant is a scratch copy). These catch REAL Pool bugs, not harness
// self-injections. The three required harness MODES (poolleak/poolnote/poolunhandled) are also run. ----
const PA = { SOAK_CYCLES: '7', SOAK_PICKS: String(A) };
// A1: note(+1) on dispatch removed -> b._total stays 0 while inflight grows -> A1 fails IN FLIGHT.
poolControl('MP1 note-removed (A1 totalInflight)',
    patchPool('                    b.note(i, 1);', '                    ;'),
    { ...PA, SOAK_LANES: 'PoolBoundedLoad' }, 1, 'pool assertion');
// A2: a settle inflight-- skipped 1/500 -> inflight cells stuck > 0 at quiescence.
poolControl('MP2 settle-skip (A2 quiescence)',
    patchPool('                inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;', '                if (((this.__sk = (this.__sk | 0) + 1) % 500) !== 0) inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A3: a run never settles 1/997 -> the batch deadline trips -> lostRun -> assert3_accounted FAIL.
poolControl('MP3 never-resolving (A3 lost run)',
    patchPool('                out = await fn(i, signal);', '                out = await ((this.__hg = (this.__hg | 0) + 1) % 997 === 0 ? new Promise(() => {}) : fn(i, signal));'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A4/outcome: no failover (break on attempt>0) -> a failover run rejects instead of resolving.
poolControl('MP4 no-failover (outcome)',
    patchPool('                let i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());', '                if (attempt > 0) break;\n                let i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A4/outcome: abort checks disabled -> an aborted run resolves instead of rejecting with the reason.
poolControl('MP4b abort-ignored (outcome)',
    patchPool('if (signal && signal.aborted)', 'if (false && signal.aborted)', 2),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A5: failover reuses a tried endpoint (distinctness broken).
poolControl('MP5 failover-repeat (A5 distinct)',
    patchPool('                if (attempt > 0) {', '                if (attempt > 0) { i = held[0]; } else if (false) {'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A6: Pool retains every instance in a global -> tracker.size() never drains.
poolControl('MP6 pool-retains-self (A6 retention)',
    patchPool('        const b = this._b, inflight = this._inflight;', '        const b = this._b, inflight = this._inflight; (globalThis.__PLEAK = globalThis.__PLEAK || []).push(this);'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'pool assertion');
// A7: Pool creates an unhandled rejection.
poolControl('MP7 pool-unhandled (A7)',
    patchPool('        const o = opts != null ? opts : undefined;', '        const o = opts != null ? opts : undefined; if (((this.__ur = (this.__ur | 0) + 1) % 1000) === 0) Promise.reject(new Error("pool unhandled"));'),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 1, 'unhandled');
// The three REQUIRED harness modes (also exit 1 through main).
modeControl('MPm1 poolnote mode (A1)', { ...PA, SOAK_LANES: 'PoolBoundedLoad', SOAK_MUSTFAIL: 'poolnote' }, 1, 'pool assertion');
modeControl('MPm2 poolleak mode (A2)', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolleak' }, 1, 'pool assertion');
modeControl('MPm3 poolunhandled mode (A7)', { ...PA, SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolunhandled' }, 1, 'unhandled');

// --- config fail-closed cases (audit 1.1): a bad env aborts with exit 2, never a silent 0-picks PASS.
// These run the CLEAN in-tree kernel (config is parsed before the kernel does anything). --------------
function runCfg(env, flags) {
    const full = Object.assign({}, process.env, { SOAK_OUT: join(TMP, 'cfg-' + (idx++) + '.jsonl') }, env);
    try {
        execFileSync('node', (flags || NODE_FLAGS).concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: full, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
        return { status: 0, stderr: '' };
    } catch (e) { return { status: e.status === undefined ? -1 : e.status, stderr: String(e.stderr || '') }; }
}
function cfgCase(name, env, flags) { record('CFG ' + name, runCfg(env, flags), 2, null); }
cfgCase('SOAK_CYCLES=abc', { SOAK_CYCLES: 'abc' });
cfgCase('SOAK_CYCLES=-5', { SOAK_CYCLES: '-5' });
cfgCase('SOAK_CYCLES=2.5', { SOAK_CYCLES: '2.5' });
cfgCase('SOAK_CYCLES=3 (below 7)', { SOAK_CYCLES: '3' });
cfgCase('SOAK_PICKS=xyz', { SOAK_PICKS: 'xyz' });
cfgCase('SOAK_CYCLE typo (unknown key)', { SOAK_CYCLE: '5' });
cfgCase('CYCLES+DURATION mutually exclusive', { SOAK_CYCLES: '7', SOAK_DURATION: '1m' });
cfgCase('SOAK_DURATION=45 (no unit)', { SOAK_DURATION: '45' });
cfgCase('SOAK_OUT empty', { SOAK_OUT: '', SOAK_CYCLES: '7' });
cfgCase('unpinned semi-space', { SOAK_CYCLES: '7' }, ['--expose-gc']);

// --- the 1.0.0-revert check (audit 1.5): the ORIGINAL buggy kernel (before the 1.0.1 audit fixes) must
// be CAUGHT by the new quality gates -- the whole point of adding them. git show the pre-fix Pick.js into
// a scratch file and drive the H3 (SmoothWRR/CH weight-0), H4 (BoundedLoad cap) and H1 (PeakEWMA) lanes;
// it must exit 1 on a quality breach. (Pool.js/markers unchanged in the fix, so the kernel-lane soak loads
// the old kernel fine.) ---------------------------------------------------------------------------------
{
    const name = 'REVERT 1.0.0 kernel (H1/H3/H4)';
    try {
        const old = execFileSync('git', ['show', '8c1ecc7:Pick.js'], { cwd: ROOT, encoding: 'utf8' });
        const p = writeMutant(old, 'revert100');
        record(name, runSoak(p, { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'SmoothWRR,BoundedLoad,PeakEWMA' }), 1, 'quality');
    } catch (e) {
        allOk = false;
        out.push('  MISS ' + name.padEnd(34) + ' <<< could not run: ' + String(e.message || e).slice(0, 80));
    }
}

// --- pass-control: the CLEAN kernel through the same path must exit 0 ----------------------------
control('P clean kernel (pass-control)', PICK,
    { SOAK_CYCLES: '7', SOAK_PICKS: String(Q), SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0, null);
poolControl('P2 clean pool (pass-control)', patchPool("from '" + REAL_PICK_URL + "'", "from '" + REAL_PICK_URL + "'"),
    { ...PA, SOAK_LANES: 'PoolP2C' }, 0, null);

// --- soak:report pass-controls: a GENUINE (untampered) stream must pass its own integrity check. These
// run SoakReport.mjs on real streams so a report regression (e.g. a smoke/FAIL false-alarm) is caught by
// the teeth battery, not only by the reviewer. ---------------------------------------------------------
function reportControl(name, soakEnv, wantExit) {
    const stream = join(TMP, 'rep-' + (idx++) + '.jsonl');
    try { execFileSync('node', NODE_FLAGS.concat(['benchmark/soak/main.mjs']), { cwd: ROOT, env: Object.assign({}, process.env, soakEnv, { SOAK_OUT: stream }), stdio: 'ignore' }); } catch { /* the soak itself may exit 1 (a FAIL stream); we only report on its output */ }
    let status = 0, stderr = '';
    try { execFileSync('node', ['benchmark/soak/SoakReport.mjs', stream], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }); }
    catch (e) { status = e.status === undefined ? -1 : e.status; stderr = String(e.stderr || ''); }
    record(name, { status, stderr }, wantExit, null);
}
reportControl('RPT clean non-smoke -> integrity OK', { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0);
reportControl('RPT clean smoke -> integrity OK', { SOAK_SMOKE: '1', SOAK_LANES: 'RoundRobin,SmoothWRR,WeightedRandom' }, 0);
reportControl('RPT genuine FAIL stream -> integrity OK', { SOAK_CYCLES: '7', SOAK_PICKS: String(A), SOAK_LANES: 'RoundRobin', SOAK_MUSTFAIL: 'imbalance' }, 0);

for (const l of out) process.stdout.write(l + '\n');
process.stdout.write('MUSTFAIL(through main.mjs): ' + (allOk ? 'all controls behaved AS REQUIRED (gates have teeth)' : 'A CONTROL MISBEHAVED -- gate is hollow or over-eager') + '\n');
process.exit(allOk ? 0 : 1);
