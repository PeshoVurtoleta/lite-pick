/**
 * @zakkster/lite-pick -- loader for the RECIPES section 17 snippet (the lite-logn `Fenwick` dynamic-weight seam).
 *
 * Not a suite: shared by test/LognSeam.test.js (correctness) and test/perf/PerfGate.test.mjs (0 B/op), so both
 * run the PUBLISHED snippet verbatim. The first ```js block after "## 17." is extracted; only the two package
 * specifiers are rewritten (lite-pick -> the local Pick.js, lite-logn -> the installed devDependency); a prelude
 * supplies the snippet's one free name (`CAP`) and an epilogue exports its bindings for the oracles. Each call
 * imports a FRESH copy (a new temp file), so callers never share tree state.
 *
 * Returns null when @zakkster/lite-logn cannot be resolved (the CI Node 18 job runs `npm test` with no install);
 * callers decide whether that skips or fails.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PICK_URL = pathToFileURL(join(ROOT, 'Pick.js')).href;

/** The first ```js block after the "## 17." heading of RECIPES.md; throws if absent. */
export function extractSection17() {
    const md = readFileSync(join(ROOT, 'RECIPES.md'), 'utf8');
    const h = md.indexOf('\n## 17.');
    if (h < 0) throw new Error('RECIPES.md has no "## 17." section');
    const open = md.indexOf('```js\n', h);
    const next = md.indexOf('\n## ', h + 1);
    if (open < 0 || (next >= 0 && open > next)) throw new Error('RECIPES section 17 has no js block');
    const close = md.indexOf('\n```', open + 6);
    if (close < 0) throw new Error('RECIPES section 17 js block is not closed');
    return md.slice(open + 6, close + 1);
}

/** The resolved URL of @zakkster/lite-logn, or null when it is not installed. */
export function lognUrl() {
    try {
        return import.meta.resolve('@zakkster/lite-logn');
    } catch {
        return null;
    }
}

/**
 * Import a fresh copy of the section-17 snippet with `CAP = cap`.
 * @param {number} cap
 * @returns {Promise<null | { pick: () => number, setWeight: (i: number, w: number) => void,
 *   setUp: (i: number, up: boolean) => void, tree: any, target: Float64Array, weights: Uint32Array,
 *   eligible: Uint8Array, rng: any, U: number, source: string }>}
 */
export async function loadRecipe17(cap) {
    const logn = lognUrl();
    if (logn === null) return null;
    const source = extractSection17();
    const pickSpec = "from '@zakkster/lite-pick'";
    const lognSpec = "from '@zakkster/lite-logn'";
    if (source.split(pickSpec).length !== 2 || source.split(lognSpec).length !== 2) {
        throw new Error('RECIPES section 17 must import @zakkster/lite-pick and @zakkster/lite-logn exactly once');
    }
    const code = 'const CAP = ' + cap + ';\n' +
        source.replace(pickSpec, "from '" + PICK_URL + "'").replace(lognSpec, "from '" + logn + "'") +
        '\nexport { pick, setWeight, setUp, tree, target, weights, eligible, rng, U };\n';
    const dir = mkdtempSync(join(tmpdir(), 'lite-pick-r17-'));
    const file = join(dir, 'recipe17.mjs');
    writeFileSync(file, code);
    const mod = await import(pathToFileURL(file).href);
    return { ...mod, source };
}
