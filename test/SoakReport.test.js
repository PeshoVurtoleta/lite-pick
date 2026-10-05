/**
 * @zakkster/lite-pick -- soak:report (SoakReport.mjs) behaviour suite.
 *
 *     node --test test/SoakReport.test.js
 *
 * SoakReport.mjs re-derives a soak verdict from the raw JSONL and fails closed on anything that is not
 * sound, green, release-shaped evidence. This suite builds SMALL real streams (main.mjs in smoke mode),
 * edits them into the shapes the report must judge, and asserts the exit code for each:
 *   - a genuine pool A6 FAIL re-derives FAIL with [integrity OK] (exit 0): the report judges INTEGRITY,
 *     not the soak's own verdict, and a pool retention failure is NOT a non-pool retention mismatch;
 *   - a signal-interrupted PARTIAL grid (k or k-1 cycles, a roster prefix) is legitimate -> INCONCLUSIVE
 *     with integrity OK (exit 0);
 *   - the SAME partial grid WITHOUT reason 'signal' is a ragged/short grid -> INTEGRITY MISMATCH (exit 1);
 *   - a red (non-PASS) --baseline is refused BASELINE NOT GREEN (exit 1);
 *   - a foreign-schema --baseline is refused BASELINE INCOMPATIBLE (exit 1);
 *   - a parity-mismatch stream is refused PARITY MISMATCH (exit 1), allowed with --allow-parity-mismatch.
 *
 * Each assertion is ABSOLUTE (the exact exit code + message). The one-time proof that these teeth are NEW
 * -- >= 5 of the 6 cases differed from the pre-change report (cd060cd's SoakReport.mjs) -- is recorded in
 * CHANGELOG.md, NOT re-run here: a `git show HEAD:` revert-check goes red forever once this code is HEAD.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOAK_DIR = join(ROOT, 'benchmark', 'soak');
const MAIN = join(SOAK_DIR, 'main.mjs');
const REPORT = join(SOAK_DIR, 'SoakReport.mjs');
const NODE = process.execPath;
const FLAGS = ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'];

// The fixture streams come from the REAL harness (main.mjs), which imports three devDependencies. Node 18 CI
// runs `npm test` with NO install (as test/LognSeam.test.js): there, and only on Node < 20, missing harness
// dependencies skip this suite. Anywhere else a missing devDependency FAILS it.
const MAJOR = Number(process.versions.node.split('.')[0]);
const SOAK_DEPS = ['lite-sketch', 'lite-leak', 'lite-gc-profiler'];
const MISSING = SOAK_DEPS.filter((d) => !existsSync(join(ROOT, 'node_modules', '@zakkster', d, 'package.json')));
const SKIP = MISSING.length > 0 && MAJOR < 20
    ? 'no node_modules on the Node 18 job: ' + MISSING.join(', ') + ' not installed' : false;
const soakTest = (name, fn) => test(name, { skip: SKIP }, fn);

let TMP;
const F = {};          // fixture stream paths

/** Run main.mjs and require EXACTLY the expected exit and a written stream (stderr is surfaced on a miss). */
function runMain(env, out, wantExit) {
    const r = spawnSync(NODE, FLAGS.concat([MAIN]), {
        cwd: ROOT, env: Object.assign({}, process.env, env, { SOAK_OUT: out }),
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120000,
    });
    const why = ' (exit ' + r.status + (r.error ? ', ' + r.error.message : '') + ')\n' + String(r.stderr || '').slice(-2000);
    assert.equal(r.status, wantExit, 'main.mjs must exit ' + wantExit + ' for ' + out + why);
    assert.ok(existsSync(out), 'main.mjs wrote no stream ' + out + why);
    return out;
}

function recs(path) { return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)); }
function writeRecs(list) {
    const p = join(TMP, 'fx-' + (writeRecs._n = (writeRecs._n || 0) + 1) + '.jsonl');
    writeFileSync(p, list.map((r, i) => { r.seq = i; return JSON.stringify(r); }).join('\n') + '\n');
    return p;
}
function editSummary(list, patch) { for (const r of list) if (r.type === 'summary') Object.assign(r, patch); return list; }

