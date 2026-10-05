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
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    return r.stdout.trim().split('\n').map((l) => JSON.parse(l));
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
