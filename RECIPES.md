# lite-pick recipes -- from a one-liner to a real load balancer

`@zakkster/lite-pick` is a SELECTION KERNEL, not a proxy. It answers one question --
"which endpoint should this request go to?" -- and returns an integer index (or
`PICK_NONE` = -1 when nothing is eligible). A *real* load balancer is that kernel plus
the wiring around it:

- **eligibility** -- who is up? (a health check writes a shared bitmap)
- **load counters** -- how busy is each endpoint? (you own an `inflight` array)
- **the dispatch/settle loop** -- increment on send, decrement on finish
- **failover** -- if a call fails, try a different endpoint
- **latency feedback** -- for latency-aware routing, feed measured rtt back

These recipes build that wiring up, one layer at a time. Every array is preallocated
once and reused -- the pick path allocates 0 bytes.

Install: `npm i @zakkster/lite-pick`  (zero runtime dependencies; ESM; Node >= 18)

---

## 1. The 30-second version -- round-robin over a fixed pool

```js
import { RoundRobinBalancer, PICK_NONE } from '@zakkster/lite-pick';

const CAP = 4;                              // fixed pool size
const eligible = new Uint8Array(CAP).fill(1); // 1 = up, 0 = down (all up here)
const lb = new RoundRobinBalancer(CAP, eligible);

const endpoints = ['a.svc:8080', 'b.svc:8080', 'c.svc:8080', 'd.svc:8080'];

for (let r = 0; r < 6; r++) {
  const i = lb.pick();                      // -> next eligible index, round-robin
  if (i === PICK_NONE) throw new Error('pool is down');
  send(endpoints[i]);                        // your transport; lite-pick never opens a socket
}
// picks: a, b, c, d, a, b
```

`pick()` is the whole kernel. Everything below adds a capability around it.

---

## 2. Fail closed -- always handle PICK_NONE

lite-pick never returns a down endpoint and never guesses. When the whole pool is
ineligible, `pick()` returns `PICK_NONE` (-1). Treat it as a first-class outcome:

```js
const i = lb.pick();
if (i === PICK_NONE) {
  // shed load, return 503, or fall back -- your policy. Never index endpoints[-1].
  return respond503();
}
send(endpoints[i]);
```

`lb.live` is an O(1) count of eligible endpoints if you want to check before picking.

---

## 3. Wire health -> eligibility (the shared bitmap)

Eligibility is a shared `Uint8Array` (1 = pickable, 0 = down). Something else writes it
-- a health checker, a circuit breaker, or `@zakkster/lite-di-health` -- and `pick()`
only reads it. Two ways to flip a node:

```js
// (a) write the bitmap directly if you own it elsewhere (zero-copy, pick sees it live):
eligible[2] = 0;                 // endpoint c is down

// (b) go through the balancer so its O(1) `live` count stays exact (recommended):
lb.setEligible(2, false);        // COLD path; idempotent; keeps `live` correct
lb.setEligible(2, true);         // back up

lb.isEligible(2);                // -> boolean, HOT, out-of-range is false (never throws)
```

Prefer `setEligible` when you rely on `live`. Health flapping is the writer's problem:
apply hysteresis/dwell in the health layer -- `pick()` stays greedy and stateless.

---

## 4. Weighted pools -- SmoothWRR

When endpoints have different capacities, weight them. `SmoothWRRBalancer` owns its
weight state; it is the SOLE writer -- always go through `setWeight`, never mutate the
array directly (direct mutation desyncs the internal total = undefined behavior).

```js
import { SmoothWRRBalancer } from '@zakkster/lite-pick';

const weights = new Uint32Array(CAP);        // the balancer manages these
const lb = new SmoothWRRBalancer(CAP, eligible, weights);
lb.setWeight(0, 5);                          // a is 5x
lb.setWeight(1, 1);
lb.setWeight(2, 1);
lb.setWeight(3, 1);
// pick() interleaves smoothly (nginx smooth WRR): a a b a c a a d ... not a a a a a b c d
```

Use SmoothWRR when weights are known/config-driven and change rarely.

---

## 5. Load-aware selection -- you own the `inflight` counters

