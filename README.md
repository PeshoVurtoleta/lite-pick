# @zakkster/lite-pick

> Zero-GC load-balancing **selection kernel**: one hot `pick()` that returns an endpoint **index** over a fixed pool and allocates **0 B/op** on the steady-state path. A pure selector, never a proxy -- it consumes health and circuit state, it never owns them. **v1.0.0 ships the complete ten-strategy roster -- `RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, the exact `LeastConnBalancer` / `SedBalancer` / `NqBalancer` family, the latency-aware `PeakEwmaBalancer`, the sticky/affinity `ConsistentHashBalancer` (a Maglev lookup table), the hotspot-protecting `BoundedLoadBalancer` (consistent hashing with bounded loads -- sticky routing + an occupancy cap that overflows a hot backend to its neighbours), and `WeightedRandomBalancer` (O(1) Vose alias-table sampling with rejection-sampling eligibility)** -- on the substrate seams (`VERSION`, `PICK_NONE`, a deterministic `Prng`, and `BalancerBase`'s shared read-only eligibility view), plus a **`@zakkster/lite-pick/pool`** subpath: the async dispatch/settle counter layer with distinct-endpoint failover and a duck-typed query-cache fetcher. Not sure which strategy? See **[GUIDE.md](./GUIDE.md)**.

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

> **Status: M10 (v1.0.0) -- the roster-complete release.** Ships the substrate seams **plus all ten strategies: `RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, the exact `LeastConnBalancer` / `SedBalancer` / `NqBalancer` family, the latency-aware `PeakEwmaBalancer`, the sticky/affinity `ConsistentHashBalancer` (a Maglev table), the hotspot-protecting `BoundedLoadBalancer` (consistent hashing with bounded loads), and `WeightedRandomBalancer` (O(1) Vose alias-table sampling with rejection-sampling eligibility)**, the **`@zakkster/lite-pick/pool`** request layer (with opt-in latency-feedback, occupancy-feedback, and keyed-routing hooks), the **benchmark suite** -- the balance anchor + GC blast-radius headlines, a seeded/version-stamped `results.json`, a `bench:verify` drift check with teeth, and the vs-AWS positioning (see *Evidence* below) -- and the **[GUIDE.md](./GUIDE.md)** strategy-selection capstone. This session APPENDS one class: the other strategies in `Pick.js` are byte-identical, only the header roster/count and the `VERSION` stamp change. Every strategy is gated: `pick()` proven **0 B/op** (torture + PerfGate), RoundRobin **perfectly fair** with **zero dead picks** vs the naive `i++ % n` foil, SmoothWRR **exactly weighted** and **smooth**, **P2C proves the `ln ln n` balance ceiling** (peak-to-mean gap ~2 vs a random foil's ~21 at n=1024), **LeastConn is greedy-perfect** (max-minus-min load <= 1), **SED tracks weight within 1%**, **PeakEWMA steers around a 10x-slow node** (it takes <= 25% of P2C's share for it and cuts service p99), **ConsistentHash remaps only ~1.6% of keys on a scale event** (vs ~98% for naive modulo), **BoundedLoad tames a hotspot plain consistent hashing can't** (under a skewed key stream ConsistentHash spikes a hot backend to ~13x the mean occupancy while BoundedLoad's `(1+eps)` cap holds it near the mean by overflowing to neighbours), and **WeightedRandom holds every node's share within 2% of its weight** while its O(1) alias sample beats an O(n) cumsum foil by >=3x ops/ms at n=4096 -- all held under a **seeded invariant fuzzer** (`test/fuzz.mjs`) that checks state-synchronisation after *every* op. Roster complete **for now, not closed** (AZ-aware routing, hedging, subsetting are post-1.0). See [ROADMAP.md](./ROADMAP.md), and [decisions/](./decisions) for the ownership boundary (ADR 0001), anti-flapping (ADR 0002), the RoundRobin (0003), SmoothWRR (0004), P2C (0005), LeastConn-family (0006), pool-adapter (0007), benchmark-suite (0008), PeakEWMA (0009), ConsistentHash (0010), BoundedLoad/CHBL (0011), and WeightedRandom (0012) design forks.

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

## PeakEWMA -- latency-aware P2C (v0.7.0)

