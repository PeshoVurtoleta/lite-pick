# lite-pick Research Notes

**Status**: Living research document (first pass, 2026-09-22)
**Scope**: Design identity, analytical anchor, strategy roster, and sibling boundaries for a
tree-shakeable, zero-GC **load-balancing selection kernel** in JavaScript/TypeScript -- the pure
`pick()` core that chooses among already-known, already-healthy endpoints, and nothing else. Not a
proxy, not a gateway, not a health checker, not a service-discovery client.

---

## 1. Core Identity

- **The `pick()` IS the product.** One hot-path primitive: given a pool of endpoints, return the index
  of the one to use next. Every strategy (round-robin, weighted, power-of-two-choices, least-connections,
  latency-aware, consistent-hash, bounded-load) is a different `pick()` over the same substrate.
- **Zero garbage collection on the steady-state pick path (0 B/op).** The balancer runs on EVERY request;
  at high fan-out that is 10^4-10^6 picks/sec. A single temporary object, closure, or string per pick is
  GC jitter and tail latency. Proven, not asserted (section 2), via lite-leak + lite-gc-profiler.
- **Fixed, preallocated capacity.** Endpoint count is sized at construction; add/remove/re-weight is a
  COLD path (may allocate). `null` is not zero; an unsized pool is never a zero-endpoint one.
- **Integer indices, not objects.** `pick()` returns a `number` index into the caller's own endpoint
  array. The kernel never holds URLs, sockets, or request objects -- it holds counters and bits. This is
  what keeps it zero-GC AND framework-agnostic (works behind fetch, undici, axios, lite-query, workers).
- **It does not check health; it CONSUMES health.** Liveness is owned by `@zakkster/lite-di-health`
  (section 6). The kernel reads a shared `Uint8Array` eligibility view -- WRITTEN by health probes /
  circuit breakers, READ-ONLY to `pick()` -- and excludes down nodes; it never calls out, never risks
  re-entrancy. Clean split: health answers "is it up?"; lite-pick answers "given who is up, who next?".
- **Design center of gravity: IN-PROCESS first** (workers, DI services), with remote HTTP a first-class
  SECONDARY consumer via a thin adapter that owns the observation loop and writes the same shared views.
  The five load-bearing ownership forks (in-process-first, shared read-only eligibility, breaker consumed
  not built-in, caller-owned counters, one-bitmap-path-with-fastbit32-later) are RATIFIED in
  `decisions/0001-selection-kernel-boundary.md`. The through-line: lite-pick owns no mutable state it can
  avoid owning.
- Single-file ESM, zero runtime deps, `node:test` only, ASCII-only source. Tree-shakeable: import one
  strategy without pulling the others into the bundle.

**What lite-pick is NOT** (the honesty line, stated up front because the market confuses these):
a reverse proxy, an API gateway, a TLS terminator, a rate limiter, a retry/circuit-breaker engine, a
service registry, or a health prober. It replaces the *load-distribution decision* of an LB -- the one
choice on the hot path -- and leaves every other gateway concern to the layer that owns it. In Zalando's
million-req/s in-process balancer (2026) this is exactly the seam: they removed the shared LB *hop* for
internal fan-out and kept the edge gateway. lite-pick is that removed hop, as a proven-zero-GC library.

---

## 2. The Analytical Anchor: balance quality vs the provable ceiling

Every package in this suite ships ONE killer measurement that turns a claim into an actionable number --
lite-lru's "% of Belady optimal", lite-o1's throughput "flatness", lite-filter's "measured vs theoretical
FPR". **lite-pick's anchor is the imbalance factor: measured peak-to-average load, checked against the
theoretical ceiling for the number of choices the strategy makes, and against a random-choice foil.**

The reference ceiling is not marketing -- it is a theorem. For n balls into n bins:

- **Random (one choice):** max load ~ `ln n / ln ln n` above average -- the foil everyone reaches for.
- **Power of two choices (P2C):** max load ~ `ln ln n / ln 2` above average (Azar, Broder, Karlin, Upfal,
  "Balanced Allocations", 1994; Mitzenmacher, 2001). An EXPONENTIAL improvement from one extra probe --
  the "power of two" result. This is lite-pick's Belady OPT: the provable ceiling on how flat two choices
  can get, that every strategy is measured against.
- **d-left / "always go left"** (Vocking): a further constant-factor improvement from asymmetry.

**Why it is the killer feature.** "Our round-robin is fast" is unfalsifiable. "P2C holds peak-to-average
<= 1.9x at n=1000 under a skewed-cost workload while plain random hits 4.3x, matching the ln ln n bound"
is immediately convincing -- and almost no JS LB ships this evidence. Two honesty axes together close the
claim, mirroring lite-o1 (flat time AND 0 B/op):

1. **Is it correct?** balance quality: peak-to-average load and its distribution vs the P2C ceiling and
   the random foil, over a seeded workload.
2. **Is it free?** the pick witness: 0 B/op on the hot path (lite-leak + lite-gc-profiler) AND flat
   ops/ms as the pool grows (a good `pick()` is O(1) or O(d), never O(n)).

A strategy that balances beautifully but allocates per pick fails axis 2; a blazing round-robin that piles
load on a slow node fails axis 1. lite-pick refuses to report one without the other.

### The witness, precisely

- **ops/ms** of `pick()` at each pool size in a geometric sweep (n = 8, 64, 512, 4096) -- flat is the
  O(1)/O(d) signature.
