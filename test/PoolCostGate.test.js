/**
 * @zakkster/lite-pick -- must-fail tests for the PoolCost L9 gate's fail-closed paths.
 *
 *     node --test test/PoolCostGate.test.js
 *
 * test/perf/PoolCost.test.mjs (run by `test:perf:pool`, needs --expose-gc + pinned semi-space) decides its
 * L9 gate with the pure helpers in test/perf/pool-cost-gate.mjs. Those helpers only run there against REAL
 * lanes, which are always well-formed, so no committed test ever showed that a malformed lane result, a bad
 * child-flag pin or a crashed lane child actually FAILS the gate. This suite does, fast and without GC flags:
 * fake lane results are plain objects, and parseLaneResult gets tiny fake child scripts spawned with
 * process.execPath from a mkdtempSync dir (removed in finally). Each must-fail case asserts the throw and its
 * message; a positive control per helper proves the case fails for the stated reason, not by accident.
 *
 * REVERT CONTROLS (each must turn this suite RED -- the reviewer can apply them to pool-cost-gate.mjs):
 *   (a) checkQuantum WITHOUT its count re-derivation (drop the `fromCounts` assert): the bytesPerRun 0.1-off
 *       cases stop throwing;
 *   (a2) checkQuantum WITHOUT its integer-count assert: the coerced-consistent cases (sN null with bytesPerRun
 *       = s8N x Q, s8N null with bytesPerRun = -sN x Q, fractional and string counts) stop throwing, and the
 *       s8N / sN null, missing and NaN cases throw the fromCounts message instead of the integer one;
 *   (b) childSemiBytes WITHOUT `min === max` (keep only `max > 0`): the min != max case (and min missing)
 *       stops throwing;
 *   (c) parseLaneResult IGNORING r.status: the exit 1 and SIGKILL children print a VALID lane line before
 *       dying, so the exit cases parse cleanly and stop throwing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CHILD_FLAGS as FLAGS, N,
    LANE_WIN_LO, LANE_WIN_HI, L9_TOL, l9Within, childSemiBytes, quantumOf, checkQuantum, parseLaneResult,
} from './perf/pool-cost-gate.mjs';

// The lane's OWN conversion, written out from pool-cost-lanes.mjs main() (count difference x 1 MiB / (7 N),
// then 0.1 rounding) -- an oracle independent of checkQuantum's LANE_WIN_* / childSemiBytes derivation.
function laneBpr(c) { return Math.round(c * 1048576 / (7 * 200000) * 10) / 10; }
// A CONSISTENT fake lane result: c = s8N - sN scavenges, bytesPerRun as the lane reports it.
function fake(c, sN = 1000) {
    return { lane: 'LF', N, sN, s8N: sN + c, bytesPerRun: laneBpr(c), oldN: 0, old8N: 0 };
}
const C = 1459;                                    // the CI-flake L3 count (CI 38110241059: L3 1092.8 B/run)
const Q = quantumOf(fake(C), N, FLAGS);

// ---- the quantum and its configuration ------------------------------------------------------------------

test('pool-cost-gate: Q is one scavenge of a 1 MiB semi-space over the 7N window span', () => {
    assert.equal(LANE_WIN_HI - LANE_WIN_LO, 7);
    assert.equal(Q, 1048576 / (7 * 200000));
    assert.equal(fake(C).bytesPerRun, 1092.8);
    assert.doesNotThrow(() => checkQuantum(fake(C), Q, N, FLAGS));   // positive control for every case below
});

test('pool-cost-gate: checkQuantum re-derivation equals the lane formula for every count 0..4000', () => {
    for (let c = 0; c <= 4000; c++) {
        const d = fake(c);
        const q = quantumOf(d, N, FLAGS);
        assert.equal(q, Q);
        checkQuantum(d, q, N, FLAGS);   // throws on the first count where the two formulas disagree
    }
});

// ---- checkQuantum: malformed scavenge counts (revert controls a, a2) ------------------------------------

test('pool-cost-gate: s8N / sN null, missing or NaN fail checkQuantum', () => {
    // The integer-count assert fires first. (Without it, these fakes would still throw the fromCounts message:
    // they keep bytesPerRun at the TRUE count difference, which the coerced difference does not reproduce.)
    const cases = [
        ['s8N', null, /lane LF scavenge counts must be integers \(got sN 1000, s8N null\)/],
        ['s8N', undefined, /lane LF scavenge counts must be integers \(got sN 1000, s8N undefined\)/],
        ['s8N', NaN, /lane LF scavenge counts must be integers \(got sN 1000, s8N NaN\)/],
        ['sN', null, /lane LF scavenge counts must be integers \(got sN null, s8N 2459\)/],
        ['sN', undefined, /lane LF scavenge counts must be integers \(got sN undefined, s8N 2459\)/],
        ['sN', NaN, /lane LF scavenge counts must be integers \(got sN NaN, s8N 2459\)/],
    ];
    for (const [key, value, re] of cases) {
        const d = fake(C);
        if (value === undefined) delete d[key]; else d[key] = value;
        assert.throws(() => checkQuantum(d, Q, N, FLAGS), re, key + ' = ' + String(value) + ' must fail closed');
    }
});

test('pool-cost-gate: a non-integer count whose COERCED difference matches bytesPerRun fails checkQuantum', () => {
    // The fail-open shape: null coerces to 0 and a string to its number in (s8N - sN), so a bytesPerRun computed
    // from the coerced difference (by the lane's own formula, laneBpr) passes the fromCounts compare. Only the
    // integer-count assert catches these.
    const cases = [
        ['sN', null, (d) => laneBpr(d.s8N), 'got sN null, s8N 2459'],             // bytesPerRun = s8N x Q
        ['s8N', null, (d) => laneBpr(0 - d.sN), 'got sN 1000, s8N null'],         // bytesPerRun = -sN x Q
        ['sN', 1000.5, (d) => laneBpr(d.s8N - d.sN), 'got sN 1000.5, s8N 2459'],  // fractional
        ['s8N', 2459.5, (d) => laneBpr(d.s8N - d.sN), 'got sN 1000, s8N 2459.5'], // fractional
        ['sN', '1000', (d) => laneBpr(d.s8N - d.sN), 'got sN 1000, s8N 2459'],    // a string, not a number
    ];
    for (const [key, value, bpr, got] of cases) {
        const d = fake(C);
        d[key] = value;
        d.bytesPerRun = bpr(d);
        // The shape really is consistent under coercion: the fromCounts compare alone would accept it.
        assert.equal(d.bytesPerRun, laneBpr(Number(d.s8N) - Number(d.sN)), key + ' = ' + String(value));
        const re = new RegExp('lane LF scavenge counts must be integers \\(' + got.replace('.', '\\.') + '\\)');
        assert.throws(() => checkQuantum(d, Q, N, FLAGS), re, key + ' = ' + String(value) + ' must fail closed');
    }
});

test('pool-cost-gate: a bytesPerRun 0.1 off its own counts fails checkQuantum', () => {
    for (const delta of [0.1, -0.1]) {
        const d = fake(C);
        d.bytesPerRun = Math.round((d.bytesPerRun + delta) * 10) / 10;
        assert.notEqual(d.bytesPerRun, 1092.8);
        assert.throws(() => checkQuantum(d, Q, N, FLAGS),
            /lane LF reported 109\d\.\d B\/run but its scavenge counts \(1000, 2459\) x Q = 1092\.8 -- /);
    }
});

test('pool-cost-gate: a q from another configuration fails checkQuantum', () => {
    assert.throws(() => checkQuantum(fake(C), Q * 2, N, FLAGS),
        /lane LF does not share the measurement configuration of Q/);
});

// ---- quantumOf: the lane's N must be the gate's N -------------------------------------------------------

test('pool-cost-gate: lane N 100000, the string "200000" or missing fails quantumOf and checkQuantum', () => {
    const cases = [
        [100000, /lane LF measured N = 100000, expected 200000/],
        ['200000', /lane LF measured N = 200000, expected 200000/],   // strict: a string is not the number
        [undefined, /lane LF measured N = undefined, expected 200000/],
    ];
    for (const [value, re] of cases) {
        const d = fake(C);
        if (value === undefined) delete d.N; else d.N = value;
        assert.throws(() => quantumOf(d, N, FLAGS), re);
        assert.throws(() => checkQuantum(d, Q, N, FLAGS), re);
    }
});

// ---- childSemiBytes: the child's semi-space pin (revert control b) --------------------------------------

test('pool-cost-gate: childSemiBytes reads a min == max pin', () => {
    assert.equal(childSemiBytes(FLAGS), 1048576);
    assert.equal(childSemiBytes(['--min-semi-space-size=4', '--max-semi-space-size=4']), 4 * 1048576);
});

test('pool-cost-gate: childSemiBytes fails closed on every unpinned or malformed flag set', () => {
    const cases = [
        [['--min-semi-space-size=1', '--max-semi-space-size=2'], 'got min 1, max 2'],         // min != max
        [['--expose-gc', '--max-semi-space-size=1'], 'got min NaN, max 1'],                   // min missing
        [['--expose-gc', '--min-semi-space-size=1'], 'got min 1, max NaN'],                   // max missing
        [[], 'got min NaN, max NaN'],                                                         // empty
        [['--min-semi-space-size=0', '--max-semi-space-size=0'], 'got min 0, max 0'],         // zero pin
        [['--min-semi-space-size=-1', '--max-semi-space-size=-1'], 'got min -1, max -1'],     // negative pin
        [['--min-semi-space-size=x', '--max-semi-space-size=x'], 'got min NaN, max NaN'],     // non-numeric
        // Only the `--flag=value` form is parsed. The space-separated form -- one string, or the two argv
        // elements V8 itself would accept -- is NOT read: both values stay NaN, so it fails closed.
        [['--min-semi-space-size 1', '--max-semi-space-size 1'], 'got min NaN, max NaN'],
        [['--min-semi-space-size', '1', '--max-semi-space-size', '1'], 'got min NaN, max NaN'],
    ];
    for (const [flags, got] of cases) {
        const re = new RegExp('CHILD_FLAGS must pin min == max semi-space \\(' + got + '\\) -- ');
        assert.throws(() => childSemiBytes(flags), re, JSON.stringify(flags));
        assert.throws(() => quantumOf(fake(C), N, flags), re, 'quantumOf ' + JSON.stringify(flags));
    }
});

// ---- l9Within: the one-sided, one-scavenge L9 tolerance -------------------------------------------------

test('pool-cost-gate: l9Within boundary -- L9 may be any amount cheaper and at most ONE scavenge dearer', () => {
    const d3 = C;
    assert.equal(l9Within(d3, d3), true);
    assert.equal(l9Within(d3 + 1, d3), true);
    assert.equal(l9Within(d3 + 2, d3), false);
    assert.equal(l9Within(1458, 1459), true);   // CI 38110241059 attempt 1: L9 1092 vs L3 1092.8 (one cheaper)
    for (let c = 0; c <= 4000; c++) {
        for (let d9 = c - 1; d9 <= c + 2; d9++) {
            assert.equal(l9Within(d9, c), d9 - c <= 1, 'l9Within(' + d9 + ', ' + c + ')');
        }
    }
});

test('pool-cost-gate: blind counters -- what the helpers accept, and what catches it instead', () => {
    // A blind scavenge counter reports all-zero (or nonsense negative) counts. These helpers are pure
    // arithmetic and cannot tell: a CONSISTENT all-zero or negative fake passes checkQuantum, and
    // l9Within(0, 0) is true, so L9's own comparison would "pass". What catches a blind counter lives in
    // test/perf/PoolCost.test.mjs, not here: the PL_BOX bound (assert.ok(!l9Within(dpb, d3)) -- a blind
    // counter reads PL_BOX's dpb no higher than d3, so that assertion FAILS), the fresh-message mutant's
    // `!l9Within(dm, d3) && m.bytesPerRun - bound > SLACK` teeth, and the attempt-0 floor (L3-L1 >= 600).
    const zero = fake(0, 0);
    assert.equal(zero.bytesPerRun, 0);
    assert.doesNotThrow(() => checkQuantum(zero, Q, N, FLAGS));
    assert.equal(l9Within(0, 0), true);
    // The PL_BOX bound asserts !l9Within(dpb, d3); with a blind dpb = d3 = 0 that predicate is false, so the
    // gate's bound assertion FAILS (fails closed) rather than passing a blind counter.
    assert.equal(!l9Within(0, 0), false);
    const neg = fake(-5, 10);
    assert.equal(neg.bytesPerRun, laneBpr(-5));
    assert.doesNotThrow(() => checkQuantum(neg, Q, N, FLAGS));
    assert.equal(l9Within(-5, 0), true);
    assert.equal(l9Within(-5, -5), true);
    assert.equal(L9_TOL, 1);
});

// ---- parseLaneResult: the lane child's exit (revert control c) ------------------------------------------

const GOOD_LINE = JSON.stringify(fake(C));
// Child scripts write with fs.writeSync (synchronous on every platform, unlike a piped process.stdout),
// so the valid lane line is really on stdout before the child dies.
const SCRIPTS = {
    'ok.js': "import { writeSync } from 'node:fs';\n" +
        "writeSync(1, 'warm-up noise\\n' + " + JSON.stringify(GOOD_LINE) + " + '\\n');\n",
    'exit1.js': "import { writeSync } from 'node:fs';\n" +
        "writeSync(1, " + JSON.stringify(GOOD_LINE) + " + '\\n');\n" +
        "writeSync(2, 'boom-stderr\\n');\n" +
        'process.exit(1);\n',
    'kill.js': "import { writeSync } from 'node:fs';\n" +
        "writeSync(1, " + JSON.stringify(GOOD_LINE) + " + '\\n');\n" +
        "process.kill(process.pid, 'SIGKILL');\n",
    'empty.js': 'process.exitCode = 0;\n',
    'garbage.js': "import { writeSync } from 'node:fs';\n" +
        "writeSync(1, 'lane warming up\\nnot json\\n');\n",
};

function withChildren(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'litepick-poolcostgate-'));
    try {
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}');   // Node 18: .js children are ESM
        for (const name of Object.keys(SCRIPTS)) writeFileSync(join(dir, name), SCRIPTS[name]);
        const run = (name) => spawnSync(process.execPath, [join(dir, name)], { encoding: 'utf8' });
        fn(run);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('pool-cost-gate: parseLaneResult -- a clean exit returns the LAST stdout line (positive control)', () => {
    withChildren((run) => {
        const r = run('ok.js');
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(parseLaneResult(r, 'LF'), fake(C));
    });
});

test('pool-cost-gate: parseLaneResult -- exit 1 and SIGKILL fail closed even with a valid lane line', () => {
    withChildren((run) => {
        const r1 = run('exit1.js');
        assert.equal(r1.status, 1);
        assert.ok(r1.stdout.includes(GOOD_LINE), 'the exit-1 child must print a valid lane line first');
        assert.throws(() => parseLaneResult(r1, 'L1'), /lane L1 exited 1\nboom-stderr/);

        const rk = run('kill.js');
        // POSIX: a signal kill has status null (null is not zero). Windows has no signals: TerminateProcess
        // reports exit code 1.
        if (process.platform !== 'win32') {
            assert.equal(rk.status, null);
            assert.equal(rk.signal, 'SIGKILL');
        }
        assert.ok(rk.stdout.includes(GOOD_LINE), 'the killed child must print a valid lane line first');
        assert.throws(() => parseLaneResult(rk, 'LK'), new RegExp('lane LK exited ' + rk.status + '\\n'));
    });
    // The status-null path on every platform, as a plain spawnSync-shaped object.
    assert.throws(() => parseLaneResult({ status: null, signal: 'SIGKILL', stdout: GOOD_LINE + '\n', stderr: '' }, 'LN'),
        /lane LN exited null\n/);
});

test('pool-cost-gate: parseLaneResult -- exit 0 with empty or non-JSON stdout throws', () => {
    withChildren((run) => {
        const re = run('empty.js');
        assert.equal(re.status, 0, re.stderr);
        assert.equal(re.stdout, '');
        assert.throws(() => parseLaneResult(re, 'LE'), /^SyntaxError: .*JSON/);
        const rg = run('garbage.js');
        assert.equal(rg.status, 0, rg.stderr);
        assert.throws(() => parseLaneResult(rg, 'LG'), /^SyntaxError: .*JSON/);
    });
});
