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

## 3. Wire health -> eligibility (the bitmap)

Eligibility is a `Uint8Array` (1 = pickable, 0 = down). A health checker, a circuit
breaker, or `@zakkster/lite-di-health` decides who is up; the balancer reads that state
through `pick()`. Flip a node **only** through `setEligible`:

```js
lb.setEligible(2, false);        // COLD path; idempotent; keeps `live` exact
lb.setEligible(2, true);         // back up

lb.isEligible(2);                // -> boolean, HOT, out-of-range (or non-integer) is false, never throws
```

- **`setEligible()` is the only supported writer.** It flips the byte AND keeps the
  balancer's cached `live` count (and SmoothWRR's eligible-weight total) exact in
  lockstep. A DIRECT write to the array (`eligible[2] = 0`) desyncs that cache: `pick()`
  then reads a stale `live`, which can fail closed on a pool that is actually up, or
  destroy weight ratios and funnel 100% of traffic to one node. Have your health source
  call `setEligible` rather than write the byte.
- **Each balancer needs its OWN eligibility array.** Do not share one `Uint8Array`
  across two balancers -- each caches its own `live`, so a `setEligible` on one leaves
  the other's count stale. Give each balancer its own array (an `Eligibility` value
  object that multiple balancers can share is deferred to 2.0; ADR 0001, amended 1.0.1).

Health flapping is the writer's problem: apply hysteresis/dwell in the health layer --
`pick()` stays greedy and stateless.

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
// pick() interleaves smoothly (nginx smooth WRR): a a b a c a d a ... not a a a a a b c d
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
elevated and fails over to a genuinely DIFFERENT endpoint: it re-picks while the
strategy repeats an already-tried endpoint (bounded), then scans for an eligible untried
one (spread across keys for a keyed run, cursor-rotated otherwise). It stops -- surfacing
the last error -- as soon as no untried eligible endpoint remains, so a 1-node pool with
`tries: 3` makes exactly **one** attempt (Pool owns spatial failover, never temporal
retry against the same node).

```js
const body = await pool.run(
  (i, signal) => fetchFrom(endpoints[i], { signal }),
  { tries: 3, signal: req.signal }           // up to 3 DISTINCT endpoints
);
```

Boundary: Pool owns **spatial** failover (move across the pool, once each, in-process).
The caller or your query cache owns **temporal** retry (backoff, staleness, dedup).
Don't double-own them. `signal` is checked before EVERY attempt: an already-aborted
signal dispatches nothing and rejects with the signal's `reason` (or a `LITE_PICK_ABORTED`
-coded error); an abort after a failure stops failover and the abort propagates.

---

## 8. Latency-aware routing -- PeakEWMA with rtt feedback