P2C, LeastConn, SED, and NQ route by *current load*. That load lives in a
caller-owned `Uint32Array` you increment on dispatch and decrement on settle. If you
don't maintain it, these strategies are blind (they see every node at 0).

```js
import { P2cBalancer } from '@zakkster/lite-pick';

const inflight = new Uint32Array(CAP);       // YOURS to maintain
const lb = new P2cBalancer(CAP, eligible, inflight);

async function handle(req) {
  const i = lb.pick();
  if (i === PICK_NONE) return respond503();
  inflight[i]++;                             // DISPATCH
  try {
    return await send(endpoints[i], req);
  } finally {
    inflight[i]--;                           // SETTLE (always, even on error)
  }
}
```

- **P2C** -- two random draws, pick the lighter. O(1), the scalable default; peak load
  hugs the `ln ln n` band. Great from ~8 endpoints up.
- **LeastConn** -- exact fewest-in-flight (O(cap) scan). Best balance for small pools.
- **SED** / **NQ** -- weighted least-conn: pass a `weights` Uint32Array too;
  `new SedBalancer(CAP, eligible, inflight, weights)`. NQ sends to an idle node first.

Maintaining the dispatch/settle loop by hand is easy to get wrong. Recipe 6 does it for
you.

---

## 6. The real request loop -- `@zakkster/lite-pick/pool`

The `/pool` subpath wraps the kernel with the async dispatch/settle ergonomics so you
don't hand-maintain `inflight`. The kernel `pick()` stays 0 B/op; `Pool.run` is a normal
async wrapper on top.

```js
import { P2cBalancer } from '@zakkster/lite-pick';
import { Pool } from '@zakkster/lite-pick/pool';

const inflight = new Uint32Array(CAP);
const lb = new P2cBalancer(CAP, eligible, inflight);
const pool = new Pool(lb, inflight);         // SAME inflight array the balancer reads

// Pool does pick -> inflight++ -> await fn -> inflight-- (in a finally) for you:
const body = await pool.run((i, signal) => fetchFrom(endpoints[i], { signal }));
```

`run(fn, opts?)` rejects with a `code: 'LITE_PICK_NONE'` error when the pool is down.
`fn(endpoint, signal)` receives the chosen index and the (optional) AbortSignal.

---

## 7. Failover -- try a different endpoint on error

Set `tries > 1`. On a thrown error, Pool keeps the failed node's in-flight count
elevated and re-picks -- so a load-aware strategy naturally steers to a DIFFERENT
endpoint -- up to `tries` attempts, then rejects with the last error.

```js
const body = await pool.run(
  (i, signal) => fetchFrom(endpoints[i], { signal }),
  { tries: 3, signal: req.signal }           // up to 3 distinct endpoints
);
```

Boundary: Pool owns **spatial** failover (move across the pool, once each, in-process).
The caller or your query cache owns **temporal** retry (backoff, staleness, dedup).
Don't double-own them. If `signal` aborts after a failure, failover stops and the abort
propagates.

---

## 8. Latency-aware routing -- PeakEWMA with rtt feedback