/** Run the in-tree report; returns the exit code (null spawn error -> -1). */
function report(reportPath, file, extra) {
    const r = spawnSync(NODE, [reportPath, file].concat(extra || []), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
    return { status: r.status === null ? -1 : r.status, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}

before(() => {
    if (SKIP) return;
    if (MISSING.length > 0) throw new Error('soak harness devDependencies missing: ' + MISSING.join(', ') + ' (run npm ci)');
    TMP = mkdtempSync(join(tmpdir(), 'litepick-soakreport-'));

    // (a) a clean two-lane smoke stream (reason 'end', complete grid, verdict PASS).
    F.clean = runMain({ SOAK_SMOKE: '1', SOAK_LANES: 'RoundRobin,SmoothWRR' }, join(TMP, 'clean.jsonl'), 0);
    // (b) a genuine pool A6 FAIL smoke stream (poolretain -> retention never drains).
    F.a6 = runMain({ SOAK_SMOKE: '1', SOAK_LANES: 'PoolP2C', SOAK_MUSTFAIL: 'poolretain' }, join(TMP, 'a6.jsonl'), 1);

    // signal-interrupted COMPLETE grid: reason 'signal' re-derives INCONCLUSIVE (interrupted). (Baseline for
    // the red-baseline case: integrity-OK on both versions, but not PASS.)
    F.signalComplete = writeRecs(editSummary(recs(F.clean), { reason: 'signal', verdict: 'INCONCLUSIVE' }));

    // signal-interrupted PARTIAL grid: drop the last roster lane's final cycle -> [k, k-1], a roster prefix.
    {
        const list = recs(F.clean);
        let lastCycle = -1;
        for (let i = 0; i < list.length; i++) if (list[i].type === 'cycle') lastCycle = i;
        list.splice(lastCycle, 1);
        const n = list.filter((r) => r.type === 'cycle').length;
        F.signalPartial = writeRecs(editSummary(list, { reason: 'signal', verdict: 'INCONCLUSIVE', rollups: n, cyclesRun: n }));
    }
    // the SAME partial grid but reason 'end' -- now a ragged/short grid (a dropped lane), an integrity error.
    {
        const list = recs(F.clean);
        let lastCycle = -1;
        for (let i = 0; i < list.length; i++) if (list[i].type === 'cycle') lastCycle = i;
        list.splice(lastCycle, 1);
        const n = list.filter((r) => r.type === 'cycle').length;
        F.endPartial = writeRecs(editSummary(list, { rollups: n, cyclesRun: n }));
    }
    // a foreign-schema baseline (older schemaVersion in the header).
    F.schemaBad = writeRecs(recs(F.clean).map((r) => { if (r.type === 'header') r.schemaVersion = 3; return r; }));
    // a parity-mismatch stream (only header.parity.ok flipped; integrity does not re-derive parity).
    F.parityBad = writeRecs(recs(F.clean).map((r) => { if (r.type === 'header') r.parity = { ok: false, mismatched: ['Pick.js'], error: null }; return r; }));
});

after(() => { if (TMP) try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// NOTE: these six assertions are ABSOLUTE (the exact exit code + message the current report must give).
// The one-time revert-check that >= 5 of 6 of them differed from the pre-change report (cd060cd's
// SoakReport.mjs) is recorded in CHANGELOG.md -- it must NOT run here, because once committed HEAD is this
// code and a `git show HEAD:` diff is always empty (0 of 6 differ -> a permanently red suite).

soakTest('a genuine pool A6 FAIL re-derives FAIL with integrity OK (exit 0)', () => {
    const r = report(REPORT, F.a6, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[integrity OK\]/);
    assert.match(r.stdout, /re-derived=FAIL/);
});

soakTest('a signal-interrupted partial grid is INCONCLUSIVE with integrity OK (exit 0)', () => {
    const r = report(REPORT, F.signalPartial, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[integrity OK\]/);
    assert.match(r.stdout, /re-derived=INCONCLUSIVE/);
});

soakTest('the same partial grid without reason signal is an INTEGRITY MISMATCH (exit 1)', () => {
    const r = report(REPORT, F.endPartial, []);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /soak:report: (ISSUE|INTEGRITY MISMATCH)/);
});

soakTest('a red (non-PASS) baseline is refused BASELINE NOT GREEN (exit 1)', () => {
    const r = report(REPORT, F.clean, ['--baseline', F.signalComplete]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /soak:report: BASELINE NOT GREEN/);
});

soakTest('a foreign-schema baseline is refused BASELINE INCOMPATIBLE (exit 1)', () => {
    const r = report(REPORT, F.clean, ['--baseline', F.schemaBad]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /soak:report: BASELINE INCOMPATIBLE/);
});

soakTest('a parity mismatch is refused (exit 1), allowed with --allow-parity-mismatch (exit 0)', () => {
    const r = report(REPORT, F.parityBad, []);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /soak:report: PARITY MISMATCH/);
    const ok = report(REPORT, F.parityBad, ['--allow-parity-mismatch']);
    assert.equal(ok.status, 0, ok.stderr);
});

// --- boundary matrix (QA 2026-10-05): CLI edges + grid shapes the six cases above do not reach -------------

/** Drop cycle records matching `pred`, mark the stream signal-interrupted, fix the two count fields. */
function signalWithout(pred) {
    const list = recs(F.clean).filter((r) => !(r.type === 'cycle' && pred(r)));
    const n = list.filter((r) => r.type === 'cycle').length;
    return writeRecs(editSummary(list, { reason: 'signal', verdict: 'INCONCLUSIVE', rollups: n, cyclesRun: n }));
}
function rosterOf(path) { return recs(path).find((r) => r.type === 'header').laneRoster; }
function lastCycleOf(path) { return Math.max(...recs(path).filter((r) => r.type === 'cycle').map((r) => r.cycle)); }

soakTest('an unknown flag exits 2 with a did-you-mean', () => {
    const r = report(REPORT, F.clean, ['--basline', F.clean]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /soak:report: unknown flag --basline -- did you mean --baseline\?/);
    const far = report(REPORT, F.clean, ['--zzzzzzzzzzzzz']);
    assert.equal(far.status, 2, far.stdout);
    assert.match(far.stderr, /soak:report: unknown flag --zzzzzzzzzzzzz$/m);
});

soakTest('--allow-parity-mismatch is accepted on a clean stream (exit 0, PASS)', () => {
    const r = report(REPORT, F.clean, ['--allow-parity-mismatch']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-derived=PASS {2}\[integrity OK\]/);
});

soakTest('signal run with a MIDDLE roster lane short of the last cycle (not a prefix) is a MISMATCH (exit 1)', () => {
    const roster = rosterOf(F.clean), k = lastCycleOf(F.clean);
    assert.ok(roster.length >= 3, 'fixture roster has a middle lane: ' + roster.join(','));
    const mid = roster[1];
    const r = report(REPORT, signalWithout((c) => c.lane === mid && c.cycle === k), []);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /ISSUE ragged lane x cycle grid \(signal run/);
    assert.match(r.stderr, /INTEGRITY MISMATCH/);
});

soakTest('signal run with the FIRST lane short and later lanes complete (k-1 then k) is a MISMATCH (exit 1)', () => {
    const roster = rosterOf(F.clean), k = lastCycleOf(F.clean);
    const r = report(REPORT, signalWithout((c) => c.lane === roster[0] && c.cycle === k), []);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /ISSUE ragged lane x cycle grid \(signal run/);
});

soakTest('signal run with the last cycle missing on EVERY lane is integrity OK, INCONCLUSIVE (exit 0)', () => {
    const k = lastCycleOf(F.clean);
    const r = report(REPORT, signalWithout((c) => c.cycle === k), []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /re-derived=INCONCLUSIVE {2}\[integrity OK\]/);
});

soakTest('the same every-lane-short grid with reason end is a MISMATCH (header.config.cycles not met)', () => {
    const k = lastCycleOf(F.clean);
    const list = recs(F.clean).filter((r) => !(r.type === 'cycle' && r.cycle === k));
    const n = list.filter((r) => r.type === 'cycle').length;
    const r = report(REPORT, writeRecs(editSummary(list, { rollups: n, cyclesRun: n })), []);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /ISSUE lane \S+ has \d+ cycles, header\.config\.cycles = /);
});

soakTest('an empty / whitespace-only / header-only stream fails closed (exit 2, clear message)', () => {
    const empty = join(TMP, 'empty.jsonl'); writeFileSync(empty, '');
    const blank = join(TMP, 'blank.jsonl'); writeFileSync(blank, '\n  \n\n');
    for (const p of [empty, blank]) {
        const r = report(REPORT, p, []);
        assert.equal(r.status, 2, r.stdout);
        assert.match(r.stderr, /soak:report: empty stream /);
    }
    const hdr = writeRecs(recs(F.clean).filter((r) => r.type === 'header'));
    const h = report(REPORT, hdr, []);
    assert.equal(h.status, 2, h.stdout);
    assert.match(h.stderr, /soak:report: no summary record in /);
    const nul = join(TMP, 'null.jsonl'); writeFileSync(nul, 'null\n');
    const n = report(REPORT, nul, []);
    assert.equal(n.status, 2, n.stdout);
    assert.match(n.stderr, /non-object JSONL line/);
});

soakTest('a baseline that is the same file as the current stream is sane: no regression (exit 0)', () => {
    const r = report(REPORT, F.clean, ['--baseline', F.clean]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[integrity OK\]/);
    assert.match(r.stdout, /vs baseline /);
    assert.doesNotMatch(r.stdout + r.stderr, /REGRESSION|LANE MISSING/);
});

// QA FINDING (2026-10-05, fixed): `--baseline` as the LAST argument (no value) used to be dropped silently --
// the diff was skipped and the report exited 0 with no "vs baseline" section. A requested comparison that never
// ran must fail closed (exit 2), like an unknown flag. Same for `--out`, and for a flag where the value should be.
for (const argv of [['--baseline'], ['--out'], ['--baseline', '--allow-parity-mismatch'], ['--out', '']]) {
    soakTest('flag without its value fails closed (exit 2): ' + JSON.stringify(argv), () => {
        const r = report(REPORT, F.clean, argv);
        assert.equal(r.status, 2, 'exit ' + r.status + ': ' + r.stdout.slice(0, 200));
        assert.match(r.stderr + r.stdout, /needs a path/);
    });
}
