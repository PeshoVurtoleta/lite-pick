/**
 * @zakkster/lite-pick -- soak teeth COVERAGE meta-test (audit 2026-09-29, burst 9b).
 *
 *     node --test test/SoakTeeth.test.js
 *
 * The must-fail battery (benchmark/soak/_mustfail.mjs) proves gates trip -- but only the gates it has a
 * control for, and nothing proved the battery covered them all. This suite lists the battery without
 * running it (MUSTFAIL_LIST=1: every mutant is BUILT, so a stale patch anchor fails here, in `npm test`,
 * instead of at nightly time) and checks it against the manifest benchmark/soak/teeth.mjs:
 *   - every check is covered by a control, or is UNREACHABLE from main.mjs with a proof here (a unit run of
 *     the real gate code, or a source pin), or is a declared gap -- and no gap/unreachable entry is covered;
 *   - a report-only gate (REPORT_ONLY_GATES) cannot FAIL even on input built to breach it;
 *   - every control's spec is well-formed (a typo'd spec could only MISS);
 *   - the manifest matches the code (gate names, breach families, pool assertions, quality kinds,
 *     INCONCLUSIVE / NOTE causes), so a new gate cannot slip in without a check;
 *   - the nightly's two MUSTFAIL_ONLY jobs partition the battery (every control runs exactly once).
 * Zero-dep and fast (< 1 s): it runs in the no-install Node 18 job too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
    checks, covers, validSpec, GAPS, UNREACHABLE, BREACH_FAMILIES, POOL_ASSERTIONS, QUALITY_KINDS, INCONCLUSIVE_CAUSES, NOTE_GATES,
} from '../benchmark/soak/teeth.mjs';
import { GATE_NAMES, REPORT_ONLY_GATES, GateAccumulator, VERDICT } from '../benchmark/soak/gates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const scan = (text, re) => { const out = new Set(); for (const m of text.matchAll(re)) out.add(m[1]); return [...out].sort(); };
const sorted = (a) => [...a].sort();

function listBattery() {
    const env = Object.assign({}, process.env, { MUSTFAIL_LIST: '1' });
    delete env.MUSTFAIL_ONLY;
    const r = spawnSync(process.execPath, ['benchmark/soak/_mustfail.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, 'MUSTFAIL_LIST=1 failed (a stale patch anchor?):\n' + r.stderr);
    const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    // The list must end with its sentinel and count every row: a truncated pipe (macOS) must FAIL, not
    // quietly drop the tail of the battery.
    const end = rows.pop();
    assert.deepEqual(end, { end: true, count: rows.length }, 'MUSTFAIL_LIST output truncated or unterminated');
    return rows;
}
const CONTROLS = listBattery();
const CHECKS = checks();

test('the battery lists controls with unique names', () => {
    assert.ok(CONTROLS.length > 0);
    const names = CONTROLS.map((c) => c.name);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

test('every control spec is well-formed against the manifest', () => {
    const bad = CONTROLS.flatMap((c) => c.specs.map((sp) => [c.name, sp, validSpec(sp)])).filter((x) => x[2] !== null);
    assert.deepEqual(bad, []);
});

test('every check is covered by a control, unreachable with a proof, or a declared gap', () => {
    const uncovered = CHECKS.filter((k) => !CONTROLS.some((c) => covers(c, k)) && !(k.id in GAPS) && !(k.id in UNREACHABLE)).map((k) => k.id);
    assert.deepEqual(uncovered, [], 'checks with no control (add one; never a GAPS line for a new gate)');
});

test('no declared gap is stale (covered, or not a check)', () => {
    const ids = CHECKS.map((k) => k.id);
    const notACheck = Object.keys(GAPS).filter((g) => ids.indexOf(g) === -1);
    assert.deepEqual(notACheck, [], 'GAPS keys that are no check id');
    const nowCovered = CHECKS.filter((k) => (k.id in GAPS) && CONTROLS.some((c) => covers(c, k))).map((k) => k.id);
    assert.deepEqual(nowCovered, [], 'covered now: delete these GAPS lines');
});

// --- UNREACHABLE: one proof per entry, against the REAL gate code main.mjs feeds -------------------------
const OPTS = { smoke: false, lanes: ['RoundRobin'], interrupted: false, timerFloorNs: 41, poolLaunched: 0 };
/** A plausible cycle record (the fields GateAccumulator reads), with `over` applied per cycle. */
function rec(cycle, over) {
    return Object.assign({
        lane: 'RoundRobin', cycle, tier: 'kernel', heapUsedMB: 20, rssMB: 80, hotOpsDense: 2e8, hotOpsSparse: 1e8,
        gcPauseAvgMs: 0.1, latency: { p99: 100, samples: 96000 }, rebuildP99: 0, rebuildSamples: 0, gcMajor: 0,
        totalPicks: 100000, hotBytesPerOp: 0, hotBopNonFinite: false, hotBopGcFree: 128, hotBopPassMax: 0,
    }, over(cycle));
}
function judge(over) {
    const acc = new GateAccumulator({ warmupCycles: 1, gateN: 5, lanes: ['RoundRobin'] });
    for (let c = 0; c < 11; c++) acc.push(rec(c, over));
    return acc.compute(OPTS);
}
const PROOFS = {
    'gate=totalPicks': () => {
        const g = judge(() => ({ totalPicks: 0 }));
        assert.equal(g.verdict, VERDICT.FAIL);
        assert.ok(g.breaches.some((b) => b.startsWith('totalPicks=0')), g.breaches.join(' | '));
    },
    'soak: INCONCLUSIVE -- hotAlloc[': () => {
        const g = judge(() => ({ hotBytesPerOp: null, hotBopGcFree: 64 }));
        assert.equal(g.verdict, VERDICT.INCONCLUSIVE);
        assert.ok(g.inconclusive.some((w) => w.startsWith('hotAlloc[RoundRobin]')), g.inconclusive.join(' | '));
    },
    'tracker': () => {
        const main = src('benchmark/soak/main.mjs');
        assert.ok(/tracker\.audit\(\)/.test(main), 'the tracker check exists');
        assert.ok(!/registerKernel/.test(main), 'main.mjs now registers a lite-leak kernel: the tracker check is reachable -- add a control and drop the UNREACHABLE entry');
    },
};

