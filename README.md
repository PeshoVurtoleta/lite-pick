# @zakkster/lite-pick

> Zero-GC load-balancing **selection kernel**: one hot `pick()` that returns an endpoint **index** over a fixed pool and allocates **0 B/op** on the steady-state path. A pure selector, never a proxy -- it consumes health and circuit state, it never owns them. **v0.5.0 ships six strategies -- `RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, and the exact `LeastConnBalancer` / `SedBalancer` / `NqBalancer` family** -- on the substrate seams (`VERSION`, `PICK_NONE`, a deterministic `Prng`, and `BalancerBase`'s shared read-only eligibility view), plus a **`@zakkster/lite-pick/pool`** subpath: the async dispatch/settle counter layer with distinct-endpoint failover and a duck-typed query-cache fetcher. The rest of the roster -- PeakEWMA, ConsistentHash, BoundedLoad, WeightedRandom -- lands one per session.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-pick.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-pick)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-pick?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-pick)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-pick?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-pick)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-pick?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-pick)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The load balancer the ecosystem was missing

The npm landscape has old algorithm libraries (`load-balancers`, `loadbalance`, `wrr`) and heavy full proxies -- but **no package that ships a provably zero-GC `pick()` path with a measured balance-quality anchor.** Most algorithm libraries use ordinary objects and arrays and quietly allocate under sustained high call rates (millions of picks/sec in worker fan-out, high-QPS internal services, client-side routing). `lite-pick` fills that gap: a small, dependency-free, ESM-first selection **kernel** you drop into an HTTP client, a worker pool, or a custom proxy -- and it proves its two claims instead of asserting them.

- **The `pick()` is the product.** One hot-path primitive: given a pool of endpoints, return the index of the one to use. Every strategy (round-robin, weighted, power-of-two-choices, least-connections, latency-aware, consistent-hash, bounded-load) is a different `pick()` over the same substrate.
- **Two pieces of evidence, both shipped.** A **0 B/op** witness on the pick path (no object, closure, string, or array created per pick), and a measured **balance-quality anchor** -- peak-to-average load within the strategy's theoretical ceiling (for P2C, the Azar-Broder-Karlin-Upfal `ln ln n / ln 2` bound) and strictly better than a random foil.
- **A pure selector, not a proxy.** It **consumes** health and circuit state; it never owns them. Health is a shared read-only bitmap written by [`@zakkster/lite-di-health`](https://www.npmjs.com/package/@zakkster/lite-di-health); circuit state comes from [`@zakkster/lite-statechart`](https://www.npmjs.com/package/@zakkster/lite-statechart); load counters are caller-owned typed arrays. `pick()` only reads.

> **Status: M6 (v0.6.0).** Ships the substrate seams **plus `RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, and the exact `LeastConnBalancer` / `SedBalancer` / `NqBalancer` family**, the **`@zakkster/lite-pick/pool`** request layer, and now the **benchmark suite** -- the balance anchor + GC blast-radius headlines, a seeded/version-stamped `results.json`, a `bench:verify` drift check with teeth, and the vs-AWS positioning (see *Evidence* below). The kernel `Pick.js` / `Pool.js` are byte-identical to v0.5.0 apart from the version stamp. Every strategy is gated: `pick()` proven **0 B/op** (torture + PerfGate), RoundRobin **perfectly fair** with **zero dead picks** vs the naive `i++ % n` foil, SmoothWRR **exactly weighted** and **smooth**, **P2C proves the `ln ln n` balance ceiling** (peak-to-mean gap ~2 vs a random foil's ~21 at n=1024), **LeastConn is greedy-perfect** (max-minus-min load <= 1), and **SED tracks weight within 1%** -- all held under a **seeded invariant fuzzer** (`test/fuzz.mjs`) that checks state-synchronisation after *every* op. See [ROADMAP.md](./ROADMAP.md) for the M6 -> M10 path to 1.0.0, and [decisions/](./decisions) for the ownership boundary (ADR 0001), anti-flapping (ADR 0002), the RoundRobin (0003), SmoothWRR (0004), P2C (0005), LeastConn-family (0006), pool-adapter (0007), and benchmark-suite (0008) design forks.

```bash
npm install @zakkster/lite-pick
```

## RoundRobin (v0.1.0)

```js
import { RoundRobinBalancer, PICK_NONE } from '@zakkster/lite-pick';

// A pool of 4 endpoints. The eligibility view is SHARED and read-only to pick():
// lite-di-health probes / circuit breakers write it; the balancer only reads it.
const eligible = Uint8Array.from([1, 1, 0, 1]); // endpoint 2 is down

const rr = new RoundRobinBalancer(4, eligible);

rr.pick();            // -> 0
rr.pick();            // -> 1
rr.pick();            // -> 3   (skips the down endpoint 2, never returns it)
rr.pick();            // -> 0   (wraps)

// A health source marks endpoint 2 back up (cold path; live count stays exact).
rr.setEligible(2, true);
rr.pick();            // -> 1, then 2, then 3, ... now that 2 is eligible

// Whole pool down -> fail closed, never a dead pick.
for (let i = 0; i < 4; i++) rr.setEligible(i, false);
rr.pick() === PICK_NONE; // -> true  (-1)
```

Every `pick()` above allocates **0 bytes**, owns only an integer cursor, and reads the one shared eligibility view (no second copy to drift). Over a run it hands each *live* endpoint an equal share -- true round-robin over the eligible set, not the raw index space.

## SmoothWRR (v0.2.0)

The weighted default -- nginx's *smooth* weighted round-robin. Weighted picks are **interleaved evenly** instead of clumped, so a heavy endpoint doesn't get a burst of consecutive requests.

```js
import { SmoothWRRBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1]);
const weights  = Uint32Array.from([5, 1, 1]); // A is 5x

const wrr = new SmoothWRRBalancer(3, eligible, weights);

const seq = Array.from({ length: 7 }, () => wrr.pick());
// -> [0, 0, 1, 0, 2, 0, 0]   smooth: A A B A C A A  (not A A A A A B C)
// over 7 picks: A=5, B=1, C=1 -- exactly the weights

// Reweight on the cold path (the balancer stays the sole writer of the weights):
wrr.setWeight(1, 4);  // B is now 4x
```

`pick()` is **0 B/op** and **O(cap)** (one scan of the pool -- negligible at real endpoint counts). It owns its smoothing accumulators; weights live in your `Uint32Array` but you mutate them only through `setWeight`, which keeps the internal eligible-weight total exact. Marking a node down/up resets its accumulator, so a recovered node rejoins neutral -- no stale burst or starvation ([ADR 0004](./decisions/0004-smoothwrr-weight-ownership.md)).

## P2C -- power-of-two-choices (v0.3.0, the headline)

Two random eligible draws, take the one with lower in-flight load. That single extra probe buys an **exponential** drop in peak load -- the max stays within an *additive* `ln ln n / ln 2` of the mean, versus random's `ln n / ln ln n` gap.

```js
import { P2cBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const inflight = new Uint32Array(4);           // YOU own this; pick() only reads it

const p2c = new P2cBalancer(4, eligible, inflight);

const i = p2c.pick();                           // the lower-loaded of two random eligibles
inflight[i]++;                                  // you increment on dispatch...
// ...and inflight[i]-- when the request settles (the M5 lite-query adapter will do this)
```

The proof (from `test/balance.mjs`, the library's analytical anchor):

| pool `n` | P2C peak/avg | random foil peak/avg |
|---|---|---|
| 1024 | **1.06** (gap 2) | 1.66 (gap 21) |
| 4096 | **1.06** (gap 2) | 1.78 (gap 25) |

P2C's gap stays a small `ln ln n` constant while the random foil's grows with the pool. `pick()` is **0 B/op** and **O(1)** (two expected-O(1) rejection draws + a compare); in-flight counts are your caller-owned `Uint32Array` ([ADR 0005](./decisions/0005-p2c-draw.md)).

## LeastConn / SED / NQ -- the exact load-aware family (v0.4.0)

P2C above is the **O(1) approximation** of least-connections. When you want the **exact** least-loaded endpoint -- and the weighted (SED) and worker-pool (NQ) variants -- M4 ships the IPVS `lc` / `sed` / `nq` cohort, made zero-GC. All three read your caller-owned `inflight` (and, for SED/NQ, `weights`) **live** -- no `setWeight`, no derived total, so you mutate the counters directly in your feedback loop ([ADR 0006](./decisions/0006-leastconn-family.md)).

```js
import { LeastConnBalancer, SedBalancer, NqBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const inflight = new Uint32Array(4);            // YOU own this; increment on dispatch, decrement on settle

// LeastConn: the EXACT fewest-in-flight endpoint (O(cap) scan). In a feedback loop it is
// greedy-optimal -- load spreads within 1 of the mean (tighter than P2C's ln ln n gap).
const lc = new LeastConnBalancer(4, eligible, inflight);
const a = lc.pick(); inflight[a]++;

// SED (shortest-expected-delay): minimizes (inflight + 1) / weight -- higher weight absorbs
// proportionally more load. A weight-0 eligible node is never a candidate.
const weights = Uint32Array.from([1, 2, 3, 4]);
const sed = new SedBalancer(4, eligible, inflight, weights);
const b = sed.pick(); inflight[b]++;

// NQ (never-queue): jump to an IDLE endpoint (in-flight 0) the instant one exists, else SED.
// The best fit for a worker pool -- fill free workers before queueing anywhere.
const nq = new NqBalancer(4, eligible, inflight, weights);
const c = nq.pick(); inflight[c]++;
```

The proof (from `test/balance.mjs`):

| strategy | claim | measured |
|---|---|---|
| **LeastConn** | exact greedy balance | **max-minus-min load <= 1** (peak/avg 1.00), tighter than P2C; peak <= P2C's on the same run |
| **SED** | load proportional to weight | **< 1% share drift** from each node's weight fraction; weighted-imbalance far below a random foil |
| **NQ** | never queue while idle | first *n* dispatches hit **n distinct idle workers**, then falls back to SED |

Each `pick()` is **0 B/op** and **O(cap)** (NQ is O(1) when an early node is idle). Because these are the state-heaviest strategies so far, M4 also introduces the **invariant fuzzer** (`npm run fuzz`): a seeded state-machine attack that, after *every* `pick` / `setEligible` / weight / load op, asserts the chosen endpoint is the *exact* optimum, `live` stays exact, and `PICK_NONE` holds *iff* nothing is pickable -- printing the seed on any failure for byte-for-byte replay.

## Evidence -- the two headlines (v0.6.0 benchmark suite)

> **Framing: parity on speed, superiority on the contract + balance + tail.** A trivial `i++ % n` round-robin -- or `wrr` -- *matches* P2C on raw ops/sec, so `lite-pick` does **not** claim "N times faster." Throughput is claimed at **parity**; the wins are **zero-GC**, **balance quality**, **tail latency** (GC blast-radius), and **never a dead pick**. Every number below is **seeded** and regenerated by `npm run bench:report`; `npm run bench:verify` fails CI if a README number drifts from a fresh run (algorithmic exact, timing within +/-15%). Node / CPU / OS / every PRNG seed are stamped into `benchmark/results.json`.

### Throughput parity vs the incumbents (ops/ms, same pool)

The real pinned npm incumbents (`load-balancers`, `loadbalance`, `wrr`) run through the **same** harness on the **same** `n=1024` pool as the matching `lite-pick` strategy of the **same complexity class** -- ops/ms side by side, not a winner. On the same-work P2C row `lite-pick` holds parity (59591 vs 60956). On the RoundRobin row `lite-pick` is ~22% slower (260168 vs 334541), and that gap is owned, not hidden: `loadbalance@1.0.0` is a bare `i++ % n` with no liveness, while `lite-pick`'s `RoundRobinBalancer` forward-scans the eligibility bitmap to skip down nodes -- so it never returns a dead pick. That scan is the constant-factor cost of a guarantee none of these incumbents offer. `lite-pick` claims parity only where the work is equal; where it is slower, it is slower for the liveness contract, and the balance + tail wins above are the reason to pay it. The weighted-random row is a disclosed **SKIP**: `lite-pick`'s O(1) weighted-random (`WeightedRandom`, alias table) lands at **M10**, so it is not raced against here -- our shipped `SmoothWRRBalancer` is O(cap) *smooth* weighted round-robin (a different, stronger-smoothness guarantee), whose throughput is measured by `npm run witness` and `npm run bench`, not force-fit into this parity table.

<!-- bench:competitors -->

| family | lite-pick | lite-pick ops/ms | incumbent (npm) | incumbent ops/ms |
| --- | --- | --- | --- | --- |
| P2C (power-of-two-choices) | P2cBalancer | 59591 | load-balancers@1.3.52 | 60956 |
| RoundRobin | RoundRobinBalancer | 260168 | loadbalance@1.0.0 | 334541 |
| Weighted-random | WeightedRandom -- SKIP, ships M10 | -- | wrr@1.0.0 | 158395 |

<!-- /bench:competitors -->

### Balance quality -- the anchor (headline #1)

The canonical balls-into-bins experiment (throw `m = 32*n` balls into `n` bins): P2C's peak load stays within an additive `ln ln n / ln 2` of the mean, while a single random draw's gap grows with the pool. **Peak-gap** = heaviest bin minus the mean (32); the ceiling column is `4*lnln(n)/ln2 + 4`.

<!-- bench:balance -->

| pool n | P2C peak-gap | random foil peak-gap | ceiling |
| --- | --- | --- | --- |
| 64 | 3 | 13 | 12.2 |
| 1024 | 2 | 21 | 15.2 |
| 4096 | 2 | 25 | 16.2 |

<!-- /bench:balance -->

P2C's peak-gap stays a small `ln ln n` constant while the random foil's grows with `n` -- the exponential improvement one extra probe buys, measured not asserted ([ADR 0008](./decisions/0008-benchmark-suite.md)).

### GC blast-radius -- the tail (headline #2)

The point of zero-GC is **not** the pick's own latency -- a major GC pause freezes **every in-flight request at once**, so an allocating balancer inflates the *service-level* tail. The **same** sustained mixed workload (`n=1024`, 2M requests) runs through two lanes: the zero-GC `lite-pick` lane vs the ordinary "collect candidates, sort, take the best" idiom that allocates a request context per pick (promoted to old gen while in flight -- exactly the garbage that forces mark-sweep).

<!-- bench:gc -->

| lane | major GC | pick B/op | max GC pause (ms) |
| --- | --- | --- | --- |
| lite-pick | 0 | 0 | 0.1 |
| allocating foil | 13 | allocates | 2.9 |

<!-- /bench:gc -->

The `lite-pick` lane holds **0 major GC / 0 B/op** on the pick path; the allocating foil's promoted request state forces mark-sweep pauses that stall the whole service. **That contrast is the headline**, not ops/sec.

### Consistent-hash disruption -- a trust gate

On a scale event (add / remove a node), what fraction of keys keep their node? The **naive-modulo** trap (`key % n`) reshuffles almost everything -- blowing every downstream cache -- while a good consistent hash moves only ~`1/n`. The real `ConsistentHash` (Maglev) lands at **M8**; it is disclosed here as an explicit **SKIP**, not a stub:

<!-- bench:disruption -->

| scale event | naive-modulo remap | good consistent hash |
| --- | --- | --- |
| node removed | 98.4% | 1.6% |
| node added | 98.5% | 1.5% |
| ConsistentHash (Maglev) | SKIP -- ships in a later milestone | -- |

<!-- /bench:disruption -->

### Honest cold-path cost (so the 0 B/op HOT-path claim stays bounded)

`pick()` is **0 B/op** and that is the whole point -- so the cold-path costs are **named**, not hidden:

| operation | when | allocates |
| --- | --- | --- |
| `new <Strategy>Balancer(...)` | construction, once | the balancer object + its owned accumulators (SmoothWRR's Float64 `current`). The eligibility / inflight / weight views are **caller-owned**, never copied |
| `setEligible(i, up)` | cold, on a health flip | **0** -- one byte write + an O(1) live-count adjust |
| `setWeight(i, w)` (SmoothWRR) | cold, on reweight | **0** -- one array write + an O(1) eligible-total adjust |
| `pick()` | **HOT**, per request | **0 B/op** -- proven by `torture` + `test:perf`, measured by `bench:gc` |
| `Pool.run(fn)` (`/pool`) | per request | a promise + one small `held` array -- an async wrapper, **not** the kernel path ([ADR 0007](./decisions/0007-pool-adapter.md)) |

### Complementary to AWS NLB / ALB (not a competitor)

`lite-pick` does not replace a managed **ALB/NLB** -- it governs the *inner* hop those never see (your service fanning out to downstreams / shards / replicas / workers), bringing the **same algorithm family AWS bills for at the edge** to a zero-GC in-process selector you own:

| AWS edge feature (managed, billed) | `lite-pick` equivalent (in-process, zero-GC) |
| --- | --- |
| ALB `least_outstanding_requests` (LOR) | `LeastConnBalancer` / `P2cBalancer` |
| ALB `weighted_random` + anomaly mitigation | `WeightedRandom` + `BoundedLoad` (M9/M10) |
| NLB flow-hash (5-tuple) | `ConsistentHash` (Maglev, M8) |

The composition: inbound traffic still enters through your **ALB/NLB -> service** (the edge hop AWS owns and bills); `lite-pick` governs the fan-out **after** that, the hop no AWS load balancer touches. Complementary, not a replacement -- "the hop your ALB/NLB never sees."

## The substrate (under every strategy)

```js
import { BalancerBase, Prng, PICK_NONE, VERSION } from '@zakkster/lite-pick';

// A pool of 4 endpoints. The eligibility view is SHARED and read-only to pick():
// lite-di-health probes / circuit breakers write it; the balancer only reads it.
const eligible = Uint8Array.from([1, 1, 0, 1]); // endpoint 2 is down

const base = new BalancerBase(4, eligible);
base.capacity;        // -> 4
base.live;            // -> 3  (O(1), cold-path maintained)
base.isEligible(2);   // -> false  (out-of-range is false too, never a throw)

// Cold path: a health source marks endpoint 2 back up. live stays exact.
base.setEligible(2, true);
base.live;            // -> 4

// A deterministic PRNG so the balance benchmark is reproducible (no Math.random
// on a gated path). Strategies draw from this on the hot path, zero-alloc.
const rng = new Prng(0x1234abcd);
rng.nextBelow(4);     // -> a uint32 in [0, 4)
rng.reset();          // replays the exact stream

PICK_NONE;            // -> -1  (fail-closed sentinel: no endpoint, never a dead pick)
VERSION;              // -> '0.6.0'
```

`BalancerBase.pick()` is **abstract** -- it throws, so an unfinished strategy fails loudly rather than returning a dead index. Every shipped strategy (`RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, `LeastConnBalancer`, `SedBalancer`, `NqBalancer`) extends it and reads the same shared eligibility view; you subclass it the same way to add your own.

## Wiring it up -- `@zakkster/lite-pick/pool` (v0.5.0)

The kernel gives you `pick() -> index`. Real callers also need the counter ergonomics: **increment in-flight on dispatch, decrement on settle, and re-pick a *different* endpoint on failure.** That layer is async (it wraps the request), so it lives in a separate subpath -- `@zakkster/lite-pick/pool` -- and the kernel stays 0 B/op.

```js
import { LeastConnBalancer } from '@zakkster/lite-pick';
import { Pool, liteQueryFetcher } from '@zakkster/lite-pick/pool';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const inflight = new Uint32Array(4);
const balancer = new LeastConnBalancer(4, eligible, inflight);
const pool = new Pool(balancer, inflight);      // Pool is the inc/dec authority around run()

// run(): pick -> inflight++ -> await fn -> inflight-- (in a finally). tries=2 re-picks a
// DIFFERENT endpoint if the first throws (a load-aware strategy steers off the failed node).
const res = await pool.run((i, signal) => fetch(urls[i], { signal }), { tries: 2 });

// Drop-in for a query cache (lite-query, or any `({ key, signal }) => Promise` fetcher).
// Duck-typed -- imports NOTHING from lite-query, so peerDependencies stays empty.
const fetcher = liteQueryFetcher(pool,
  ({ endpoint, key, signal }) => fetch(urls[endpoint] + '/' + key[0], { signal }).then(r => r.json()),
  { tries: 2 });
// query(qc, { key: ['users'], fetcher });
```

**Two layers, no overlap** ([ADR 0007](./decisions/0007-pool-adapter.md)): the pool owns **spatial** failover (try a different endpoint *now*); your query cache owns **temporal** retry (backoff, staleness). `run()` is a normal async wrapper -- it adds O(1) counter ops per attempt, **it is not held to the kernel's 0 B/op bar** (that's `pick()`). See it end-to-end -- least-conn fan-out over a flaky pool with a node killed mid-run, proving 0 dead picks and 0 leaked in-flight:

```bash
npm run demo
```

## Design ownership (ratified before any strategy)

lite-pick owns **no mutable state it can avoid owning** ([ADR 0001](./decisions/0001-selection-kernel-boundary.md)):

| Concern | Owner | lite-pick's role |
| --- | --- | --- |
| Liveness / eligibility | `@zakkster/lite-di-health` writes a shared `Uint8Array` | **reads** it, zero-copy |
| Circuit state | `@zakkster/lite-statechart` (consumed) | never built in; sees only the bit |
| In-flight / rtt counters | caller-owned `Uint32Array` / `Float64Array` | **reads** them; pure `pick()` |
| Whole pool down | -- | fail-closed: returns `PICK_NONE` (-1) |
| Routing flap | the layer that writes the shared view | hysteresis/dwell ([ADR 0002](./decisions/0002-anti-flapping.md)); `pick()` stays greedy |

**In-process first** (workers, DI services, ECS-style systems); remote HTTP is served by a thin optional adapter that owns the observation loop and writes the same shared views. The zero-GC contract stays strict because the kernel never touches the request lifecycle.

## Composes with

The moat is not the algorithms -- it is that lite-pick wires already-proven zero-GC parts of the suite: [`lite-di-health`](https://www.npmjs.com/package/@zakkster/lite-di-health) (liveness), [`lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) (`RandomSet` / `AliasTable` / `RingLog` substrate), [`lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) (exact least-conn heap / Fenwick weights), [`lite-lru`](https://www.npmjs.com/package/@zakkster/lite-lru) (sticky affinity), [`lite-statechart`](https://www.npmjs.com/package/@zakkster/lite-statechart) (breaker), [`lite-query`](https://www.npmjs.com/package/@zakkster/lite-query) (the fetcher adapter), and [`lite-await`](https://www.npmjs.com/package/@zakkster/lite-await) (hedging). **None is a hard dependency** -- each is an *optional peer* (`peerDependenciesMeta.optional`), every seam is duck-typed over a shared TypedArray, and the kernel runs with zero peers installed.

## Gates

Every strategy session must pass, no exceptions:

```bash
npm test           # node:test boundary suite
npm run test:types # tsc type-surface check (Pick.d.ts vs runtime)
npm run torture    # lite-leak retention + lite-gc-profiler 0 B/op (needs --expose-gc)
npm run test:perf  # lite-perf-gate HARD zero-alloc gate + a mustFail teeth-check
npm run witness    # pick throughput flatness across a pool-size sweep
npm run balance    # peak-to-average vs the strategy ceiling + random foil (the anchor)
npm run fuzz       # seeded invariant fuzzer: state-sync invariants after every op
npm run verify     # all of the above
```

The zero-GC proof is two complementary tools kept separate (the suite's torture-harness discipline): a soak tester (`torture.mjs`, [`@zakkster/lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) + [`@zakkster/lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)) and a node:test-native hard gate (`test/perf/PerfGate.test.mjs`, [`@zakkster/lite-perf-gate`](https://www.npmjs.com/package/@zakkster/lite-perf-gate)), which includes a `mustFail` scenario proving the instrument has teeth.

## License

MIT (c) Zahary Shinikchiev
