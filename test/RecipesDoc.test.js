/**
 * @zakkster/lite-pick -- RECIPES section 8 doc-test (audit 2026-09-29 D1).
 *
 *     node --test test/RecipesDoc.test.js
 *
 * The PeakEWMA manual-loop recipe is extracted from RECIPES.md and run VERBATIM (only the package
 * specifier is rewritten to the local Pick.js), so the published recipe cannot drift back into the
 * black hole it used to teach (49.1% failed requests). The snippet's free names (CAP, eligible,
 * endpoints, send, respond503) and its clock are supplied by a prelude: `process` is shadowed by a
 * virtual nanosecond clock that `send` advances, so the run is deterministic and instant.
 *
 * Falsifiable assertions:
 *   R1. The section-8 heading and its first js block exist and define `async function handle(`.
 *   R2. Node 0 fails in 1 us, nodes 1..3 succeed in 1 ms: <= 5% of 20000 requests fail.
 *   R3. A caller abort records NO penalty: after warm-up, the aborted node's estimate stays at the
 *       1 ms scale and it keeps a fair share.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PICK_URL = pathToFileURL(join(ROOT, 'Pick.js')).href;

/** The first ```js block after the "## 8." heading of RECIPES.md (fail closed if absent). */
function extractSection8() {
    const md = readFileSync(join(ROOT, 'RECIPES.md'), 'utf8');
    const h = md.indexOf('\n## 8.');
    assert.ok(h >= 0, 'RECIPES.md has a "## 8." section');
    const open = md.indexOf('```js\n', h);
    const next = md.indexOf('\n## ', h + 1);
    assert.ok(open >= 0 && (next < 0 || open < next), 'section 8 has a js block');
    const close = md.indexOf('\n```', open + 6);
    assert.ok(close > open, 'the js block is closed');
    return md.slice(open + 6, close + 1);
}

// The world the snippet runs in. `process` is shadowed so the snippet's own `nowNs` reads the
// virtual clock; send() advances it by the endpoint's latency and fails endpoint 0 (fast fail).
const PRELUDE = `
let vclock = 1_000_000_000;
const process = { hrtime: { bigint: () => BigInt(vclock) } };
const CAP = 4;
const eligible = new Uint8Array(CAP).fill(1);
const endpoints = [0, 1, 2, 3];
const stats = { fail: 0, served: new Uint32Array(CAP), abortNext: null };
async function send(endpoint, req, signal) {
    stats.served[endpoint]++;
    if (stats.abortNext) { const ac = stats.abortNext; stats.abortNext = null; vclock += 500_000; ac.abort(); throw new Error('aborted'); }
    if (endpoint === 0 && req.failNode0) { vclock += 1_000; throw new Error('node0 503'); }
    vclock += 1_000_000;
    return 'ok';
}
function respond503() { return '503'; }
`;

let dir;
async function loadRecipe() {
    const snippet = extractSection8();
    assert.ok(snippet.includes('async function handle('), 'the recipe defines handle()');
    const from = "from '@zakkster/lite-pick'";
    assert.equal(snippet.split(from).length, 2, 'the recipe imports from the package exactly once');
    // Imports must stay at the top of a module: hoist the snippet's import line above the prelude.
    const lines = snippet.replace(from, "from '" + PICK_URL + "'").split('\n');
    const imports = lines.filter((l) => l.startsWith('import '));
    const body = lines.filter((l) => !l.startsWith('import '));
    dir = dir || mkdtempSync(join(tmpdir(), 'litepick-doctest-'));
    const file = join(dir, 'recipe-' + Math.random().toString(36).slice(2) + '.mjs');
    writeFileSync(file, imports.join('\n') + '\n' + PRELUDE + body.join('\n') +
        '\nexport { handle, lb, stats };\nexport const now = () => vclock;\n');
    return import(pathToFileURL(file).href);
}

test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('R1+R2 (D1): the recipe does not black-hole a fast-failing node (<= 5% failed of 20000)', async () => {
    const r = await loadRecipe();
    const N = 20000;
    let failed = 0;
    for (let k = 0; k < N; k++) {
        try { await r.handle({ failNode0: true }); } catch { failed++; }
    }
    assert.ok(failed <= N * 0.05, 'failed ' + failed + '/' + N + ' (the old finally-recipe failed ~49.1%)');
    assert.ok(r.stats.served[0] >= 1, 'node 0 is still re-probed (recovery works)');
});