test('every UNREACHABLE entry is a check, uncovered, not a gap, and has a proof', () => {
    const ids = CHECKS.map((k) => k.id);
    assert.deepEqual(Object.keys(UNREACHABLE).filter((u) => ids.indexOf(u) === -1), [], 'UNREACHABLE keys that are no check id');
    assert.deepEqual(Object.keys(UNREACHABLE).filter((u) => u in GAPS), [], 'both UNREACHABLE and a gap');
    const covered = CHECKS.filter((k) => (k.id in UNREACHABLE) && CONTROLS.some((c) => covers(c, k))).map((k) => k.id);
    assert.deepEqual(covered, [], 'a control reaches these: delete their UNREACHABLE entries');
    assert.deepEqual(sorted(Object.keys(PROOFS)), sorted(Object.keys(UNREACHABLE)));
});

for (const id of Object.keys(PROOFS)) test('UNREACHABLE proof: ' + id, PROOFS[id]);

test('report-only gates cannot FAIL, even on input built to breach them', () => {
    assert.deepEqual(sorted(REPORT_ONLY_GATES), ['gcPause', 'rebuild']);
    // late rebuild p99 x10000 with 5000 samples per window; late mean pause x500 -- both far past their bounds.
    const g = judge((c) => ({ rebuildSamples: 1000, rebuildP99: c >= 6 ? 1e6 : 100, gcPauseAvgMs: c >= 6 ? 50 : 0.1 }));
    for (const name of REPORT_ONLY_GATES) {
        assert.equal(g.perLane[0].gates[name].verdict, VERDICT.STUB, name);
        assert.ok(!g.breaches.some((b) => b.startsWith(name + '[')), name + ' breached');
    }
    assert.equal(g.perLane[0].gates.gcPause.wouldFail, true, 'the report still records that gcPause WOULD fail');
    assert.equal(g.verdict, VERDICT.PASS);
});

