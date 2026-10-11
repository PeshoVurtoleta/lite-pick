/**
 * @zakkster/lite-pick -- index TYPE matrix for every validated-index API (1.2.0).
 *
 *     node --test test/IndexType.test.js
 *
 * Every index-taking cold/warm API funnels through `_vIdx`. A non-number index of ANY type -- BigInt,
 * Symbol, string, object (even one whose valueOf throws), null, undefined, boolean -- must throw the
 * CODED RangeError `LITE_PICK_INDEX`, never V8's uncoded TypeError ('Cannot mix BigInt and other types' /
 * 'Cannot convert a Symbol value to a number'), never run user valueOf, and never write state first.
 * `isEligible` is the pure predicate: it returns false for every such value and never throws.
 * PeakEWMA's `ewmaAt` is the pure query: it returns NaN for every such value (and for any number that is
 * not an integer in [0, capacity)) and never throws; it does not go through `_vIdx`.
 * `recordRttFrom`'s buffer slot `j` gets the same treatment, with its own code `LITE_PICK_ARRAY`.
 *
 * The roster below is hand-written, but two tests pin it to the module so it cannot drift silently:
 *   - its class set must EQUAL the set of Pick.js exports that are BalancerBase or extend it;
 *   - each class's public index methods, discovered up the prototype chain, must EQUAL the roster's
 *     methods plus `isEligible` and the NOT_VIDX allow-list. A new index method therefore fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Pick from '../Pick.js';

const { BalancerBase } = Pick;
const CAP = 4;
const up = () => new Uint8Array(CAP).fill(1);
const w1 = () => new Uint32Array(CAP).fill(1);
const inf = () => new Uint32Array(CAP);

// [class, factory, _vIdx APIs it exposes beyond setEligible (which every class has)]
const ROSTER = [
    [Pick.BalancerBase, () => new Pick.BalancerBase(CAP, up()), []],
    [Pick.RoundRobinBalancer, () => new Pick.RoundRobinBalancer(CAP, up()), []],
    [Pick.SmoothWRRBalancer, () => new Pick.SmoothWRRBalancer(CAP, up(), w1()), ['setWeight', 'weightOf']],
    [Pick.P2cBalancer, () => new Pick.P2cBalancer(CAP, up(), inf()), []],
    [Pick.LeastConnBalancer, () => new Pick.LeastConnBalancer(CAP, up(), inf()), []],
    [Pick.SedBalancer, () => new Pick.SedBalancer(CAP, up(), inf(), w1()), ['weightOf']],
    [Pick.NqBalancer, () => new Pick.NqBalancer(CAP, up(), inf(), w1()), ['weightOf']],
    [Pick.PeakEwmaBalancer, () => new Pick.PeakEwmaBalancer(CAP, up(), inf(), 1e9), ['recordRtt', 'recordRttFrom']],
    [Pick.ConsistentHashBalancer, () => new Pick.ConsistentHashBalancer(CAP, up(), w1(), 1031), ['setWeight', 'weightOf']],
    [Pick.BoundedLoadBalancer, () => new Pick.BoundedLoadBalancer(CAP, up(), inf(), 0.25, w1(), 1031), ['setWeight', 'weightOf', 'note']],
    [Pick.WeightedRandomBalancer, () => new Pick.WeightedRandomBalancer(CAP, up(), w1()), ['setWeight', 'weightOf']],
];

const CALLS = {
    setEligible: (b, x) => b.setEligible(x, false),
    setWeight: (b, x) => b.setWeight(x, 7),
    weightOf: (b, x) => b.weightOf(x),
    recordRtt: (b, x) => b.recordRtt(x, 1, 1),
    recordRttFrom: (b, x) => b.recordRttFrom(x, new Float64Array(2), 0),
    note: (b, x) => b.note(x, 1),
};

// Public methods whose first parameter is an endpoint index but which deliberately do NOT go through
// _vIdx. ewmaAt is PeakEWMA's pure query: a non-number index returns NaN and never throws (tested below,
// not through _vIdx); listed so the discovery test below stays exact.
const NOT_VIDX = { PeakEwmaBalancer: ['ewmaAt'] };

/** Fresh bad-value list: `hostile` counts every valueOf / toString / toPrimitive invocation. */
function badIndices(hostile) {
    const bump = () => { hostile.n++; throw new Error('coerced'); };
    return [
        ['0n', 0n], ['1n', 1n], ['-1n', -1n],
        ['Symbol', Symbol('i')],
        ['hostile valueOf', { valueOf: bump, toString: bump, [Symbol.toPrimitive]: bump }],
        ["'0'", '0'], ['null', null], ['undefined', undefined], ['true', true], ['{}', {}],
    ];
}
const BAD_COUNT = badIndices({ n: 0 }).length;

/** Read-only snapshot of every own data field (typed arrays copied, scalars by value). */
function snap(b) {
    const out = { live: b.live };
    for (const k of Object.keys(b)) {
        const v = b[k];
        if (ArrayBuffer.isView(v)) out[k] = Array.from(v, (e) => (typeof e === 'bigint' ? e.toString() : e));
        else if (v === null || typeof v !== 'object') out[k] = typeof v === 'bigint' ? v.toString() : v;
    }
    return out;
}

