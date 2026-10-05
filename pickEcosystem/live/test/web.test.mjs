/**
 * pickEcosystem/live -- the browser page's gates that run in Node (capstone P3). The page itself is exercised in
 * a real browser by test/browser-smoke.mjs; these keep what it is built from honest.
 *
 *   W1 import-map drift: index.html's map and package.json pin the SAME versions, both ways -- every dependency
 *      is in the map at its exact version, every map entry is a dependency at that version, and a brick that
 *      imports another mapped brick at runtime loads with ?external= so both share the one pinned instance.
 *      Control: a map with one version bumped fails the same check.
 *   W2 the browser's module graph (every static and dynamic import reachable from page.js): no node: module,
 *      every bare specifier is in the map, every relative file exists. Control: the same walk from tui.mjs
 *      does reach node: modules.
 *   W3 the DOM contract: every id the shared renderer (render.mjs) and each page look up exists in that page's
 *      HTML; every fault key has a button.
 *   W4 the browser crash path in job.js (no `process`): the job fails AND an uncaught error is scheduled, so the
 *      page's Worker gets an error event and the set takes the worker down (a silent close() would not).
 *   W5 the device scene: calibration measures this machine (and clamps a frozen clock); the offered rate
 *      follows the core count; resync() makes the next traffic tick offer nothing for the gap.
 *   W6 the static server serves the hub's and the live page's files but never node_modules, tests or package files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WEB_SCOPE_IDS } from '../../../demo/pool-scope/web/render.mjs';
import { jobFn, CTL_LEN, CTL_CRASH, CTL_UNITS, CTL_SLOW, UNITS_PER_MS } from '../job.js';
import { calibrateUnitsPerMs, browserScene, FAULT_KEYS } from '../surface.js';
import { Traffic } from '../traffic.js';
import { walk } from '../site.mjs';
import * as lp from '@zakkster/lite-pick';

const LIVE = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(LIVE, '..', '..');
const SIM = join(REPO, 'demo', 'pool-scope', 'web');
const read = (p) => readFileSync(p, 'utf8');
const pkg = JSON.parse(read(join(LIVE, 'package.json')));
const html = read(join(LIVE, 'index.html'));

function importMap(src) {
    const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(src);
    assert.ok(m, 'the page has an import map');
    return JSON.parse(m[1]).imports;
}

/** Parse an esm.sh URL: { name, version, sub, externals }. */
function esm(url) {
    const m = /^https:\/\/esm\.sh\/(@[^/@]+\/[^/@?]+)@([0-9][^/?]*)(\/[^?]*)?(?:\?(.*))?$/.exec(url);
    if (!m) return null;
    const q = new URLSearchParams(m[4] || '');
    return { name: m[1], version: m[2], sub: m[3] || '', externals: (q.get('external') || '').split(',').filter(Boolean) };
}

