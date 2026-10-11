/**
 * @zakkster/lite-pick -- the Pool.run cost gate (companion to PerfGate, for the ASYNC /pool layer).
 *
 * Run:  node --expose-gc --min-semi-space-size=1 --max-semi-space-size=1 --test test/perf/PoolCost.test.mjs
 *       (or: npm run test:perf:pool)
 *
 * The kernel pick() is 0 B/op (PerfGate). Pool.run is a normal async function and is NOT 0 B/op: a run
 * that settles on attempt 0 costs a promise + a frame + one await; each failover attempt adds another.
 * This gate pins Pool's OWN share (above the bare-await driver floor L1) by the scavenge-count ladder in
 * test/perf/pool-cost-lanes.mjs -- each lane in its own pinned child, after a FIXED 3,000,000-run
 * warm-up (the lanes reach steady state and hold it; there is no adaptive detector). It asserts, for the
 * CURRENT exact process.version:
 *   - L0 (bare pick + inflight ++/--) is 0 B/run -- the floor really is free;
 *   - attempt-0 share L3 - L1 <= CEIL.attempt0;
 *   - failover share  L6 - L1 <= CEIL.failover (one extra, re-picked attempt) -- so failover can never
 *     silently regress (on Node 26 L6 was bimodal under contention before 1.2.0; see SHARES);
 *   - weighted-fallback share L6CH - L1 <= the SAME CEIL.failover (1.2.0: a weighted ConsistentHash, cap 64,
 *     whose attempt 1 always reaches Pool's weighted fallback `_chooseUntried`) -- the fallback allocates
 *     nothing; TEETH: the same lane over a Pool.js mutant whose fallback builds a candidate array MUST trip it;
 *   - clocked share   L8b - L1 <= CEIL.clocked (PeakEWMA + a 1.7e15 epoch-ns clock, which V8 boxes at
 *     the pick()/recordRtt boundary) -- a latency balancer costs more per attempt and is gated here;
 *   - TEETH (must trip the attempt-0 ceiling): PL_BOX (L3 + one escaped boxed double i+0.5 /run),
 *     CTRL_OBJ (+{a:i}), PLANT (+[]+push); the failover ceiling: PL_BOX6 (L6 + boxed double),
 *     CTRL_OBJ6 (+{a:i}); the clocked ceiling: PL_BOX8b (L8b + boxed double). CEIL = measured-share + 8
 *     B, below one boxed double, so even a single boxed value crossing a call trips it;
 *   - L9 (both diagnostics channels subscribed) <= L3 + ONE scavenge quantum (one-sided; the quantum is
 *     derived from runLane's own window/semi-space configuration) -- the reused-message publish path is
 *     free; three checks hold the tolerance (L9_TOL): TEETH -- L9 over a Pool.js mutant that builds a FRESH
 *     message object per publish MUST exceed it; BOUND -- PL_BOX (L3 + one boxed double/run) MUST also
 *     exceed it, so the tolerance stays below one boxed double; PIN -- L9_TOL is asserted to be exactly 1;
 *   - OLD-GEN is 0 in every measured window. This catches a transient per-run allocation but NOT a
 *     RETAINED, pretenured one: an object that survives into old_space does not raise the young-gen
 *     scavenge RATE (B/run) and is only caught by the PROMOTE control, whose old-gen count MUST be > 0
 *     -- otherwise the oldGen==0 assertion is vacuous;
 *   - RETENTION: 50 cycles x 1000 mixed-shape runs over a FRESH Pool each cycle (lite-leak) -- after gc
 *     the tracker is empty and every inflight slot is 0; a control that deliberately retains one Pool
 *     MUST leave tracker.size() >= 1 (else the retention lane is blind);
 *   - the gated attempt-0 ceiling literal "<= <ceil> B" is present at every doc site.
 *
 * CEIL = (measured share) + 8 B, keyed by EXACT process.version (NOT major): V8 fixes the per-run byte
 * cost, and under the fixed warm-up + 1 MiB pin the attempt-0 and clocked shares are stable to +/-1
 * (~0.7 B/run), so 8 B of slack trips on one boxed double yet never flakes. The one exception was the
 * Node-26 failover lane (L6), bimodal under contention before 1.2.0 (see SHARES): a row pins the upper
 * observed mode, so a lower mode only passes. Rows below were measured with `npm run bench:pool` (darwin arm64). A process.version with
 * no row FAILS CLOSED, printing the measured shares so a row can be added. NEVER widen a ceiling to pass
 * -- if a share rose, find the regression; if a change is intended, re-measure and re-pin in the same change.
 *
 * NOT gated (reported by `npm run bench:pool`, above a successful run -- never quote these as cheap):
 * the abort-before-dispatch path (L7, ~1374 B/run on Node 22, above L3's ~1108).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Pool } from '../../Pool.js';
import { P2cBalancer } from '../../Pick.js';

const LANES = fileURLToPath(new URL('./pool-cost-lanes.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD_FLAGS = ['--expose-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];
const N = 200000;

// Slack above the measured share. 8 B: below one boxed double (a ~16 B HeapNumber), so a single boxed
// value crossing a call trips the gate (the PL_BOX / PL_BOX6 teeth below), and comfortably above the
// measured run-to-run jitter (<= 1 scavenge ~= 0.7 B/run under the fixed 3,000,000-run warm-up). NEVER
// raise it to make a measurement fit.
const SLACK = 8;

/**
 * Measured SHARES (lane B/run - L1 B/run), by EXACT process.version. `npm run bench:pool`, darwin arm64,
 * N=200000, young gen pinned to 1 MiB, FIXED 3,000,000-run warm-up:
 *   v22.23.3: L1 204.5  L3 1092.8 (attempt0 888.3)  L6 1467.3 (failover 1262.8)  L8b 1125.7 (clocked 921.2)
 *   v26.8.2:  L1  47.9  L3  898.0 (attempt0 850.1)  L6 1266.5 (failover 1218.6)  L8b  960.2 (clocked 912.3)
 *   Re-pinned 1.2.0 (TIGHTER, every row): Pool's failover fallback became a weighted choice and run()'s
 *   interpreter frame lost a register (60 -> 59), so EVERY path got ~16 B/run cheaper (1bc5eec on v22.23.3:
 *   L3 1108.5, L6 1484.5, L8b 1140.7; on v26.8.2: L3 913.8, L6 1324.2, L8b 976.7). The old rows left the
 *   one-box teeth (PL_BOX, PL_BOX6, PL_BOX8b on v22; PL_BOX6 on v26) UNDER their ceilings -- a stale ceiling
 *   is a blunt gate. L6 on v26.8.2 read 1266.5 in 6/6 runs under 6-way contention (no low mode seen).
 * attempt0 / clocked are deterministic 5x on both Nodes; failover (L6) is DETERMINISTIC on v22.23.3. On
 * v26.8.2 it was BIMODAL before 1.2.0 (upper mode: lane 1324.2 = share 1276.3; a lower mode appeared in a
 * minority of contended runs; the row pinned the upper-mode share). After the 1.2.0 re-pin the lane read
 * 1266.5 (share 1218.6) in 6/6 contended runs with no low mode seen, and the row pins that share -- if
 * a lower mode reappears it can only pass; a higher one fails.
 * `clocked` = a latency-aware balancer (PeakEWMA) driven by a 1.7e15 epoch-ns clock, which V8 boxes at
 * the non-inlined pick()/recordRtt boundary (read twice per successful attempt) -- ~32 B/run more than
 * L3 on v22.23.3, ~63 on v26.8.2. CEIL = share + SLACK. A version absent here fails closed (see the test).
 */
