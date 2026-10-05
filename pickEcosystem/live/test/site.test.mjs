/**
 * pickEcosystem/live -- the deployed site's gates (capstone P4). test/browser-smoke.mjs drives the built site in
 * headless Chrome; these keep its construction honest.
 *
 *   S1 the site is exactly what the pages reach: the three pages, their stylesheets and images, every module in
 *      their import graphs -- and never node_modules, tests, research or package files. A built site has a root
 *      that redirects to the hub. The builder refuses to empty the repo or an unrelated directory.
 *   S2 the hub's composition graph is the running kernel's: regenerated from bootKernel's container and compared
 *      byte for byte with the committed graph.json / graph.svg. Control: one edge fewer draws a different picture.
 *   S3 every version the hub prints is the version package.json pins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, PAGES, siteFiles, buildSite, pageRefs } from '../site.mjs';
import { build, render } from '../graph.mjs';

const read = (p) => readFileSync(join(REPO, p), 'utf8');

test('S1 the site is exactly what the pages reach, never the package internals', () => {
    const files = siteFiles();
    for (const p of PAGES) assert.ok(files.includes(p), p);
    for (const f of ['pickEcosystem/hub.css', 'pickEcosystem/graph.svg', 'demo/pool-scope/web/scope.css', 'pickEcosystem/live/live.css',
        'pickEcosystem/live/kernel.js', 'pickEcosystem/live/page.js', 'demo/pool-scope/web/render.mjs', 'Pick.js']) {
        assert.ok(files.includes(f), 'the site carries ' + f);
    }
    for (const f of files) {
        assert.ok(!/node_modules|\/test\/|^research\/|package(-lock)?\.json$|\.mjs$/.test(f) || /^demo\/pool-scope\/.*\.mjs$/.test(f),
            'the site must not carry ' + f);
    }
    for (const f of ['pickEcosystem/live/tui.mjs', 'pickEcosystem/live/nodeworker.js', 'pickEcosystem/live/virtual.js', 'Pool.js']) {
        assert.ok(!files.includes(f), f + ' is not reachable from a page');
    }
    assert.deepEqual(pageRefs('<a href="https://x.y/">x</a><img src="data:,"/><a href="#t">t</a><link href="./a.css?v=1"/><a href="b/#c">b</a>'), ['./a.css', 'b/']);
    const out = mkdtempSync(join(tmpdir(), 'pick-site-test-'));
    try {
        const copied = buildSite(out);
        assert.deepEqual(copied, files);
        assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /url=pickEcosystem\//);
        assert.ok(existsSync(join(out, '.nojekyll')));
        assert.ok(existsSync(join(out, 'pickEcosystem', 'live', 'page.js')));
        buildSite(out);                                    // a previous build may be rebuilt in place
        assert.throws(() => buildSite(REPO), /contains the repo/);
        const other = mkdtempSync(join(tmpdir(), 'pick-not-a-site-'));
        writeFileSync(join(other, 'keep.txt'), 'mine');
        try {
            assert.throws(() => buildSite(other), /refusing to empty/);
            assert.deepEqual(readdirSync(other), ['keep.txt'], 'an unrelated directory is left alone');
        } finally { rmSync(other, { recursive: true, force: true }); }
    } finally { rmSync(out, { recursive: true, force: true }); }
});

test('S2 the hub graph is the running kernel\'s container, byte for byte -- control: one edge fewer differs', async () => {
    const fresh = await build();
    assert.equal(fresh.json, read('pickEcosystem/graph.json'), 'graph.json is stale: run `node graph.mjs` in pickEcosystem/live');
    assert.equal(fresh.svg, read('pickEcosystem/graph.svg'), 'graph.svg is stale: run `node graph.mjs` in pickEcosystem/live');
    const g = JSON.parse(fresh.json);
    assert.ok(g.root.nodes.length >= 30 && g.root.edges.length >= 30, 'a real graph: ' + g.root.nodes.length + ' tokens');
    assert.match(read('pickEcosystem/index.html'), new RegExp(g.root.nodes.length + ' tokens, ' + g.root.edges.length + ' edges'),
        'the hub states the graph\'s real size');
    const cut = { ...g.root, edges: g.root.edges.slice(1) };
    assert.notEqual(render(cut, g.scope), fresh.svg);
});

test('S3 every version the hub prints is the version package.json pins', () => {
    const deps = JSON.parse(read('pickEcosystem/live/package.json')).dependencies;
    const hub = read('pickEcosystem/index.html');
    const tagged = [...hub.matchAll(/data-pkg="([^"]+)">([^<]+)</g)];
    assert.ok(tagged.length >= 12, tagged.length + ' versions tagged');
    for (const [, pkg, ver] of tagged) assert.equal(ver, deps[pkg], pkg + ' on the hub');
});
