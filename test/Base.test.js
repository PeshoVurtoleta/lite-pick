/**
 * @zakkster/lite-pick -- M0 substrate boundary suite.
 *
 *     node --test test/Base.test.js
 *
 * Covers the seams every strategy (M1+) rides: VERSION/PICK_NONE constants, the
 * deterministic xorshift32 Prng, and BalancerBase's shared eligibility view + O(1)
 * live count + fail-closed abstract pick().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, PICK_NONE, Prng, BalancerBase } from '../Pick.js';

test('VERSION is a non-empty semver-shaped string', () => {
    assert.equal(typeof VERSION, 'string');
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('PICK_NONE is the -1 fail-closed sentinel', () => {
    assert.equal(PICK_NONE, -1);
});

test('Prng is deterministic for a given seed', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});

test('Prng.reset() replays the exact stream', () => {
    const p = new Prng(0xabcdef);
    const first = [];
    for (let i = 0; i < 100; i++) first.push(p.next());
    p.reset();
    for (let i = 0; i < 100; i++) assert.equal(p.next(), first[i]);
});

test('Prng remaps a zero seed (xorshift stuck at 0 would never move)', () => {
    const p = new Prng(0);
    assert.notEqual(p.next(), 0);
});

test('Prng.nextBelow(n) stays in [0, n)', () => {
    const p = new Prng(7);
    for (let i = 0; i < 10000; i++) {
        const v = p.nextBelow(13);
        assert.ok(v >= 0 && v < 13, 'out of range: ' + v);
    }
});

test('Prng.nextBelow covers the whole range over many draws', () => {
    const p = new Prng(99);
    const seen = new Set();
    for (let i = 0; i < 100000; i++) seen.add(p.nextBelow(8));
    for (let k = 0; k < 8; k++) assert.ok(seen.has(k), 'never drew ' + k);
});

test('BalancerBase counts initial eligibility in O(1) live', () => {
    const el = Uint8Array.from([1, 0, 1, 1, 0]);
    const b = new BalancerBase(5, el);
    assert.equal(b.capacity, 5);
    assert.equal(b.live, 3);
});

test('BalancerBase.isEligible reflects the shared view and bounds', () => {
    const el = Uint8Array.from([1, 0, 1]);
    const b = new BalancerBase(3, el);
    assert.equal(b.isEligible(0), true);
    assert.equal(b.isEligible(1), false);
    assert.equal(b.isEligible(2), true);
    assert.equal(b.isEligible(-1), false);
    assert.equal(b.isEligible(3), false);
});

test('setEligible keeps the shared view and live count in lockstep', () => {
    const el = new Uint8Array(4); // all down
    const b = new BalancerBase(4, el);
    assert.equal(b.live, 0);

    b.setEligible(1, true);
    assert.equal(el[1], 1);
    assert.equal(b.live, 1);

    b.setEligible(1, true); // idempotent
    assert.equal(b.live, 1);

    b.setEligible(1, false);
    assert.equal(el[1], 0);
    assert.equal(b.live, 0);

    b.setEligible(0, false); // already down, idempotent
    assert.equal(b.live, 0);
});

test('BalancerBase rejects a bad capacity', () => {
    assert.throws(() => new BalancerBase(0, new Uint8Array(1)), RangeError);
    assert.throws(() => new BalancerBase(1.5, new Uint8Array(2)), RangeError);
});

test('BalancerBase rejects an eligible view that is too small or wrong type', () => {
    assert.throws(() => new BalancerBase(4, new Uint8Array(3)), RangeError);
    assert.throws(() => new BalancerBase(4, [1, 1, 1, 1]), RangeError);
});

test('setEligible rejects an out-of-range index', () => {
    const b = new BalancerBase(2, new Uint8Array(2));
    assert.throws(() => b.setEligible(2, true), RangeError);
    assert.throws(() => b.setEligible(-1, true), RangeError);
});

test('BalancerBase.pick() is abstract until a strategy overrides it', () => {
    const b = new BalancerBase(2, Uint8Array.from([1, 1]));
    assert.throws(() => b.pick(), /abstract/);
});