test('GATE_NAMES is exactly what computeGates() judges', () => {
    const acc = new GateAccumulator({ warmupCycles: 1, gateN: 5, lanes: ['RoundRobin'] });
    const g = acc.compute({ smoke: true, lanes: ['RoundRobin'], interrupted: false, timerFloorNs: 0, poolLaunched: 0 });
    assert.deepEqual(sorted(GATE_NAMES), sorted(Object.keys(g.perLane[0].gates).concat(['totalPicks'])));
});

test('breach families / pool assertions / quality kinds match what the soak emits', () => {
    const main = src('benchmark/soak/main.mjs'), jsonl = src('benchmark/soak/jsonl.mjs');
    const fams = sorted(new Set(scan(main, /breach\('([a-z]+)[= ]/g).concat(scan(jsonl, /soak: BREACH ([a-z]+)[= ]/g))));
    assert.deepEqual(fams, sorted(BREACH_FAMILIES));
    assert.deepEqual(sorted(new Set(scan(main, /pool=(A\d)/g).concat(scan(jsonl, /pool=(A\d)/g)))), sorted(POOL_ASSERTIONS));
    assert.deepEqual(scan(main, /kinds\.push\('(\w+)'\)/g), sorted(QUALITY_KINDS));
});

test('INCONCLUSIVE causes and NOTE gates match what the soak emits', () => {
    const gates = src('benchmark/soak/gates.mjs'), main = src('benchmark/soak/main.mjs');
    const emitted = scan(gates, /inconclusive\.push\('([^'[]*\[?)/g).concat(scan(main, /'soak: INCONCLUSIVE -- ([^']+)'/g));
    assert.ok(emitted.length > 0);
    assert.deepEqual(emitted.filter((e) => !INCONCLUSIVE_CAUSES.some((c) => e.startsWith(c))), [], 'emitted cause not in INCONCLUSIVE_CAUSES');
    assert.deepEqual(INCONCLUSIVE_CAUSES.filter((c) => !emitted.some((e) => e.startsWith(c))), [], 'INCONCLUSIVE_CAUSES entry the soak never emits');
    assert.deepEqual(scan(gates, /notes\.push\('(\w+)\[/g), sorted(NOTE_GATES));
});

test('the nightly teeth jobs partition the battery (every control exactly once)', () => {
    const yml = src('.github/workflows/soak-nightly.yml');
    const res = scan(yml, /MUSTFAIL_ONLY: '([^']+)'/g).map((r) => new RegExp(r));
    assert.equal(res.length, 2);
    const wrong = CONTROLS.filter((c) => res.filter((re) => re.test(c.name)).length !== 1).map((c) => c.name);
    assert.deepEqual(wrong, []);
    // The long full-roster PF control is routed to teeth-long (like PL/ML), never teeth.
    assert.ok(CONTROLS.some((c) => c.name === 'PF full roster default (pass-control)'), 'PF control is built');
});

// MUST-FAIL (in-memory): the partition only holds because teeth EXCLUDES `PF ` as well. Drop `|PF ` from
// teeth's negative lookahead and PF matches BOTH teeth (it is not PL/ML) and teeth-long (^(PL|ML|PF) ),
// so it would run twice -- the partition check must catch exactly that. If this ever passes cleanly, the
// real partition test above has lost its teeth.
test("must-fail control: dropping |PF from teeth's exclusion mispartitions PF", () => {
    const broken = [new RegExp('^(?!PL |ML )'), new RegExp('^(PL|ML|PF) ')];
    const wrong = CONTROLS.filter((c) => broken.filter((re) => re.test(c.name)).length !== 1).map((c) => c.name);
    assert.ok(
        wrong.includes('PF full roster default (pass-control)'),
        'expected PF to be mispartitioned (run in two jobs); got ' + JSON.stringify(wrong),
    );
});

// QA 2026-10-05: the `bop>=` numeric-threshold token. Only a plain non-negative decimal is a threshold; an
// empty, non-numeric, signed, exponent or non-finite one would make the spec unmatchable (a MISS that looks
// like a gate without teeth), so validSpec must reject it. Also: `bop>=` only on gate=hotAlloc.
test('validSpec: bop>= accepts only a plain non-negative decimal, only on gate=hotAlloc', () => {
    const head = 'gate=hotAlloc lane=RoundRobin ';
    for (const ok of ['bop>=0.3', 'bop>=0', 'bop>=12', 'bop>=39.904']) assert.equal(validSpec(head + ok), null, ok);
    for (const bad of ['bop>=', 'bop>=abc', 'bop>=-1', 'bop>=-0', 'bop>=1e3', 'bop>=NaN', 'bop>=Infinity', 'bop>=.5',
        'bop>=0.', 'bop>=0x1', 'bop>=1_0', 'bop>=0.3x', 'bop>=' + '9'.repeat(400)]) {
        assert.match(String(validSpec(head + bad)), /bop>= needs a number/, bad);
    }
    assert.match(String(validSpec(head + 'bop>= 0.3')), /bop>= needs a number/);   // the space splits off the value
    assert.match(String(validSpec(head + 'xyz>=1')), /unknown >= key xyz/);
    assert.match(String(validSpec('gate=gcMajor lane=RoundRobin bop>=0.3')), /bop>= only valid on gate=hotAlloc/);
});

// --- cross-version lanes (1.2.0 review B1 / B4) -------------------------------------------------------------
// soak:ab drives the IN-TREE lanes.mjs against the REGISTRY release on side A (SOAK_KERNEL), `--aa` on both
// sides, and soak:ab:teeth against 1.1.0 on both sides. So every lane invariant must hold on the kernel that
// is LOADED, not only on the in-tree one: the PeakEWMA invariant may read the K6 `_sampled` bitmap only where
// it exists, and the CH / BL fail-closed mass must follow the loaded kernel's all-zero-weights rule (1.1.x
// routes everywhere on equal quotas; 1.2.0 K8 returns PICK_NONE). The soak's chaos `allZero` phase reaches
// all-zero weights on the keyed lanes via setWeights, so this is a real soak state, not a hypothetical.
// Each kernel runs in a child process because kernel.mjs resolves SOAK_KERNEL at import time.
const LANE_PROBE = `
import { KERNEL_LANES, checkLane, CAP, KEYS } from ${JSON.stringify(pathToFileURL(join(ROOT, 'benchmark', 'soak', 'lanes.mjs')).href)};
const out = {};
const lane = (n) => KERNEL_LANES.find((l) => l.name === n);
try {
    const L = lane('PeakEWMA');
    const { b, eligible, inflight } = L.make(0xC0FFEE, CAP, L.m);
    let now = 0;
    for (let t = 0; t < 600; t++) {
        const p = b.pick(now);
        if (p >= 0) b.recordRtt(p, 1000 + (t & 63) * 37, now);
        if ((t & 31) === 5) b.setEligible(t & (CAP - 1), false);
        now += 1000;
    }
    const lastPick = b.pick(now);
    out.PeakEWMA = checkLane(L, { b, cap: CAP, eligible, inflight, weights: null, lastPick });
    // 1.2.0 review nit: the lane skips its bitmap check when _sampled is undefined, so a renamed field would
    // silently disable it. Report whether the loaded kernel HAS it, and a must-fail control: _sampled[i] = 2.
    out.sampledIsU8 = b._sampled instanceof Uint8Array;
    out.sampledCtl = null;
    if (b._sampled !== undefined) {
        b._sampled[3] = 2;
        out.sampledCtl = checkLane(L, { b, cap: CAP, eligible, inflight, weights: null, lastPick });
    }
} catch (e) { out.PeakEWMA = 'THREW ' + e.message; }
for (const n of ['ConsistentHash', 'BoundedLoad']) {
    try {
        const L = lane(n);
        const { b, eligible, inflight, weights } = L.make(0xC0FFEE, CAP, L.m);
        weights.fill(0);
        b.setWeights(weights);                       // the soak's chaos allZero phase, verbatim
        let bad = null;
        for (let k = 0; k < 64 && bad === null; k++) {
            const lastPick = b.pick(KEYS[k] >>> 0);
            bad = checkLane(L, { b, cap: CAP, eligible, inflight, weights, lastPick });
        }
        out[n] = bad;
    } catch (e) { out[n] = 'THREW ' + e.message; }
}
console.log(JSON.stringify(out));
`;
function probeLanes(kernelPath) {
    const env = Object.assign({}, process.env);
    if (kernelPath) env.SOAK_KERNEL = kernelPath; else delete env.SOAK_KERNEL;
    delete env.SOAK_POOL;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', LANE_PROBE], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, 'lane probe crashed: ' + r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}
// 8c1ecc7 is the pre-1.0.1 kernel soak:teeth's REVERT control drives through these lanes: it predates the
// 1.0.1 `_samp` pool mean as well as K6, and has no setWeights (the control shims it), so only its PeakEWMA
// lane is probed here -- the CH / BL all-zero path is the control's own job.
for (const [label, rev] of [['1.0.0 (8c1ecc7)', '8c1ecc7'], ['1.1.0 (2a08567)', '2a08567'], ['1.1.1 (7ff60f5)', '7ff60f5'], ['in-tree', null]]) {
    test('soak lanes hold on the ' + label + ' kernel: PeakEWMA + all-zero CH/BL checkLane -> null, never throws', () => {
        let dir = null, path = null;
        if (rev !== null) {
            const g = spawnSync('git', ['show', rev + ':Pick.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
            assert.equal(g.status, 0, 'git show ' + rev + ':Pick.js failed (CI needs fetch-depth 0): ' + g.stderr);
            dir = mkdtempSync(join(tmpdir(), 'lanes-xver-'));
            // Node 18 has no module-type detection: without this a temp-dir Pick.js parses as CommonJS.
            writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
            path = join(dir, 'Pick.js');
            writeFileSync(path, g.stdout);
        }
        try {
            const got = probeLanes(path);
            if (rev === '8c1ecc7') assert.equal(got.PeakEWMA, null, label + ': the PeakEWMA lane check must not throw');
            else assert.deepEqual({ PeakEWMA: got.PeakEWMA, ConsistentHash: got.ConsistentHash, BoundedLoad: got.BoundedLoad },
                { PeakEWMA: null, ConsistentHash: null, BoundedLoad: null });
            if (rev === null) {
                // The in-tree kernel HAS the K6 bitmap (a renamed field would make lanes.mjs skip the check), and
                // the lane check has teeth: a _sampled byte of 2 is a non-null violation.
                assert.equal(got.sampledIsU8, true, 'in-tree PeakEWMA must have a Uint8Array _sampled');
                assert.match(String(got.sampledCtl), /_sampled\[3\] is 2/, 'must-fail control: _sampled[3] = 2 is caught');
            } else {
                assert.deepEqual([got.sampledIsU8, got.sampledCtl], [false, null], label + ' predates K6: no _sampled, check skipped');
            }
        } finally {
            if (dir !== null) rmSync(dir, { recursive: true, force: true });
        }
    });
}
