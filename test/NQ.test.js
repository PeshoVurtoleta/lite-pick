/**
 * @zakkster/lite-pick -- NqBalancer boundary + behaviour suite (M4).
 *
 *     node --test test/NQ.test.js
 *
 * Falsifiable assertions (the planner contract for M4 / NQ):
 *   A1. IDLE-FIRST: if any eligible positive-weight node is idle (in-flight 0), pick() returns
 *       the FIRST such node -- never queues while a server sits free.
 *   A2. SED FALLBACK: with no idle node, pick() returns the SED minimum ((inflight+1)/weight).
 *   A3. WEIGHT-0 EXCLUSION: a weight-0 node is never picked (even when idle); all-zero-weight
 *       fails closed.
 *   A4. WORKER-POOL FILL: dispatching to idle-first spreads the first n requests across n
 *       distinct idle workers before any second request is queued.
 *   A5. pick() never returns a down node; PICK_NONE only when no eligible positive-weight node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NqBalancer, BalancerBase, PICK_NONE, Prng } from '../Pick.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';


const up = (n) => { const e = new Uint8Array(n); e.fill(1); return e; };

test('NqBalancer is a BalancerBase', () => {
    const b = new NqBalancer(3, up(3), new Uint32Array(3), Uint32Array.from([1, 1, 1]));
    assert.ok(b instanceof BalancerBase);
});

test('constructor validates inflight and weights', () => {
    assert.throws(() => new NqBalancer(3, up(3), new Uint32Array(2), new Uint32Array(3)), RangeError);
    assert.throws(() => new NqBalancer(3, up(3), new Uint32Array(3), new Uint32Array(2)), RangeError);
});

test('A1: idle-first -- returns the first idle node ignoring SED', () => {
    // node 2 is idle (inflight 0); nodes 0,1 are busy. NQ jumps to 2 regardless of weight.
    const b = new NqBalancer(3, up(3), Uint32Array.from([1, 2, 0]), Uint32Array.from([9, 9, 1]));
    assert.equal(b.pick(), 2);
});

test('A1: the FIRST idle node wins (lowest index)', () => {
    const b = new NqBalancer(4, up(4), Uint32Array.from([2, 0, 0, 0]), Uint32Array.from([1, 1, 1, 1]));
    assert.equal(b.pick(), 1);
});

test('A1: an idle but DOWN node is skipped; the first idle ELIGIBLE node wins', () => {
    const el = Uint8Array.from([1, 0, 1, 1]);
    const b = new NqBalancer(4, el, Uint32Array.from([3, 0, 0, 0]), Uint32Array.from([1, 1, 1, 1]));
    assert.equal(b.pick(), 2); // index 1 idle but down -> first idle eligible is 2
});

test('A2: no idle node -> SED fallback', () => {
    // all busy: node 0 (1+1)/1=2, node 1 (1+1)/2=1, node 2 (3+1)/2=2 -> min is node 1
    const b = new NqBalancer(3, up(3), Uint32Array.from([1, 1, 3]), Uint32Array.from([1, 2, 2]));
    assert.equal(b.pick(), 1);
});

test('A3: a weight-0 node is never picked, even when idle', () => {
    // node 0 idle but weight 0 -> excluded; node 1 idle with weight -> picked.
    const b = new NqBalancer(3, up(3), Uint32Array.from([0, 0, 5]), Uint32Array.from([0, 1, 1]));
    assert.equal(b.pick(), 1);
});

test('A3: all eligible weights 0 -> fail closed', () => {
    const b = new NqBalancer(4, up(4), new Uint32Array(4), new Uint32Array(4));
    assert.equal(b.pick(), PICK_NONE);
});

test('A4: worker-pool fill -- n requests fan out to n distinct idle workers first', () => {
    const n = 8;
    const inflight = new Uint32Array(n);
    const b = new NqBalancer(n, up(n), inflight, new Uint32Array(n).fill(1));
    const seen = new Set();
    for (let i = 0; i < n; i++) { const p = b.pick(); seen.add(p); inflight[p]++; } // dispatch, no settle
    assert.equal(seen.size, n, 'first n picks should hit n distinct idle workers');
});

test('A4: fail closed when the whole pool is down', () => {
    const b = new NqBalancer(4, new Uint8Array(4), new Uint32Array(4), new Uint32Array(4).fill(1));
    assert.equal(b.pick(), PICK_NONE);
});

test('A5 (churn): never returns a down or weight-0 index under flapping', () => {
    const n = 12, el = up(n), inflight = new Uint32Array(n), weights = new Uint32Array(n);
    for (let i = 0; i < n; i++) weights[i] = 1 + (i & 3);
    const b = new NqBalancer(n, el, inflight, weights);
    let s = 0x0ddba11 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 200000; step++) {
        if ((step & 3) === 0) b.setEligible(rnd() % n, (rnd() & 1) === 0);
        if ((step & 7) === 0) { const j = rnd() % n; inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0; }
        const p = b.pick();
        if (p === PICK_NONE) continue;
        assert.equal(el[p], 1, 'down index at step ' + step);
        assert.ok(weights[p] > 0, 'weight-0 index at step ' + step);
        inflight[p]++;
    }
});

test('M5 (1.1.0): idle nodes take turns; with none idle, equal scores rotate', () => {
    const N = 4, inf = new Uint32Array(N), wt = new Uint32Array(N).fill(1);
    const b = new NqBalancer(N, up(N), inf, wt);
    const got = [];
    for (let r = 0; r < 8; r++) got.push(b.pick());
    assert.deepEqual(got, [0, 1, 2, 3, 0, 1, 2, 3], 'idle nodes in turn (1.0.x: always 0)');
    inf.set([2, 1, 3, 1]);                        // nobody idle; nodes 1 and 3 tie at score 2
    const busy = [];
    for (let r = 0; r < 4; r++) busy.push(b.pick());
    assert.deepEqual(busy, [1, 3, 1, 3]);
    inf[2] = 0;                                   // an idle node wins outright over any score
    assert.equal(b.pick(), 2);
});

test('M1 (kill): the cursor advances when the idle winner is found in the [0, cursor) wrap arm', () => {
    // The existing M5 test only exercises the FIRST scan arm's `this._cur = i + 1` (idle nodes at or
    // after the cursor). Deleting the SECOND arm's identical assignment (the one reached only after a
    // wrap, when the winner sits at an index BELOW the cursor) survives every other NQ test. Here the
    // cursor is driven to the last index and the only idle nodes sit at 0 and 1 (below it), so every
    // pick resolves in the wrap arm. If that arm forgets to advance the cursor, pick() never leaves 0.
    const N = 5, inf = new Uint32Array(N), wt = new Uint32Array(N).fill(1);
    const b = new NqBalancer(N, up(N), inf, wt);
    for (let r = 0; r < 4; r++) b.pick();          // all idle: returns 0,1,2,3 -> tie cursor now 4
    inf.set([0, 0, 5, 5, 5]);                       // nodes 0,1 idle; 2,3,4 busy; cursor parked at 4
    const got = [];
    for (let r = 0; r < 4; r++) got.push(b.pick()); // no dispatch, so 0 and 1 stay idle across the picks
    assert.deepEqual(got, [0, 1, 0, 1],
        'the wrap-arm idle winner advances the cursor (M1 mutant / 1.0.x: stuck at [0,0,0,0])');
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

/** Reference (R1): the SAME algorithm -- 4 uniform idle draws (NQ_IDLE_TRIES), then the reservoir scan with
 * idle scored 0 -- written plainly on a Prng, independent of the kernel's inlined state. */