PeakEWMA (latency-aware P2C, Finagle's peak-EWMA) steers away from *slow* endpoints,
not just busy ones. It scores each candidate `(inflight + 1) x ewma(rtt)`, so a node
that got slow gets less traffic even if its connection count looks fine. It needs two
things you didn't need before: a **clock** (`now`, caller-supplied nanoseconds) and
**rtt feedback** (`recordRtt`).

Manual loop:

```js
import { PeakEwmaBalancer } from '@zakkster/lite-pick';

const TAU_NS = 30_000_000;                    // 30ms half-life for the EWMA decay
const inflight = new Uint32Array(CAP);
const lb = new PeakEwmaBalancer(CAP, eligible, inflight, TAU_NS);
const nowNs = () => Number(process.hrtime.bigint());

async function handle(req) {
  const now = nowNs();
  const i = lb.pick(now);                      // decay-on-read, 0 B/op
  if (i === PICK_NONE) return respond503();
  inflight[i]++;
  const start = nowNs();
  try {
    return await send(endpoints[i], req);
  } finally {
    inflight[i]--;
    lb.recordRtt(i, nowNs() - start, nowNs()); // FEEDBACK: measured rtt, snaps up / decays down
  }
}
```

Or let Pool do the feedback for you -- pass a `clock`; Pool drives `pick(now)` and calls
`recordRtt` on a successful settle when the balancer supports it:

```js
import { Pool } from '@zakkster/lite-pick/pool';
const pool = new Pool(lb, inflight);
const body = await pool.run(
  (i, signal) => fetchFrom(endpoints[i], { signal }),
  { clock: () => Number(process.hrtime.bigint()), tries: 2 }
);
```

Notes:
- **Cold start** (no samples yet) degrades gracefully to least-connections -- never NaN.
- `now` must be a FINITE number. A non-finite `now` degrades to P2C-random (no throw).
- Pick `tauNs` around your p50-p90 rtt: smaller = reacts faster to a slowdown, larger =
  steadier. It IS the anti-flap smoothing; no extra dwell needed.
- Measured effect: with one node at 10x latency, PeakEWMA sends it a tiny fraction of
  the traffic P2C-over-inflight would, and cuts service p99 sharply.

---

## 9. Sticky / affinity routing -- ConsistentHash (you hash the key)

When a request must land on the **same** backend every time -- a session pinned to a shard,
a cache key kept warm, a stateful worker -- use `ConsistentHashBalancer`. It is a prebuilt
**Maglev table**, so `pick(keyHash)` is `O(1)` and `0 B/op`, and scaling the pool moves only
~`1/N` of keys (not the whole keyspace, the way `key % n` would).

The one rule: **you hash the key to an INTEGER**, on the cold path. Per-pick *string* hashing
allocates -- the single zero-GC hazard -- so `pick()` takes a number and `lite-pick` ships no
hashing dependency. Any small integer hash works; FNV-1a is a fine default:

```js
import { ConsistentHashBalancer, PICK_NONE } from '@zakkster/lite-pick';

// A tiny FNV-1a over a string -- done ONCE per key, never inside pick().
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const eligible = new Uint8Array(CAP).fill(1);
const lb = new ConsistentHashBalancer(CAP, eligible);   // default M = 65537 (prime)

function routeFor(sessionId) {
  const i = lb.pick(fnv1a(sessionId));   // same session -> same backend, at fixed membership
  if (i === PICK_NONE) return respond503();
  return endpoints[i];
}
```

Notes:
- **Remove a backend by marking it down** (`lb.setEligible(i, false)`) -- the table is
  untouched, so only that backend's keys reroute (~`1/N`); everyone else stays put. A health
  flap costs nothing (the bounded probe absorbs it) -- it never rebuilds.
- **Add / reweight** rebuilds the table (cold): `new ConsistentHashBalancer(N + 1, ...)`, or
  `lb.setWeight(i, w)` / `lb.rebuild()`. Pass a `Uint32Array` of weights for proportional shares.
- **Cost:** the table is `M x 4` bytes (~256KB at the `65537` default) -- a cold, one-time
  allocation. Turn `M` down for a small pool (any prime `>= N`).
- `pick(keyHash)` coerces `keyHash >>> 0` and never throws; it returns `PICK_NONE` only when the
  pool is down or no eligible backend is reachable within the probe bound.

---

## 10. Wire it into a query cache (lite-query, or any fetcher)

`liteQueryFetcher` adapts a Pool into a `({ key, signal }) => Promise` fetcher -- the
shape lite-query (or any cache/route-loader) expects. It imports nothing from lite-query
(duck-typed), so it works with any fetcher-shaped consumer.

```js
import { Pool, liteQueryFetcher } from '@zakkster/lite-pick/pool';

const pool = new Pool(lb, inflight);
const fetcher = liteQueryFetcher(
  pool,
  ({ endpoint, key, signal }) => fetchFrom(endpoints[endpoint], { key, signal }),
  { tries: 2 }
);
// hand `fetcher` to your query cache; each cache miss fans out across the pool with failover.
```

---

## 11. Choosing a strategy

| Strategy      | Route by            | Cost        | Reach for it when |
|---------------|---------------------|-------------|-------------------|
| RoundRobin    | position            | O(1) amort. | uniform endpoints, no load signal |
| SmoothWRR     | static weight       | O(cap)      | known/config capacities, smooth interleave |
| P2C           | in-flight (approx)  | O(1)        | the scalable default from ~8 nodes up |
| LeastConn     | in-flight (exact)   | O(cap)      | small pools, tightest connection balance |
| SED           | in-flight / weight  | O(cap)      | weighted least-conn |
| NQ            | idle-first else SED  | O(cap)/O(1) | worker pools -- never queue while a worker is free |
| PeakEWMA      | in-flight x ewma(rtt)| O(1)        | heterogeneous / flaky backends; steer around slow nodes |
| ConsistentHash| key hash (sticky)   | O(1)        | affinity/sticky: same key -> same backend, minimal disruption on scale |

The load-aware strategies read the SAME `inflight` array live, so you can swap among them
without rewiring; ConsistentHash instead takes an integer key per pick (recipe 9).

---

## 12. The "FE profile" -- a browser / front-end client

For a front-end client picking among origins a handful of times per second (not a
zero-GC hot loop), the recommended profile is **PeakEWMA + health/eligibility only** --
latency-aware choice across origins with a fail-closed eligibility view -- and skip the
bounded-load / AZ / occupancy machinery. Feed rtt from your `fetch` timings via
`recordRtt`.

---

## 13. Compose with the suite (all optional, all duck-typed)

lite-pick declares ZERO hard dependencies and an EMPTY `peerDependencies`. Each seam is
a shared TypedArray or a duck-typed shape, so you wire in a sibling only if you use it:

- `@zakkster/lite-di-health` -- writes the eligibility bitmap from health checks.
- `@zakkster/lite-statechart` -- a circuit breaker that flips eligibility.
- `@zakkster/lite-query` -- the cache behind `liteQueryFetcher` (recipe 10).
- `@zakkster/lite-sketch` -- `DDSketch` for a p99-aware PeakEWMA variant (deferred).
- `@zakkster/lite-filter` -- a hot-key / known-key oracle at the ConsistentHash key-routing
  layer (warm/cold only, never the pick path; deferred).
- `@zakkster/lite-await` -- hedging (race the P2C second choice past a percentile).

None is required; the kernel runs over raw TypedArrays with nothing installed.

---

## 14. Zero-GC discipline (why the pick path stays 0 B/op)

- Allocate `eligible` / `inflight` / `weights` ONCE at startup and reuse them. Never
  build arrays per pick.
- The counters are YOURS -- mutate them in place (`inflight[i]++/--`), don't replace them.
- `pick()` / `pick(now)` and `recordRtt` allocate nothing. The only async allocation is
  the promise your own `fn` already creates (disclosed; `Pool.run` adds O(1) integer ops
  plus one small per-run array).
- Fixed capacity: the pool size is set at construction and the backing arrays never
  reallocate.

---

## 15. Gotchas

- **PICK_NONE (-1)** is always possible -- handle it before indexing (recipe 2).
- **SmoothWRR weights** must go through `setWeight`; direct array mutation is UB.
- **ConsistentHash takes an INTEGER key** -- hash strings yourself, cold (recipe 9). Never
  `pick(someString)` on the hot path; `M` must be a prime `>= capacity`.
- **Load-aware strategies need the dispatch/settle loop** -- forget the `inflight--` in
  a `finally` and load leaks upward forever. Use `/pool` (recipe 6) to avoid it.
- **PeakEWMA needs a finite `now`** and rtt feedback -- without `recordRtt` it behaves
  like LeastConn (cold-start baseline).
- **Eligibility is read-only to `pick()`** -- the health layer writes it; the balancer
  only reads (or maintains `live` via `setEligible`).
- **lite-pick is not a proxy** -- it returns an index; you own transport, retries/backoff
  (temporal), health checking, and the socket.

---

See also: `README.md` (overview + gates), `llms.txt` (full API surface),
`decisions/` (the ADRs behind each design call), `ROADMAP.md` (what's next).