const SHARES = {
    'v22.23.3': { attempt0: 888.3, failover: 1262.8, clocked: 921.2 },
    'v26.8.2': { attempt0: 850.1, failover: 1218.6, clocked: 912.3 },
};
const VER = process.version;
const HAVE_ROW = Object.prototype.hasOwnProperty.call(SHARES, VER);
// The docs quote the v22.23.3 attempt-0 ceiling (the pinned CI perf job). 888.3 + 8 = 896.3 (1.2.0; was 912).
const DOC_CEIL = SHARES['v22.23.3'].attempt0 + SLACK;

function ceilOf(kind) { return SHARES[VER][kind] + SLACK; }

// ---- fail-closed semi-space pin check (PerfGate.test.mjs:44-59) -----------
function semiSpaceMB(flag) {
    const av = process.execArgv;
    for (let i = 0; i < av.length; i++) {
        const a = av[i];
        if (a === flag && i + 1 < av.length) return Number(av[i + 1]);
        if (a.startsWith(flag + '=')) return Number(a.slice(flag.length + 1));
    }
    return NaN;
}
test('pool-cost: semi-space pinned to 1MB (min AND max) -- fail closed', () => {
    const max = semiSpaceMB('--max-semi-space-size');
    const min = semiSpaceMB('--min-semi-space-size');
    assert.equal(max, 1, 'run with --max-semi-space-size=1 (got ' + max + ') -- use: npm run test:perf:pool');
    assert.equal(min, 1, 'run with --min-semi-space-size=1 so new space does not grow mid-run ' +
        '(got ' + min + ') -- use: npm run test:perf:pool');
});

