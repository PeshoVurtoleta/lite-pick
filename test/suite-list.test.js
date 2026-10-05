/**
 * @zakkster/lite-pick -- test-suite roster guard.
 *
 *     node --test test/suite-list.test.js
 *
 * The `test` script names every top-level `test/*.test.[cm]?js` file EXPLICITLY, because a bare
 * glob is not portable: cmd.exe does not expand `test/*.test.js`, and `node --test test/` recurses
 * into test/perf/PerfGate.test.mjs (which needs --expose-gc + pinned semi-space flags, run only by
 * `test:perf`). An explicit list is portable but fails OPEN -- a newly added suite is silently
 * never run. This guard closes that gap in three directions:
 *   1. every top-level suite on disk is named in the `test` script;
 *   2. the `test` script names no file that is absent from disk;
 *   3. no test file hides ANYWHERE under test/ where no runner would pick it up.
 *
 * Guard 3 walks the WHOLE test/ tree (top-level AND every subdirectory), because the old
 * SUBDIRECTORY-only scan exempted the perf/ and types/ dirs WHOLESALE -- so a stray
 * test/perf/Extra.test.js or test/types/Extra.test.js passed the guard and was never run. Only the
 * files that genuinely have their own runner are exempt now:
 *   - test/perf/PerfGate.test.mjs  (run by `test:perf`, needs --expose-gc + pinned semi-space)
 *   - test/perf/PoolCost.test.mjs  (run by `test:perf:pool`, same pinned flags)
 *   - any `*.test-d.ts`            (type-definition tests, run by `test:types` via tsc)
 *   - the test/types/consumer/ fixture's OWN files (index.ts, package.json, tsconfig*.json) -- that
 *     dir is WALKED, not skipped, so a stray suite planted inside it is still caught.
 *
 * Detection is CASE-INSENSITIVE (so `Extra.TEST.js` is caught) and covers the common alternative
 * conventions as well as `*.test.[cm]?js`: `*.spec.[cm]?js`, `*-test.[cm]?js`, `*_test.[cm]?js`,
 * `test-*.[cm]?js`, and a bare `test.[cm]?js`.
 * `*.test.js`, `*.test.mjs` and `*.test.cjs` all count -- a `.mjs`/`.cjs` suite must not slip the
 * roster. This file is itself in the list (so `node --test` runs it). It reads package.json/dir at
 * test time; it is a meta-test with no dependency on Pick.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG = fileURLToPath(new URL('../package.json', import.meta.url));

/** A top-level node --test suite: `.test.js`, `.test.mjs`, or `.test.cjs`. */
const SUITE_RE = /\.test\.[cm]?js$/;

/**
 * True if `name` LOOKS like a runnable node:test suite by any common convention, CASE-INSENSITIVELY.
 * A `*.test-d.ts` is a TYPE-definition test (run by `test:types` via tsc, not node:test) and is
 * deliberately NOT a match. Recognised: `foo.test.[cm]?js` (and a hidden `.test.<ext>` such as a
 * stray `.ts`), `foo.spec.[cm]?js`, `foo-test.[cm]?js`, `foo_test.[cm]?js` (Node's underscore form),
 * `test-foo.[cm]?js`, and a bare `test.[cm]?js`.
 */
function looksLikeSuite(name) {
    const n = name.toLowerCase();
    if (/\.test-d\.ts$/.test(n)) return false;   // type-definition test: run by test:types, not node
    return /\.test\.[^./]+$/.test(n) ||          // foo.test.js/.mjs/.cjs (and a stray .test.ts etc.)
        /\.spec\.[cm]?js$/.test(n) ||            // foo.spec.js/.mjs/.cjs
        /[-_]test\.[cm]?js$/.test(n) ||          // foo-test / foo_test .js/.mjs/.cjs (Node conventions)
        /^test-[^./]*\.[cm]?js$/.test(n) ||      // test-foo.js/.mjs/.cjs
        /^test\.[cm]?js$/.test(n);               // a bare test.js/.mjs/.cjs
}

