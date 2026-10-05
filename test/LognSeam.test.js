/**
 * @zakkster/lite-pick -- RECIPES section 17 doc-test: the lite-logn `Fenwick` dynamic-weight seam (1.1.0 B7).
 *
 *     node --test test/LognSeam.test.js
 *
 * The section-17 snippet is extracted from RECIPES.md and run VERBATIM (test/recipe17.mjs rewrites only the two
 * package specifiers), against the @zakkster/lite-logn devDependency. lite-pick itself imports nothing from
 * lite-logn; this pins the documented wiring so the recipe cannot drift.
 *
 * Falsifiable assertions:
 *   F1. Section 17 has a js block that samples with `searchFrom` (the 0-box form), never the boxing `search(`.
 *   F2. Fail closed: an empty tree, every node down, or every weight 0 -> PICK_NONE.
 *   F3. Every pick is EXACTLY the smallest i whose cumulative live weight reaches the drawn target (a brute-force
 *       oracle over `eligible ? weights : 0`), through interleaved reweights and up/down flips -- so a weight-0 or
 *       down node is never returned.
 *   F4. Over 1,000,000 picks the counts follow the weights (chi-square, |z| < 5).
 *   F5. Both ends of the draw: with the Prng steered to its smallest and largest `nextBelow(U)` output, the
 *       target is total / U (> 0: the first live node, never a dead node 0) and exactly total (the last live
 *       node, never `length`). A random run hits either end once in 2^30 draws, so it is forced here.
 *
 * Node 18 CI runs `npm test` with NO install (the unit suites are dependency-free): there, and only on
 * Node < 20, a missing lite-logn skips this file. Anywhere else a missing devDependency FAILS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICK_NONE } from '../Pick.js';
import { extractSection17, lognUrl, loadRecipe17 } from './recipe17.mjs';

const MAJOR = Number(process.versions.node.split('.')[0]);
const MISSING = lognUrl() === null;
const SKIP = MISSING && MAJOR < 20 ? 'no node_modules on the Node 18 job: @zakkster/lite-logn not installed' : false;

test('F0: @zakkster/lite-logn (devDependency) resolves on Node >= 20', () => {
    if (MAJOR < 20) return;
    assert.equal(MISSING, false, 'run npm install: the section-17 doc-test needs the @zakkster/lite-logn devDependency');
});

test('F1: section 17 samples with searchFrom, never the boxing search(', () => {
    const src = extractSection17();
    assert.match(src, /\.searchFrom\(target, 0\)/);
    assert.doesNotMatch(src, /\.search\(/, 'plain search(u) boxes its fractional target when not inlined');
    assert.match(src, /function pick\(\)/);
});

test('F2: fail closed -- empty tree, all down, all weights 0', { skip: SKIP }, async () => {
    const r = await loadRecipe17(8);
    assert.equal(r.pick(), PICK_NONE, 'empty tree');
    for (let i = 0; i < 8; i++) r.setWeight(i, 5);
    assert.equal(r.pick(), PICK_NONE, 'weights set, every node still down');
    for (let i = 0; i < 8; i++) r.setUp(i, true);
    assert.ok(r.pick() >= 0);
    for (let i = 0; i < 8; i++) r.setWeight(i, 0);
    assert.equal(r.pick(), PICK_NONE, 'every node up, every weight 0');
    r.setWeight(3, 1);
    for (let k = 0; k < 200; k++) assert.equal(r.pick(), 3, 'the only positive weight');
    r.setUp(3, false);
    assert.equal(r.pick(), PICK_NONE, 'the only weighted node goes down');
});

test('F3: every pick is the exact lower bound of its target, through reweights and flips', { skip: SKIP }, async () => {
    const CAP = 257;
    const r = await loadRecipe17(CAP);
    for (let i = 0; i < CAP; i++) {
        r.setUp(i, i % 11 !== 0);
        r.setWeight(i, i % 6 === 0 ? 0 : 1 + ((i * 7919) % 97));
    }
    let x = 0x2545f491;
    for (let k = 0; k < 20000; k++) {
        if (k % 7 === 0) {
            x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
            const i = x % CAP;
            if (x & 0x100) r.setUp(i, !r.eligible[i]);
            else r.setWeight(i, (x >>> 9) % 40);       // 0 included
        }
        const p = r.pick();
        let total = 0;
        for (let i = 0; i < CAP; i++) if (r.eligible[i]) total += r.weights[i];
        if (total === 0) { assert.equal(p, PICK_NONE, 'no live weight at step ' + k); continue; }
        const t = r.target[0];
        assert.ok(t > 0 && t <= total, 'target in (0, total] at step ' + k + ': ' + t + ' / ' + total);
        let cum = 0, want = -1;
        for (let i = 0; i < CAP; i++) {
            if (r.eligible[i]) cum += r.weights[i];
            if (cum >= t) { want = i; break; }
        }
        assert.equal(p, want, 'lower bound at step ' + k);
        assert.ok(r.eligible[p] === 1 && r.weights[p] > 0, 'never a down or weight-0 node (step ' + k + ')');
    }
});

test('F4: 1,000,000 picks follow the weights (chi-square |z| < 5)', { skip: SKIP }, async () => {
    const CAP = 1000, S = 1000000;
    const r = await loadRecipe17(CAP);
    for (let i = 0; i < CAP; i++) {
        r.setUp(i, i % 13 !== 0);
        r.setWeight(i, i % 10 === 0 ? 0 : 1 + ((i * 7919) % 1000));
    }
    const cnt = new Float64Array(CAP);
    for (let s = 0; s < S; s++) cnt[r.pick()]++;
    let total = 0;
    for (let i = 0; i < CAP; i++) if (r.eligible[i]) total += r.weights[i];
    let chi = 0, df = -1;
    for (let i = 0; i < CAP; i++) {
        const live = r.eligible[i] ? r.weights[i] : 0;
        if (live === 0) { assert.equal(cnt[i], 0, 'node ' + i + ' has no live weight'); continue; }
        const e = S * live / total;
        chi += (cnt[i] - e) ** 2 / e;
        df++;
    }
    const z = (chi - df) / Math.sqrt(2 * df);
    assert.ok(Math.abs(z) < 5, 'chi-square z = ' + z.toFixed(2) + ' (df ' + df + ')');
});

/** The xorshift32 state whose NEXT step (13, 17, 5 -- Prng's) yields `x`: undo each shift-xor in reverse. */
function prevState(x) {
    let y = x >>> 0, v = y;
    for (let k = 0; k < 7; k++) v = (y ^ (v << 5)) >>> 0;         // undo x ^= x << 5
    y = v;
    for (let k = 0; k < 2; k++) v = (y ^ (v >>> 17)) >>> 0;       // undo x ^= x >>> 17
    y = v;
    for (let k = 0; k < 3; k++) v = (y ^ (v << 13)) >>> 0;        // undo x ^= x << 13
    return v;
}

