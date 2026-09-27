/**
 * @zakkster/lite-pick/pool -- ES2022-only compile check (L15, tsc --noEmit).
 *
 * Compiled by tsconfig.es2022.json with `lib: ["ES2022"]`, NO DOM, NO @types/node, and
 * `skipLibCheck: false`. It uses the structural `AbortLike` shape instead of the global DOM
 * `AbortSignal`, proving Pool.d.ts + Pick.d.ts type-check for a consumer without DOM/node libs.
 * Also included in the default tsconfig.json so `npm run test:types` exercises it too.
 */

import { Pool, liteQueryFetcher, type AbortLike, type RunOptions } from '../../Pool.js';
import { LeastConnBalancer, PeakEwmaBalancer } from '../../Pick.js';

// A structural abort signal -- NO DOM AbortSignal, NO @types/node.
const abortLike: AbortLike = { aborted: false };

const inflight = new Uint32Array(4);
const pool = new Pool(new LeastConnBalancer(4, new Uint8Array(4), inflight), inflight);

const p1: Promise<number> = pool.run((endpoint: number, signal?: AbortLike) => {
    void signal;
    return endpoint;
}, { signal: abortLike, tries: 2, failurePenaltyNs: 1e9 });
void p1;

// A latency balancer needs a clock (forwarded through RunOptions.clock).
const peInflight = new Uint32Array(4);
const pe = new PeakEwmaBalancer(4, new Uint8Array(4), peInflight, 1e6);
const pePool = new Pool(pe, peInflight);
let now = 0;
const p2: Promise<number> = pePool.run((e: number) => e, { clock: () => (now += 1000) });
void p2;

const fetcher = liteQueryFetcher(pool, (ctx: { endpoint: number; key: any; signal?: AbortLike }) => {
    void ctx.signal;
    return ctx.endpoint;
}, { tries: 2 });
const out: Promise<number> = fetcher({ key: ['x'], signal: abortLike });
void out;

const opts: RunOptions = { tries: 1, failurePenaltyNs: 1e9 };
void opts;
