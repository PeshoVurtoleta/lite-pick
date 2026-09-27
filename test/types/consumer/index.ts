/**
 * @zakkster/lite-pick consumer type fixture.
 *
 * Imports the package by its PUBLIC specifiers -- the bare `@zakkster/lite-pick` and the
 * `@zakkster/lite-pick/pool` subpath -- so the compile exercises the package exports map and
 * the `typesVersions` `/pool` mapping, which the in-repo `../../Pick.js` relative type tests
 * never touch. Kept strictly DOM-free (no fetch/document; a plain object satisfies AbortLike)
 * so it also type-checks under `lib: ["ES2022"]` with no DOM and no @types/node.
 */

import { WeightedRandomBalancer, PICK_NONE, VERSION } from '@zakkster/lite-pick';
import { Pool, type AbortLike, type RunOptions } from '@zakkster/lite-pick/pool';

const el = new Uint8Array(4);
el.fill(1);
const weights = new Uint32Array([1, 2, 3, 4]);
const wr = new WeightedRandomBalancer(4, el, weights, 42);

const idx: number = wr.pick();
const isNone: boolean = idx === PICK_NONE;
const version: string = VERSION;

const inflight = new Uint32Array(4);
const pool = new Pool(wr, inflight);

// AbortLike is the minimal { readonly aborted: boolean } (L15): satisfiable with NO DOM lib.
const signal: AbortLike = { aborted: false };
const opts: RunOptions = { key: 7, signal };

export async function exercise(): Promise<number> {
    const out = await pool.run<number>((endpoint: number, s?: AbortLike): number => {
        void s;
        return endpoint;
    }, opts);
    void isNone;
    void version;
    return out;
}