test('F5: both ends of the draw -- target total / U picks the first live node, total the last', { skip: SKIP }, async () => {
    const CAP = 64;
    const r = await loadRecipe17(CAP);
    for (let i = 0; i < CAP; i++) {
        r.setUp(i, i !== 0 && i !== 63);                 // nodes 0 and 63 are down
        r.setWeight(i, i === 1 || i === 62 ? 0 : 3);     // nodes 1 and 62 weigh 0
    }
    // The steering must reproduce Prng's own step: nextBelow(U) is then 0, resp. U - 1.
    r.rng._s = prevState(1);
    assert.equal(r.rng.nextBelow(r.U), 0, 'prevState inverts the xorshift step');
    r.rng._s = prevState(0xFFFFFFFF);
    assert.equal(r.rng.nextBelow(r.U), r.U - 1);

    r.rng._s = prevState(1);
    assert.equal(r.pick(), 2, 'smallest draw: the first live node (0 is down, 1 weighs 0)');
    assert.ok(r.target[0] > 0, 'the target is never 0');
    r.rng._s = prevState(0xFFFFFFFF);
    assert.equal(r.pick(), 61, 'largest draw: the last live node (63 is down, 62 weighs 0), never length');
    assert.equal(r.target[0], r.tree.prefix(CAP - 1), 'the largest target is exactly the total');
});