const LANE_CACHE = new Map();
function runLane(id, poolImpl) {
    const ck = poolImpl ? id + '@' + poolImpl : id;
    if (LANE_CACHE.has(ck)) return LANE_CACHE.get(ck);
    const env = poolImpl ? { ...process.env, LITE_POOL_IMPL: poolImpl } : process.env;
    const r = spawnSync(process.execPath, [...CHILD_FLAGS, LANES, id, String(N)], { encoding: 'utf8', env });
    assert.equal(r.status, 0, 'lane ' + id + ' exited ' + r.status + '\n' + (r.stderr || ''));
    const d = JSON.parse(r.stdout.trim().split('\n').pop());
    LANE_CACHE.set(ck, d);
    return d;
}
function share(id, l1) { return runLane(id).bytesPerRun - l1.bytesPerRun; }

test('pool-cost: this exact process.version has a measured CEIL row (else fail closed)', () => {
    if (HAVE_ROW) return;
    const l1 = runLane('L1');
    const measured = (id) => (runLane(id).bytesPerRun - l1.bytesPerRun).toFixed(1);
    assert.fail('no CEIL row for ' + VER + ' -- run `npm run bench:pool` on this exact version and add a ' +
        'SHARES row (CEIL = share + ' + SLACK + ' B). Never invent a row or widen an existing one. ' +
        'Measured here: attempt0 (L3-L1) = ' + measured('L3') + ', failover (L6-L1) = ' + measured('L6') +
        ', clocked (L8b-L1) = ' + measured('L8b') + ' B/run.');
});

test('pool-cost: the floor (L0) is 0 B/run and old-gen is 0', () => {
    const d = runLane('L0');
    assert.equal(d.bytesPerRun, 0, 'L0 (bare pick + inflight ++/--) must be 0 B/run, got ' + d.bytesPerRun);
    assert.equal(d.oldN, 0, 'L0 old-gen (N window) must be 0');
    assert.equal(d.old8N, 0, 'L0 old-gen (8N window) must be 0');
});

test('pool-cost: attempt-0 share (L3-L1) <= CEIL and old-gen 0 in every window', () => {
    if (!HAVE_ROW) return;
    const l1 = runLane('L1');
    const l3 = runLane('L3');
    for (const [id, d] of [['L1', l1], ['L3', l3]]) {
        assert.equal(d.oldN, 0, id + ' old-gen (N window) must be 0, got ' + d.oldN);
        assert.equal(d.old8N, 0, id + ' old-gen (8N window) must be 0, got ' + d.old8N);
    }
    const s = l3.bytesPerRun - l1.bytesPerRun;
    assert.ok(s <= ceilOf('attempt0'),
        'attempt-0 share L3-L1 = ' + s.toFixed(1) + ' B/run exceeds CEIL.attempt0 = ' + ceilOf('attempt0').toFixed(1) +
        ' (' + VER + ') -- a per-run allocation regressed. Fix the code, never widen the ceiling. (npm run bench:pool)');
    assert.ok(s >= 600, 'attempt-0 share L3-L1 = ' + s.toFixed(1) + ' B/run is below 600 -- attribution looks wrong.');
});

