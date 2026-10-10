/**
 * @zakkster/lite-pick -- the CODES runtime export (1.2.0).
 *
 *     node --test test/Codes.test.js
 *
 * `CODES` is the frozen runtime map of every stable error `code` (value === key). Pinned four ways:
 *   1. its key set EQUALS the `LitePickErrorCode` union parsed from Pick.d.ts (types and runtime agree);
 *   2. it is frozen and every value equals its key;
 *   3. CENSUS: every code thrown in Pick.js / Pool.js (`_err(X, 'LITE_PICK_*'` and `code = 'LITE_PICK_*'`,
 *      plus any quoted `'LITE_PICK_*'` literal) is a CODES key, and every CODES key is thrown somewhere.
 *      The census strips the CODES declaration block first -- else "every key used" passes trivially;
 *   4. /pool re-exports the SAME object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CODES } from '../Pick.js';
import { CODES as POOL_CODES } from '../Pool.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** The `LitePickErrorCode` union members, parsed from the declaration text. */
function unionFromDts() {
    const dts = read('../Pick.d.ts');
    const m = /export type LitePickErrorCode\s*=([^;]*);/.exec(dts);
    assert.ok(m, 'Pick.d.ts declares `export type LitePickErrorCode = ...;`');
    return new Set(Array.from(m[1].matchAll(/'(LITE_PICK_[A-Z_]+)'/g), (x) => x[1]));
}

/** Pick.js with the CODES declaration block removed (from `export const CODES` to its closing `});`). */
function pickSourceWithoutCodes() {
    const src = read('../Pick.js');
    const a = src.indexOf('export const CODES');
    assert.ok(a >= 0, 'Pick.js declares `export const CODES`');
    const b = src.indexOf('});', a);
    assert.ok(b > a, 'the CODES block closes');
    return src.slice(0, a) + src.slice(b + 3);
}

/** Every code a source THROWS, by the two throw forms; and every quoted LITE_PICK_ literal. */
function census(src) {
    const thrown = new Set();
    for (const x of src.matchAll(/_err\(\s*\w+\s*,\s*'(LITE_PICK_[A-Z_]+)'/g)) thrown.add(x[1]);
    for (const x of src.matchAll(/\bcode\s*=\s*'(LITE_PICK_[A-Z_]+)'/g)) thrown.add(x[1]);
    const literals = new Set(Array.from(src.matchAll(/'(LITE_PICK_[A-Z_]*)'/g), (x) => x[1]));
    return { thrown, literals };
}

test('CODES: the key set equals the LitePickErrorCode union in Pick.d.ts (14 codes)', () => {
    const union = unionFromDts();
    const keys = new Set(Object.keys(CODES));
    assert.equal(union.size, 14, 'the d.ts union has 14 members');
    assert.deepEqual([...keys].sort(), [...union].sort(), 'Object.keys(CODES) set-equals the d.ts union');
});

test('CODES: frozen, plain, value === key', () => {
    assert.ok(Object.isFrozen(CODES), 'CODES is frozen');
    assert.equal(Object.getPrototypeOf(CODES), Object.prototype);
    for (const [k, v] of Object.entries(CODES)) assert.equal(v, k, 'CODES.' + k + ' === its key');
    assert.throws(() => { CODES.LITE_PICK_INDEX = 'x'; }, TypeError);   // ESM is strict mode
    assert.equal(CODES.LITE_PICK_INDEX, 'LITE_PICK_INDEX');
});

test('CODES census: every thrown code is in CODES, and every CODES key is thrown (Pick.js + Pool.js)', () => {
    const pick = census(pickSourceWithoutCodes());
    const pool = census(read('../Pool.js'));
    const thrown = new Set([...pick.thrown, ...pool.thrown]);
    const literals = new Set([...pick.literals, ...pool.literals]);
    for (const c of thrown) assert.ok(Object.hasOwn(CODES, c), 'thrown code ' + c + ' is missing from CODES');
    for (const c of literals) assert.ok(Object.hasOwn(CODES, c), "quoted literal '" + c + "' is not a CODES key (typo?)");
    for (const c of Object.keys(CODES)) assert.ok(thrown.has(c), 'CODES.' + c + ' is never thrown (dead code or a missed site)');
    // The split the docs state: 8 kernel codes in Pick.js, 6 more only /pool throws.
    const poolOnly = [...pool.thrown].filter((c) => !pick.thrown.has(c)).sort();
    assert.deepEqual(poolOnly, ['LITE_PICK_ABORTED', 'LITE_PICK_CLOCK_INVALID', 'LITE_PICK_CLOCK_REQUIRED',
        'LITE_PICK_FEEDBACK', 'LITE_PICK_KEY_REQUIRED', 'LITE_PICK_NONE']);
    assert.equal(pick.thrown.size, 8, 'the kernel throws exactly the 8 kernel codes');
});

test('CODES: /pool re-exports the SAME frozen object as the core', () => {
    assert.equal(POOL_CODES, CODES);
});