function REF(cap, el, inf, wt, rng) {
    for (let t = 0; t < 4; t++) {
        const j = rng.nextBelow(cap);
        if (el[j] && inf[j] === 0 && wt[j] > 0) { K.fast++; return j; }
    }
    let best = -1, bs = Infinity, c = 0, r = 0;
    for (let i = 0; i < cap; i++) {
        if (!el[i] || !(wt[i] > 0)) continue;
        const score = inf[i] === 0 ? 0 : (inf[i] + 1) / wt[i];
        if (score < bs) { if (c > 1) K.resets++; bs = score; best = i; c = 1; r = 0; }
        else if (score === bs) {
            if (score === 0) K.idleTies++;
            if (r === 0) { r = Math.floor(c / (rng.next() / U32)) + 1; K.draws++; }   // the skip: next replacing tie index
            if (++c === r) { best = i; r = 0; K.repl++; }
        }
    }
    return best;
}
const MAKE = (cap, el, inf, wt, o) => new NqBalancer(cap, el, inf, wt, o);
const DEAD = (el, wt) => wt.fill(0);   // every eligible node weight 0
const FLOORS = (cov) => {
    assert.ok(K.fast >= 500, 'idle fast-path hits ' + cov);
    assert.ok(K.idleTies >= 500, 'idle ties in the scan (the draws missed) ' + cov);
};
const MUTMAKE = (m) => (cap, el, inf, wt, o) => new m.NqBalancer(cap, el, inf, wt, o);
/** 8 BUSY nodes tied on SED score (no idle node): the fast path always misses, the reservoir scan decides. */
const TIE8 = (make, o) => {
    const inf = Uint32Array.from([1, 3, 7, 1, 3, 7, 1, 3]), wt = Uint32Array.from([1, 2, 4, 1, 2, 4, 1, 2]);
    return { b: make(8, new Uint8Array(8).fill(1), inf, wt, o), inf };
};
/** all busy: scores [3 x6, 2, 2] -- the first six tie, then 6 and 7 are strictly lower and tie. */
const LOWER = (make, o) => {
    const inf = Uint32Array.from([2, 2, 2, 2, 2, 2, 1, 3]), wt = Uint32Array.from([1, 1, 1, 1, 1, 1, 1, 2]);
    return { b: make(8, new Uint8Array(8).fill(1), inf, wt, o), inf };
};