/** The bare packages a package's entry file imports at runtime (static imports, not JSDoc types). */
function runtimeImports(name) {
    const dir = join(LIVE, 'node_modules', name);
    const p = JSON.parse(read(join(dir, 'package.json')));
    const e = p.exports && p.exports['.'];
    const entry = typeof e === 'string' ? e : (e && (e.import || e.default)) || p.main || 'index.js';
    const src = read(join(dir, entry));
    const out = new Set();
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*["']([^"'.][^"']*)["']/gm)) out.add(m[1]);
    for (const m of src.matchAll(/^\s*import\s*["']([^"'.][^"']*)["']/gm)) out.add(m[1]);
    return out;
}

/** Every violation of the drift contract between `map` and `deps`. */
function driftErrors(map, deps) {
    const errs = [];
    for (const [name, version] of Object.entries(deps)) {
        const u = map[name];
        const e = u && esm(u);
        if (!e) { errs.push(name + ' is not in the import map'); continue; }
        if (e.name !== name || e.version !== version) errs.push(name + ': map has ' + e.name + '@' + e.version + ', package.json ' + version);
    }
    for (const [spec, url] of Object.entries(map)) {
        const e = esm(url);
        if (!e) { errs.push(spec + ': not a pinned esm.sh URL: ' + url); continue; }
        if (deps[e.name] !== e.version) errs.push(spec + ': ' + e.name + '@' + e.version + ' is not a package.json dependency at that version');
        if (spec !== e.name + e.sub) errs.push(spec + ': maps to the wrong module ' + e.name + e.sub);
    }
    for (const name of Object.keys(deps)) {
        const e = map[name] && esm(map[name]);
        if (!e) continue;
        for (const dep of runtimeImports(name)) {
            const base = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
            if (map[base] !== undefined && e.externals.indexOf(base) < 0) {
                errs.push(name + ' imports ' + base + ' at runtime but loads without ?external=' + base + ' (a second instance)');
            }
        }
    }
    return errs;
}

test('W1 the import map and package.json pin the same versions, both ways; shared bricks load once', () => {
    const map = importMap(html);
    assert.deepEqual(driftErrors(map, pkg.dependencies), []);
    assert.ok(Object.keys(map).length >= Object.keys(pkg.dependencies).length);
    // Control: one bumped version must be caught.
    const bumped = { ...map, '@zakkster/lite-pick': 'https://esm.sh/@zakkster/lite-pick@1.1.1' };
    assert.ok(driftErrors(bumped, pkg.dependencies).some((e) => /lite-pick/.test(e)), 'a bumped version is caught');
    const unshared = { ...map, '@zakkster/lite-worker-pool': 'https://esm.sh/@zakkster/lite-worker-pool@1.1.0' };
    assert.ok(driftErrors(unshared, pkg.dependencies).some((e) => /second instance/.test(e)), 'a missing ?external= is caught');
});

test('W2 the browser module graph: no node: module, every bare import mapped, every file present', () => {
    const map = importMap(html);
    const g = walk(join(LIVE, 'page.js'));
    assert.deepEqual([...g.node], [], 'node: modules reachable from the page');
    assert.deepEqual(g.missing, []);
    for (const b of g.bare) assert.ok(map[b] !== undefined, b + ' is imported but not in the import map');
    assert.ok(g.files.has(join(LIVE, 'kernel.js')) && g.files.has(join(SIM, 'render.mjs')), 'the walk reaches the kernel and the renderer');
    // Control: the terminal entry reaches worker_threads.
    assert.ok(walk(join(LIVE, 'tui.mjs')).node.size > 0, 'the walk sees node: imports');
    // The simulated page too (it shares the renderer).
    const simMap = importMap(read(join(SIM, 'index.html')));
    const s = walk(join(SIM, 'main.mjs'));
    assert.deepEqual([...s.node], []);
    for (const b of s.bare) assert.ok(simMap[b] !== undefined, b + ' is imported by the simulated page but not in its map');
});

function idsLookedUp(src) {
    const out = new Set();
    for (const m of src.matchAll(/\$\('([a-z0-9-]+)'\)/g)) out.add(m[1]);
    return out;
}

test('W3 the DOM contract: every id the renderer and the pages look up exists; every fault key has a button', () => {
    const sim = read(join(SIM, 'index.html'));
    const has = (page, id) => page.indexOf('id="' + id + '"') >= 0;
    for (const id of WEB_SCOPE_IDS) {
        assert.ok(has(html, id), 'live page lacks #' + id);
        assert.ok(has(sim, id), 'simulated page lacks #' + id);
    }
    for (const id of idsLookedUp(read(join(SIM, 'render.mjs')))) assert.ok(WEB_SCOPE_IDS.indexOf(id) >= 0, 'render.mjs looks up #' + id + ' outside WEB_SCOPE_IDS');
    for (const id of idsLookedUp(read(join(LIVE, 'page.js')))) assert.ok(has(html, id), 'page.js looks up #' + id);
    for (const id of idsLookedUp(read(join(SIM, 'main.mjs')))) assert.ok(has(sim, id), 'main.mjs looks up #' + id);
    for (const kind of Object.values(FAULT_KEYS)) assert.ok(html.indexOf('data-fault="' + kind + '"') >= 0, 'no button for ' + kind);
});

test('W4 the browser crash path: the job fails and an uncaught error is raised right after', () => {
    const scheduled = [];
    const ctx = vm.createContext({ Float64Array, Math, Date, Error, setTimeout: (fn, ms) => { scheduled.push(fn); return 1; } });
    const run = vm.runInContext('(' + jobFn.toString() + ')', ctx);
    const ctl = new Float64Array(CTL_LEN);
    ctl[CTL_UNITS] = 1000;
    ctl[CTL_SLOW] = 1;
    assert.equal(typeof run(7, ctl), 'number', 'a healthy job returns its value');
    assert.equal(scheduled.length, 0);
    ctl[CTL_CRASH] = 1;
    assert.throws(() => run(7, ctl), /worker crashed/);
    assert.equal(scheduled.length, 1, 'an error is scheduled');
    assert.throws(() => scheduled[0](), /worker crashed/, 'and it is uncaught when it runs');
});

test('W5 the device scene: calibration, the offered rate by cores, traffic resync', () => {
    const u = calibrateUnitsPerMs(() => performance.now(), 40);
    assert.ok(u > UNITS_PER_MS / 20 && u < UNITS_PER_MS * 5, 'this machine: ' + u + ' units/ms');
    assert.equal(calibrateUnitsPerMs(() => 0, 10), UNITS_PER_MS, 'a frozen clock ends, and yields the reference');
    let c = 0;
    const lo = calibrateUnitsPerMs(() => (c += 1000), 40);
    assert.equal(lo, UNITS_PER_MS / 20, 'an absurdly slow reading clamps');
    assert.equal(browserScene(16).rate, 2000);
    assert.equal(browserScene(6).rate, 1500);
    assert.equal(browserScene(4).rate, 1000);
    assert.equal(browserScene(undefined).rate, 1000);
    let n = 0;
    const tr = new Traffic({ rate: 2000, keys: 100, zipfS: 1.1, seed: 7 }, { request() { n++; }, lastWorker: 0 }, lp);
    tr.tick(0);
    tr.tick(10);
    assert.ok(n > 5, 'a 10 ms tick offers ~20');
    tr.resync();
    const before = n;
    tr.tick(60000);                       // a minute in the background
    assert.equal(n, before, 'the gap is not offered');
    tr.tick(60010);
    assert.ok(n - before > 5 && n - before < 60, 'then the rate resumes: ' + (n - before));
});

function get(port, path) {
    return fetch('http://127.0.0.1:' + port + path, { redirect: 'manual' }).then((r) => r.status);
}

test('W6 the static server: the hub and the live page are served, node_modules / tests / package files never', async () => {
    const port = 8791;
    const srv = spawn(process.execPath, [join(SIM, 'serve.mjs'), '--port', String(port), '--page', 'live'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('server did not start')), 10000);
            srv.stdout.on('data', (d) => { if (/open/.test(d)) { clearTimeout(t); res(); } });
        });
        assert.equal(await get(port, '/'), 302);
        assert.equal(await get(port, '/pickEcosystem/live/'), 200);
        assert.equal(await get(port, '/pickEcosystem/live/page.js'), 200);
        assert.equal(await get(port, '/pickEcosystem/live/kernel.js'), 200);
        assert.equal(await get(port, '/demo/pool-scope/web/render.mjs'), 200);
        assert.equal(await get(port, '/pickEcosystem'), 302);
        assert.equal(await get(port, '/pickEcosystem/'), 200);
        assert.equal(await get(port, '/pickEcosystem/graph.svg'), 200);
        assert.equal(await get(port, '/pickEcosystem/live/node_modules/@zakkster/lite-pick/package.json'), 404);
        assert.equal(await get(port, '/pickEcosystem/live/test/web.test.mjs'), 404);
        assert.equal(await get(port, '/pickEcosystem/live/package.json'), 404);
        assert.equal(await get(port, '/pickEcosystem/live/package-lock.json'), 404);
        assert.equal(await get(port, '/pickEcosystem/live/.gitignore'), 404);
        assert.equal(await get(port, '/pickEcosystem/live/%2e%2e/%2e%2e/package.json'), 404);
        assert.equal(await get(port, '/package.json'), 404);
    } finally {
        srv.kill();
    }
});
