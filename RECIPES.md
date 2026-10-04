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
the pool's lifetime mean rtt. So a node that got slow gets less traffic even if its
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
  a time) and the pool's lifetime mean sampled rtt once it is busy -- graceful, never NaN,
  never the old 1.0 ns black hole. A node that never records a sample (e.g. one that fails
  fast so the caller records nothing) keeps winning while idle: record failures as a
  penalty too (the manual loop's `PENALTY_NS` branch; Pool's `failurePenaltyNs` does it for
  you).
- `now` must be a FINITE number. A non-finite `now` degrades `pick` to P2C-random (no
  throw); `recordRtt` throws on a non-finite argument.
- Pick `tauNs` around your p50-p90 rtt: smaller = reacts faster to a slowdown, larger =
  steadier. `tauNs` is the EWMA TIME CONSTANT (half-life = `tauNs x ln2`); it IS the
  anti-flap smoothing, no extra dwell needed.
- **KNOWN LIMITATION (1.0.1, buffer-based API planned for 1.1.0).** `pick(now)` /
  `recordRtt(..., now)` take a nanosecond `now` as a plain number argument. When the call
  is not inlined, V8 boxes a non-small-integer number into a ~16 B HeapNumber -- so with a
  realistic nanosecond clock these calls allocate ~16 B/op (transient, dies young; it does
  not RETAIN and does not force a major GC). Small-integer arguments are 0 B/op; the
  small-integer range is build-dependent (below 2^31 on stock 64-bit Node, below 2^30 on
  pointer-compressed builds such as Chrome/Electron). A buffer-based `recordRttFrom`/clock
  API that keeps `now` in a `Float64Array` slot is planned for 1.1.0.
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
- **KNOWN LIMITATION (1.0.1).** `pick(keyHash)` takes the key as a plain number argument.
  A key `>= 2^31` (about half of a 32-bit FNV-1a output) boxes into a ~16 B HeapNumber
  when the call is not inlined (transient, does not retain; keys below the build's
  small-integer range -- 2^31 on stock 64-bit Node, 2^30 on pointer-compressed builds --
  are 0 B/op). A value produced by `%` or division can box even when it is a small
  integer. A buffer-based key API is planned for 1.1.0.

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
  a major GC). Small-integer arguments are 0 B/op; buffer-based variants are planned for
  1.1.0. See section 8/9.
- The only async allocation is the promise your own `fn` already creates (disclosed;
  `Pool.run` adds O(1) integer ops plus one small per-run array).
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
- **Tie order is unspecified** -- LeastConn/SED/NQ break an exact tie deterministically
  but on no promised index (1.0.1; a rotating tie-break is planned for 1.1.0).
- **lite-pick is not a proxy** -- it returns an index; you own transport, retries/backoff
  (temporal), health checking, and the socket.

---

See also: `README.md` (overview + gates), `llms.txt` (full API surface),
`decisions/` (the ADRs behind each design call), `ROADMAP.md` (what's next).
