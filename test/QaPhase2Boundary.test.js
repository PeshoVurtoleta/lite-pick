/**
 * @zakkster/lite-pick -- 1.2.0 phase-2 QA boundary matrix (independent oracle, written from the ASSERTIONS
 * and the spec, not from the implementation's own tests).
 *
 *     node --test test/QaPhase2Boundary.test.js
 *
 *   B1 default tie path: LeastConn / SED / NQ prototype.pick source is byte-identical to 1bc5eec (git show);
 *      a default / null / {} / { ties: 'rotate' } instance has NO own pick.
 *   B2 ties 'random': chi-square uniform among the tied minima at k = 1, 2, 7, 8, 33, 64 for all three, ties
 *      scattered among lower-index higher-score nodes, ineligible and (SED / NQ) weight-0 nodes; SED / NQ ties
 *      across DIFFERENT weights with the same score; Uint32 extremes (2^32 - 1 loads / weights); NQ picks the
 *      idle set only; a must-fail control (rng frozen per pick) fails the same chi-square.
 *   B3 seed boundaries / determinism; option validation (own data props, accessor never invoked, inherited,
 *      symbols, arrays, primitives, did-you-mean); describe() ties + tieCursor.
 *   B4 weightOf on SmoothWRR / CH / BL / WR / SED / NQ: live vs owned copy, index matrix, exact Uint32 values.
 *   B5 Pool failover: CH cap 8 / 64 spread (keys crossing 2^31 and 2^32), weighted spill ratio, fractional and
 *      huge duck weights, W >= 2^53, weight-0, [1,0,0,0] identity, overflow, throwing weightOf / isEligible,
 *      keyed stability, per-attempt difference, _failSeq crossing its 2^30 wrap (field set directly: a fresh
 *      Pool would need 2^30 failover runs), inflight drains to 0 everywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
    PICK_NONE, Prng, LeastConnBalancer, SedBalancer, NqBalancer, SmoothWRRBalancer,
    ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
} from '../Pick.js';
import { Pool } from '../Pool.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const up = (n) => new Uint8Array(n).fill(1);
const P30 = 2 ** 30, P31 = 2 ** 31, P32 = 2 ** 32, P53 = 2 ** 53;

/** Wilson-Hilferty chi-square quantile at p = 0.999 (z = 3.0902). */
function chiCrit(df) {
    const a = 2 / (9 * df);
    return df * (1 - a + 3.0902 * Math.sqrt(a)) ** 3;
}
function chiSq(counts, n) {
    const e = n / counts.length;
    let s = 0;
    for (const c of counts) s += (c - e) * (c - e) / e;
    return s;
}