test('R9 (1.2.0): NQ random is uniform among the IDLE candidates only (mixed weights, busy / down / weight-0 never)', () => {
    // idle: 0 (w1), 2 (w5), 4 (w2), 7 (w1); busy: 1, 3; 5 idle but weight 0; 6 idle but DOWN.
    const el = Uint8Array.from([1, 1, 1, 1, 1, 1, 0, 1]);
    const inf = Uint32Array.from([0, 1, 0, 1, 0, 0, 0, 0]), wt = Uint32Array.from([1, 9, 5, 9, 2, 0, 1, 1]);
    const b = new NqBalancer(8, el, inf, wt, RANDOM), ids = [0, 2, 4, 7], counts = [0, 0, 0, 0], seq = [];
    for (let k = 0; k < 4e4; k++) {
        const p = b.pick();
        assert.ok(ids.includes(p), 'picked a non-idle / weight-0 / down node ' + p);
        counts[ids.indexOf(p)]++; seq.push(p);
    }
    assert.ok(chiSq(counts) < 16.27, 'idle chi-square (df 3) ' + chiSq(counts).toFixed(2) + ' ' + counts);
    assert.ok(pairChi(seq, ids) < 37.70, 'idle pair chi-square (df 15) ' + pairChi(seq, ids).toFixed(2));
    // An 8-way ALL-IDLE tie exercises the fast path (draws) rather than the scan.
    const all = new NqBalancer(8, new Uint8Array(8).fill(1), new Uint32Array(8), new Uint32Array(8).fill(3), RANDOM);
    const c8 = new Array(8).fill(0), s8 = [];
    for (let k = 0; k < 8e4; k++) { const p = all.pick(); c8[p]++; s8.push(p); }
    assert.ok(chiSq(c8) < CHI7, 'all-idle chi-square ' + chiSq(c8).toFixed(2));
    assert.ok(pairChi(s8, [0, 1, 2, 3, 4, 5, 6, 7]) < CHI63, 'all-idle pair chi-square ' + pairChi(s8, [0, 1, 2, 3, 4, 5, 6, 7]).toFixed(2));
});