PeakEWMA (latency-aware P2C, Finagle's peak-EWMA) steers away from *slow* endpoints,
not just busy ones. Of two random candidates it takes the cheaper one, where a sampled
node costs `(inflight + 1) x max(decayed ewma(rtt), time busy since its last sample)`, an
unsampled idle node costs 0 (it gets one probe), and an unsampled busy node is priced at
the pool's recent mean rtt (a decaying mean since 1.1.0). So a node that got slow gets less traffic even if its
connection count looks fine. It needs two things you didn't need before: a **clock**
(`now`, caller-supplied nanoseconds) and **rtt feedback** (`recordRtt`).

Manual loop. Record the measured rtt on SUCCESS, a PENALTY on FAILURE, and nothing when
the caller cancelled -- exactly what Pool does for you below:

```js
import { PeakEwmaBalancer, PICK_NONE } from '@zakkster/lite-pick';

const TAU_NS = 30_000_000;                    // 30ms EWMA TIME CONSTANT (half-life = tau x ln2 ~= 21ms)
const PENALTY_NS = 1_000_000_000;             // a failed call is priced at >= 1s (Pool's failurePenaltyNs)
const inflight = new Uint32Array(CAP);
const lb = new PeakEwmaBalancer(CAP, eligible, inflight, TAU_NS);
const nowNs = () => Number(process.hrtime.bigint());

async function handle(req, signal) {
  const start = nowNs();
  const i = lb.pick(start);                    // decay-on-read, 0 B/op
  if (i === PICK_NONE) return respond503();
  inflight[i]++;
  try {
    const res = await send(endpoints[i], req, signal);
    const done = nowNs();
    lb.recordRtt(i, done - start, done);       // SUCCESS: the measured rtt, snaps up / decays down
    return res;
  } catch (err) {
    if (!(signal && signal.aborted)) {         // a caller cancel is not the endpoint's fault
      const done = nowNs();
      const elapsed = done - start;
      // FAILURE: never record a fast failure as a tiny rtt -- that makes the node the cheapest
      // pick (a black hole). Price it at least PENALTY_NS.
      lb.recordRtt(i, elapsed > PENALTY_NS ? elapsed : PENALTY_NS, done);
    }
    throw err;
  } finally {
    inflight[i]--;
  }
}
```

Do NOT put `recordRtt(i, elapsed)` in a `finally`: a node that fails in 1 us would then
record a 1 us rtt and attract about half of all traffic (measured: 49.1% failed requests
with one fast-failing node of four). The doc-test `test/RecipesDoc.test.js`
runs this exact snippet and holds it under 5%.

Or let Pool do the feedback for you. A latency balancer **requires** `opts.clock`
(otherwise `run` rejects with a `LITE_PICK_CLOCK_REQUIRED`-coded error). Pool reads the
clock before each dispatch, drives `pick(now)`, records the settled rtt on success, and
-- new in 1.0.1 -- feeds a PENALTY on a thrown attempt so a fast-failing endpoint stops
looking cheap (since 1.0.2, not when the `signal` is aborted -- a caller cancel is not the
endpoint's fault):

```js
import { Pool } from '@zakkster/lite-pick/pool';
const pool = new Pool(lb, inflight);
const clock = () => Number(process.hrtime.bigint());

const body = await pool.run(
  (i, signal) => fetchFrom(endpoints[i], { signal }),
  {
    clock,                                   // REQUIRED for PeakEWMA; validated finite each read
    tries: 2,
    failurePenaltyNs: 1_000_000_000,         // a throw records max(elapsed, this) as the rtt (default 1s)
  }
);
```

Without the penalty a node that fails instantly would be sampled at ~0 rtt and become
the most attractive pick (a black hole). With it, a failing node is priced expensive and
only RE-PROBED roughly every `tauNs x ln(failurePenaltyNs / healthyRttNs)`, so it
recovers when it heals but never dominates while broken.

**Feedback never loses a result and never re-runs `fn`.** `fn` runs exactly once per
attempt. If settle-time feedback after a SUCCESS fails (a clock that throws or returns
non-finite, or a throwing `recordRtt`), `run` rejects with a `LITE_PICK_FEEDBACK`-coded
error carrying `.cause` (the feedback error) and `.result` (fn's resolved value), so the
caller can still use the result:

```js
try {
  return await pool.run(work, { clock, tries: 2 });
} catch (e) {
  if (e.code === 'LITE_PICK_FEEDBACK') return e.result;   // fn succeeded; only the rtt bookkeeping failed
  throw e;
}
```

(A feedback failure after a FAILED attempt instead re-throws `fn`'s own error unchanged,
with the feedback error attached as a non-enumerable `liteFeedbackError` -- identity is
preserved. A backwards-stepping but finite clock records no sample and resolves normally.)

Notes:
- **Cold start.** An unsampled node costs 0 while idle (so it takes one probe request at
  a time) and the pool's decaying mean sampled rtt once it is busy (every sample weighted
  by `exp(-age/tau)`, so a slow first hour does not price new nodes forever) -- graceful, never NaN,
  never the old 1.0 ns black hole. A node that never records a sample (e.g. one that fails
  fast so the caller records nothing) keeps winning while idle: record failures as a
  penalty too (the manual loop's `PENALTY_NS` branch; Pool's `failurePenaltyNs` does it for
  you).
- **Set a per-attempt timeout.** A request that never returns records no sample, so a
  hung node is priced only by the busy floor (time since its last response). Put a timer
  on each ATTEMPT, inside `fn` (or `send` in the manual loop): the attempt throws, the
  elapsed time goes in as a peak sample, and Pool fails over. Do NOT use the run's own
  `signal` for this -- aborting it is a caller cancel, which records nothing:

  ```js
  const body = await pool.run(
    (i, signal) => fetchFrom(endpoints[i], {
      // Node >= 20.3: the caller's cancel OR this attempt's own 2 s timer
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000),
    }),
    { clock, tries: 2, signal: req.signal },
  );
  ```
- `now` must be a FINITE number. A non-finite `now` degrades `pick` to P2C-random (no
  throw); `recordRtt` throws on a non-finite argument.
- Pick `tauNs` around your p50-p90 rtt: smaller = reacts faster to a slowdown, larger =
  steadier. `tauNs` is the EWMA TIME CONSTANT (half-life = `tauNs x ln2`); it IS the
  anti-flap smoothing, no extra dwell needed.
- **Zero-box clock (1.1.0).** `pick(now)` / `recordRtt(..., now)` take plain numbers; V8
  boxes a nanosecond clock or a fractional rtt into a ~16 B HeapNumber whenever the call
  is not inlined (transient; never retained, never a major GC). For a strictly 0 B/op loop,
  write the numbers into your own `Float64Array` slots and use the `From` siblings -- same
  selection, same errors, 0 B/op even with V8 inlining off:

  ```js
  const t = new Float64Array(1), fb = new Float64Array(2);
  t[0] = nowNs();
  const i = lb.pickFrom(t, 0);                 // == lb.pick(t[0])
  // ... on settle:
  const done = nowNs();
  fb[0] = done - t[0]; fb[1] = done;           // [sampleNs, now] -- recordRtt's argument order
  lb.recordRttFrom(i, fb, 0);                  // == lb.recordRtt(i, fb[0], fb[1])
  ```
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
- **Take a backend out by marking it down** (`lb.setEligible(i, false)`) -- the table is
  untouched, so only that backend's keys reroute (~`1/N`); everyone else stays put. A health
  flap costs nothing (the bounded probe absorbs it) -- it never rebuilds. That is a DRAIN;
  `setWeight(i, 0)` is a REMOVE, and moves other keys too (see "Drain vs remove" below).
- **Add / reweight** rebuilds the table (cold): `new ConsistentHashBalancer(N + 1, ...)`, or
  `lb.setWeight(i, w)` / `lb.rebuild()`, or `lb.setWeights(weights)` to retune every backend with ONE
  rebuild (1.1.0). Pass a `Uint32Array` of weights for proportional shares.
- **Cost:** the table is `M x 4` bytes (~256KB at the `65537` default) -- a cold, one-time
  allocation. Turn `M` down for a small pool (any prime `>= N`).
- `pick(keyHash)` coerces `keyHash >>> 0` and never throws; it returns `PICK_NONE` only when no
  eligible backend owns a table slot (1.1.0: past the 64-slot probe window it sweeps the whole table).
- **Through `/pool`, a keyed balancer REQUIRES `opts.key`** (an integer), or `pool.run`
  rejects with a `LITE_PICK_KEY_REQUIRED`-coded error -- the key never routes silently to
  backend 0. The key drives the keyed `pick(key)` only; it is never passed to a latency
  balancer as `now`:
  ```js
  import { Pool } from '@zakkster/lite-pick/pool';
  const pool = new Pool(lb, new Uint32Array(CAP));   // CH does not read inflight; any view works
  const body = await pool.run(
    (endpoint, signal) => fetchFrom(endpoints[endpoint], { signal }),
    { key: fnv1a(sessionId), tries: 2 }              // same key -> same backend; failover overflows to a neighbour
  );
  ```
- **Zero-box keys (1.1.0).** A key `>= 2^31` (about half of a 32-bit FNV-1a output) boxes
  into a ~16 B HeapNumber when `pick(keyHash)` is not inlined (transient, does not retain).
  Keep the key in a `Uint32Array` slot and call `pickFrom` -- the same backend, 0 B/op even
  with V8 inlining off (BoundedLoad inherits it):

  ```js
  const keys = new Uint32Array(1);
  keys[0] = fnv1a(sessionId);
  const i = ch.pickFrom(keys, 0);              // == ch.pick(keys[0])
  ```

### Drain vs remove -- two ways to take a backend out

Linux IPVS's `mh` scheduler names the two. A DRAIN keeps the backend's table slots and sends its
keys elsewhere; a REMOVE rebuilds the table without it. In lite-pick:

|        | call                   | table                     | other backends' keys | undo |
|--------|------------------------|---------------------------|----------------------|------|
| drain  | `lb.setEligible(i, false)` | unchanged, no rebuild | **0** move           | `setEligible(i, true)` -- every key comes back |
| remove | `lb.setWeight(i, 0)`   | rebuilt (cold, ~1.2 ms at the default M) | **~0.5%** move at M = 65537, ~2.5% at M = 4099 | `setWeight(i, w)` -- the same table, every key comes back |

Measured on the 1.1.0 kernel: 64 backends, 200,000 keys, each backend drained and removed in turn
(medians; the remove share ranged 0.40-0.59% at M = 65537). A drained backend's own keys spread over
all 63 others (the largest share 2.9%). BoundedLoad inherits both; its drain also moved 0 other keys.

- **Drain for anything temporary** -- a health flap, a deploy, a breaker trip. This is what
  lite-di-health and a breaker do through `setEligible` (recipe 3).
- **Remove when the backend is gone for good, or when many are down at once.** A drained backend
  keeps its slots, so each of its keys probes past them; when the 64 slots after a key's home are all
  down, the pick sweeps the table (cold, O(M), counted in `STAT_FALLBACK_SCANS`, recipe 16).
  `setWeights(weights)` removes several with one rebuild.
- **Weight 0 means the opposite of IPVS.** In IPVS, weight 0 drains (the table keeps the last non-zero
  weight). Here weight 0 removes: the backend gets no slots. Keep the old weight if you will restore it.

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
| WeightedRandom| static weight (O(1))| O(1)        | weighted at very large pools where SmoothWRR's O(cap) scan hurts; accepts sampling variance |
| ConsistentHash| key hash (sticky)   | O(1)        | affinity/sticky: same key -> same backend, minimal disruption on scale |
| BoundedLoad   | key hash + occupancy cap | O(1)   | sticky routing AND a few hot keys would otherwise overload one backend |

The load-aware strategies read the SAME `inflight` array live, so you can swap among them
without rewiring; ConsistentHash and BoundedLoad instead take an integer key per pick
(recipe 9). See [GUIDE.md](./GUIDE.md) for the full decision tree.

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

- `@zakkster/lite-di-health` -- drives `setEligible` from health checks (the supported
  writer; a direct byte write desyncs the cached `live`, recipe 3).
- `@zakkster/lite-statechart` -- a circuit breaker that flips eligibility via `setEligible`.
- `@zakkster/lite-query` -- the cache behind `liteQueryFetcher` (recipe 10).
- `@zakkster/lite-sketch` -- `DDSketch` for a p99-aware PeakEWMA variant (deferred).
- `@zakkster/lite-filter` -- a hot-key / known-key oracle at the ConsistentHash key-routing
  layer (warm/cold only, never the pick path; deferred).
- `@zakkster/lite-await` -- hedging (race the P2C second choice past a percentile).
- `@zakkster/lite-logn` -- `Fenwick` for weights that change all the time (recipe 17); an
  exact-O(log n) least-conn over its `BinaryHeap` is a deferred seam (decisions/0006).

None is required; the kernel runs over raw TypedArrays with nothing installed.

---

## 14. Zero-GC discipline (why the pick path stays 0 B/op)

- Allocate `eligible` / `inflight` / `weights` ONCE at startup and reuse them. Never
  build arrays per pick.
- The counters are YOURS -- mutate them in place (`inflight[i]++/--`), don't replace them.
- `pick()` allocates 0 B/op (proven by PerfGate scavenge counting) and retains 0 B/op
  (proven by torture). CAVEAT: `pick(now)` / `recordRtt(..., now)` and
  `pick(keyHash)` take a number argument; V8 boxes a non-small-integer value into a
  ~16 B transient HeapNumber when the call is not inlined -- so a realistic nanosecond
  clock or a key `>= 2^31` allocates ~16 B/op (transient, does not retain, does not force
  a major GC). The 1.1.0 `pickFrom` / `recordRttFrom` siblings read those numbers from your
  typed-array slots and are 0 B/op even when V8 does not inline them. See section 8/9.
- `Pool.run` is a normal async function. A run that settles on **attempt 0** (any `tries`) costs
  ~900 B/run (Node 22 v22.23.3, Pool's own share above the bare-await driver floor, by scavenge
  count; `npm run bench:pool`), gated <= 912 B/run; each extra failover attempt adds ~375 B/run
  (gated too); a latency-aware balancer (PeakEWMA) driven by an epoch-ns `clock` adds ~32 B/run more
  per attempt (Node 22; the clock boxes) and is gated on its own row. Abort-before-dispatch is **not**
  cheaper than a successful run (ungated, above L3). Your `fn`'s closure, promise and I/O come on top --
  a submit-shaped `fn` adds ~310 B/run (ladder L10-L3); the capstone's full request wiring measured
  ~2.9 KB/request end to end on 1.1.0, before this change. For 0 B/request, use the hand-wired
  `pickFrom` + settle recipe (sections 8/9) instead of the Pool wrapper.
- Fixed capacity: the pool size is set at construction and the backing arrays never
  reallocate.

---

## 15. Gotchas

- **PICK_NONE (-1)** is always possible -- handle it before indexing (recipe 2).
- **SmoothWRR weights** must go through `setWeight`; direct array mutation is UB.
- **BoundedLoad occupancy** -- update `inflight[i]` AND call `note(i, +/-1)` in LOCKSTEP
  (or drive it through `/pool`, which does both). `note` maintains the balancer's `_total`;
  it does NOT write `inflight`. A direct `inflight` write without the matching `note`
  desyncs `_total` and the cap goes wrong (UB).
- **ConsistentHash / BoundedLoad take an INTEGER key** -- hash strings yourself, cold
  (recipe 9). Never `pick(someString)` on the hot path; `M` must be a prime `>= capacity`.
  Through `/pool` a keyed balancer requires `opts.key` (`LITE_PICK_KEY_REQUIRED` otherwise).
- **Load-aware strategies need the dispatch/settle loop** -- forget the `inflight--` in
  a `finally` and load leaks upward forever. Use `/pool` (recipe 6) to avoid it.
- **PeakEWMA needs a finite `now`** and rtt feedback -- without `recordRtt` it behaves
  like LeastConn (cold-start baseline). Through `/pool` it requires `opts.clock`
  (`LITE_PICK_CLOCK_REQUIRED` otherwise); pass `failurePenaltyNs` so failures are priced.
- **Eligibility flips go through `setEligible`** -- it is the only supported writer and
  keeps `live` exact; a direct byte write desyncs the cached count (recipe 3). Each
  balancer needs its own eligibility array.
- **Ties rotate, but WHICH tied node wins is not a contract** -- since 1.1.0 LeastConn/SED/NQ hand
  exact ties to the first tied node after a moving cursor, so tied nodes take turns (1.0.x: always the
  lowest index). Do not depend on a particular index.
- **lite-pick is not a proxy** -- it returns an index; you own transport, retries/backoff
  (temporal), health checking, and the socket.

---

## 16. See what the balancer is doing -- stats, describe(), codes, events, assertConsistent (1.1.0)

Counters you export, a snapshot for an admin endpoint, a consistency check for your tests:

```js
import { ConsistentHashBalancer, STAT_COUNT, STAT_DISPLACED, STAT_FALLBACK_SCANS, STAT_REBUILDS }
  from '@zakkster/lite-pick';

const stats = new Float64Array(STAT_COUNT);   // ONE slab for every balancer is fine: counts add up
lb.attachStats(stats);

let last = new Float64Array(STAT_COUNT);
setInterval(() => {                            // your metrics tick -- the library never resets the slab
  metrics.gauge('lb.displaced', stats[STAT_DISPLACED] - last[STAT_DISPLACED]);   // affinity loss
  metrics.gauge('lb.fallback', stats[STAT_FALLBACK_SCANS] - last[STAT_FALLBACK_SCANS]);
  metrics.gauge('lb.rebuilds', stats[STAT_REBUILDS] - last[STAT_REBUILDS]);
  last.set(stats);
}, 10_000);

app.get('/admin/lb', (req, res) => res.json(lb.describe()));   // JSON-safe snapshot
```

- `STAT_DISPLACED` rising means keys are leaving their home backend (ConsistentHash: the home is
  down; BoundedLoad: also over cap). `STAT_FALLBACK_SCANS` rising means the pool is mostly down
  (each one is an O(cap) or O(M) scan). Picks and `PICK_NONE` are not counted -- you see those.
- Match errors on `e.code` (`LITE_PICK_INDEX`, `LITE_PICK_ARRAY`, ...), never on the message.
- Trace each request through `/pool` with `node:diagnostics_channel` (Node >= 20.16 / 22.3):

  ```js
  import dc from 'node:diagnostics_channel';
  import { POOL_CHANNEL_DISPATCH, POOL_CHANNEL_SETTLE } from '@zakkster/lite-pick/pool';

  dc.subscribe(POOL_CHANNEL_DISPATCH, (m) => {          // { pool, endpoint, attempt, key, now }
    if (m.attempt > 0) metrics.count('lb.failover');
  });
  dc.subscribe(POOL_CHANNEL_SETTLE, (m) => {            // { pool, endpoint, attempt, ok, error, aborted }
    if (!m.ok && !m.aborted) metrics.count('lb.error.' + m.endpoint);
  });
  ```

  The message object is REUSED: read or copy its fields inside the handler, never keep `m`.
- In tests, call `lb.assertConsistent()` after driving the balancer: it throws
  `LITE_PICK_INCONSISTENT` when someone wrote `eligible[i]` or `weights[i]` directly, or changed
  BoundedLoad's `inflight` without `note()`. It is O(cap) -- not for the request path.

---

## 17. Weights that change all the time -- a lite-logn `Fenwick`

`WeightedRandomBalancer` samples in O(1) from an alias table, but every `setWeight` rebuilds that
table in O(cap). When weights change per request -- load reports, a cost you recompute
continuously -- use a `Fenwick` tree from `@zakkster/lite-logn` (>= 1.4.0) instead: O(log n) to
change a weight, O(log n) to sample. lite-pick does not import it (`peerDependencies` stays `{}`);
this is the wiring (run verbatim by `test/LognSeam.test.js` and the perf gate, against lite-logn as a
devDependency):

```js
import { Fenwick } from '@zakkster/lite-logn';
import { Prng, PICK_NONE } from '@zakkster/lite-pick';

const U = 1073741824;                         // 2^30: nextBelow(U) is a small integer on every engine
const weights = new Uint32Array(CAP);         // integer weights keep every sum exact
const eligible = new Uint8Array(CAP);
const tree = new Fenwick(CAP);                // holds weights[i] while i is up, 0 while it is down
const target = new Float64Array(1);           // searchFrom reads the target from this slot
const rng = new Prng(0x9e3779b9);

function setWeight(i, w) { weights[i] = w; tree.set(i, eligible[i] ? w : 0); }      // O(log n)
function setUp(i, up) { eligible[i] = up ? 1 : 0; tree.set(i, up ? weights[i] : 0); }

function pick() {
  const total = tree.prefix(CAP - 1);
  if (!(total > 0)) return PICK_NONE;         // nothing up, or every weight 0: fail closed
  target[0] = (rng.nextBelow(U) + 1) * (total / U);    // uniform in (0, total]
  return tree.searchFrom(target, 0);          // the smallest i with prefix(i) >= target
}
```

- **Exact with integer weights.** `search` is an exact lower bound over the tree's own prefix sums,
  so a node with weight 0 (or marked down) is never returned. Measured: 5,000,000 picks over 1000
  nodes with a tenth at weight 0 and every 13th down -- never a zero-weight or down node, and the
  counts match the weights (chi-square z = 1.04). Through 100,000 reweights, one pick after each, the
  same: never a zero-weight or down node.
- **Call `searchFrom`, not `search`.** The target is a fraction; passed as an argument it boxes when
  the call is not inlined. Measured with V8 inlining off: `search(u)` 16 B/op, `searchFrom` 0 B/op
  (Node 22 and 26; recipe 14 explains the rule).
- **Cost at 1000 endpoints:** a pick ~57 ns (Node 22) / ~98 ns (Node 26) -- two O(log n) walks; a
  weight change ~12-22 ns. WeightedRandom picks in ~16 ns but rebuilds in ~10-17 us. So the tree wins
  when weights change more often than about once per 200 picks; the crossover moves with pool size,
  because the rebuild is O(cap).

---

See also: `README.md` (overview + gates), `llms.txt` (full API surface),
`decisions/` (the ADRs behind each design call), `ROADMAP.md` (what's next).