// ---------------------------------------------------------------------------------------------------------
// B1 default path byte-identical
// ---------------------------------------------------------------------------------------------------------
test('B1: default pick() bodies are byte-identical to 1bc5eec; default-like options bind no own pick', async (t) => {
    let src;
    try {
        src = execFileSync('git', ['show', '1bc5eec:Pick.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        t.skip('git history unavailable');
        return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'qa-p2-'));
    try {
        const f = join(dir, 'Pick.mjs');
        writeFileSync(f, src);
        const OLD = await import(pathToFileURL(f).href);
        for (const name of ['LeastConnBalancer', 'SedBalancer', 'NqBalancer']) {
            const NEW = { LeastConnBalancer, SedBalancer, NqBalancer }[name];
            assert.equal(NEW.prototype.pick.toString(), OLD[name].prototype.pick.toString(), name + ' pick body changed');
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    const n = 4, inf = new Uint32Array(n), w = new Uint32Array(n).fill(1);
    for (const o of [undefined, null, {}, { ties: 'rotate' }, { ties: undefined }, { seed: 5 }, Object.create(null)]) {
        const bs = [new LeastConnBalancer(n, up(n), inf, o), new SedBalancer(n, up(n), inf, w, o), new NqBalancer(n, up(n), inf, w, o)];
        for (const b of bs) {
            assert.equal(Object.hasOwn(b, 'pick'), false, b.constructor.name + ' ' + JSON.stringify(o) + ' must keep the prototype pick');
            assert.equal(b.describe().ties, 'rotate');
            assert.ok(Number.isInteger(b.describe().tieCursor) && b.describe().tieCursor >= 0);
        }
    }
});

// ---------------------------------------------------------------------------------------------------------
// B2 'random' uniformity among tied minima
// ---------------------------------------------------------------------------------------------------------
/**
 * Builds a cap-node pool where exactly k nodes tie at the minimum, scattered over the index range, with
 * higher-score nodes BEFORE and between them, plus ineligible nodes and (weighted) weight-0 nodes carrying a
 * LOWER raw load (a bad kernel that ignores eligibility / weight would pick them).
 */
function tieLayout(strat, k, cap, extreme) {
    const el = up(cap), inf = new Uint32Array(cap), w = new Uint32Array(cap);
    const base = extreme ? 0xFFFFFFFE : 5;
    const tied = [];
    const stride = Math.floor(cap / k);
    for (let i = 0; i < cap; i++) { inf[i] = base + 1; w[i] = 1; }
    for (let j = 0; j < k; j++) tied.push(j * stride + (stride > 1 ? 1 : 0));
    for (const i of tied) inf[i] = base;
    if (strat !== 'LC') {
        // SED/NQ score (inf+1)/w; make some ties share the score with a DIFFERENT weight: inf=2b+1, w=2
        for (let j = 0; j < tied.length; j += 3) {
            const i = tied[j];
            if (!extreme) { inf[i] = 2 * base + 1; w[i] = 2; }
        }
        if (extreme) for (let i = 0; i < cap; i++) w[i] = 0xFFFFFFFF;
    }
    // traps: free slots that are not tied -> ineligible with load 0, or weight 0 with load 0
    let trap = 0;
    for (let i = 0; i < cap && trap < 4; i++) {
        if (tied.includes(i)) continue;
        inf[i] = 0;
        if (strat === 'LC' || (trap & 1) === 0) el[i] = 0; else w[i] = 0;
        trap++;
    }
    return { el, inf, w, tied };
}
function make(strat, cap, el, inf, w, opts) {
    if (strat === 'LC') return new LeastConnBalancer(cap, el, inf, opts);
    if (strat === 'SED') return new SedBalancer(cap, el, inf, w, opts);
    return new NqBalancer(cap, el, inf, w, opts);
}

for (const strat of ['LC', 'SED', 'NQ']) {
    for (const [k, cap] of [[1, 5], [2, 9], [7, 40], [8, 64], [33, 100], [64, 200]]) {
        test(`B2 ${strat}: ${k}-way tie in cap ${cap} under ties random is uniform (chi-square df ${k - 1})`, (t) => {
            const { el, inf, w, tied } = tieLayout(strat, k, cap, false);
            // NQ: an idle node scores 0, so the ties here are busy (SED fallback); NQ idle set is B2-NQ below.
            const b = make(strat, cap, el, inf, w, { ties: 'random', seed: 0xC0FFEE });
            const N = Math.max(2000, 1500 * k);
            const pos = new Map(tied.map((i, j) => [i, j]));
            const cnt = new Array(k).fill(0);
            for (let n = 0; n < N; n++) {
                const i = b.pick();
                const j = pos.get(i);
                assert.ok(j !== undefined, strat + ' picked non-minimum ' + i);
                cnt[j]++;
            }
            if (k === 1) return;
            const x2 = chiSq(cnt, N), crit = chiCrit(k - 1);
            t.diagnostic(`${strat} k=${k} chi2=${x2.toFixed(2)} crit=${crit.toFixed(2)} min=${Math.min(...cnt)} max=${Math.max(...cnt)} E=${N / k}`);
            assert.ok(x2 < crit, `${strat} k=${k} chi2 ${x2} >= ${crit}`);
            // must-fail control: the same instance with its rng frozen before each pick is NOT uniform
            const c = make(strat, cap, el, inf, w, { ties: 'random', seed: 0xC0FFEE });
            const s0 = c._rng._s;
            const cc = new Array(k).fill(0);
            for (let n = 0; n < N; n++) { c._rng._s = s0; cc[pos.get(c.pick())]++; }
            assert.ok(chiSq(cc, N) >= crit, 'control (frozen rng) must fail the chi-square');
        });
    }
    test(`B2 ${strat}: Uint32 extremes (loads 2^32 - 2 / 2^32 - 1, weights 2^32 - 1) -- 7-way tie uniform`, () => {
        const cap = 21;
        const { el, inf, w, tied } = tieLayout(strat, 7, cap, true);
        const b = make(strat, cap, el, inf, w, { ties: 'random', seed: P32 - 1 });
        const pos = new Map(tied.map((i, j) => [i, j]));
        const cnt = new Array(7).fill(0), N = 14000;
        for (let n = 0; n < N; n++) {
            const i = b.pick();
            if (strat === 'NQ' && !pos.has(i)) {
                assert.equal(inf[i], 0, 'NQ may only leave the tie set for an idle node');
                continue;
            }
            assert.ok(pos.has(i), strat + ' picked non-minimum ' + i);
            cnt[pos.get(i)]++;
        }
        if (strat !== 'NQ') assert.ok(chiSq(cnt, N) < chiCrit(6), strat + ' extreme chi2 ' + chiSq(cnt, N));
    });
}

test('B2 NQ: random is uniform over the IDLE set only (k = 2, 7, 33, 64), never busy / down / weight-0', (t) => {
    for (const [k, cap] of [[2, 11], [7, 64], [33, 64], [64, 128]]) {
        const el = up(cap), inf = new Uint32Array(cap).fill(3), w = new Uint32Array(cap).fill(1);
        const idle = [];
        for (let i = 0; i < cap && idle.length < k; i += Math.max(1, Math.floor(cap / k))) { idle.push(i); inf[i] = 0; w[i] = 1 + (i % 5); }
        // traps: idle-looking but down / weight 0; busy with the highest weight (lowest SED score)
        let traps = 0;
        for (let i = 0; i < cap && traps < 6; i++) {
            if (idle.includes(i)) continue;
            if (traps % 3 === 0) { inf[i] = 0; el[i] = 0; } else if (traps % 3 === 1) { inf[i] = 0; w[i] = 0; } else { inf[i] = 1; w[i] = 0xFFFFFFFF; }
            traps++;
        }
        assert.equal(idle.length, k);
        const b = new NqBalancer(cap, el, inf, w, { ties: 'random', seed: 7 });
        const pos = new Map(idle.map((i, j) => [i, j]));
        const N = 2000 * k, cnt = new Array(k).fill(0);
        for (let n = 0; n < N; n++) {
            const i = b.pick();
            assert.ok(pos.has(i), 'NQ picked non-idle ' + i + ' inf=' + inf[i] + ' el=' + el[i] + ' w=' + w[i]);
            cnt[pos.get(i)]++;
        }
        const x2 = chiSq(cnt, N);
        t.diagnostic(`NQ idle k=${k} cap=${cap} chi2=${x2.toFixed(2)} crit=${chiCrit(k - 1).toFixed(2)}`);
        assert.ok(x2 < chiCrit(k - 1), `NQ idle k=${k} chi2 ${x2}`);
    }
    // no idle positive-weight node: fall back to SED among busy; a lone weight-0 idle node never wins
    const el = up(4), inf = new Uint32Array([0, 2, 2, 5]), w = new Uint32Array([0, 1, 1, 1]);
    const b = new NqBalancer(4, el, inf, w, { ties: 'random', seed: 1 });
    const c = [0, 0, 0, 0];
    for (let n = 0; n < 4000; n++) c[b.pick()]++;
    assert.equal(c[0], 0); assert.equal(c[3], 0);
    assert.ok(Math.abs(c[1] - 2000) < 200, JSON.stringify(c));
    // everything weight 0 / down -> PICK_NONE; cap 1
    assert.equal(new NqBalancer(2, up(2), new Uint32Array(2), new Uint32Array(2), { ties: 'random' }).pick(), PICK_NONE);
    assert.equal(new SedBalancer(2, up(2), new Uint32Array(2), new Uint32Array(2), { ties: 'random' }).pick(), PICK_NONE);
    for (const s of ['LC', 'SED', 'NQ']) {
        const one = make(s, 1, up(1), new Uint32Array(1), new Uint32Array([1]), { ties: 'random', seed: P31 });
        for (let n = 0; n < 50; n++) assert.equal(one.pick(), 0);
        const down = make(s, 1, new Uint8Array(1), new Uint32Array(1), new Uint32Array([1]), { ties: 'random' });
        assert.equal(down.pick(), PICK_NONE);
    }
});

// ---------------------------------------------------------------------------------------------------------
// B3 seeds, options, describe()
// ---------------------------------------------------------------------------------------------------------
function seq(strat, opts, n = 64) {
    const cap = 33, inf = new Uint32Array(cap), w = new Uint32Array(cap).fill(1);
    for (let i = 0; i < cap; i++) inf[i] = strat === 'NQ' ? 1 + (i & 1) : i & 1;   // 17-way tie
    const b = make(strat, cap, up(cap), inf, w, opts);
    const out = [];
    for (let i = 0; i < n; i++) out.push(b.pick());
    return out;
}

test('B3: seed boundaries accepted / rejected (LITE_PICK_OPTION), determinism, 0 and -0 map to the default', () => {
    for (const s of ['LC', 'SED', 'NQ']) {
        const seen = new Set();
        for (const seed of [0, 1, P31 - 1, P31, P32 - 1, P30, P32 - 2]) {
            const a = seq(s, { ties: 'random', seed }), b = seq(s, { ties: 'random', seed });
            assert.deepEqual(a, b, s + ' seed ' + seed + ' not deterministic');
            seen.add(a.join(','));
        }
        assert.equal(seen.size, 7, s + ' distinct seeds must give distinct sequences');
        assert.deepEqual(seq(s, { ties: 'random', seed: 0 }), seq(s, { ties: 'random' }), 'seed 0 == default');
        assert.deepEqual(seq(s, { ties: 'random', seed: -0 }), seq(s, { ties: 'random' }), 'seed -0 == default');
        assert.deepEqual(seq(s, { ties: 'random', seed: 0x9e3779b9 }), seq(s, { ties: 'random' }));
        for (const seed of [-1, P32, P53 - 1, P53, 1.5, NaN, Infinity, -Infinity, '5', null, true, 5n, [5], {}]) {
            assert.throws(() => seq(s, { ties: 'random', seed }), (e) => e.code === 'LITE_PICK_OPTION' && (e instanceof RangeError || e instanceof TypeError),
                s + ' seed ' + String(seed) + ' must be rejected');
        }
        // seed is validated even under the default 'rotate' mode
        assert.throws(() => seq(s, { seed: -1 }), (e) => e.code === 'LITE_PICK_OPTION');
    }
});

test('B3: options fail closed -- own data props only, accessor never invoked, did-you-mean, null = defaults', () => {
    const cap = 3, inf = new Uint32Array(cap), w = new Uint32Array(cap).fill(1);
    const all = (o) => [() => new LeastConnBalancer(cap, up(cap), inf, o), () => new SedBalancer(cap, up(cap), inf, w, o), () => new NqBalancer(cap, up(cap), inf, w, o)];
    const isOpt = (re) => (e) => e.code === 'LITE_PICK_OPTION' && (!re || re.test(e.message));
    for (const f of all(null)) assert.equal(f().describe().ties, 'rotate');
    let calls = 0;
    const acc = {}; Object.defineProperty(acc, 'ties', { get() { calls++; return 'random'; }, enumerable: true });
    const bad = [
        [acc, TypeError, /accessor/],
        [Object.create({ ties: 'random' }), TypeError, null],                       // inherited
        [{ [Symbol('ties')]: 'random' }, TypeError, null],
        [['random'], TypeError, null],
        ['random', TypeError, null], [5, TypeError, null], [true, TypeError, null], [() => {}, TypeError, null],
        [new (class Opts { constructor() { this.ties = 'random'; } })(), TypeError, null],
        [{ tie: 'random' }, TypeError, /did you mean 'ties'/],
        [{ TIES: 'random' }, TypeError, /did you mean 'ties'/],
        [{ sed: 1 }, TypeError, /did you mean 'seed'/],
        [{ seeds: 1 }, TypeError, /did you mean 'seed'/],
        [{ zzzzzzzz: 1 }, TypeError, /unknown option 'zzzzzzzz'$/],
        [{ ties: 'RANDOM' }, RangeError, /'rotate' or 'random'/],
        [{ ties: '' }, RangeError, /'rotate' or 'random'/],
        [{ ties: null }, RangeError, /'rotate' or 'random'/],
        [{ ties: ['random'] }, RangeError, /'rotate' or 'random'/],
    ];
    const nonEnum = {}; Object.defineProperty(nonEnum, 'bogus', { value: 1, enumerable: false });
    bad.push([nonEnum, TypeError, /unknown option 'bogus'/]);
    for (let b = 0; b < bad.length; b++) {
        const [o, Cls, re] = bad[b];
        for (const f of all(o)) assert.throws(f, (e) => e instanceof Cls && isOpt(re)(e), 'bad options case #' + b);
    }
    assert.equal(calls, 0, 'an accessor option must never be invoked');
    // frozen / null-proto data objects are fine
    for (const o of [Object.freeze({ ties: 'random', seed: 3 }), Object.assign(Object.create(null), { ties: 'random' })]) {
        for (const f of all(o)) { const b = f(); assert.equal(b.describe().ties, 'random'); assert.equal(b.describe().tieCursor, -1); }
    }
    // the ctor validates options BEFORE the array arguments? either way: a bad option never yields an instance
    assert.throws(() => new LeastConnBalancer(cap, up(cap), [0, 0, 0], { tie: 1 }));
});

test('B3: describe() -- ties mode + tieCursor -1 under random (before and after picks); rotate keeps a cursor', () => {
    const cap = 8, inf = new Uint32Array(cap), w = new Uint32Array(cap).fill(1);
    for (const s of ['LC', 'SED', 'NQ']) {
        const r = make(s, cap, up(cap), inf, w, { ties: 'random', seed: 9 });
        assert.equal(r.describe().ties, 'random'); assert.equal(r.describe().tieCursor, -1);
        for (let i = 0; i < 100; i++) r.pick();
        assert.equal(r.describe().ties, 'random'); assert.equal(r.describe().tieCursor, -1);
        assert.ok(Object.hasOwn(r, 'pick'));
        const d = make(s, cap, up(cap), inf, w);
        d.pick(); d.pick(); d.pick();
        assert.equal(d.describe().ties, 'rotate');
        assert.ok(d.describe().tieCursor >= 0 && d.describe().tieCursor < cap);
        // same own-key set (shape) in both modes, except the bound pick
        const kr = Object.keys(r).filter((k) => k !== 'pick').sort(), kd = Object.keys(d).sort();
        assert.deepEqual(kr, kd, s + ' instance shape differs between modes');
    }
});

// ---------------------------------------------------------------------------------------------------------
// B4 weightOf
// ---------------------------------------------------------------------------------------------------------
test('B4: weightOf -- live (SmoothWRR / WR / SED / NQ) vs owned copy (CH / BL); index matrix; exact Uint32 values', () => {
    const cap = 4;
    const VALS = [0, 1, P31 - 1, P32 - 1];
    const mk = {
        SmoothWRR: (w) => new SmoothWRRBalancer(cap, up(cap), w),
        WR: (w) => new WeightedRandomBalancer(cap, up(cap), w),
        SED: (w) => new SedBalancer(cap, up(cap), new Uint32Array(cap), w),
        NQ: (w) => new NqBalancer(cap, up(cap), new Uint32Array(cap), w),
        CH: (w) => new ConsistentHashBalancer(cap, up(cap), w, 1031),
        BL: (w) => new BoundedLoadBalancer(cap, up(cap), new Uint32Array(cap), 0.25, w, 1031),
    };
    for (const [name, f] of Object.entries(mk)) {
        const w = new Uint32Array(VALS);
        const b = f(w);
        for (let i = 0; i < cap; i++) {
            const v = b.weightOf(i);
            assert.ok(Object.is(v, VALS[i]), name + ' weightOf(' + i + ') = ' + v + ' expected ' + VALS[i]);
        }
        assert.ok(Object.is(b.weightOf(-0), 0), name + ' weightOf(-0) reads index 0');
        w[1] = 7;
        const owned = name === 'CH' || name === 'BL';
        assert.equal(b.weightOf(1), owned ? 1 : 7, name + (owned ? ' must read its OWNED copy' : ' must read the LIVE array'));
        if (owned) { b.setWeights(new Uint32Array([3, 7, 0, 1])); assert.equal(b.weightOf(1), 7); assert.equal(b.weightOf(3), 1); }
        for (const i of [-1, cap, cap + 1, 1.5, NaN, Infinity, -Infinity, '0', '1', null, undefined, true, P30, P31 - 1, P31, P32 - 1, P32, P53 - 1, P53, [0], {}]) {
            assert.throws(() => b.weightOf(i), (e) => e instanceof RangeError && e.code === 'LITE_PICK_INDEX', name + ' weightOf(' + String(i) + ')');
        }
        // Fixed in 1.2.0: a BigInt / Symbol index used to escape _vIdx as V8's uncoded TypeError ('Cannot mix
        // BigInt'); every non-number now throws the coded RangeError, without running a hostile valueOf.
        let coerced = 0;
        const hostile = { valueOf() { coerced++; throw new Error('coerced'); } };
        for (const i of [0n, 1n, Symbol('x'), hostile]) {
            assert.throws(() => b.weightOf(i), (e) => e instanceof RangeError && e.code === 'LITE_PICK_INDEX', name + ' weightOf(' + typeof i + ')');
        }
        assert.equal(coerced, 0, name + ' weightOf must never invoke the index valueOf');
    }
});

// ---------------------------------------------------------------------------------------------------------
// B5 Pool failover
// ---------------------------------------------------------------------------------------------------------
const FAIL = Symbol('fail');
async function failoverTarget(pool, key, homeFails, tries = 2) {
    const seen = [];
    try {
        await pool.run((i) => { seen.push(i); if (homeFails(i, seen.length - 1)) throw FAIL; return i; }, key === undefined ? { tries } : { tries, key });
    } catch (e) { if (e !== FAIL) throw e; }
    return seen;
}

for (const [cap, homes, band, start] of [[8, [0, 3, 7], 0.10, P31 - 80000], [64, [0, 31, 63], 0.30, P32 - 400000]]) {
    test(`B5 CH cap ${cap}: failover spread over every survivor within +-${band * 100}% (keys from ${start}, crossing the wrap)`, async (t) => {
        const N = 20000;
        const inflight = new Uint32Array(cap);
        const ch = new ConsistentHashBalancer(cap, up(cap), null, cap === 8 ? 1031 : 8191);
        const pool = new Pool(ch, inflight);
        const keysFor = new Map(homes.map((h) => [h, []]));
        for (let k = start; [...keysFor.values()].some((a) => a.length < N); k++) {
            const h = ch.pick(k);
            const a = keysFor.get(h);
            if (a && a.length < N) a.push(k);
        }
        let worst = 0, worstCell = '';
        for (const h of homes) {
            const hist = new Array(cap).fill(0);
            for (const k of keysFor.get(h)) {
                const s = await failoverTarget(pool, k, (i) => i === h);
                assert.equal(s[0], h);
                assert.equal(s.length, 2);
                hist[s[1]]++;
            }
            assert.equal(hist[h], 0);
            const e = N / (cap - 1);
            for (let i = 0; i < cap; i++) {
                if (i === h) continue;
                const dev = (hist[i] - e) / e;
                if (Math.abs(dev) > Math.abs(worst)) { worst = dev; worstCell = `home ${h} -> ${i}: ${hist[i]} (E ${e.toFixed(1)})`; }
                assert.ok(Math.abs(dev) <= band, `cap ${cap} home ${h} survivor ${i}: ${hist[i]} vs ${e.toFixed(1)}`);
            }
            if (h === homes[1]) t.diagnostic(`cap ${cap} home ${h} histogram ${JSON.stringify(hist)}`);
        }
        t.diagnostic(`cap ${cap} worst cell ${worstCell} dev ${(worst * 100).toFixed(2)}%`);
        assert.ok(inflight.every((v) => v === 0));
    });
}

test('B5 weighted CH [1,1,1,1,4,4,4,4]: spill ratio w4/w1 in [3.6, 4.4]; weight-0 never chosen', async (t) => {
    const cap = 8, inflight = new Uint32Array(cap);
    const ch = new ConsistentHashBalancer(cap, up(cap), new Uint32Array([1, 1, 1, 1, 4, 4, 4, 4]), 1031);
    const pool = new Pool(ch, inflight);
    const hist = new Array(cap).fill(0);
    let n = 0;
    for (let k = 0; n < 20000; k++) {
        if (ch.pick(k) !== 4) continue;
        n++;
        hist[(await failoverTarget(pool, k, (i) => i === 4))[1]]++;
    }
    const m1 = (hist[0] + hist[1] + hist[2] + hist[3]) / 4, m4 = (hist[5] + hist[6] + hist[7]) / 3;
    t.diagnostic(`weighted spill hist ${JSON.stringify(hist)} ratio ${(m4 / m1).toFixed(3)}`);
    assert.ok(m4 / m1 >= 3.6 && m4 / m1 <= 4.4, 'ratio ' + m4 / m1);
    // weight-0: [0, 1, 0, 1, 0, 1, 1, 0], home failing, all three tries -> never a weight-0 dispatch
    const ch0 = new ConsistentHashBalancer(cap, up(cap), new Uint32Array([0, 1, 0, 1, 0, 1, 1, 0]), 1031);
    const p0 = new Pool(ch0, inflight);
    for (let k = 0; k < 3000; k++) {
        const s = await failoverTarget(p0, k, () => true, 8);
        for (const i of s) assert.ok(ch0.weightOf(i) > 0, 'dispatched weight-0 ' + i);
        assert.equal(new Set(s).size, s.length);
        assert.equal(s.length, 4);
    }
    assert.ok(inflight.every((v) => v === 0));
});

class Duck {
    constructor(ws, v = 0) { this.ws = ws; this.capacity = ws.length; this.live = ws.length; this.v = v; }
    pick() { return this.v; }
    isEligible() { return true; }
    weightOf(i) { return this.ws[i]; }
}

test('B5 duck weights: fractional, huge (2^32 - 1 and W >= 2^53), weight-0 / [1,0,0,0] identity, overflow, throwing hooks', async (t) => {
    const inflight = new Uint32Array(8);
    const share = async (ws, runs) => {
        const pool = new Pool(new Duck(ws), inflight);
        const h = new Array(ws.length).fill(0);
        for (let r = 0; r < runs; r++) h[(await failoverTarget(pool, undefined, (i) => i === 0))[1]]++;
        return h;
    };
    const f = await share([1, 0.1, 0.2, 0.7], 20000);
    t.diagnostic('fractional ' + JSON.stringify(f));
    assert.equal(f[0], 0);
    for (const [i, p] of [[1, 0.1], [2, 0.2], [3, 0.7]]) assert.ok(Math.abs(f[i] / 20000 - p) < 0.02, 'fractional ' + i + ' ' + f[i]);
    const big = await share([1, P32 - 1, P32 - 1, P32 - 1, P32 - 1], 8000);
    for (let i = 1; i < 5; i++) assert.ok(Math.abs(big[i] - 2000) < 240, 'Uint32-max weights ' + JSON.stringify(big));
    const huge = await share([1, P53, 1, 0], 2000);
    assert.equal(huge[3], 0); assert.equal(huge[0], 0);
    assert.ok(huge[1] >= 1990, 'W >= 2^53: heavy node dominates ' + JSON.stringify(huge));
    // weight 0 everywhere else -> stop with attempt 0's error, by identity, exactly one dispatch
    for (const ws of [[1, 0, 0, 0], [1, -1, NaN, Infinity], [1, '1', null, undefined], [1, -0, 0n, {}]]) {
        const pool = new Pool(new Duck(ws), inflight);
        const err0 = new Error('a0');
        let calls = 0;
        await assert.rejects(pool.run(() => { calls++; throw err0; }, { tries: 4 }), (e) => e === err0);
        assert.equal(calls, 1, JSON.stringify(ws.map(String)));
    }
    // overflow: two finite weights summing to Infinity -> stop, attempt 0's error
    {
        const pool = new Pool(new Duck([1, Number.MAX_VALUE, Number.MAX_VALUE]), inflight);
        const err0 = new Error('a0'); let calls = 0;
        await assert.rejects(pool.run(() => { calls++; throw err0; }, { tries: 3 }), (e) => e === err0);
        assert.equal(calls, 1);
    }
    // throwing weightOf / isEligible -> that error, inflight drained
    for (const hook of ['weightOf', 'isEligible']) {
        const d = new Duck([1, 1, 1]);
        const boom = new Error(hook);
        d[hook] = () => { throw boom; };
        const pool = new Pool(d, inflight);
        await assert.rejects(pool.run(() => { throw new Error('a0'); }, { tries: 3 }), (e) => e === boom);
    }
    assert.ok(inflight.every((v) => v === 0), 'inflight drains ' + inflight);
});

test('B5 keyed: target stable per key, distinct per attempt, not the next neighbour; keys at 2^32 - 1 / 2^32 / 2^53 - 1', async () => {
    const cap = 8, inflight = new Uint32Array(cap);
    const ch = new ConsistentHashBalancer(cap, up(cap), null, 1031);
    const pool = new Pool(ch, inflight);
    let adj = 0, total = 0;
    for (const k of [0, 1, P31 - 1, P31, P32 - 1, P32, P53 - 1, ...Array.from({ length: 400 }, (_, j) => 1000 + j * 7919)]) {
        const a = await failoverTarget(pool, k, () => true, 3);
        const b = await failoverTarget(pool, k, () => true, 3);
        assert.deepEqual(a, b, 'key ' + k + ' unstable');
        assert.equal(new Set(a).size, 3);
        total++;
        if (a[2] === (a[1] + 1) % cap) adj++;
    }
    assert.ok(adj / total <= 0.25, 'attempt2 == attempt1 + 1 in ' + adj + '/' + total);
    assert.ok(inflight.every((v) => v === 0));
});

test('B5 unkeyed: _failSeq crosses its 2^30 wrap as a small integer; post-wrap targets replay a fresh Pool', async () => {
    const inflight = new Uint32Array(5);
    const W = 0x3fffffff;
    const fresh = new Pool(new Duck([1, 1, 1, 1, 1]), inflight);
    const freshT = [];
    for (let r = 0; r < 8; r++) freshT.push((await failoverTarget(fresh, undefined, (i) => i === 0))[1]);
    const pool = new Pool(new Duck([1, 1, 1, 1, 1]), inflight);
    pool._failSeq = W - 2;   // set directly: reaching it through runs needs 2^30 failovers
    const seqs = [], targets = [];
    for (let r = 0; r < 12; r++) {
        targets.push((await failoverTarget(pool, undefined, (i) => i === 0))[1]);
        seqs.push(pool._failSeq);
    }
    assert.deepEqual(seqs, [W - 1, W, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of seqs) assert.ok(Number.isInteger(s) && s >= 0 && s < P30);
    assert.deepEqual(targets.slice(3, 11), freshT, 'seq 1.. after the wrap replays a fresh Pool');
    for (const x of targets) assert.ok(x >= 1 && x <= 4);
    // 4000 runs straddling the wrap: nodes 1..4 each 1000 +-12%
    pool._failSeq = W - 2000;
    const h = [0, 0, 0, 0, 0];
    for (let r = 0; r < 4000; r++) h[(await failoverTarget(pool, undefined, (i) => i === 0))[1]]++;
    assert.equal(h[0], 0);
    for (let i = 1; i < 5; i++) assert.ok(Math.abs(h[i] - 1000) <= 120, 'wrap spread ' + JSON.stringify(h));
    // keyed runs never advance _failSeq
    const before = pool._failSeq;
    const ch = new ConsistentHashBalancer(5, up(5), null, 1031);
    const kp = new Pool(ch, inflight);
    kp._failSeq = W;
    for (let k = 0; k < 50; k++) await failoverTarget(kp, k, () => true, 3);
    assert.equal(kp._failSeq, W);
    assert.equal(pool._failSeq, before);
    assert.ok(inflight.every((v) => v === 0));
});

test('B5 Pool over ties random: re-entrant run() from inside fn, inflight balanced', async () => {
    const cap = 6, inflight = new Uint32Array(cap), w = new Uint32Array(cap).fill(1);
    const nq = new NqBalancer(cap, up(cap), inflight, w, { ties: 'random', seed: P32 - 1 });
    const pool = new Pool(nq, inflight);
    const seen = [];
    await pool.run(async (i) => {
        seen.push(i);
        // re-entrant: a nested run while i is in flight never lands on i (NQ never queues)
        const j = await pool.run((jj) => jj);
        assert.notEqual(j, i);
        assert.equal(inflight[i], 1);
        return i;
    });
    assert.ok(inflight.every((v) => v === 0));
});