test('D-lit (K7): README and llms.txt teach Number(process.hrtime.bigint()) as the PeakEWMA clock', () => {
    const CLOCK = 'Number(process.hrtime.bigint())';
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    assert.ok(readme.includes(CLOCK), 'README.md passes the hrtime clock through Number(...), not a raw BigInt');
    assert.ok(llms.includes(CLOCK), 'llms.txt passes the hrtime clock through Number(...), not a raw BigInt');
});

test('D-lit (K6, 1.2.0): README and llms.txt accept a negative / offset PeakEWMA clock; the 1.1.1 caveat is gone', () => {
    const ACCEPT = 'negative included';
    const STALE = 'no busy floor, no pool-mean decay';
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    const dts = readFileSync(join(ROOT, 'Pick.d.ts'), 'utf8');
    assert.ok(readme.includes(ACCEPT) && readme.includes('offset'),
        'README.md must state that any finite `now`, negative / offset included, is accepted');
    assert.ok(llms.includes(ACCEPT) && llms.includes('offset'),
        'llms.txt must state that any finite `now`, negative / offset included, is accepted');
    assert.ok(!readme.includes(STALE), 'README.md still claims a negative clock disables PeakEWMA learning');
    assert.ok(!llms.includes(STALE), 'llms.txt still claims a negative clock disables PeakEWMA learning');
    assert.ok(!dts.includes('1.2.0 will reject'), 'Pick.d.ts still promises that 1.2.0 rejects a negative now');
    assert.ok(dts.includes(ACCEPT), 'Pick.d.ts must state the clock contract: any finite now, negative included');
});

test('D-lit (K23): Pool.d.ts documents a throwing subscriber as an uncaughtException', () => {
    const poolDts = readFileSync(join(ROOT, 'Pool.d.ts'), 'utf8');
    assert.ok(poolDts.includes('uncaughtException'),
        'Pool.d.ts states a throwing diagnostics_channel subscriber surfaces as an uncaughtException');
});

test('D-lit (K-info): Pick.d.ts no longer claims "TypeError for a wrong type"', () => {
    const pickDts = readFileSync(join(ROOT, 'Pick.d.ts'), 'utf8');
    assert.ok(!pickDts.includes('TypeError for a wrong type'),
        'the error-class note must not use the wrong "TypeError for a wrong type" phrasing (RangeError covers a wrong-type/out-of-range value)');
});

test('R3 (D1/N1): a caller abort feeds no penalty -- the node keeps its estimate and its share', async () => {
    const r = await loadRecipe();
    for (let k = 0; k < 200; k++) await r.handle({});          // every node settles at ~1 ms
    const ac = new AbortController();
    r.stats.abortNext = ac;
    const before = Array.from(r.stats.served);
    await assert.rejects(r.handle({}, ac.signal), /aborted/);
    let victim = -1;
    for (let i = 0; i < 4; i++) if (r.stats.served[i] !== before[i]) victim = i;
    assert.ok(victim >= 0, 'the aborted request dispatched');
    const est = r.lb.ewmaAt(victim, r.now());
    assert.ok(est <= 2e6, 'no 1 s penalty on abort (ewma ' + est.toExponential(2) + ')');
    const base = r.stats.served[victim];
    for (let k = 0; k < 1000; k++) await r.handle({});
    assert.ok(r.stats.served[victim] - base >= 200, 'the aborted node keeps a fair share (' + (r.stats.served[victim] - base) + '/1000)');
});

test('D-lit (1.2.0 phase 2): tie-bias and failover notes carry the corrected / FIXED wording, no stale copy', () => {
    // Regression pin on the docs: these phrases were the phase-1 caveats and must not return.
    const STALE = ['1.2.0 fix queued', 'fix is queued', 'KNOWN (ROADMAP 4b, phase 2)', 'ignores weights', '~1 pp'];
    for (const f of ['README.md', 'llms.txt', 'GUIDE.md', 'RECIPES.md', 'ROADMAP.md']) {
        const txt = readFileSync(join(ROOT, f), 'utf8');
        for (const p of STALE) assert.ok(!txt.includes(p), f + ' still carries the stale phrase: ' + p);
    }
    for (const f of ['README.md', 'llms.txt', 'GUIDE.md', 'RECIPES.md']) {
        const txt = readFileSync(join(ROOT, f), 'utf8');
        assert.ok(txt.includes("ties: 'random'"), f + ' must point at ties: \'random\'');
        assert.ok(txt.includes('3.66'), f + ' must carry the corrected SED bias numbers');
    }
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    assert.ok(llms.includes('weightOf(i)') && llms.includes('TieOptions'), 'llms.txt documents weightOf and TieOptions');
});
