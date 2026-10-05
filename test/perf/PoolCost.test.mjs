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
 *     silently regress (on Node 26 L6 is bimodal under CPU contention; the row pins the upper mode);
 *   - clocked share   L8b - L1 <= CEIL.clocked (PeakEWMA + a 1.7e15 epoch-ns clock, which V8 boxes at
 *     the pick()/recordRtt boundary) -- a latency balancer costs more per attempt and is gated here;
 *   - TEETH (must trip the attempt-0 ceiling): PL_BOX (L3 + one escaped boxed double i+0.5 /run),
 *     CTRL_OBJ (+{a:i}), PLANT (+[]+push); the failover ceiling: PL_BOX6 (L6 + boxed double),
 *     CTRL_OBJ6 (+{a:i}); the clocked ceiling: PL_BOX8b (L8b + boxed double). CEIL = measured-share + 8
 *     B, below one boxed double, so even a single boxed value crossing a call trips it;
 *   - L9 (both diagnostics channels subscribed) == L3 -- the reused-message publish path is free;
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
 * (~0.7 B/run), so 8 B of slack trips on one boxed double yet never flakes. The one exception is the
 * Node-26 failover lane (L6), bimodal under CPU contention; its row pins the UPPER mode so the low mode
 * only passes. Rows below were measured with `npm run bench:pool` (darwin arm64). A process.version with
 * no row FAILS CLOSED, printing the measured shares so a row can be added. NEVER widen a ceiling to pass
 * -- if a share rose, find the regression; if a change is intended, re-measure and re-pin in the same change.
 *
 * NOT gated (reported by `npm run bench:pool`, above a successful run -- never quote these as cheap):
 * the abort-before-dispatch path (L7, ~1374 B/run on Node 22, above L3's ~1108).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
 *   v22.23.3: L1 204.5  L3 1108.5 (attempt0 904.0)  L6 1484.5 (failover 1280.0)  L8b 1140.7 (clocked 936.2)
 *   v26.8.2:  L1  47.9  L3  913.8 (attempt0 865.9)  L6 1324.2 (failover 1276.3)  L8b  976.7 (clocked 928.8)
 * attempt0 / clocked are deterministic 5x on both Nodes; failover (L6) is DETERMINISTIC on v22.23.3 but
 * BIMODAL on v26.8.2 under CPU contention (L6 settles at 1324.2 but drops to 1276.3 in a minority of
 * contended runs). The failover row pins the UPPER mode (share 1276.3), so the low mode can only pass.
 * `clocked` = a latency-aware balancer (PeakEWMA) driven by a 1.7e15 epoch-ns clock, which V8 boxes at
 * the non-inlined pick()/recordRtt boundary (read twice per successful attempt) -- ~32 B/run more than
 * L3 on v22.23.3, ~63 on v26.8.2. CEIL = share + SLACK. A version absent here fails closed (see the test).
 */
const SHARES = {
    'v22.23.3': { attempt0: 904.0, failover: 1280.0, clocked: 936.2 },
    'v26.8.2': { attempt0: 865.9, failover: 1276.3, clocked: 928.8 },
};
const VER = process.version;
const HAVE_ROW = Object.prototype.hasOwnProperty.call(SHARES, VER);
// The docs quote the v22.23.3 attempt-0 ceiling (the pinned CI perf job). 904.0 + 8 = 912.
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
function runLane(id) {
    if (LANE_CACHE.has(id)) return LANE_CACHE.get(id);
    const r = spawnSync(process.execPath, [...CHILD_FLAGS, LANES, id, String(N)], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'lane ' + id + ' exited ' + r.status + '\n' + (r.stderr || ''));
    const d = JSON.parse(r.stdout.trim().split('\n').pop());
    LANE_CACHE.set(id, d);
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

test('pool-cost: L9 (both channels subscribed) == L3 -- the unsubscribed-publish guard is free', () => {
    if (!HAVE_ROW) return;
    const l3 = runLane('L3');
    const l9 = runLane('L9');
    assert.equal(l9.bytesPerRun, l3.bytesPerRun,
        'L9 (both diagnostics channels subscribed) = ' + l9.bytesPerRun + ' B/run != L3 = ' + l3.bytesPerRun +
        ' -- with the reused message object a subscribed dispatch/settle must cost the same as L3 (Pool.js:70-73).');
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
