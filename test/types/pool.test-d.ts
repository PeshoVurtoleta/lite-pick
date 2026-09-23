/**
 * @zakkster/lite-pick/pool -- type-surface compile test (tsc --noEmit).
 *
 * Exercises the Pool + liteQueryFetcher signatures so a drift between Pool.d.ts and the
 * runtime fails `npm run test:types`. Not executed; only type-checked.
 */

import { Pool, liteQueryFetcher, VERSION } from '../../Pool.js';
import { LeastConnBalancer, BoundedLoadBalancer } from '../../Pick.js';

// VERSION is a string (re-exported from the core).
const v: string = VERSION;
void v;

const inflight = new Uint32Array(4);
const balancer = new LeastConnBalancer(4, new Uint8Array(4), inflight);

// Pool: balancer + inflight; getters are readonly.
const pool: Pool = new Pool(balancer, inflight);
const b = pool.balancer;
const inf: Uint32Array = pool.inflight;
void b; void inf;

// @ts-expect-error -- balancer is readonly.
pool.balancer = balancer;

// run: fn (endpoint, signal?) -> T | Promise<T>; returns Promise<T>. Generic inferred.
const p1: Promise<string> = pool.run((endpoint: number) => 'ep:' + endpoint);
const p2: Promise<number> = pool.run(async (endpoint: number, signal?: AbortSignal) => {
    void signal;
    return endpoint;
}, { tries: 2 });
void p1; void p2;

// run with a signal option.
const ac = new AbortController();
const p3: Promise<void> = pool.run((endpoint: number) => { void endpoint; }, { signal: ac.signal, tries: 3 });
void p3;

// run with the M7 opt-in latency clock (drives pick(now) + recordRtt feedback).
let nowNs = 1_000;
const p4: Promise<number> = pool.run((endpoint: number) => endpoint, { clock: () => (nowNs += 1000) });
void p4;

// run with the M9 keyed-routing option, over a bounded-load (keyed) balancer.
const blInflight = new Uint32Array(4);
const bl = new BoundedLoadBalancer(4, new Uint8Array(4), blInflight);
const blPool: Pool = new Pool(bl, blInflight);
const p5: Promise<number> = blPool.run((endpoint: number) => endpoint, { key: 0xABCD1234, tries: 2 });
void p5;

// @ts-expect-error -- key must be a number, not a string.
blPool.run((endpoint: number) => endpoint, { key: 'nope' });

// @ts-expect-error -- run needs a function.
pool.run(42);

// liteQueryFetcher: produces ({ key, signal }) -> Promise<T>.
const fetcher = liteQueryFetcher(pool, (ctx: { endpoint: number; key: any; signal?: AbortSignal }) => {
    void ctx.signal;
    return String(ctx.endpoint) + ':' + String(ctx.key[0]);
}, { tries: 2 });
const out: Promise<string> = fetcher({ key: ['x'], signal: ac.signal });
void out;

// The produced fetcher is shaped for a query cache: key required, signal optional.
const out2: Promise<string> = fetcher({ key: ['y'] });
void out2;

// @ts-expect-error -- liteQueryFetcher needs a Pool as the first argument.
liteQueryFetcher({}, (ctx: { endpoint: number; key: any }) => String(ctx.endpoint));

// @ts-expect-error -- perEndpoint must be a function.
liteQueryFetcher(pool, 'nope');
