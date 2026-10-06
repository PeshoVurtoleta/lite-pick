# Which strategy? -- the lite-pick decision guide

`@zakkster/lite-pick` ships **ten** selection strategies. They are not ranked; each wins a different
job. This guide is how you CHOOSE one. It is deliberately distinct from [RECIPES.md](./RECIPES.md),
which shows how to WIRE a chosen strategy (dispatch/settle counters, health, the `/pool` layer).

Every strategy shares the same contract: a hot `pick()` returning an endpoint **index** over a fixed
pool, **fail-closed** (`PICK_NONE` = -1 when nothing is pickable, never a dead pick), reading a
**read-only eligibility bitmap** it never writes -- flipped only through `setEligible` (the sole
supported writer, which keeps the cached `live` exact; a direct byte write desyncs it), and each
balancer has its own eligibility array.

`pick()` **allocates 0 B/op** (PerfGate scavenge counting) and **retains 0 B/op** (torture) in the
steady state. The strategies that take a **number argument** on the hot path --
`PeakEWMA.pick(now)` / `recordRtt(..., now)` with a realistic nanosecond clock, and
`ConsistentHash`/`BoundedLoad.pick(keyHash)` with a key `>= 2^31` -- box that argument into a ~16 B
transient `HeapNumber` when the call is not inlined (transient, does not retain, does not force a
major GC); V8's small-integer range is below 2^31 on stock 64-bit Node and below 2^30 on
pointer-compressed builds such as Chrome/Electron. Since 1.1.0 each has a ZERO-BOX sibling that reads
the number from a caller-owned typed-array slot -- `pickFrom(buf, i)` and `recordRttFrom(i, buf, j)`
-- gated at 0 B/op even with V8 inlining switched off.

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

> **NQ tie-fairness caveat (known, 1.2.0 fix queued).** NQ's idle-first grab plus its single rotating
> cursor leaves a small positional tie bias under **mixed weights**: in the audit's Poisson run with
> weights `[1,1,1,1,4,4,4,4]` at load 0.9, the four weight-4 endpoints took 20.6 / 20.1 / 19.8 / 19.6%
> instead of a flat 20% (lower index slightly favoured; LeastConn and SED are fair). It is at most
> ~1 percentage point and never breaks the fail-closed / exact-optimum contract. If you need exact
> within-tie fairness under heterogeneous weights today, prefer SED.

## SmoothWRR vs WeightedRandom -- the weighted fork, made explicit

Both send load proportional to a configured integer weight. They differ in HOW and in cost:

- **SmoothWRR** is DETERMINISTIC and SMOOTH: weights `[5,1,1]` yield `A A B A C A A`, not bursts. It
  converges EXACTLY (counts == k x weight over a cycle) with the lowest variance. Cost: **O(cap) per
  pick**, and it owns per-endpoint accumulator state that is maintained in lockstep.
- **WeightedRandom** is a STATELESS **O(1)** sample from a Vose alias table: one column draw + one
  compare. It converges to the weight ratios by the law of large numbers (any single pick is random --
  it pays SAMPLING VARIANCE). No accumulator to desync.

Rule of thumb: **small-to-medium pools or when smoothness matters -> SmoothWRR; very large pools where
the O(cap) scan hurts -> WeightedRandom.** For weights that change **all the time** (per-request load
reports), use a `@zakkster/lite-logn` `Fenwick` (>= 1.4.0) beside lite-pick: O(log n) to change a weight,
O(log n) to sample with `searchFrom(buf, i)` (0 B/op). At 1000 endpoints it picks in ~57-98 ns where
WeightedRandom takes ~16 ns, but a weight change costs ~12-22 ns where WeightedRandom rebuilds its table
in ~10-17 us -- so the tree wins once weights change more often than about once per 200 picks. lite-pick
does not import it; RECIPES.md section 17 has the wiring.

## Taking a backend out of ConsistentHash / BoundedLoad: drain or remove?

- **Drain** -- `setEligible(i, false)`: the table is unchanged, **0** other keys move, and marking it up
  again brings every key back. For health flaps, deploys, breaker trips.
- **Remove** -- `setWeight(i, 0)`: the table is rebuilt (cold), **~0.5%** of other keys move at the default
  M (~2.5% at M = 4099). For a backend that is gone for good, or many down at once (a drained backend's
  keys probe past its slots). Note that IPVS's weight 0 DRAINS; lite-pick's weight 0 removes.

Measured numbers and the full trade-off: RECIPES.md section 9, "Drain vs remove".

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