/** The nested suites with their own runners (test:perf / test:perf:pool), exempt from the stray scan. */
const PERF_SUITE_REL = new Set([
    'test/perf/PerfGate.test.mjs',   // run by test:perf
    'test/perf/PoolCost.test.mjs',   // run by test:perf:pool (Pool.run async cost gate)
]);
/**
 * The published-package TYPE fixture dir and the ONLY files it may legitimately contain. The dir is
 * WALKED (not skipped wholesale) so a stray suite planted there -- e.g. test/types/consumer/extra.test.js
 * -- is still caught; only these exact fixture files are exempt. tsconfig*.json is matched by pattern.
 */
const TYPE_FIXTURE_DIR = 'test/types/consumer/';
function isTypeFixtureFile(name) {
    return name === 'index.ts' || name === 'package.json' || /^tsconfig.*\.json$/.test(name);
}

/** The suite basenames named in the `test` script (top-level test/ files only). */
function listedFiles() {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
    const script = pkg.scripts && pkg.scripts.test;
    assert.equal(typeof script, 'string', 'package.json has no `test` script');
    const out = new Set();
    // Match `test/<name>.test.[cm]js` tokens; the [^\s/] class rejects any nested path.
    const re = /(?:^|\s)test\/([^\s/]+\.test\.[cm]?js)(?=\s|$)/g;
    let m;
    while ((m = re.exec(script)) !== null) out.add(m[1]);
    // A `test/<dir>/...` token would be a nested suite the flat guard does not manage.
    assert.ok(!/\stest\/[^\s]*\/[^\s]*\.test\.[cm]?js/.test(script),
        'the `test` script names a nested suite; keep --test to top-level test/*.test.[cm]js files');
    return out;
}

/** The actual top-level suite files present on disk. */
function actualFiles() {
    const out = new Set();
    for (const name of readdirSync(TEST_DIR)) {
        if (SUITE_RE.test(name)) out.add(name);
    }
    return out;
}

/**
 * Any test-looking file ANYWHERE under test/ that no runner would pick up (would be silently
 * skipped). Walks the WHOLE tree, including test/types/consumer/. Exempt: test/perf/PerfGate.test.mjs
 * (test:perf), `*.test-d.ts` (test:types, via looksLikeSuite), the consumer fixture's actual files
 * (index.ts / package.json / tsconfig*.json), and top-level standard `*.test.[cm]?js` suites (managed
 * by the roster guards 1 and 2, not this stray guard).
 */
function straySuites() {
    const out = [];
    const walk = (dir, rel) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const childRel = rel + ent.name;
            if (ent.isDirectory()) { walk(join(dir, ent.name), childRel + '/'); continue; }
            if (rel === TYPE_FIXTURE_DIR && isTypeFixtureFile(ent.name)) continue;  // fixture's own files
            if (!looksLikeSuite(ent.name)) continue;
            if (PERF_SUITE_REL.has(childRel)) continue;                // run by test:perf / test:perf:pool
            if (rel === 'test/' && SUITE_RE.test(ent.name)) continue;  // top-level standard suite: guards 1/2
            out.push(childRel);
        }
    };
    walk(TEST_DIR, 'test/');
    return out.sort();
}

test('every top-level test/*.test.[cm]js file is named in the `test` script', () => {
    const listed = listedFiles();
    const actual = actualFiles();
    const missing = [...actual].filter((f) => !listed.has(f)).sort();
    assert.deepEqual(missing, [],
        'these suites exist on disk but the `test` script never runs them: ' + missing.join(', '));
});

test('the `test` script names no file that is absent from disk', () => {
    const listed = listedFiles();
    const actual = actualFiles();
    const ghosts = [...listed].filter((f) => !actual.has(f)).sort();
    assert.deepEqual(ghosts, [],
        'the `test` script names files that do not exist: ' + ghosts.join(', '));
});

test('no test-looking file hides anywhere under test/ where no runner picks it up', () => {
    const strays = straySuites();
    assert.deepEqual(strays, [],
        'these test-looking files sit under test/ but no runner runs them (only ' +
        'test/perf/PerfGate.test.mjs, test/perf/PoolCost.test.mjs, *.test-d.ts and the test/types/consumer/ fixture are ' +
        'exempt): ' + strays.join(', '));
});

test('this guard file is itself in the roster', () => {
    assert.ok(listedFiles().has('suite-list.test.js'),
        'suite-list.test.js must be listed so `node --test` runs the guard');
});