test('pool-cost: failover share (L6-L1) <= CEIL.failover and old-gen 0', () => {
    if (!HAVE_ROW) return;
    const l1 = runLane('L1');
    const l6 = runLane('L6');
    assert.equal(l6.oldN, 0, 'L6 old-gen (N window) must be 0, got ' + l6.oldN);
    assert.equal(l6.old8N, 0, 'L6 old-gen (8N window) must be 0, got ' + l6.old8N);
    const s = l6.bytesPerRun - l1.bytesPerRun;
    assert.ok(s <= ceilOf('failover'),
        'failover share L6-L1 = ' + s.toFixed(1) + ' B/run exceeds CEIL.failover = ' + ceilOf('failover').toFixed(1) +
        ' (' + VER + ') -- the failover path allocated more per attempt. Fix the code, never widen the ceiling.');
});

/**
 * The allocating mutant of Pool's weighted fallback (1.2.0): pass 1 collects (index, weight) pairs into a
 * fresh candidate array and pass 2 walks the array -- the obvious "simpler" implementation. Written to a
 * scratch dir with a copy of Pick.js beside it (Pool.js imports './Pick.js').
 */
function allocatingFallbackPool(dir) {
    const src = readFileSync(ROOT + 'Pool.js', 'utf8');
    const from = `    let run = 0, last = PICK_NONE;
    for (let i = 0; i < cap; i++) {
        if (b.isEligible(i) && held.indexOf(i) < 0) {
            const w = hasW ? b.weightOf(i) : 1;
            if (typeof w === 'number' && w > 0 && w < Infinity) {
                run += w;
                last = i;
                if (t < run) return i;
            }
        }
    }
    return last;`;
    const to = `    const cand = [];
    for (let i = 0; i < cap; i++) {
        if (b.isEligible(i) && held.indexOf(i) < 0) {
            const w = hasW ? b.weightOf(i) : 1;
            if (typeof w === 'number' && w > 0 && w < Infinity) cand.push(i, w);
        }
    }
    let run = 0, last = PICK_NONE;
    for (let j = 0; j < cand.length; j += 2) { run += cand[j + 1]; last = cand[j]; if (t < run) return last; }
    return last;`;
    assert.equal(src.split(from).length - 1, 1, 'mutant anchor: the fallback\'s second pass, found once in Pool.js');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    copyFileSync(ROOT + 'Pick.js', join(dir, 'Pick.js'));
    writeFileSync(join(dir, 'Pool.js'), src.split(from).join(to));
    return join(dir, 'Pool.js');
}