- **B/op** on the pick path -- gated at 0 (excludes the cold add/remove/reweight path, which is labeled).
- **imbalance = maxLoad / meanLoad** after a seeded assignment workload, reported next to the strategy's
  theoretical bound and the random foil's measured imbalance.
- **failover latency** (section 3, dim 5): picks-until-recovery after a node's health bit drops -- the
  resilience number the FE case actually cares about.

### Prior art that validates the anchor (Linux / IBM / Google)

The roster is not invented -- it mirrors battle-tested production balancers, which is the strongest
evidence the picks are canonical:

- **Linux IPVS added a `twos` scheduler (kernel 5.12): power-of-two-choices, "two random servers by
  weight, pick the least connections normalized by weight," to fight "herd behavior."** That is P2C
  (section 7) and its exact anchor rationale, shipped in the kernel -- direct vindication of the M3
  headline, and of carrying weight INTO P2C (weighted least-conn = IPVS `wlc`, its default).
- The IPVS scheduler set (`rr / wrr / lc / wlc / sed / nq / sh / dh / mh / twos`) maps almost 1:1 onto
  lite-pick's roster; `sed`/`nq` are folded in above.
- **Maglev** consistent hashing is the production choice (IPVS `mh`, Meta Katran, Cilium) -- confirms the
  M8 Maglev-over-ring lean.
- **Linux CFS** load balancing is deliberately anti-greedy (imbalance thresholds, migration cost,
  `nr_balance_failed` backoff, wake-affinity) -- the source of the anti-flapping principle (section 5).
- **IBM z/OS WLM / Sysplex Distributor**: goal-oriented dynamic per-server weights, and the explicit
  note that in-sysplex (client-side) routing "has more real-time information than outboard load
  balancers" -- validation of the in-process-first thesis and the parent of an AdaptiveWeight strategy.

---

## 3. The Benchmark Suite (the ecosystem MVP)

Raw ops/ms is necessary and nowhere near sufficient for a balancer -- a fast pick that distributes badly
is worse than a slow one that distributes well. Following lite-o1's multi-dimension discipline, adapted to
selection.

### The claim we are actually proving (framing, so the table cannot be picked apart)

The differentiator is NOT "X times faster ops/sec." A hand-rolled `i++ % n` round-robin, or `wrr`, will
MATCH OR BEAT any honest strategy that does two draws + a compare (P2C, SED) on raw pick throughput -- so a
"faster than everything" headline would show lite-pick LOSING on some rows and a sharp reviewer would
discount the whole suite. The defensible, and stronger, claim is a PAIR:

1. **The contract (superiority):** 0 major GC / ~0 B/op on the steady-state pick path -- a guarantee NONE
   of the alternatives publish or can pass. This is the hard gate, not a slogan.
2. **The outcome (superiority where it matters, parity where it does not):** better BALANCE QUALITY and
   better SERVICE-LEVEL TAIL under load, at throughput PARITY with the trivial foils.

"Parity on speed, superiority on the contract and the tail" is honest and still wins. Every dimension below
serves one of those two, or is a trust gate a paying evaluator needs more than an ops/sec bar.

### Dimensions

1. **Pick throughput + flatness (parity check).** ops/ms across the pool-size sweep; O(1)/O(d) stays flat,
   an O(n) strategy decays. Foil: `i++ % n` hand-rolled round-robin. The bar here is PARITY, not a win --
   a strategy that is within noise of the trivial foil while holding the 0 B/op contract has passed.
