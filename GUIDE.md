# Which strategy? -- the lite-pick decision guide

`@zakkster/lite-pick` ships **ten** selection strategies. They are not ranked; each wins a different
job. This guide is how you CHOOSE one. It is deliberately distinct from [RECIPES.md](./RECIPES.md),
which shows how to WIRE a chosen strategy (dispatch/settle counters, health, the `/pool` layer).

Every strategy shares the same contract: a hot `pick()` returning an endpoint **index** over a fixed
pool, **0 B/op** steady-state, **fail-closed** (`PICK_NONE` = -1 when nothing is pickable, never a
dead pick), reading a **shared read-only eligibility bitmap** it never writes.

## The one question that splits everything: what fixes the primary choice?

```
Is routing decided by a KEY (same key -> same backend, for cache/session affinity)?
|
+-- YES -> you want a CONSISTENT HASH.
|          |
|          +-- Do a few hot keys overload one backend?
|          |     NO  -> ConsistentHash   (sticky, minimal disruption, O(1))
|          |     YES -> BoundedLoad       (sticky + an occupancy cap that overflows a hotspot, O(1))
|
+-- NO -> the choice is by LOAD / LATENCY / WEIGHT, not a key.
          |
          +-- Do you have a LATENCY signal (rtt) and want to steer around a slow-but-up node?
          |     YES -> PeakEWMA           (latency-aware power-of-two-choices, O(1))
          |
          +-- Do you have live IN-FLIGHT counts (a closed dispatch/settle loop)?
          |     |
          |     +-- Want the EXACT least-loaded, and O(cap) is fine (dozens-hundreds of nodes)?
          |     |     unweighted        -> LeastConn   (exact fewest-in-flight, O(cap))
          |     |     weighted          -> SED         (minimizes (inflight+1)/weight, O(cap))
          |     |     worker pool (idle-first) -> NQ    (never-queue: idle node first, else SED, O(cap))
          |     |
          |     +-- Want O(1) at very large pools and can accept a tiny balance gap?
          |           -> P2C              (power-of-two-choices, the ln ln n ceiling, O(1))
          |
          +-- No load signal -- just spread by a fixed WEIGHT (or evenly)?
                |
                +-- Equal weight, simple rotation      -> RoundRobin   (O(1) amortized)
                +-- Weighted, want SMOOTH low-variance  -> SmoothWRR    (deterministic, O(cap))
                +-- Weighted, want STATELESS O(1) at scale -> WeightedRandom (alias table, O(1))
```

## The table

| Strategy | Decides by | Bound / pick | State the balancer owns | Wins when |
| --- | --- | --- | --- | --- |
| **RoundRobin** | rotation | O(1) amortized | a cursor | equal weight, no load signal, simplest fair spread |
| **SmoothWRR** | fixed weight | O(cap) | smoothing accumulators (`_current`) | weighted **and** you want deterministic, smooth, low-variance interleaving |
| **WeightedRandom** | fixed weight | **O(1)** | a Vose alias table (`_prob`/`_alias`) | weighted at **very large** pools where SmoothWRR's O(cap) scan hurts; can accept sampling variance |
| **P2C** | in-flight load | **O(1)** | just a PRNG | O(1) load-balancing at scale; the `ln ln n` peak ceiling, a tiny gap vs exact |
| **LeastConn** | in-flight load | O(cap) | none (reads live) | the **exact** least-loaded in a feedback loop; dozens-hundreds of nodes |
| **SED** | (inflight+1)/weight | O(cap) | none (reads live) | **weighted** exact least-loaded (load settles proportional to weight) |
| **NQ** | idle-first, else SED | O(cap) | none (reads live) | **worker pools** -- never queue while a server is idle |
| **PeakEWMA** | (inflight+1) x decayed rtt | **O(1)** | EWMA rtt state (`_ewma`/`_stamp`) | you have latency and want to steer around a **slow-but-up** node |
| **ConsistentHash** | key hash (Maglev) | **O(1)** | a Maglev lookup table | **sticky** cache/session affinity; minimal disruption on scale events (~1/N keys move) |
| **BoundedLoad** | key hash + occupancy cap | **O(1)** | Maglev table + a running `_total` | sticky routing **and** a few hot keys would otherwise overload one backend |

## SmoothWRR vs WeightedRandom -- the weighted fork, made explicit

Both send load proportional to a configured integer weight. They differ in HOW and in cost:

- **SmoothWRR** is DETERMINISTIC and SMOOTH: weights `[5,1,1]` yield `A A B A C A A`, not bursts. It
  converges EXACTLY (counts == k x weight over a cycle) with the lowest variance. Cost: **O(cap) per
  pick**, and it owns per-endpoint accumulator state that is maintained in lockstep.
- **WeightedRandom** is a STATELESS **O(1)** sample from a Vose alias table: one column draw + one
  compare. It converges to the weight ratios by the law of large numbers (any single pick is random --
  it pays SAMPLING VARIANCE). No accumulator to desync.

Rule of thumb: **small-to-medium pools or when smoothness matters -> SmoothWRR; very large pools where
the O(cap) scan hurts -> WeightedRandom.** For **frequently-changing** weights, a `@zakkster/lite-logn`
Fenwick tree (O(log n) update + sample) is the deferred dynamic-weight complement to WeightedRandom's
static alias table (rebuilt cold on reweight); see the roadmap.

## Not sure you even want lite-pick? -- the sibling boundary

- **`@zakkster/lite-random` is NOT a load balancer.** It is a GAME RNG (Mulberry32) for loot tables,
  particle systems, and gaussian sampling; its `weighted(items, weights) -> T` returns an **item**
  one-shot, is not eligibility-aware, and holds no reusable table. For **game loot tables use
  lite-random**; **lite-pick WeightedRandom is the eligibility-aware LB selector** (returns an endpoint
  INDEX, honours the shared eligibility bitmap, owns a persistent alias table rebuilt only on reweight,
  fail-closed). Different domain, different contract -- lite-random is not a peer or a substrate here.
- lite-pick is the **in-process** hop selector: it consumes health/circuit state and returns an index;
  it is never a proxy. It is complementary to AWS NLB/ALB (which balance the network hop AWS sees) --
  ALB's `weighted_random` + anomaly mitigation is lite-pick's WeightedRandom + BoundedLoad, and NLB's
  flow-hash is ConsistentHash, at the hop AWS never sees.

## Then wire it

Once you have picked a strategy, [RECIPES.md](./RECIPES.md) shows the real wiring: the shared
eligibility bitmap from a health source, the caller-owned in-flight / weight arrays, the `/pool`
dispatch/settle + failover layer, and the latency (`recordRtt`) / occupancy (`note`) / keyed
(`opts.key`) feedback hooks.