test('pool-cost: weighted-fallback share (L6CH-L1, weighted CH cap 64) <= CEIL.failover; an allocating fallback trips it', () => {
    if (!HAVE_ROW) return;
    const l1 = runLane('L1');
    const d = runLane('L6CH');
    assert.equal(d.oldN, 0, 'L6CH old-gen (N window) must be 0, got ' + d.oldN);
    assert.equal(d.old8N, 0, 'L6CH old-gen (8N window) must be 0, got ' + d.old8N);
    const s = d.bytesPerRun - l1.bytesPerRun;
    assert.ok(s <= ceilOf('failover'),
        'weighted-fallback share L6CH-L1 = ' + s.toFixed(1) + ' B/run exceeds CEIL.failover = ' + ceilOf('failover').toFixed(1) +
        ' (' + VER + ') -- Pool\'s weighted failover fallback allocated. Fix the code, never widen the ceiling.');
    const dir = mkdtempSync(join(tmpdir(), 'litepick-poolcost-'));
    try {
        const sm = runLane('L6CH', allocatingFallbackPool(dir)).bytesPerRun - l1.bytesPerRun;
        assert.ok(sm > ceilOf('failover'),
            'L6CH over the candidate-array mutant = ' + sm.toFixed(1) + ' B/run did NOT exceed CEIL.failover = ' +
            ceilOf('failover').toFixed(1) + ' -- the weighted-fallback gate has no teeth.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pool-cost: clocked share (L8b-L1, epoch-ns clock) <= CEIL.clocked and old-gen 0', () => {
    if (!HAVE_ROW) return;
    const l1 = runLane('L1');
    const l8b = runLane('L8b');
    assert.equal(l8b.oldN, 0, 'L8b old-gen (N window) must be 0, got ' + l8b.oldN);
    assert.equal(l8b.old8N, 0, 'L8b old-gen (8N window) must be 0, got ' + l8b.old8N);
    const s = l8b.bytesPerRun - l1.bytesPerRun;
    assert.ok(s <= ceilOf('clocked'),
        'clocked share L8b-L1 = ' + s.toFixed(1) + ' B/run exceeds CEIL.clocked = ' + ceilOf('clocked').toFixed(1) +
        ' (' + VER + ') -- a latency balancer with an epoch-ns clock allocated more. Fix the code, never widen the ceiling.');
    // Teeth: an escaped boxed double on top of the clocked path must trip CEIL.clocked.
    const s8 = share('PL_BOX8b', l1);
    assert.ok(s8 > ceilOf('clocked'),
        'PL_BOX8b-L1 = ' + s8.toFixed(1) + ' B/run did NOT exceed CEIL.clocked = ' + ceilOf('clocked').toFixed(1) +
        ' -- the clocked gate has no teeth.');
});

test('pool-cost: the teeth -- CTRL_OBJ/PLANT trip attempt0, CTRL_OBJ6 trips failover', () => {
    if (!HAVE_ROW) return;
    const l1 = runLane('L1');
    // PL_BOX / CTRL_OBJ / PLANT reintroduce a single per-run allocation on the attempt-0 path (a boxed
    // double, a small object, an array) -- the SLACK=8 ceiling must catch even the ~16 B boxed double.
    for (const id of ['PL_BOX', 'CTRL_OBJ', 'PLANT']) {
        const d = runLane(id);
        assert.equal(d.oldN, 0, id + ' old-gen (N window) must be 0');
        assert.equal(d.old8N, 0, id + ' old-gen (8N window) must be 0');
        const s = d.bytesPerRun - l1.bytesPerRun;
        assert.ok(s > ceilOf('attempt0'),
            id + '-L1 = ' + s.toFixed(1) + ' B/run did NOT exceed CEIL.attempt0 = ' + ceilOf('attempt0').toFixed(1) +
            ' -- the teeth are blunt: a reintroduced per-run allocation would slip past the gate.');
    }
    // PL_BOX6 / CTRL_OBJ6 reintroduce a per-attempt allocation on the FAILOVER path.
    for (const id of ['PL_BOX6', 'CTRL_OBJ6']) {
        const s6 = share(id, l1);
        assert.ok(s6 > ceilOf('failover'),
            id + '-L1 = ' + s6.toFixed(1) + ' B/run did NOT exceed CEIL.failover = ' + ceilOf('failover').toFixed(1) +
            ' -- the failover gate has no teeth.');
    }
});

/**
 * ONE scavenge quantum in B/run, derived from runLane's own measurement configuration -- never typed in.
 * pool-cost-lanes.mjs counts minor GCs over a window of N runs and one of 8N runs (its main(): lo = N,
 * hi = 8 * N) under the young generation pinned by CHILD_FLAGS, and converts the count difference as
 *     B/run = (S_8N - S_N) x semiBytes / ((8 - 1) x N)
 * so one scavenge more or less moves B/run by semiBytes / (7 N) (~0.75 B/run at 1 MiB, N = 200000).
 * `checkQuantum` proves this is the lane's real conversion: each lane's reported bytesPerRun must equal
 * its own scavenge counts times Q (rounded to 0.1 as the lane rounds); if the lane formula, the windows
 * or the pin ever change, that check fails closed instead of the quantum silently going stale.
 */
const LANE_WIN_LO = 1;   // countWindow(drive, lane, N, ...)      -- pool-cost-lanes.mjs main()
const LANE_WIN_HI = 8;   // countWindow(drive, lane, 8 * N, ...)  -- pool-cost-lanes.mjs main()
// The ONE L9 tolerance, in scavenges (Q each): exactly one quantum (ADR 0007, +/-1 scavenge). Three checks
// hold it, none of them by itself: (a) the gate and the fresh-message control share l9Within, which proves
// the gate trips on the mutant (that mutant clears the bound by ~185-200 scavenges, so it alone does NOT bound
// the tolerance); (b) PL_BOX (L3 + one boxed double per run: measured 23 scavenges above L3 on v22.23.3, the
// pinned CI perf job, and 61 on v26.8.2) must ALSO fall outside
// l9Within, so any tolerance wide enough to hide one boxed double fails; (c) the literal is pinned to 1 in the
// L9 test, which catches every other change. NEVER raise it to pass.
const L9_TOL = 1;
function l9Within(d9, d3) { return d9 <= d3 + L9_TOL; }
function childSemiBytes() {
    let max = NaN, min = NaN;
    for (const f of CHILD_FLAGS) {
        if (f.startsWith('--max-semi-space-size=')) max = Number(f.slice('--max-semi-space-size='.length));
        if (f.startsWith('--min-semi-space-size=')) min = Number(f.slice('--min-semi-space-size='.length));
    }
    assert.ok(max > 0 && min === max, 'CHILD_FLAGS must pin min == max semi-space (got min ' + min + ', max ' + max +
        ') -- without both, one scavenge is not a fixed number of bytes and the quantum is undefined');
    return max * 1048576;
}
function quantumOf(d) {
    assert.equal(d.N, N, 'lane ' + d.lane + ' measured N = ' + d.N + ', expected ' + N);
    return childSemiBytes() / ((LANE_WIN_HI - LANE_WIN_LO) * d.N);
}
function checkQuantum(d, q) {
    assert.equal(quantumOf(d), q, 'lane ' + d.lane + ' does not share the measurement configuration of Q');
    // Same operation order as the lane (count x semiBytes / (span x N), then 0.1 rounding), so an equal
    // formula can never differ here by a float ulp.
    const fromCounts = Math.round(((d.s8N - d.sN) * childSemiBytes()) / ((LANE_WIN_HI - LANE_WIN_LO) * d.N) * 10) / 10;
    assert.equal(d.bytesPerRun, fromCounts,
        'lane ' + d.lane + ' reported ' + d.bytesPerRun + ' B/run but its scavenge counts (' + d.sN + ', ' + d.s8N +
        ') x Q = ' + fromCounts + ' -- pool-cost-lanes.mjs no longer converts counts the way Q assumes; re-derive Q.');
}

/**
 * The allocating mutant of Pool's publish path: every dispatch / settle publish builds a FRESH message
 * object instead of reusing _dMsg / _sMsg (the design research 7.2 measured at 315-458 scavenges / 10M
 * runs). Written to a scratch dir with a copy of Pick.js beside it, as allocatingFallbackPool does.
 */
function freshMessagePool(dir) {
    const src = readFileSync(ROOT + 'Pool.js', 'utf8');
    const anchors = ['_dDepth === 0 ? _dMsg : ', '_sDepth === 0 ? _sMsg : '];
    let out = src;
    for (const a of anchors) {
        assert.equal(out.split(a).length - 1, 1, 'mutant anchor "' + a + '" must be found once in Pool.js');
        out = out.split(a).join('');
    }
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    copyFileSync(ROOT + 'Pick.js', join(dir, 'Pick.js'));
    writeFileSync(join(dir, 'Pool.js'), out);
    return join(dir, 'Pool.js');
}

test('pool-cost: L9 (both channels subscribed) <= L3 + one scavenge quantum; a fresh-message publish trips it', () => {
    if (!HAVE_ROW) return;
    const l3 = runLane('L3');
    const l9 = runLane('L9');
    const q = quantumOf(l3);
    checkQuantum(l3, q);
    checkQuantum(l9, q);
    assert.equal(L9_TOL, 1, 'L9_TOL = ' + L9_TOL + ': the L9 tolerance is exactly one scavenge quantum (ADR 0007, ' +
        'lanes stable to +/-1 scavenge); changing it is a gate change that needs a maintainer decision.');
    // ONE-SIDED, one quantum. B/run is scavenge-QUANTISED and each lane is stable only to +/-1 scavenge
    // (ADR 0007), so an exact L9 == L3 flaked (CI 38110241059 attempt 1: L9 1092 vs L3 1092.8, L9 one quantum
    // CHEAPER). L9 may be any amount cheaper and at most ONE scavenge dearer. Compared in the integer
    // scavenge counts that bytesPerRun is made of -- the same test as l9 <= l3 + Q in B/run, exactly,
    // without the lanes' 0.1 B rounding or a float ulp deciding it.
    const d3 = l3.s8N - l3.sN;
    const d9 = l9.s8N - l9.sN;
    const bound = l3.bytesPerRun + L9_TOL * q;
    const tolText = 'L3 + ' + L9_TOL + ' x Q = ' + bound.toFixed(2);
    assert.ok(l9Within(d9, d3),
        'L9 (both diagnostics channels subscribed) = ' + l9.bytesPerRun + ' B/run exceeds ' + tolText +
        ' (Q = one scavenge = ' + q.toFixed(3) + ' B/run; scavenges ' + d9 + ' vs ' + d3 +
        ') -- a subscribed dispatch/settle allocated per run; the reused message objects (Pool.js _dMsg / _sMsg) ' +
        'must keep it within ' + L9_TOL + ' scavenge(s) of L3. Fix the code, never widen Q or L9_TOL.');
    // TOLERANCE BOUND: PL_BOX is L3 + ONE escaped boxed double per run (already run and cached by the teeth
    // test). It must fall OUTSIDE l9Within, so the tolerance stays below one boxed double.
    const pb = runLane('PL_BOX');
    checkQuantum(pb, q);
    const dpb = pb.s8N - pb.sN;
    assert.ok(!l9Within(dpb, d3),
        'PL_BOX (L3 + one boxed double/run) = ' + pb.bytesPerRun + ' B/run (scavenges ' + dpb + ' vs L3 ' + d3 +
        ') is within ' + tolText + ' -- L9_TOL = ' + L9_TOL + ' would hide a boxed double per run.');
    // TEETH: the same lane over a Pool.js that allocates a fresh message per publish MUST fall outside
    // l9Within, and exceed the bound by more than SLACK (below one boxed double).
    const dir = mkdtempSync(join(tmpdir(), 'litepick-poolcost-'));
    try {
        const m = runLane('L9', freshMessagePool(dir));
        checkQuantum(m, q);
        const dm = m.s8N - m.sN;
        assert.ok(!l9Within(dm, d3) && m.bytesPerRun - bound > SLACK,
            'L9 over the fresh-message mutant = ' + m.bytesPerRun + ' B/run (scavenges ' + dm + ') did NOT exceed ' +
            tolText + ' by more than SLACK = ' + SLACK + ' B -- the L9 gate has no teeth.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pool-cost: the old-gen teeth -- PROMOTE forces an old-gen collection', () => {
    const p = runLane('PROMOTE');
    assert.ok((p.oldN + p.old8N) > 0,
        'PROMOTE (retains per-run objects) showed 0 old-gen GCs (N:' + p.oldN + ' 8N:' + p.old8N +
        ') -- the oldGen==0 assertion on the real lanes is vacuous; the counter cannot see promotion.');
});

test('pool-cost: RETENTION -- no Pool outlives its cycle, inflight drains to 0 (with a retained control)', async () => {
    const CAP = 8;
    const ERR = new Error('retention-preallocated');
    // The cleanup closes over NOTHING and the tag is a literal (lite-leak held-value contract: neither
    // may capture the tracked Pool, or finalization is defeated and the harness reports a false clean).
    const noop = () => {};

    // churn(tracker, keepArr): 50 cycles x 1000 mixed-shape runs over a FRESH Pool each cycle. If keepArr
    // is given, ONE pool is deliberately retained into it (the control). No onLeak handler: a Pool owns no
    // external kernel, so being COLLECTED is the desired outcome; the proof is tracker.size() -> 0.
    async function churn(tracker, keepArr) {
        for (let c = 0; c < 50; c++) {
            const el = new Uint8Array(CAP).fill(1);
            const inflight = new Uint32Array(CAP);
            const pool = new Pool(new P2cBalancer(CAP, el, inflight, c + 1), inflight);
            tracker.track(pool, noop, 'pool', { audit: true });
            if (keepArr && c === 7) keepArr.push(pool);   // control: this one must NOT be collectable
            let attempt = 0;
            for (let i = 0; i < 1000; i++) {
                const shape = i % 3;
                if (shape === 0) {
                    await pool.run((ep) => ep, { tries: 1 });                                            // L3 shape
                } else if (shape === 1) {
                    attempt = 0;
                    await pool.run((ep) => { if (attempt++ === 0) throw ERR; return ep; }, { tries: 2 }); // L6 shape
                } else {
                    try { await pool.run((ep) => ep, { tries: 1, signal: { aborted: true, reason: ERR } }); } catch { /* L7 abort */ }
                }
            }
            for (let k = 0; k < CAP; k++) {
                assert.equal(inflight[k], 0, 'inflight[' + k + '] = ' + inflight[k] + ' after cycle ' + c + ' -- a counter leaked');
            }
        }
    }

    async function settle(tracker) {
        globalThis.gc();
        await sleep(50);
        globalThis.gc();
        let live = tracker.size();
        for (let i = 0; i < 8 && live > 0; i++) { globalThis.gc(); await sleep(20); live = tracker.size(); }
        return live;
    }

    // CONTROL: one Pool retained -> the tracker must still see it (proves the lane is not blind).
    const warns0 = [];
    const ctlTracker = createLeakTracker({ name: 'poolcost-ctl', onWarning: (w) => warns0.push(w.kind + ':' + w.reason) });
    const kept = [];
    await churn(ctlTracker, kept);
    const ctlLive = await settle(ctlTracker);
    assert.ok(kept.length === 1 && ctlLive >= 1,
        'retention CONTROL is blind: a deliberately retained Pool left tracker.size() = ' + ctlLive + ' (expected >= 1)');

    // The real test: nothing retained -> every Pool is collected.
    const warns = [];
    const tracker = createLeakTracker({ name: 'poolcost', onWarning: (w) => warns.push(w.kind + ':' + w.reason) });
    await churn(tracker, null);
    const live = await settle(tracker);
    const findings = tracker.audit();
    assert.equal(live, 0, 'a Pool outlived its cycle: tracker.size() = ' + live);
    assert.equal(findings.length, 0, 'retention findings: ' + findings.join(', '));
    assert.equal(warns.length, 0, 'warnings: ' + warns.join(', '));
});

test('pool-cost: the gated attempt-0 ceiling literal "<= ' + DOC_CEIL + ' B" is present at every doc site', () => {
    const sites = ['Pool.js', 'README.md', 'llms.txt', 'RECIPES.md', 'decisions/0007-pool-adapter.md'];
    const needle = '<= ' + DOC_CEIL + ' B';
    for (const site of sites) {
        const text = readFileSync(ROOT + site, 'utf8');
        assert.ok(text.includes(needle),
            site + ' is missing the gated ceiling literal "' + needle + '" -- the doc claim and the gate ' +
            'must quote the same number (v22.23.3 attempt-0 ceiling). Update the doc if the ceiling changed.');
    }
});
