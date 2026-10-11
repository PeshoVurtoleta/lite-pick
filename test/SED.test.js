/**
 * @zakkster/lite-pick -- SedBalancer boundary + behaviour suite (M4).
 *
 *     node --test test/SED.test.js
 *
 * Falsifiable assertions (the planner contract for M4 / SED):
 *   A1. EXACT SED MINIMUM: pick() returns the eligible, positive-weight node minimizing
 *       (inflight + 1) / weight (lowest index on a tie).
 *   A2. WEIGHT-0 EXCLUSION: an eligible node with weight 0 is never picked; if every eligible
 *       node has weight 0, pick() fails closed.
 *   A3. WEIGHTED FAIRNESS: in a feedback loop, load converges to proportional-to-weight
 *       (inflight[i] / weight[i] roughly equal across the pool).
 *   A4. Equal weights reduce SED to least-connections.
 *   A5. pick() never returns a down node; PICK_NONE only when no eligible positive-weight node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SedBalancer, BalancerBase, PICK_NONE, Prng } from '../Pick.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';


const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('SedBalancer is a BalancerBase', () => {
    const b = new SedBalancer(3, up(3), new Uint32Array(3), Uint32Array.from([1, 1, 1]));
    assert.ok(b instanceof BalancerBase);
});

test('constructor validates inflight and weights', () => {
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(2), new Uint32Array(3)), RangeError);
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(3), new Uint32Array(2)), RangeError);
    assert.throws(() => new SedBalancer(3, up(3), new Uint32Array(3), [1, 1, 1]), RangeError);
});

test('A1: returns the exact SED minimum (inflight+1)/weight', () => {
    // node 0: (0+1)/1 = 1.0 ; node 1: (0+1)/3 = 0.333 ; node 2: (2+1)/2 = 1.5
    const b = new SedBalancer(3, up(3), Uint32Array.from([0, 0, 2]), Uint32Array.from([1, 3, 2]));
    assert.equal(b.pick(), 1);
});

test('A2: weight-0 node is never a candidate', () => {
    // node 0 has the lowest raw inflight but weight 0 -> excluded.
    const b = new SedBalancer(3, up(3), Uint32Array.from([0, 5, 5]), Uint32Array.from([0, 1, 1]));
    assert.equal(b.pick(), 1); // (5+1)/1 == node 2, tie -> lowest index 1
});

test('A2: all eligible weights 0 -> fail closed even with the pool up', () => {
    const b = new SedBalancer(4, up(4), new Uint32Array(4), new Uint32Array(4));
    assert.equal(b.live, 4);
    assert.equal(b.pick(), PICK_NONE);
});

test('A3: weighted fairness -- load converges to proportional-to-weight', () => {
    const weights = Uint32Array.from([1, 2, 3, 4]); // sum 10
    const n = weights.length;
    const inflight = new Uint32Array(n);
    const b = new SedBalancer(n, up(n), inflight, weights);
    const TOTAL = 100000;
    for (let i = 0; i < TOTAL; i++) inflight[b.pick()]++;
    // Each node's share should track its weight fraction within a small tolerance.
    for (let i = 0; i < n; i++) {
        const share = inflight[i] / TOTAL;
        const target = weights[i] / 10;
        assert.ok(Math.abs(share - target) < 0.01,
            'node ' + i + ' share ' + share.toFixed(3) + ' should track weight target ' + target.toFixed(3));
    }
});

test('A4: equal weights reduce SED to least-connections', () => {
    const w = Uint32Array.from([1, 1, 1, 1]);
    const inflight = Uint32Array.from([3, 1, 4, 1]);
    const b = new SedBalancer(4, up(4), inflight, w);
    assert.equal(b.pick(), 1); // min inflight, lowest index on tie
});

test('A5 (churn): never returns a down or weight-0 index under flapping', () => {
    const n = 12, el = up(n), inflight = new Uint32Array(n), weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 3);
    const b = new SedBalancer(n, el, inflight, weights);
    let s = 0xbeef1234 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        const p = b.pick();
        if (p === PICK_NONE) continue; // acceptable when no eligible positive-weight node
        assert.equal(el[p], 1, 'down index at step ' + step);
        assert.ok(weights[p] > 0, 'weight-0 index at step ' + step);
        inflight[p]++;
    }
});

test('M5 (1.1.0): equal SED scores rotate', () => {
    // weights 2 and 4 with in-flight 0 and 1: scores (0+1)/2 = (1+1)/4 = 0.5 -- a tie, so they alternate.
    const inf = Uint32Array.from([0, 1, 9]), wt = Uint32Array.from([2, 4, 1]);
    const b = new SedBalancer(3, up(3), inf, wt);
    const got = [];
    for (let r = 0; r < 6; r++) got.push(b.pick());
    assert.deepEqual(got, [0, 1, 0, 1, 0, 1]);
});

// ---- 1.2.0 opt-in `ties: 'random'` (K3) -------------------------------------------------------------
// The default (rotate) pick() is byte-identical to 1.1.x and stays pinned by the tests above. The opt-in
// mode is a SEEDED skip-based size-1 reservoir (Vitter). These gates: (R1) the kernel equals an independent
// reference of the SAME algorithm on `new Prng(seed)` over 1000 random states; (R2) an 8-way tie is uniform
// (chi-square df 7 < 24.32, p = 0.001) AND its consecutive picks are independent (pair chi-square df 63 <
// 103.44 -- the rotating cursor's fixed successor fails this); (R3) a 64-way tie is uniform (df 63);
// (R4) a kernel patched to NEVER replace on a tie fails R2; (R5) a strictly lower score restarts the
// tie count; (R6) seed determinism; (R7) options fail closed; (R8) the default keeps the prototype pick.

const CHI7 = 24.32, CHI63 = 103.44;
const chiSq = (counts) => {
    let n = 0;
    for (const c of counts) n += c;
    const e = n / counts.length;
    let x = 0;
    for (const c of counts) x += (c - e) * (c - e) / e;
    return x;
};
/** Chi-square of consecutive (prev, next) pairs over the `ids` set: tests independence, not just marginals. */
const pairChi = (seq, ids) => {
    const k = ids.length, cells = new Array(k * k).fill(0);
    for (let t = 1; t < seq.length; t++) cells[ids.indexOf(seq[t - 1]) * k + ids.indexOf(seq[t])]++;
    return chiSq(cells);
};
const U32 = 4294967296;