When endpoints differ in **latency**, not just queue depth, count-based strategies keep re-probing a slow-but-up node: it drains its queue between visits, so its in-flight looks attractive again. `PeakEwmaBalancer` (Twitter Finagle's *peak-EWMA*) is power-of-two-choices over a **latency cost** -- `cost = (inflight + 1) x decayed-EWMA(rtt)` -- so a degraded node is avoided **even while idle** ([ADR 0009](./decisions/0009-peakewma.md)). It is `O(d) = O(1)` per pick and **0 B/op** on both the pick path and the feedback path.

```js
import { PeakEwmaBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const inflight = new Uint32Array(4);          // YOU own this; read live by pick()
const TAU_NS = 30e6;                          // EWMA half-life: 30ms of latency memory

// `now` and rtt samples are CALLER-supplied nanoseconds -- deterministic, testable, zero-GC.
const pe = new PeakEwmaBalancer(4, eligible, inflight, TAU_NS);

const now = perfNs();                          // your monotonic ns clock
const i = pe.pick(now);                         // two random eligibles, lower latency-cost wins
inflight[i]++;                                  // dispatch
// ... await the request ...
inflight[i]--;                                  // settle
pe.recordRtt(i, perfNs() - now, perfNs());      // feed the observed rtt back (the warm path)
```

- **Decay-on-read.** `pick()` *never writes* -- it applies exponential decay when it reads (`ewmaAt(i, now) = _ewma[i] x exp(-(now - _stamp[i]) / tau)`), so the hot path is a pure read and allocates nothing.
- **The peak rule.** `recordRtt` *snaps the cost up* to a larger sample instantly (a spike is felt on the next pick) and *decays it down* over `~tau`. The half-life **is** the anti-flap smoothing -- no extra dwell ([ADR 0002](./decisions/0002-anti-flapping.md)).
- **Balancer-owned state.** `inflight` is your live-read `Uint32Array`; the EWMA arrays are owned by the balancer and written *only* by `recordRtt`. Cold start seeds the EWMA to `1.0` with an *unsampled* sentinel (`_stamp = -1`): an unsampled node scores at its undecayed baseline, so before any sample PeakEWMA degrades gracefully to least-connections **regardless of your clock's magnitude** -- never underflowing to `0` (which a plain `_stamp = 0` would, as `exp(-now/tau)`, under a real large clock) and never `NaN`. The first `recordRtt` initializes the EWMA *exactly* to the sample; the peak rule applies from the second sample on.
- **`now` must be finite.** `now` (for `pick(now)` / `recordRtt`) and `sampleNs` must be finite numbers. `recordRtt` throws on a non-finite argument; `pick(now)` never throws (the fail-closed contract), so a non-finite `now` yields P2C-random selection rather than an error.

The proof (from `test/balance.mjs`, a closed-loop queue sim with one node at 10x service time):

| lane | slow-node share | service p99 |
|---|---|---|
| **PeakEWMA** | **~0.01%** (learns and avoids it) | **lowest** |
| P2C (in-flight only) | ~1.5% (keeps re-probing) | ~7x PeakEWMA's |
| random foil | ~6% (blind) | saturates the slow node |

PeakEWMA sends the slow node **<= 25% of P2C's share** for it and cuts service p99 **>= 20% below** P2C-over-inflight; the random foil is worse than both.

### FE profile -- PeakEWMA + health, nothing else

For a **front-end / browser client** -- a handful of picks per second across origins/regions, not a zero-GC hot loop -- the recommended profile is **PeakEWMA + the eligibility bitmap only**: latency-aware choice with a fail-closed health view, and **none** of the server-side bounded-load / availability-zone / occupancy machinery. It is the smallest honest latency-aware client balancer. *(Deferred: a tail-aware `inflight x p99Rtt` variant via an optional-peer `@zakkster/lite-sketch` `DDSketch`; the EWMA-mean score is the shipped zero-peer default, and `peerDependencies` stays `{}` -- [ADR 0009](./decisions/0009-peakewma.md).)*

## ConsistentHash -- sticky / cache-affinity routing (v0.8.0)

When a request must go to the **same** backend every time -- a session, a cache shard, a stateful worker -- you want **consistent hashing**: a stable key -> backend map that barely changes when the pool scales. `ConsistentHashBalancer` is a prebuilt **Maglev lookup table** (the in-kernel/production choice -- Linux IPVS `mh`, Meta Katran, Cilium), so `pick(keyHash)` is `slot = keyHash % M`, one table read, and a bounded probe past down slots -- **O(1)** and **0 B/op** ([ADR 0010](./decisions/0010-consistenthash.md)).

```js
import { ConsistentHashBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
// YOU hash the key to an INTEGER (cold) -- per-pick STRING hashing is the one zero-GC hazard.
const b = new ConsistentHashBalancer(4, eligible);  // default M = 65537 (prime); weights optional

const key = fnv1a(sessionId);       // any integer hash you like -- lite-pick adds none
const i = b.pick(key >>> 0);        // same key -> same backend, at fixed membership

// A tiny FNV-1a over a string, done ONCE per key on the cold path (never inside pick):
function fnv1a(s) { let h = 0x811c9dc5; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); } return h >>> 0; }
```

- **Caller-supplied INTEGER key.** `pick(keyHash)` coerces `keyHash >>> 0` (so `NaN`/`undefined` -> `0`) and **never throws** (the fail-closed contract). It never hashes a string -- that would allocate on the hot path. Hash string keys yourself, cold (a tiny FNV-1a is fine -- see the snippet above); `lite-pick` adds **no hashing dependency**.
- **Minimal disruption.** Removing a backend is just `setEligible(i, false)` -- the table is **untouched**, so every key not on that backend keeps its exact backend and only ~`1/N` reroute (measured **1.6%** vs the naive-modulo trap's **98%** above). A membership or weight change rebuilds the table (**cold**); a health flap **never** does -- the bounded probe (<= 64 slots) absorbs it.
- **Weighted.** Pass a `Uint32Array` of weights (copied, balancer-owned) for a per-backend slot share proportional to weight; `setWeight(i, w)` / `rebuild()` rebuild the table cold. Unweighted = equal share.
- **Cost & bound.** The lookup table is `M x 4` bytes -- `~256KB` at the `65537` default -- a **cold, one-time** allocation (disclosed in the cost table below; `M` is configurable **down** for small pools). `pick()` is `O(1)`, `0 B/op`. Fail-closed: `PICK_NONE` when the pool is down or no eligible backend is reachable within the probe bound (a near-total outage may return `PICK_NONE` even if a far eligible slot exists -- safe, never a dead pick).
- **Deferred seams (import nothing).** A `@zakkster/lite-filter` hot-key / known-key oracle at the key-routing layer (warm/cold only, never the pick path) and a `@zakkster/lite-o1` `EliasFano` ring alternative to the table are optional-peer seams -- `peerDependencies` **stays `{}`** until a shipped path imports one ([ADR 0010](./decisions/0010-consistenthash.md)).

## BoundedLoad -- consistent hashing with bounded loads (v0.9.0)

Plain consistent hashing is sticky and minimally-disruptive, but it has one failure mode: a **hot key**. If a handful of keys carry most of the traffic, consistent hashing pins each one's *entire* load on its one hashed backend -- an unbounded **hotspot**. `BoundedLoadBalancer` is [`ConsistentHashBalancer`](#consistenthash--sticky--cache-affinity-routing-v080) (the Maglev table) **plus a per-backend occupancy cap** `cap = (1 + eps) x mean` (the mean occupancy `_total / live`, with slack `eps`): a key sticks to its hashed home **unless** that backend is over cap, in which case the request **overflows** along the same bounded probe to the next eligible, under-cap backend (Mirrokni et al. *Consistent Hashing with Bounded Loads*, Google Research; Vimeo's `eps = 0.25` -- [ADR 0011](./decisions/0011-boundedload.md)). You keep stickiness + minimal disruption **and** gain the hotspot protection consistent hashing lacks.

```js
import { BoundedLoadBalancer } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const inflight = new Uint32Array(4);            // YOU own this; read live as per-backend OCCUPANCY

// eps = 0.25 -> a backend over 1.25x the mean occupancy overflows the key to a neighbour.
const bl = new BoundedLoadBalancer(4, eligible, inflight, 0.25);

const key = fnv1a(sessionId);                    // any integer hash (cold) -- lite-pick adds none
const i = bl.pick(key >>> 0);                    // sticky home, or the overflow target if it's hot
inflight[i]++;   bl.note(i, +1);                 // dispatch: bump the counter AND tell the balancer
// ... await the request ...
inflight[i]--;   bl.note(i, -1);                 // settle: net-zero on both
```

- **Sticky + overflow.** `pick(keyHash)` maps the integer key to its Maglev home; if that backend is under cap it wins (the common, sticky path). If it is over cap, the request overflows along the bounded probe to the first eligible, under-cap backend. If nothing in the window is under cap, it falls back to the first eligible seen -- **sticky wins; the cap is a soft preference, never a dead pick**. When `_total === 0` the cap is skipped entirely, so it behaves as pure `ConsistentHashBalancer`.
- **`note()` is the sole writer of the mean.** BoundedLoad **owns** a running occupancy sum `_total` and keeps it O(1)-current through `note(i, +1)` on dispatch / `note(i, -1)` on settle -- so the cap's mean never needs a scan; `inflight` is your live-read per-backend occupancy. **Contract:** mutate the mirrored counter **only** through `note()` (or the `/pool` adapter, which does it for you) -- direct mutation desyncs `_total` (UB, the same asymmetry `SmoothWRRBalancer` has for its weights). `note()` clamps `_total` at 0, and `totalInflight` exposes it.
- **Inherits the Maglev table.** It extends `ConsistentHashBalancer`, so `setWeight(i, w)` / `rebuild()` / `tableSize` and the whole weighted-Maglev build + bounded-probe walk are reused verbatim; the `weights` / `m` / `seed` constructor args are the same. `pick()` and `note()` are both **0 B/op**, `O(1)`. `PICK_NONE` only when no eligible backend is reachable in the probe window -- never merely because backends are over cap.
- **Why not "P2C with a cap"?** A note on the design (the honest one): power-of-two-choices over in-flight *plus* a `(1+eps) x mean` cap is **byte-identical to plain P2C** -- an under-cap draw always has lower in-flight than an over-cap one, so "prefer under-cap" and "lower-of-two" pick the same node. The cap is a no-op there. It is only *load-bearing* when the primary choice is fixed by something other than load -- a **hash**. That is CHBL, and it is why BoundedLoad is built on consistent hashing ([ADR 0011](./decisions/0011-boundedload.md)).

The proof (from `test/balance.mjs`, a Zipfian-skewed key stream over 64 backends, one fixed concurrency window):

| lane | mean occupancy | max backend occupancy |
|---|---|---|
| **BoundedLoad (CHBL)** | 10 | **13** (cap = 12.5 -- overflow holds it near the mean) |
| ConsistentHash (no cap) | 10 | **129** (~13x -- the hotspot) |

BoundedLoad caps the hot backend near `(1 + eps) x mean` while plain consistent hashing lets it run away, and both reroute only **~1.6%** of keys on a scale event (`test/balance.mjs`). See [`ConsistentHashBalancer`](#consistenthash--sticky--cache-affinity-routing-v080) above for the integer-key contract and the FNV-1a helper.

## WeightedRandom -- O(1) alias-table weighted selection (v1.0.0)

The weighted strategy for **very large pools**. Where `SmoothWRRBalancer` is deterministic and smooth but scans O(cap) per pick and owns per-endpoint accumulator state, `WeightedRandomBalancer` is a **stateless O(1) sample**: one draw from a precomputed **Vose/Walker alias table** (one column draw + one probability compare) returns an endpoint proportional to its weight. It converges to the weight ratios by the law of large numbers -- trading SmoothWRR's low-variance smoothness for sampling variance.

```js
import { WeightedRandomBalancer, PICK_NONE } from '@zakkster/lite-pick';

const eligible = Uint8Array.from([1, 1, 1, 1]);
const weights = Uint32Array.from([1, 2, 3, 10]);   // YOU own this; endpoint 3 gets ~10/16 of traffic
const wr = new WeightedRandomBalancer(4, eligible, weights);

wr.pick();            // -> a weighted-random eligible index (mostly 3, sometimes 0/1/2)

// Reweight is COLD (rebuilds the alias table); the balancer is the sole writer of its table.
wr.setWeight(3, 1);   // now roughly uniform
wr.setEligible(1, false); // an eligibility flap is FREE -- it never rebuilds the table (anti-flap)
wr.pick();            // never returns endpoint 1 (down) or a weight-0 node

// Whole pool down, or every eligible node weight 0 -> fail closed.
for (let i = 0; i < 4; i++) wr.setEligible(i, false);
wr.pick() === PICK_NONE; // -> true
```

- **O(1), 0 B/op, never throws.** One alias-column draw + one compare. The table is built **cold** in the constructor (and on `setWeight` / `rebuild`) with the standard Vose small/large worklist -- reusing scratch buffers, so a rebuild allocates nothing and `pick()` allocates nothing.
- **Eligibility by rejection sampling** (the same discipline as P2C, [ADR 0005](./decisions/0005-p2c-draw.md)): the table is built over the **eligible-independent** weights, so a **weight-0 node is never a column** (never returned). If a drawn candidate is ineligible, `pick()` redraws up to a bounded 64, then falls back to a 0-B/op rotated linear eligible scan. Because every candidate is a positive-weight node, rejecting the ineligible ones **renormalizes** the weight distribution over the surviving eligible mass -- each eligible node's share converges to `weight[i] / sum(eligible weights)`.
- **Sole writer of its table.** `weights` is your `Uint32Array` (the SmoothWRR/SED seam); the balancer owns the derived alias table and is its only writer via cold `setWeight` / `rebuild`. Mutate `weights` directly and the table desyncs (UB). An eligibility flap **never** rebuilds. `PICK_NONE` only when `live === 0` or no eligible node has a positive weight.
- **Not `@zakkster/lite-random`.** That is a *game RNG* (loot tables, particles) whose `weighted(items, weights)` returns an **item** one-shot and is not eligibility-aware. WeightedRandom returns an endpoint **index**, honours the shared eligibility bitmap, and owns a persistent table -- different domain (see [GUIDE.md](./GUIDE.md) / [ADR 0012](./decisions/0012-weightedrandom.md)).

The proof (from `test/balance.mjs`, n=64, skewed weights 1..16, 8e6 seeded draws): every node's observed share is within **2%** of `weight[i]/sum` (measured worst ~0.84%), a cumsum-linear O(n) foil matches the *same* fairness, and the O(1) alias sample beats that foil by **~107x ops/ms** at n=4096. Under half the pool down: **0 ineligible / 0 weight-0** returns and survivor shares within **3%** of the renormalized target.

> **Which weighted strategy?** Small-to-medium pools or when smoothness matters -> **SmoothWRR**; very large pools where the O(cap) scan hurts -> **WeightedRandom**. Full decision tree in **[GUIDE.md](./GUIDE.md)**.

## Evidence -- the two headlines (v0.6.0 benchmark suite)

> **Framing: parity on speed, superiority on the contract + balance + tail.** A trivial `i++ % n` round-robin -- or `wrr` -- *matches* P2C on raw ops/sec, so `lite-pick` does **not** claim "N times faster." Throughput is claimed at **parity**; the wins are **zero-GC**, **balance quality**, **tail latency** (GC blast-radius), and **never a dead pick**. Every number below is **seeded** and regenerated by `npm run bench:report`; `npm run bench:verify` fails CI if a README number drifts from a fresh run (algorithmic exact, timing within +/-15%). Node / CPU / OS / every PRNG seed are stamped into `benchmark/results.json`.

### Throughput parity vs the incumbents (ops/ms, same pool)

The real pinned npm incumbents (`load-balancers`, `loadbalance`, `wrr`) run through the **same** harness on the **same** `n=1024` pool as the matching `lite-pick` strategy of the **same complexity class** -- ops/ms side by side, not a winner. On the same-work P2C row `lite-pick` holds parity (59591 vs 60956). On the RoundRobin row `lite-pick` is ~22% slower (260168 vs 334541), and that gap is owned, not hidden: `loadbalance@1.0.0` is a bare `i++ % n` with no liveness, while `lite-pick`'s `RoundRobinBalancer` forward-scans the eligibility bitmap to skip down nodes -- so it never returns a dead pick. That scan is the constant-factor cost of a guarantee none of these incumbents offer. `lite-pick` claims parity only where the work is equal; where it is slower, it is slower for the liveness contract, and the balance + tail wins above are the reason to pay it. The weighted-random row is a disclosed **SKIP**: `lite-pick`'s O(1) weighted-random (`WeightedRandom`, alias table) lands at **M10**, so it is not raced against here -- our shipped `SmoothWRRBalancer` is O(cap) *smooth* weighted round-robin (a different, stronger-smoothness guarantee), whose throughput is measured by `npm run witness` and `npm run bench`, not force-fit into this parity table.

<!-- bench:competitors -->

| family | lite-pick | lite-pick ops/ms | incumbent (npm) | incumbent ops/ms |
| --- | --- | --- | --- | --- |
| P2C (power-of-two-choices) | P2cBalancer | 57019 | load-balancers@1.3.52 | 59778 |
| RoundRobin | RoundRobinBalancer | 229911 | loadbalance@1.0.0 | 261301 |
| Weighted-random | WeightedRandomBalancer | 73673 | wrr@1.0.0 | 172137 |

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
| lite-pick | 0 | 0 | 0.2 |
| allocating foil | 13 | allocates | 1.8 |

<!-- /bench:gc -->

The `lite-pick` lane holds **0 major GC / 0 B/op** on the pick path; the allocating foil's promoted request state forces mark-sweep pauses that stall the whole service. **That contrast is the headline**, not ops/sec.

### Consistent-hash disruption -- a trust gate

On a scale event (add / remove a node), what fraction of keys keep their node? The **naive-modulo** trap (`key % n`) reshuffles almost everything -- blowing every downstream cache -- while a good consistent hash moves only ~`1/n`. `ConsistentHashBalancer` (the Maglev table, **M8**) is measured here beside the trap and the `1/n` ideal -- removing a backend is just marking it down, so only its keys reroute:

<!-- bench:disruption -->

| scale event | naive-modulo remap | ConsistentHash (Maglev) | ideal (1/n) |
| --- | --- | --- | --- |
| node removed | 98.4% | 1.6% | 1.6% |
| node added | 98.5% | 1.5% | 1.5% |

<!-- /bench:disruption -->

### Honest cold-path cost (so the 0 B/op HOT-path claim stays bounded)

`pick()` is **0 B/op** and that is the whole point -- so the cold-path costs are **named**, not hidden:

| operation | when | allocates |
| --- | --- | --- |
| `new <Strategy>Balancer(...)` | construction, once | the balancer object + its owned accumulators (SmoothWRR's Float64 `current`). The eligibility / inflight / weight views are **caller-owned**, never copied |
| `new ConsistentHashBalancer(...)` / `rebuild()` / `setWeight()` | cold, on build / membership / reweight | the Maglev lookup table: **`M x 4` bytes** (`~256KB` at the `65537` default `M`), a one-time `Uint32Array` allocation + an `O(M x N)` populate. `M` is **configurable down** for small pools. A health flap does **not** rebuild -- the bounded probe absorbs it |
| `setEligible(i, up)` | cold, on a health flip | **0** -- one byte write + an O(1) live-count adjust |
| `setWeight(i, w)` (SmoothWRR) | cold, on reweight | **0** -- one array write + an O(1) eligible-total adjust |
| `pick()` | **HOT**, per request | **0 B/op** -- proven by `torture` + `test:perf`, measured by `bench:gc` |
| `Pool.run(fn)` (`/pool`) | per request | a promise + one small `held` array -- an async wrapper, **not** the kernel path ([ADR 0007](./decisions/0007-pool-adapter.md)) |

### Complementary to AWS NLB / ALB (not a competitor)

`lite-pick` does not replace a managed **ALB/NLB** -- it governs the *inner* hop those never see (your service fanning out to downstreams / shards / replicas / workers), bringing the **same algorithm family AWS bills for at the edge** to a zero-GC in-process selector you own:

| AWS edge feature (managed, billed) | `lite-pick` equivalent (in-process, zero-GC) |
| --- | --- |
| ALB `least_outstanding_requests` (LOR) | `LeastConnBalancer` / `P2cBalancer` |
| ALB anomaly mitigation / latency-aware shedding | `PeakEwmaBalancer` (latency-aware P2C) |
| ALB anomaly mitigation on a sticky/affinity hash | `BoundedLoadBalancer` (consistent hashing with bounded loads -- sticky + hotspot overflow, M9) |
| ALB `weighted_random` | `WeightedRandom` (M10) |
| NLB flow-hash (5-tuple) | `ConsistentHashBalancer` (Maglev table -- the same family NLB flow-hash uses, at the in-process hop) |

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
VERSION;              // -> '0.9.0'
```

`BalancerBase.pick()` is **abstract** -- it throws, so an unfinished strategy fails loudly rather than returning a dead index. Every shipped strategy (`RoundRobinBalancer`, `SmoothWRRBalancer`, `P2cBalancer`, `LeastConnBalancer`, `SedBalancer`, `NqBalancer`, `PeakEwmaBalancer`, `ConsistentHashBalancer`, `BoundedLoadBalancer`) extends it and reads the same shared eligibility view; you subclass it the same way to add your own.

## Wiring it up -- `@zakkster/lite-pick/pool` (v0.5.0)

> **New to lite-pick as a load balancer?** [**RECIPES.md**](./RECIPES.md) is a beginner-to-advanced guide: it builds the kernel up into a real balancer step by step -- health/eligibility, load counters, the dispatch/settle loop, failover, latency feedback (PeakEWMA), the FE profile, and choosing a strategy. Start there; the sections below are the reference.

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