2. **Balance quality (THE anchor -- headline chart #1, with the GC proof).** peak-to-average AND the full
   load histogram vs the strategy's theoretical ceiling (P2C: `ln ln n / ln 2`) + the random foil, under
   uniform, skewed-weight, and skewed-COST (slow-node) workloads. Proof the algorithm WORKS, independent of
   it being cheap (section 2). This is a first-class gate (`test/balance.mjs`), not a sub-bullet.
3. **GC blast-radius (the number the SRE pays for -- headline chart #2).** The point of zero-GC is NOT the
   pick's own latency; a major GC pause freezes EVERY in-flight request, so an allocating balancer raises
   the SERVICE-LEVEL p99.9 and max pause, not the pick's. Run a sustained realistic mixed workload through
   an allocating competitor vs lite-pick and report the END-TO-END tail + pause distribution. This ties the
   zero-GC contract to a business outcome and is the chart an AWS-paying evaluator has never been shown.
4. **Decision tail latency.** p50/p90/p99/p99.9/max of `pick()` itself, with and without forced GC, so a
   hidden per-pick allocation spike shows as a tall bar. (The microbench complement to dimension 3.)
5. **Failover behaviour + anti-flap (trust gate).** time/picks to route away from a node whose health bit
   drops, and to fade a recovered node back in -- does it thundering-herd the healed node, or ramp (ADR
   0002)? Includes the fail-closed proof: under adversarial eligibility churn, `pick()` NEVER returns a
   down index, ever. For someone replacing a trusted paid lib, "it never routes to a dead node" outweighs
   any throughput bar.
6. **Load-signal staleness sensitivity.** balance quality as the least-conn / EWMA feedback is delayed
   (Zalando: "tolerate a few ms of metric staleness rather than contend on a cache line"). Quantifies the
   cost of the zero-contention design choice as a LABELED trade, not a cliff.
7. **Sticky / consistent-hash disruption (trust gate).** for consistent-hash and sticky strategies:
   key-to-node stability across a scale event (add/remove a node) -- what fraction of keys keep their node.
   THE consistent-hash quality metric and the direct cache-affinity selling point. Foil: naive modulo
   hashing (which reshuffles almost everything -- the classic trap). Minimal for Maglev/ring-with-vnodes.
8. **Weighted fairness / convergence (trust gate).** does SmoothWRR actually converge to the configured
   weight ratios, and SMOOTHLY (not bursty like naive weight-expansion WRR)? A distribution-error metric
   over a run, plus a burstiness measure. Proof the weighted path is correct, not just fast.
9. **Allocation rate (B/op line).** B/op curve on the hot path under sustained load, extending the 0 B/op
   pass/fail gate into a measured line so any drift toward per-pick allocation shows up before it regresses.
10. **Bundle size + tree-shaking.** gzipped size importing ONE strategy vs several -- the "you pay for what
    you import" proof.

### Honest-cost disclosure (on-brand, like lite-o1's build/space co-headline)

The 0 B/op HOT-PATH claim is credible precisely because the cold-path costs are NAMED. The suite ships a
table stating exactly what allocates and when: construction (once), `setEligible`/reweight (cold, bounded),
consistent-hash / Maglev table build (O(n) time, O(table) space), AliasTable rebuild on reweight. Nothing
on the steady-state pick path; everything else disclosed.

### Competitive matrix (apples-to-apples, reproducible)

The SAME workload -- same seed, same pool sizes, same pick count -- for every subject. Keep the competitor
list SHARP, not padded: the three relevant incumbents (`load-balancers` for P2C, `loadbalance`, `wrr` for
WRR) plus foils we write (naive RR, `Math.random`-array, hand-rolled P2C). Quality of foil beats quantity.

Each row reports: zero-GC steady state (yes/no -- only lite-pick passes), ops/sec (parity), allocs/op, and
the balance + tail numbers. Publish the raw harness so anyone reproduces it.

### Reproducibility machinery (teeth, not intent)

"No marketing-only numbers" needs enforcement, same as the `mustFail` gate: pin competitor versions in the
lockfile; stamp Node version + CPU + OS into `benchmark/results.json`; seed every PRNG; and a `bench:verify`
that FAILS CI if the numbers quoted in the README drift from a fresh run (snapshot-test the numbers). Node
LTS + current is the CI bar; Bun and browser are a POST-1.0 axis (they dilute focus and add flaky CI for a
v1), noted, not shipped in the first suite.

`benchmark/` ships tables AND graphs, always against a hand-rolled foil and, where one exists, the incumbent
npm package. This is a planned standalone workstream (M6), as in lite-o1 -- do not fold it in piecemeal.

### Correctness methodology: the invariant-fuzz vector (the state-machine attack)

Benchmarks prove the algorithm does the RIGHT thing (balance, smoothness, tail); they do not prove it never
CORRUPTS its own state under a chaotic operation stream. For the strategies that OWN mutable state --
SmoothWRR's `_current` accumulators + `_totalEligibleWeight`, later LeastConn/BoundedLoad/AdaptiveWeight --
handcrafted sequential unit tests only cover the scenarios we imagined. The high-confidence bar for a
state-owning kernel is the one AWS / Linux / IBM actually use for schedulers and load-balance paths:
**invariants + randomised (seeded) fuzzing + long soak**, not more handwritten cases.

- **Prior art.** AWS "lightweight formal methods" (property-based testing + coverage-guided fuzzing + fault
  injection + counter-example minimisation, e.g. S3 ShardStore); the Linux scheduler selftests + syzkaller +
  `stress-ng` "never return a down CPU / never violate a load-balance invariant" checks; IBM z/OS soak
  "run it until the numbers stop moving" + data-integrity invariants; and, closest to home, **Envoy ships a
  dedicated round-robin load-balancer fuzz test** -- the same idea, expressed with a corpus instead of a seed.
- **The three vectors, mapped to lite-pick's existing machinery (two are already gates):**
  1. **Zero-GC + precision soak** -- ALREADY a gate: `torture.mjs` (`lite-gc-profiler` `measureAllocs`, 0 B/op)
     + `PerfGate.test.mjs` (`lite-perf-gate` `zgcSuite`, pinned lanes). Extend the soak to hit the Float64
     accumulator hard enough to prove the `current -= total` discipline keeps values finite and well under 2^53.
  2. **Flap / chaos torture** -- ALREADY substantially covered: each boundary suite thrashes
     `setEligible`/`setWeight` while picking (200k steps) and asserts NEVER-returns-a-down-index.
  3. **Invariant fuzzer (the net-new piece)** -- a SEEDED, property-based harness firing a randomised barrage
     of `pick`/`setEligible`/`setWeight` and asserting, after each op, the strategy's INVARIANTS -- not just
     "never down" but the STATE-SYNCHRONISATION ones our churn tests do not check. On failure it prints the
     seed for byte-for-byte replay. Two modes: strict (every op -- the real proof, since the maintained totals
     are exact after each mutation) and fast (every N, for CI speed). CI runs one FIXED seed (regression) plus
     one RANDOM seed (discovery), and a small REGRESSION CORPUS of seeds that previously found bugs.
- **The per-strategy invariants** (a reusable checker; each strategy contributes its set): `pick()` never
  returns an ineligible index; `pick()` returns `PICK_NONE` IFF the strategy's "pickable mass" is zero (all
  down, or -- SmoothWRR -- eligible-weight sum 0); every maintained aggregate stays EXACT against a manual
  recompute (`_totalEligibleWeight` == sum of eligible weights; `live` == count of eligible); owned Float64
  state stays finite (no `NaN`/`Infinity`) and integral where it should be.
- **Pathological corpus** (explicit, not random): all weights = `0xFFFFFFFF` then dropped to 0 (proves the
  Float64 accumulator absorbs a large total without crossing 2^53), all-eligible-weight-zero while `live > 0`,
  single-node, and a rapid pure-flap phase with no picks.
- **The boundary.** The fuzzer proves the kernel does not CORRUPT state; the balance/anchor gates prove it
  does the RIGHT thing. Both are required; neither substitutes for the other.

---

## 4. The Strategy Roster

`pick()` bound is stated per strategy; d = number of probes (P2C: d=2). Build order: simplest and most
broadly useful first, novel/attention strategies later.

### Tier 1 -- core roster (the first slice)

| Strategy       | pick() signature            | Bound | Why it earns a slot |
|----------------|-----------------------------|-------|---------------------|
| **RoundRobin** | `pick()`                    | O(1)  | The baseline. A single wrapping index over the eligible set. The foil-beating warm-up member and the correctness reference for the eligibility bitmap. |
| **SmoothWRR**  | `pick()`                    | O(n) over weights, O(1) amortized | nginx smooth weighted round-robin: integer `current += weight; pick max; current -= total`. Spreads weighted picks EVENLY (not bursty like naive WRR). Integer state, zero-alloc. The de-facto weighted default. |
| **P2C**        | `pick()`                    | O(d)=O(1) | The headline (section 2). Two random eligible indices, return the lower load (caller-supplied `inflight` counter). The `ln ln n` balance ceiling from one extra probe. |
| **LeastConn**  | `pick()`                    | O(d)=O(1) via P2C; O(log n) exact via lite-logn | Fewest in-flight. P2C-least-conn is the sweet spot (O(1), near-exact); exact-least-conn rides a lite-logn indexed heap (O(log n) decrease-key), offered as a labeled fallback. Counters supplied by the caller / the lite-query adapter. |
| **SED**        | `pick()`                    | O(d)=O(1) | Shortest Expected Delay (Linux IPVS `sed`): minimize `(inflight+1)/weight` -- charges the NEW request's marginal cost, subtly better than plain least-conn at low load. A weighted P2C over the SED score. |
| **NQ**         | `pick()`                    | O(d)=O(1) | Never Queue (Linux IPVS `nq`): if any endpoint is IDLE (`inflight == 0`) pick it immediately, else fall back to SED. THE in-process/worker-pool fit -- an idle worker should get work now, not by probability. |

### Tier 2 -- strong candidates (next releases)

| Strategy         | pick() signature        | Bound | Why it earns a slot |
|------------------|-------------------------|-------|---------------------|
| PeakEWMA         | `pick(now)`             | O(d)=O(1) | Latency-aware P2C: score = inflight x EWMA(rtt), pick the lower. Twitter Finagle's "peak-EWMA". A Float64Array EWMA ring per node; zero-alloc. The strategy the multi-region FE case wants. |
| ConsistentHash   | `pick(keyHash)`         | O(1) via lookup table | Karger ring OR Maglev table (Eisenbud, NSDI 2016 -- O(1) lookup, minimal disruption on membership change). Sticky routing / cache affinity. Hash is caller-supplied INTEGER (no per-pick string hashing -- the one zero-GC hazard, section 5). |
| BoundedLoad      | `pick()`                | O(d)=O(1) | P2C with a cap: skip a node whose occupancy exceeds `(1+eps) x mean` (consistent-hashing-with-bounded-loads, Mirrokni et al.; the occupancy/Little's-Law variant Zalando shipped). The overload-protection layer. |
| WeightedRandom   | `pick()`                | O(1) | Vose alias-table sampling (one PRNG draw + one compare). Rides `@zakkster/lite-o1`'s `AliasTable` directly -- do NOT re-implement it (section 6). Static weights, rebuild on reweight. |

### Tier 3 -- adjacent / layered (evaluate)

| Strategy / helper | Note |
|-------------------|------|
| AZ-aware / zone-affinity | Local-first, threshold-to-escalate -- modeled on Linux CFS **scheduler domains** (balance within SMT->socket->NUMA, escalate a level only when imbalanced), with a latency-health escape hatch (Zalando: suppress local to a 1% probe floor when local rtt drifts >35% above all-zone). A wrapper over PeakEWMA + a zone tag array, not a base strategy. |
| AdaptiveWeight (WLM-style) | Recompute per-endpoint weights from observed latency vs a TARGET (IBM z/OS WLM composite weight 0-64, goal-oriented). The feedback-driven parent of PeakEWMA/bounded-load; weights written cold, read hot (ADR 0001). A future strategy, not v1. |
| Hedging helper | Not a strategy -- a `@zakkster/lite-await` combinator that fires the P2C first choice and races the second if the first is slow past a percentile. The async expression of "power of two". Lives in the lite-await adapter. |
| Subsetting | Deterministic subset of a large pool per client (Google SRE) -- reduces connection fan-out. A cold-path pool-shaping helper, not a pick strategy. |

### The boundary -- explicitly OUT of scope (and why)

Naming the boundary is the honesty discipline. lite-pick holds the line at "the pick decision":

- **Health checking / active probing** -> `@zakkster/lite-di-health` owns liveness. lite-pick consumes it.
- **HTTP transport, retries, circuit breaking, timeouts** -> the caller / the lite-query adapter. lite-pick
  emits a decision; it never opens a socket.
- **Service discovery (DNS, Consul, k8s informers)** -> the caller feeds the pool in on the cold path.
- **Rate limiting, auth, TLS, request transformation** -> the gateway. lite-pick is not a gateway.
- **A full reverse proxy** -> a different, heavier package by nature (it allocates per request). lite-pick
  is the kernel a proxy could be BUILT on, not the proxy.

### Complementary to AWS NLB / ALB (a different layer, not a competitor)

The honest positioning for an evaluator paying for AWS Elastic Load Balancing today. lite-pick does NOT
replace an NLB or an ALB -- it lives at a hop those managed load balancers do not touch, and the two
COMPOSE.

- **AWS NLB (Network Load Balancer)** is a MANAGED, regional, edge device at OSI **layer 4**. It balances
  INBOUND connections to your fleet using a single **flow-hash** over the 5-tuple (protocol, src IP+port,
  dst IP+port), pinning a connection to one target for its duration. Protocol-agnostic above TCP, ultra-low
  latency, static IP. Billed per hour + per NLCU.
- **AWS ALB (Application Load Balancer)** is a MANAGED, regional, edge device at OSI **layer 7**. It
  terminates HTTP/HTTPS, does host/path/header routing to target groups, and balances with
  **round_robin**, **least_outstanding_requests (LOR)**, or **weighted_random with anomaly mitigation**,
  plus sticky sessions and cross-zone. Billed per hour + per LCU.
- **lite-pick** is an UNMANAGED, in-process **library** with NO layer -- it runs INSIDE a Node/Bun process
  and returns an integer index among endpoints the process ALREADY knows. It never terminates a connection,
  never inspects a packet, never opens a socket. It balances the CLIENT-SIDE / EGRESS selection hop.

The composition, concretely: inbound traffic enters through the **ALB/NLB -> your service** (the edge hop
AWS owns and bills). Then your service fans OUT -- to other microservices, DB read-replicas or shards, cache
nodes, a worker pool, per-tenant backends -- and THAT inner selection is not on any AWS load balancer's
path. Today it is a `Math.random()` array pick, a naive modulo, or the AWS SDK's own client logic. That is
exactly where lite-pick lives: the same algorithm FAMILY AWS charges for at the edge (ALB's LOR is
least-connections; ALB's weighted_random + anomaly mitigation is lite-pick's WeightedRandom + BoundedLoad;
NLB's flow-hash is ConsistentHash), brought to the in-process hop as a zero-GC, zero-dependency selector
you own, with the balance-quality and 0 B/op contract published.

Where it is genuinely an ALTERNATIVE (not just complementary): when the "load balancer" someone is paying
for is really doing CLIENT-SIDE selection -- an internal service mesh sidecar, a gRPC/xDS client policy, a
direct-to-pod fan-out, or a paid npm balancer -- lite-pick is a drop-in for that selection core. When it is
a managed ALB/NLB terminating real inbound traffic, lite-pick is complementary: it does not remove the
edge, it removes the ALLOCATION (and the naivety) of the inner hop and gives that hop the same contract.

**Confirmed field case (the first interested evaluator).** He runs MANAGED AWS NLB/ALB -- so this is the
COMPLEMENTARY case, not a replacement, and the pitch is exactly the inner hop: the ALB/NLB keeps terminating
inbound traffic; lite-pick governs how his service then fans out to its downstreams (other services / shards
/ replicas / workers), replacing whatever ad-hoc `Math.random()` / modulo / SDK-default selection sits there
today with a zero-GC selector carrying the SAME algorithm family AWS bills for at the edge (LOR = least-conn,
weighted_random+anomaly = WeightedRandom+BoundedLoad, flow-hash = ConsistentHash) plus the published
balance-quality + 0 B/op contract. The demo that lands this: a lite-query adapter (M5) doing the fan-out in
a zero-GC loop with retry re-picking a DIFFERENT node -- his current AWS bill is unchanged, his inner-hop
tail and allocation are not. Do NOT pitch it as "drop your ALB/NLB"; pitch it as "the hop your ALB/NLB never
sees".

---

## 5. The Honesty Hook

A balancer makes promises about a DISTRIBUTION and about SIGNALS that are always a little stale. State and
measure the edges, never hide them:

- **Every strategy documents its balance guarantee AND its worst input.** P2C's `ln ln n` bound assumes
  independent uniform probes; adversarial or correlated keys degrade it. SmoothWRR is only as smooth as the
  weights are accurate. The bench (dim 2) shows the degraded case, not just the happy path.
- **Load signals are eventually-consistent by design.** least-conn / EWMA feedback is read without locks
  and tolerates bounded staleness (the zero-contention choice, Zalando). Dim 6 quantifies the balance cost
  of that staleness so it is a labeled trade, not a surprise.
- **No hot-path health check.** A node marked down by lite-di-health is excluded at pick time via a bitmap
  test (O(1), zero-alloc); lite-pick NEVER blocks a pick on a probe. If the whole pool is ineligible,
  `pick()` fails closed (returns -1 / throws, caller's choice at construction) -- it does not pick a dead
  node "to be safe". null is not zero.
- **Consistent-hash disruption is disclosed.** On add/remove, some keys MUST move; the bench (dim 7)
  reports exactly how many (minimal for Maglev/ring-with-vnodes, catastrophic for naive modulo -- the foil).
- **Anti-flapping is a first-class rule (ADR 0002).** Any strategy that changes routing on a signal --
  an eligibility flip, a bounded-load redirect, an AZ escalation -- must apply hysteresis (dwell /
  threshold / backoff), never react to a single noisy sample. Borrowed from Linux CFS (imbalance
  thresholds, migration cost, `nr_balance_failed` backoff, wake-affinity) and wired to lite-statechart's
  HalfOpen dwell (the breaker) and bounded-load's `(1 + eps)` cap. A dedicated dwell test gates it.

---

## 6. Boundaries with sibling packages (no duplication)

The suite ships one clear niche per package. lite-pick is unusually COMPOSITIONAL -- most of its substrate
is already built and torture-proven elsewhere, which is the point: a year of building the lego bricks so
this one snaps together fast and reliable. Every sibling below is consumed as an OPTIONAL PEER dependency
(`peerDependenciesMeta.optional: true`, the LiteQuery model) -- NEVER inlined, NEVER forked, NEVER a hard
dep. Zero-deps law = zero HARD deps; the kernel runs over raw TypedArrays with zero peers installed, and a
peer is declared only when a shipped code path imports it. lite-pick is the policy brain wiring
proven zero-GC parts, not new low-level code.

- **lite-di-health** -- OWNS liveness/readiness. lite-pick reads its aggregated health as an eligibility
  bitmap (a node's bit off -> excluded from the pick set) and feeds observed failures back. lite-pick adds
  NO probing of its own. This is the load-bearing seam.
- **lite-o1** (v1.11.0, 21 members) -- OWNS the zero-GC O(1) substrate. lite-pick builds ON it, never
  forks it: `RandomSet` (O(1) random eligible draw for P2C -- the DYNAMIC-set draw peer: O(1)
  add/remove/sample, maintained in setEligible, the right fit for a MUTATING eligibility set),
  `SparseSet` (the eligible-node set with O(1) add/remove/clear), `AliasTable` (WeightedRandom sampling --
  reused verbatim, not re-implemented), `RingLog`/`MonoDeque` (EWMA + sliding-window latency for
  PeakEWMA/BoundedLoad). Three newer members map to specific milestones: **`Reservoir`** (Vitter's Algo R,
  O(1)/item uniform k-sampling) is the substrate for **Subsetting** (post-1.0 #4 -- pick k of N endpoints
  uniformly); **`EliasFano`** (`nextGEQ` successor over a monotone integer sequence) makes the
  **ring-with-vnodes** option for **M8 ConsistentHash** viable (a ring lookup IS a successor query), an
  alternative to the Maglev table; **`RankSelect`** (`select1(k)` = k-th set bit, worst-case O(1)) is a
  STATIC/build-once index -- attractive only for a FIXED bit pattern, NOT the mutating eligibility bitmap
  (its O(n) rebuild-on-change is the wrong tradeoff there; RandomSet is the dynamic answer). If lite-pick
  needs an O(1) structure, it comes from lite-o1.
- **lite-lru** -- OWNS bounded caches. lite-pick uses a `LiteCache` for the sticky-session affinity map
  (`sessionKey -> lastNode`, LRU-evicted, bounded) instead of an unbounded `Map` (the usual sticky-LB
  memory leak). No eviction policy is re-implemented here.
- **lite-logn** -- OWNS the O(log n) structures (Fenwick / BIT, segment tree, indexed heap, skip list).
  lite-pick routes its EXACT (non-P2C) variants here instead of hand-rolling them: **exact
  least-connections** via an indexed binary heap with O(log n) decrease-key (the labeled fallback to the
  O(1) P2C-least-conn), and **dynamic-weight weighted sampling** via a Fenwick prefix-sum tree (O(log n)
  update + O(log n) sample) -- the MUTABLE-weight complement to lite-o1's static `AliasTable` (O(1) sample,
  O(n) rebuild). Rule of thumb: fixed weights -> lite-o1 AliasTable; frequently-changing weights ->
  lite-logn Fenwick; exact fewest-in-flight -> lite-logn indexed heap; near-exact and O(1) -> P2C-least-conn.
- **lite-random** (or lite-o1's seeded PRNG idiom) -- the P2C probe draws come from an instance-local
  seeded PRNG (deterministic, `reset()`-able) so the balance benchmark is reproducible. No `Math.random`
  on a gated path if it costs determinism.
- **lite-scheduler** (`FastBitScheduler`) -- a bit-bucket TASK scheduler; NOT a balancer. lite-pick must
  not drift into scheduling, and lite-scheduler must not grow endpoint selection. Cross-link, no overlap.
- **lite-query** -- consumes lite-pick: a balancer-aware fetcher (endpoint selection + retry-to-a-DIFFERENT
  node + feeds measured rtt back into PeakEWMA). The adapter lives with lite-query or in `lite-pick/adapters`.
- **lite-await** -- consumes lite-pick: the `hedged()` combinator (race the P2C second choice when the
  first is slow). The async face of the power-of-two result.
- **lite-statechart** -- OWNS the per-endpoint CIRCUIT BREAKER (Closed/Open/HalfOpen), a zero-GC integer
  transition table. Its Open state clears the endpoint's eligibility bit; lite-pick consumes the result
  and never learns WHY a node is down (ADR 0001, Fork 3). For REMOTE endpoints this breaker (driven by
  observed failures) is the eligibility source that lite-di-health then aggregates.
- **lite-fastbit32** -- OPTIONAL peer (post-1.0, ADR 0001 Fork 5): when N <= 32 the whole eligibility set
  is one branchless word (test/set/firstSet). An internal fast path with an identical `pick()`, never a
  second public identity and never a hard dependency; >32 endpoints use the general `Uint8Array`/BitSet path.
- **lite-worker + lite-worker-pool** -- the first IN-PROCESS consumer and torture-test target. HONEST
  boundary: lite-worker-pool's `map()` already balances by WORK-STEALING (idle workers pull the next
  index), so lite-pick adds nothing to the plain stateless map. It earns its slot for STICKY/keyed dispatch
  (consistent-hash an item to a worker to keep its cache warm), PUSH/fire-and-forget dispatch (no pull
  queue), and routing across HETEROGENEOUS workers or multiple pools by live load.
- **lite-di-signal** (BE) / **lite-signal-decorators** (FE) -- the OBSERVABILITY adapter, NEVER the core.
  lite-pick holds no reactive state (ADR 0001); to EXPOSE status (per-endpoint eligibility/load, live
  imbalance) a WARM/COLD adapter mirrors the shared views into signals. For a DI service reach for
  lite-di-signal (per-scope reactive registry, deterministic teardown -- the reactivity pillar beside
  lite-di-health); for an FE dashboard reach for lite-signal-decorators (a reactive view-model class).
  Neither touches the pick path.

---

## 7. Reference Implementation: P2C (the headline strategy)

The cleanest demonstration of the whole thesis -- an O(1), zero-alloc pick with a provable balance ceiling,
built over lite-o1's `RandomSet` and a caller-owned in-flight counter, gated by lite-di-health's bitmap.

```js
/**
 * P2cBalancer -- zero-GC power-of-two-choices selection over a fixed endpoint pool.
 *
 * pick() is O(1): draw two DISTINCT eligible endpoints, return the one with the lower
 * in-flight load. One extra probe over random buys an exponential drop in peak load
 * (Azar-Broder-Karlin-Upfal 1994: max load ~ ln ln n / ln 2 vs random's ln n / ln ln n).
 *
 * Health is NOT checked here -- `eligible` is a lite-di-health-owned bitmap; a node whose
 * bit is 0 is never drawn. Load counters are caller-owned (incremented on dispatch,
 * decremented on completion), so lite-pick holds no request state. Fails closed (-1) when
 * no endpoint is eligible: null is not zero, and a dead node is never picked "to be safe".
 *
 * Steady-state pick(): two PRNG draws + up to a few rejection retries + one compare.
 * No object, closure, or array is created. Proven 0 B/op by test/torture.mjs.
 */
export class P2cBalancer {
    /**
     * @param {number} capacity  endpoint count (fixed; add/remove is a cold path)
     * @param {Uint8Array} eligible   1 = pickable, 0 = down (owned by lite-di-health)
     * @param {Uint32Array} inflight  current in-flight requests per endpoint (caller-owned)
     * @param {number} [seed=0x9e3779b9]  deterministic PRNG seed (reproducible benches)
     */
    constructor(capacity, eligible, inflight, seed = 0x9e3779b9) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("[lite-pick] capacity must be an integer >= 1");
        if (eligible.length < capacity || inflight.length < capacity) throw new RangeError("[lite-pick] eligible/inflight too small");
        this._cap = capacity;
        this._eligible = eligible;
        this._inflight = inflight;
        this._s = seed >>> 0;        // xorshift32 state, instance-local, deterministic
        this._live = capacity;       // cold-path-maintained count of eligible nodes (fast fail-closed)
    }

    /** xorshift32: one PRNG step, zero-alloc, deterministic. */
    _rand() { let x = this._s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this._s = x >>> 0; return this._s; }

    /** A uniformly random ELIGIBLE index, or -1 if none. O(1) expected (rejection sampling). */
    _draw() {
        if (this._live === 0) return -1;
        const cap = this._cap, el = this._eligible;
        // Bounded rejection: with _live/cap eligible, expected tries is cap/_live (small in practice).
        for (let tries = 0; tries < 64; tries++) {
            const i = this._rand() % cap;
            if (el[i]) return i;
        }
        // Degenerate (sparse eligibility): linear scan fallback, still zero-alloc.
        for (let i = 0; i < cap; i++) if (el[i]) return i;
        return -1;
    }

    /** Pick an endpoint index by power-of-two-choices, or -1 (fail closed). O(1). */
    pick() {
        const a = this._draw();
        if (a < 0) return -1;         // whole pool down: fail closed
        if (this._live === 1) return a;
        let b = this._draw();
        if (b === a) b = this._draw(); // one nudge toward a distinct second choice
        if (b < 0 || b === a) return a;
        // Lower in-flight wins; ties go to the first draw (unbiased over many picks).
        return this._inflight[b] < this._inflight[a] ? b : a;
    }

    /** Cold path: mark a node down/up (delegated FROM lite-di-health), keep _live exact. */
    setEligible(i, up) {
        if (i < 0 || i >= this._cap) throw new RangeError("[lite-pick] index out of range: " + i);
        const was = this._eligible[i];
        const now = up ? 1 : 0;
        if (was !== now) { this._eligible[i] = now; this._live += now ? 1 : -1; }
    }
}
```

The teaching beat: two probes, one compare, no allocation -- and the `ln ln n` ceiling from that single
extra probe is the whole "power of two" magic. The witness bench proves ops/ms stays flat as the pool
grows AND that peak-to-average tracks the theoretical bound while a one-choice random foil blows past it.

---

## 8. Experimental Direction: occupancy-based bounded load (the Zalando/Finagle hero)

The strategy with the best real-world story and the subtlest math: cap a node's share of load so P2C's
"lower of two" can never overload a slow node. Two variants worth prototyping:

- **Consistent-hashing with bounded loads** (Mirrokni, Thorup, Zadimoghaddam): sticky routing that skips a
  node once its occupancy exceeds `(1 + eps) x mean`, preserving affinity while bounding tail load.
- **Occupancy via Little's Law** (Zalando 2026): a node's cost = `concurrency x (its latency / cluster mean
  latency)`, computed from running sums over a sliding window (a lite-o1 `MonoDeque`/`RingLog`), so a slow
  pod is charged more and drained. Zalando's version cut their fleet 25%. This is the member whose Big-O is
  boring (still O(d)) but whose SIGNAL design is the interesting, teachable, benchmarkable part -- the
  lite-pick counterpart to lite-o1's UnionFind "amortized hero" slot.

The honesty hook here (section 5): occupancy is a windowed, deliberately-stale signal; the bench (dim 6)
must show it degrades gracefully, not cliff-edge, as the window widens.

---

## 9. The Integration Story (lite-pick's "demo")

lite-pick's composability IS its differentiator; the demo shows the full loop, not a bare `pick()`:

- **lite-query adapter.** A fetcher that: (1) calls `pick()` for the endpoint, (2) increments `inflight[i]`
  on dispatch and decrements on settle, (3) on failure retries against a DIFFERENT `pick()` (never the same
  dead node), (4) feeds measured rtt into PeakEWMA, (5) reads the eligibility bitmap from lite-di-health so
  a node marked down disappears from selection mid-flight. Circuit-breaking becomes "health bit off".
- **lite-await hedging.** `hedged(balancer, call, { after: p50 })` fires the first choice and races the
  second if the first has not settled by the EWMA p50 -- the async power-of-two.
- **The visual demo (later session, lite-lru style).** One seeded request stream fed to every strategy side
  by side; each panel draws live from the balancer's own `dump()` (no shadow state): the load histogram
  filling, the P2C ceiling line, and a random foil visibly piling load on one bin. The headline gauge is
  the imbalance factor (section 2), not ops/ms alone -- balance quality is what a balancer is FOR.

---

## 10. Recommended Path

1. Finalize the substrate reuse: eligibility bitmap contract with lite-di-health; `RandomSet`/`SparseSet`
   from lite-o1 for the eligible set; the caller-owned `inflight` counter convention.
2. Ship **RoundRobin** (correctness reference + eligibility bitmap) and the witness harness (section 2) on
   day one.
3. Add **SmoothWRR** (weighted default), then **P2C** (the headline + the balance-quality anchor), then
   **LeastConn** (P2C-least-conn).
4. Ship the lite-query adapter (section 9) once P2C exists -- the integration is the moat, not the algorithm.
5. **DEDICATED SESSION -- the benchmark suite (section 3):** all ten dimensions framed as "parity on speed,
   superiority on the contract + balance + tail", with the P2C ceiling, the GC blast-radius chart, the
   trust gates (disruption, weighted fairness, fail-closed), the honest-cost table, and a hand-rolled +
   `load-balancers`/`wrr` foil under the reproducibility machinery. The ecosystem MVP; do not fold in piecemeal.
6. Tier 2: PeakEWMA, ConsistentHash (Maglev), BoundedLoad (the Zalando occupancy hero), WeightedRandom
   (riding lite-o1 AliasTable).
7. Every strategy proven by `node --expose-gc test/torture.mjs` (0 B/op on the pick path) AND the
   balance-quality gate (imbalance within its bound across the workload matrix). No gate output is a FAIL.

---

## 11. Open Questions

- **Fail-closed vs fail-static.** When the whole pool is ineligible, does `pick()` return -1 (caller
  decides) or throw, and is there an opt-in "last resort: pick a down node" mode? Lean: -1 by default,
  configurable, NEVER a silent dead pick.
- **Who owns the counters?** RESOLVED (ADR 0001, Fork 4): CALLER-OWNED typed arrays, `pick()` pure-read;
  optional allocation-free `TrackedPool` wrapper ships OUTSIDE the core for DX. The lite-query adapter is
  the ergonomic layer.
- **Consistent-hash: ring-with-vnodes vs Maglev table.** Maglev gives O(1) lookup + minimal disruption but
  an O(n) build; ring is simpler but O(log n) lookup. Lean: Maglev table (fits the lite-o1 static-member
  build-once/immutable honesty contract), with disruption disclosed (dim 7).
- **Per-pick string hashing is the one zero-GC hazard.** ConsistentHash/sticky require a key hash; a JS
  string hash allocates. Resolution: require an INTEGER key (caller hashes cold, or supplies a number),
  or hash over a provided `ArrayBuffer` view -- never `hash(someString)` on the pick path. Confirm the API.
- **Eligibility bitmap ownership.** RESOLVED (ADR 0001, Fork 2): a shared `Uint8Array` WRITTEN by
  lite-di-health probes / circuit breakers, READ-ONLY to `pick()` (zero-copy, pick never calls into
  health). Circuit state is CONSUMED from lite-statechart (Fork 3), never built into the kernel.
- **How much does the FE case actually want?** The browser use is resilience (failover across a few known
  origins) + latency-aware choice, NOT zero-GC (a browser picks a handful of times/sec). Consider a
  documented "FE profile" (PeakEWMA + health, no bounded-load/AZ machinery) so the FE story stays honest
  and small, per the client-side-LB caveats (CORS, topology exposure, browser caching).

---

*First-pass research reference for the lite-pick project, modeled on lite-o1/RESEARCH.md. Consolidates the
selection-kernel identity, the balance-quality anchor, the strategy roster with its explicit boundary, the
sibling-composition seams (lite-di-health, lite-o1, lite-lru, lite-logn, lite-query, lite-await), a reference
P2C implementation, and the integration story. Internal document; fold the user's notes in as authoritative
at planning time.*