/** A scratch copy of Pick.js whose 'random' picks NEVER replace on a tie (R4); patch count pinned. */
async function neverReplaceKernel() {
    const src = readFileSync(new URL('../Pick.js', import.meta.url), 'utf8');
    const from = 'if (++c === r) { best = i; r = 0; }';
    assert.equal(src.split(from).length - 1, 3, 'mutant anchor: one per random pick (LeastConn, SED, NQ)');
    const dir = mkdtempSync(join(tmpdir(), 'litepick-ties-'));
    const f = join(dir, 'Pick.never-replace.mjs');
    writeFileSync(f, src.split(from).join('if (++c === r) { r = 0; }'));
    try { return await import(pathToFileURL(f).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** An xorshift32 stream returning [0, n) from the HIGH bits (a scaled floor, never a low-bit `% n`). */
const xs32 = (seed) => {
    let s = seed >>> 0;
    return (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return Math.floor((s / 4294967296) * n); };
};
const rnd = xs32(0x2545f491);   // the STATE stream: pool shape, seeds
const opr = xs32(0x9b1d3a77);   // an INDEPENDENT op stream: feedback (dispatch / settle)
/** Coverage counters, written by REF (R1): a reference that never reaches a branch proves nothing about it. */
const K = { draws: 0, repl: 0, resets: 0, fast: 0, idleTies: 0 };
const RANDOM = { ties: 'random' };

test('R1 (1.2.0): ties random == the reference reservoir on new Prng(seed), 1000 random states', () => {
    K.draws = K.repl = K.resets = K.fast = K.idleTies = 0;
    let none = 0;
    for (let st = 0; st < 1000; st++) {
        const cap = 1 + rnd(st % 10 === 0 ? 300 : 40), seed = (rnd(65536) * 65536 + rnd(65536)) >>> 0;
        const el = new Uint8Array(cap), inf = new Uint32Array(cap), wt = new Uint32Array(cap);
        for (let i = 0; i < cap; i++) { el[i] = rnd(5) === 0 ? 0 : 1; inf[i] = rnd(3); wt[i] = rnd(4); }
        el[rnd(cap)] = 1;
        if (st % 50 === 7) DEAD(el, wt);           // 20 states with no candidate: the PICK_NONE path
        const b = MAKE(cap, el, inf, wt, { ties: 'random', seed }), rng = new Prng(seed);
        for (let k = 0; k < 40; k++) {
            const got = b.pick(), want = REF(cap, el, inf, wt, rng);
            assert.equal(got, want, 'state ' + st + ' pick ' + k + ': kernel ' + got + ' != reference ' + want);
            if (got === PICK_NONE) none++;
            if (got >= 0 && opr(2) === 0) inf[got]++;
            if (opr(4) === 0) { const d = opr(cap); if (inf[d] > 0) inf[d]--; }
        }
    }
    // Coverage floors (well below the measured counts, printed on failure): every reservoir branch was hit.
    const cov = JSON.stringify(K) + ' none=' + none;
    assert.ok(K.draws >= 1000, 'skip draws ' + cov);
    assert.ok(K.repl >= 1000, 'tie replacements ' + cov);
    assert.ok(K.resets >= 1000, 'strictly-lower resets after a tie ' + cov);
    assert.ok(none >= 20, 'PICK_NONE reached ' + cov);
    FLOORS(cov);
});

test('R2 (1.2.0): an 8-way tie is uniform (chi-square df 7) and independent (pair chi-square df 63)', () => {
    const { b } = TIE8(MAKE, RANDOM), counts = new Array(8).fill(0), seq = [];
    for (let k = 0; k < 8e4; k++) { const p = b.pick(); counts[p]++; seq.push(p); }
    const ids = [0, 1, 2, 3, 4, 5, 6, 7];
    assert.ok(chiSq(counts) < CHI7, 'marginal chi-square ' + chiSq(counts).toFixed(2) + ' counts ' + counts);
    assert.ok(pairChi(seq, ids) < CHI63, 'pair chi-square ' + pairChi(seq, ids).toFixed(2) + ' (a rotating cursor is ~5e5)');
});

test('R3 (1.2.0): a 64-way tie is uniform (chi-square df 63)', () => {
    const N = 64, el = new Uint8Array(N).fill(1), inf = new Uint32Array(N).fill(1), wt = new Uint32Array(N).fill(2);
    const b = MAKE(N, el, inf, wt, RANDOM), counts = new Array(N).fill(0), seq = [];
    for (let k = 0; k < 128000; k++) { const p = b.pick(); counts[p]++; seq.push(p); }
    assert.ok(chiSq(counts) < CHI63, 'chi-square ' + chiSq(counts).toFixed(2));
    let rep = 0;
    for (let t = 1; t < seq.length; t++) if (seq[t] === seq[t - 1]) rep++;
    assert.ok(Math.abs(rep / (seq.length - 1) - 1 / N) < 0.004, 'repeat rate ' + rep + ' (1/64 if independent, 0 for a cursor)');
});

test('R4 (1.2.0, teeth): a kernel that never replaces on a tie FAILS the R2 chi-square', async () => {
    const mut = await neverReplaceKernel();
    const { b } = TIE8(MUTMAKE(mut), RANDOM), counts = new Array(8).fill(0);
    for (let k = 0; k < 8e4; k++) counts[b.pick()]++;
    assert.ok(chiSq(counts) > CHI7, 'the never-replace mutant must fail: chi-square ' + chiSq(counts).toFixed(2));
});

test('R5 (1.2.0): a strictly lower score restarts the tie count (two-way tie after a 6-way run)', () => {
    const { b, inf } = LOWER(MAKE, RANDOM), counts = [0, 0];
    let rep = 0, prev = -1;
    for (let k = 0; k < 2e4; k++) {
        const p = b.pick();
        assert.ok(p === 6 || p === 7, 'only the strictly-lower pair wins: ' + p + ' inflight ' + inf);
        counts[p - 6]++;
        if (p === prev) rep++;
        prev = p;
    }
    // A tie count carried over from the 6-way run would give node 7 ~1/8, not 1/2.
    assert.ok(Math.abs(counts[0] / 2e4 - 0.5) < 0.02, 'nodes 6/7 ' + counts);
    assert.ok(Math.abs(rep / 2e4 - 0.5) < 0.03, 'independent picks repeat ~half the time (a cursor never does): ' + rep);
});

test('R6 (1.2.0): same seed -> same sequence; a different seed -> a different one; default seed 0x9e3779b9', () => {
    const run = (o) => { const { b } = TIE8(MAKE, o), s = []; for (let k = 0; k < 200; k++) s.push(b.pick()); return s.join(','); };
    assert.equal(run({ ties: 'random', seed: 7 }), run({ ties: 'random', seed: 7 }));
    assert.notEqual(run({ ties: 'random', seed: 7 }), run({ ties: 'random', seed: 8 }));
    assert.equal(run({ ties: 'random' }), run({ ties: 'random', seed: 0x9e3779b9 }));
});

test('R7 (1.2.0): options fail closed -- plain object only, did-you-mean, ties / seed values', () => {
    const N = 4, mk = (o) => MAKE(N, new Uint8Array(N).fill(1), new Uint32Array(N), new Uint32Array(N).fill(1), o);
    const bad = (o, Cls, re) => assert.throws(() => mk(o), (e) => e instanceof Cls && e.code === 'LITE_PICK_OPTION' && re.test(e.message), String(o));
    bad({ tie: 'random' }, TypeError, /unknown option 'tie'; did you mean 'ties'\?/);
    bad({ Seed: 1 }, TypeError, /did you mean 'seed'\?/);
    bad({ zzzzzz: 1 }, TypeError, /unknown option 'zzzzzz'$/);
    bad({ ties: 'lowest' }, RangeError, /'rotate' or 'random'/);
    bad({ ties: 'Random' }, RangeError, /'rotate' or 'random'/);
    for (const s of [-1, 1.5, 2 ** 32, NaN, '1', null]) bad({ seed: s }, RangeError, /seed must be an integer/);
    for (const o of [[], 42, 'random', new Map(), Object.create({ ties: 'random' }), { [Symbol('x')]: 1 }]) bad(o, TypeError, /plain object/);
    for (const o of [undefined, null, {}, Object.create(null), { ties: 'rotate' }, { seed: 0 }, { ties: 'random', seed: 2 ** 32 - 1 }]) mk(o);
    // Own DATA properties only, each read ONCE (review B1): a polluted Object.prototype is ignored ...
    Object.prototype.ties = 'random';
    Object.prototype.seed = 5;
    try {
        const p = mk({});
        assert.equal(p.describe().ties, 'rotate', 'an inherited ties is ignored');
        assert.equal(Object.hasOwn(p, 'pick'), false);
        assert.equal(mk({ ties: 'random' })._rng._seed, 0x9e3779b9, 'an inherited seed is ignored');
    } finally {
        delete Object.prototype.ties;
        delete Object.prototype.seed;
    }
    // ... and an accessor throws (a flip-flopping getter cannot pass validation with 7 and then hand 'zzz' on).
    let reads = 0;
    const flip = {};
    Object.defineProperty(flip, 'seed', { enumerable: true, get() { return reads++ === 0 ? 7 : 'zzz'; } });
    bad(flip, TypeError, /'seed' must be a data property/);
    const flipTies = {};
    Object.defineProperty(flipTies, 'ties', { enumerable: true, get() { return 'random'; } });
    bad(flipTies, TypeError, /'ties' must be a data property/);
    assert.equal(mk({ ties: 'random', seed: 9 })._rng._seed, 9, 'a valid own seed is the one used');
});

test('R8 (1.2.0): default / rotate keep the prototype pick (unchanged body); random binds its own; describe()', () => {
    const N = 4, mk = (o) => MAKE(N, new Uint8Array(N).fill(1), new Uint32Array(N), new Uint32Array(N).fill(1), o);
    const d = mk(), r = mk({ ties: 'rotate' }), x = mk(RANDOM), proto = Object.getPrototypeOf(d);
    assert.equal(d.pick, proto.pick); assert.equal(Object.hasOwn(d, 'pick'), false);
    assert.equal(r.pick, proto.pick);
    assert.notEqual(x.pick, proto.pick); assert.equal(Object.hasOwn(x, 'pick'), true);
    assert.equal(d.describe().ties, 'rotate'); assert.equal(x.describe().ties, 'random');
    d.pick();
    assert.equal(d.describe().tieCursor, 1, 'rotate: the 1.1.0 cursor');
    x.pick();
    assert.equal(x.describe().tieCursor, -1, "random: -1 = not applicable");
});

/** Reference (R1): the SAME algorithm, written plainly on a Prng -- independent of the kernel's inlined state. */
function REF(cap, el, inf, wt, rng) {
    let best = -1, bs = Infinity, c = 0, r = 0;
    for (let i = 0; i < cap; i++) {
        if (!el[i] || !(wt[i] > 0)) continue;
        const score = (inf[i] + 1) / wt[i];
        if (score < bs) { if (c > 1) K.resets++; bs = score; best = i; c = 1; r = 0; }
        else if (score === bs) {
            if (r === 0) { r = Math.floor(c / (rng.next() / U32)) + 1; K.draws++; }   // the skip: next replacing tie index
            if (++c === r) { best = i; r = 0; K.repl++; }
        }
    }
    return best;
}
const MAKE = (cap, el, inf, wt, o) => new SedBalancer(cap, el, inf, wt, o);
const DEAD = (el, wt) => wt.fill(0);   // every eligible node weight 0
const FLOORS = () => {};
const MUTMAKE = (m) => (cap, el, inf, wt, o) => new m.SedBalancer(cap, el, inf, wt, o);
/** 8 nodes tied on SED score 0.5 through DIFFERENT (inflight, weight) pairs: (0,2) (1,4) (3,8) ... */
const TIE8 = (make, o) => {
    const inf = Uint32Array.from([0, 1, 3, 0, 1, 3, 0, 1]), wt = Uint32Array.from([2, 4, 8, 2, 4, 8, 2, 4]);
    return { b: make(8, new Uint8Array(8).fill(1), inf, wt, o), inf };
};
/** scores [1 x6, 0.5, 0.5]: the first six tie, then 6 and 7 are strictly lower and tie. */
const LOWER = (make, o) => {
    const inf = Uint32Array.from([0, 0, 0, 1, 1, 1, 0, 1]), wt = Uint32Array.from([1, 1, 1, 2, 2, 2, 2, 4]);
    return { b: make(8, new Uint8Array(8).fill(1), inf, wt, o), inf };
};