/**
 * Public index methods of a class, discovered up its prototype chain: every own, non-underscore,
 * data-property function whose FIRST declared parameter is named `i`. Pick.js names the endpoint index
 * `i` in every such method. This is a source-text heuristic, chosen because it needs no list to maintain;
 * a new index method whose first parameter is named otherwise would slip past it.
 */
function indexMethods(Cls) {
    const found = new Set();
    for (let p = Cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const n of Object.getOwnPropertyNames(p)) {
            const d = Object.getOwnPropertyDescriptor(p, n);
            if (n === 'constructor' || n[0] === '_' || typeof d.value !== 'function') continue;
            const m = /^[^(]*\(\s*([A-Za-z_$][\w$]*)/.exec(Function.prototype.toString.call(d.value));
            if (m && m[1] === 'i') found.add(n);
        }
    }
    return [...found].sort();
}

test('roster: its class set equals every BalancerBase-derived export of Pick.js', () => {
    const exported = Object.values(Pick)
        .filter((v) => typeof v === 'function' && (v === BalancerBase || v.prototype instanceof BalancerBase))
        .map((c) => c.name).sort();
    const listed = ROSTER.map(([C]) => C.name).sort();
    assert.deepEqual(listed, exported);
});

test('roster: each class exposes exactly the listed index APIs (+ isEligible, + NOT_VIDX)', () => {
    for (const [Cls, make, extra] of ROSTER) {
        const b = make();
        for (const m of ['setEligible', 'isEligible', ...extra]) {
            assert.equal(typeof b[m], 'function', Cls.name + '.' + m + ' must exist');
        }
        const expected = ['isEligible', 'setEligible', ...extra, ...(NOT_VIDX[Cls.name] || [])].sort();
        assert.deepEqual(indexMethods(Cls), expected, Cls.name + ': an index method is missing from the roster');
    }
});

test('every _vIdx API: a non-number index throws RangeError LITE_PICK_INDEX, no coercion, no state write', () => {
    let checked = 0;
    for (const [Cls, make, extra] of ROSTER) {
        const name = Cls.name;
        for (const m of ['setEligible', ...extra]) {
            const hostile = { n: 0 };
            for (const [label, x] of badIndices(hostile)) {
                const b = make();
                const before = snap(b);
                assert.throws(() => CALLS[m](b, x), (e) => {
                    assert.ok(e instanceof RangeError, name + '.' + m + '(' + label + ') threw ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message));
                    assert.equal(e.code, 'LITE_PICK_INDEX', name + '.' + m + '(' + label + ') code');
                    return true;
                });
                assert.deepEqual(snap(b), before, name + '.' + m + '(' + label + ') mutated state');
                checked++;
            }
            assert.equal(hostile.n, 0, name + '.' + m + ' coerced a hostile index (valueOf ran ' + hostile.n + 'x)');
        }
    }
    const pairs = ROSTER.reduce((n, [, , extra]) => n + 1 + extra.length, 0);
    assert.equal(checked, pairs * BAD_COUNT, 'matrix size: every roster pair x every bad index');
});

test('recordRttFrom: a non-number slot j throws RangeError LITE_PICK_ARRAY, no coercion, no state write', () => {
    const rows = ROSTER.filter(([, , extra]) => extra.includes('recordRttFrom'));
    assert.ok(rows.length > 0, 'roster has a recordRttFrom class');
    let checked = 0;
    for (const [Cls, make] of rows) {
        const hostile = { n: 0 };
        const bump = () => { hostile.n++; throw new Error('coerced'); };
        const js = [['0n', 0n], ['1n', 1n], ['Symbol', Symbol('j')],
            ['hostile valueOf', { valueOf: bump, toString: bump, [Symbol.toPrimitive]: bump }], ["'0'", '0']];
        for (const [label, j] of js) {
            const b = make();
            const buf = new Float64Array([5, 10]);
            const before = snap(b);
            assert.throws(() => b.recordRttFrom(1, buf, j), (e) => {
                assert.ok(e instanceof RangeError, Cls.name + '.recordRttFrom(1, buf, ' + label + ') threw ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message));
                assert.equal(e.code, 'LITE_PICK_ARRAY', Cls.name + '.recordRttFrom j=' + label + ' code');
                return true;
            });
            assert.deepEqual(snap(b), before, Cls.name + '.recordRttFrom j=' + label + ' mutated state');
            assert.deepEqual(Array.from(buf), [5, 10], 'buf untouched');
            checked++;
        }
        assert.equal(hostile.n, 0, Cls.name + '.recordRttFrom coerced a hostile j (valueOf ran ' + hostile.n + 'x)');
        // control: a valid j records (state changes), so the snapshot above can see a write
        const b = make();
        const before = snap(b);
        b.recordRttFrom(1, new Float64Array([5, 10]), 0);
        assert.notDeepEqual(snap(b), before, 'control: a valid recordRttFrom writes state');
    }
    assert.equal(checked, rows.length * 5);
});

test('isEligible: a non-number index returns false, never throws, never coerces', () => {
    for (const [Cls, make] of ROSTER) {
        const b = make();
        const hostile = { n: 0 };
        for (const [label, x] of badIndices(hostile)) {
            let r;
            assert.doesNotThrow(() => { r = b.isEligible(x); }, Cls.name + '.isEligible(' + label + ')');
            assert.equal(r, false, Cls.name + '.isEligible(' + label + ')');
        }
        assert.equal(hostile.n, 0, Cls.name + '.isEligible coerced a hostile index');
        assert.equal(b.isEligible(0), true, Cls.name + '.isEligible(0) control');
    }
});

test('PeakEWMA ewmaAt: a non-number index returns NaN, never throws, never coerces, never aliases slot 0', () => {
    const b = new Pick.PeakEwmaBalancer(CAP, up(), inf(), 1e9);
    b.recordRtt(0, 5e6, 1000);                      // slot 0 sampled: its estimate is a finite 5e6, not NaN
    const slot0 = b.ewmaAt(0, 1000);
    assert.equal(slot0, 5e6, 'control: slot 0 reads its sample');
    const hostile = { n: 0 };
    const rows = badIndices(hostile).concat([['0n (explicit)', 0n]]);
    for (const [label, x] of rows) {
        let r;
        assert.doesNotThrow(() => { r = b.ewmaAt(x, 1000); }, 'ewmaAt(' + label + ')');
        assert.ok(Number.isNaN(r), 'ewmaAt(' + label + ') = ' + String(r) + ', want NaN');
        assert.notEqual(r, slot0, 'ewmaAt(' + label + ') aliased slot 0');
    }
    assert.equal(hostile.n, 0, 'ewmaAt coerced a hostile index (valueOf/toString ran ' + hostile.n + 'x)');
    // number indices outside [0, CAP) or not integers read undefined -> NaN, never throw
    for (const x of [-1, CAP, CAP + 1, 1.5, 0.5, -0.5, NaN, Infinity, -Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
        let r;
        assert.doesNotThrow(() => { r = b.ewmaAt(x, 1000); }, 'ewmaAt(' + x + ')');
        assert.ok(Number.isNaN(r), 'ewmaAt(' + x + ') = ' + r + ', want NaN');
    }
    // -0 is the integer 0: reads slot 0 exactly like 0 (sampled and unsampled)
    assert.equal(b.ewmaAt(-0, 1000), slot0, 'ewmaAt(-0) sampled');
    assert.equal(b.ewmaAt(-0, 5e9), b.ewmaAt(0, 5e9), 'ewmaAt(-0) decayed');
    assert.equal(b.ewmaAt(1, 1000), 1, 'unsampled slot 1 reads its 1.0 baseline');
});

test('PeakEWMA ewmaAt: a non-number now returns NaN, never throws, never coerces (sampled and unsampled slots)', () => {
    const b = new Pick.PeakEwmaBalancer(CAP, up(), inf(), 1e9);
    b.recordRtt(0, 5e6, 1000);                      // slot 0 sampled; slots 1..3 unsampled
    const fresh = new Pick.PeakEwmaBalancer(CAP, up(), inf(), 1e9);   // every slot unsampled
    const hostile = { n: 0 };
    const bump = () => { hostile.n++; throw new Error('coerced'); };
    const nows = [
        ['1000n', 1000n], ['0n', 0n], ['Symbol', Symbol('now')],
        ['hostile object', { valueOf: bump, toString: bump, [Symbol.toPrimitive]: bump }],
        ["'1000'", '1000'], ['null', null], ['undefined', undefined], ['{}', {}],
    ];
    const cases = [];
    for (const [label, now] of nows) {
        cases.push(['sampled ewmaAt(0, ' + label + ')', () => b.ewmaAt(0, now)]);
        cases.push(['unsampled ewmaAt(1, ' + label + ')', () => b.ewmaAt(1, now)]);
        cases.push(['all-unsampled ewmaAt(0, ' + label + ')', () => fresh.ewmaAt(0, now)]);
        cases.push(['out-of-range ewmaAt(99, ' + label + ')', () => fresh.ewmaAt(99, now)]);
        cases.push(['bad i AND now ewmaAt(0n, ' + label + ')', () => b.ewmaAt(0n, now)]);
    }
    for (const [label, call] of cases) {
        let r;
        assert.doesNotThrow(() => { r = call(); }, label);
        assert.ok(Number.isNaN(r), label + ' = ' + String(r) + ', want NaN');
    }
    assert.equal(hostile.n, 0, 'ewmaAt coerced a hostile now (valueOf/toString ran ' + hostile.n + 'x)');
    // controls: a number now still reads normally on both kinds of slot
    assert.equal(b.ewmaAt(0, 1000), 5e6, 'control: sampled slot 0 at a number now');
    assert.equal(b.ewmaAt(1, 1000), 1, 'control: unsampled slot 1 at a number now');
});
