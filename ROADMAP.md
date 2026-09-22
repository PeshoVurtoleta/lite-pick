# lite-pick -- from-zero build roadmap (M0 scaffold, M1-M10 to 1.0.0)

A FEATURE roadmap for a NEW package: `@zakkster/lite-pick`, a zero-GC load-balancing
selection kernel. Modeled on `../BLUEPRINT_ROADMAP.md` (the session-brief blueprint)
and on `../LiteO1/ROADMAP.md`'s member-accounting discipline. Sourced from this
package's `RESEARCH.md` (2026-09-22). One strategy per session, simplest and most
broadly useful first; the integration adapter and the benchmark suite are their own
sessions, as in lite-o1.

**Why it exists.** The npm landscape has old algorithm libs (`load-balancers` ~7yr
stale, `loadbalance`, `wrr`) and heavy full proxies, but NO package that ships a
provably zero-GC pick path with a measured balance-quality anchor. lite-pick fills
that gap AND -- its real moat -- composes natively with lite-di-health (liveness),
lite-o1 (the O(1) substrate), lite-logn (exact O(log n) variants), lite-lru (sticky
affinity), lite-query (the fetcher), and lite-await (hedging). It is the policy brain
wiring proven zero-GC parts, not new low-level code.

| Session | Deliverable | Version | Bound | State |
| --- | --- | --- | --- | --- |
| **M0** | Scaffold + substrate seams (no strategy) | 0.0.1 | -- | SHIPPED |
| **M1** | **RoundRobin** + witness/balance harness | 0.1.0 | O(1) | SHIPPED |
| **M2** | **SmoothWRR** (nginx smooth weighted RR) | 0.2.0 | O(cap) | SHIPPED |
| **M3** | **P2C** (the headline + balance anchor) | 0.3.0 | O(d)=O(1) | planned |
| **M4** | **LeastConn family** (P2C-least-conn, SED, NQ; lite-logn exact fallback) | 0.4.0 | O(1) / O(log n) exact | planned |
| **M5** | **lite-query adapter** (the integration moat) | 0.5.0 | -- | planned |
| **M6** | **Benchmark suite** (ecosystem MVP: balance + GC blast-radius headlines, trust gates, vs-AWS positioning) | 0.6.0 | -- | planned |
| **M7** | **PeakEWMA** (latency-aware P2C) | 0.7.0 | O(d)=O(1) | planned |
| **M8** | **ConsistentHash** (Maglev table) | 0.8.0 | O(1) lookup | planned |
| **M9** | **BoundedLoad** (occupancy / Little's Law) | 0.9.0 | O(d)=O(1) | planned |
| **M10** | **WeightedRandom** (rides lite-o1 AliasTable) + docs/GUIDE capstone | 1.0.0 | O(1) | planned |

**1.0.0 = eight strategies (RoundRobin, SmoothWRR, P2C, LeastConn, PeakEWMA,
ConsistentHash, BoundedLoad, WeightedRandom) + the lite-query adapter + the two-round
benchmark suite + the docs/GUIDE capstone.** "Complete for now", not "closed" -- AZ-aware
routing, the lite-await hedging combinator, and subsetting are queued post-1.0.

---

## 0. Preflight -- single-file accounting (do this before appending each strategy)

lite-pick is a SINGLE-FILE library (suite law): every strategy is a class appended to
`Pick.js`, and each release touches the SAME fixed set of registration sites. Adding a
strategy means editing all of them in one pass -- a missed site is how a strategy ships
witnessed-but-unbenchmarked, or typed-but-untortured.

| # | Site | What a new strategy adds |
| --- | --- | --- |
| 1 | `Pick.js` | the appended `export class <Strategy>Balancer` (+ any module-level `const`) |
| 2 | `Pick.js` header comment | the strategy-count word + roster list |
| 3 | `Pick.js` `VERSION` | bump (one of three version sites) |
| 4 | `package.json` `version` | bump (site two) + `description` roster + `keywords` |
| 5 | `llms.txt` | API surface + version stamp (site three -- three-place sync) |
| 6 | `Pick.d.ts` | the typed export |
| 7 | `test/types/pick.test-d.ts` | a type-level smoke of the new export |
| 8 | `test/<Strategy>.test.js` | the boundary + behaviour suite |
| 9 | `test/torture.mjs` | import + retention (lite-leak) + 0 B/op hot-path phase (lite-gc-profiler) |
| 10 | `test/perf/PerfGate.test.mjs` | node:test-native HARD zero-alloc gate (lite-perf-gate `zgcSuite`) + a `mustFail` teeth-check |
| 11 | `test/witness.mjs` | pick throughput + flatness gate |
| 12 | `test/balance.mjs` | imbalance vs the strategy's ceiling + random foil (the anchor gate) |
| 13 | `benchmark/Matrix.mjs` (+ M6 `GcBlastRadius.mjs`, `Disruption.mjs`, `Fairness.mjs`, `Report.mjs`, `results.json`) | `SUBJECTS` + foil map + dimension flags; the M6 session adds the blast-radius / disruption / fairness dimensions + the seeded, version-stamped report |
| 14 | `README.md` + `CHANGELOG.md` + `decisions/00NN-*.md` | the docs + the ADR |

`npm pack --dry-run` must exclude `test/`, `benchmark/`, `demo/`, and `decisions/`, and
include only the `files[]` entries. Published metadata (`homepage`/`repository`/`bugs`)
points at `PeshoVurtoleta/lite-pick` -- set it at M0 and verify it stays clean.

---

## 1. The substrate seams -- SETTLED (decisions/0001-selection-kernel-boundary.md)

Load-bearing and shared by every strategy. The five ownership forks are RATIFIED in ADR 0001
(in-process-first; shared read-only eligibility; breaker consumed not built-in; caller-owned
counters; one bitmap path with fastbit32 later). M0 wires them; it does not re-litigate them.

- **Eligibility bitmap (lite-di-health seam).** A `Uint8Array` (1 = pickable, 0 = down)
  WRITTEN by lite-di-health, READ by every `pick()`. Zero-copy shared buffer; pick never
  calls into health. lite-pick keeps a cold-path `_live` count for O(1) fail-closed.
- **In-flight / rtt counters (caller-owned).** `Uint32Array` inflight + `Float64Array`
  rtt/EWMA, passed in at construction. The kernel holds no request state; the lite-query
  adapter (M5) provides the ergonomic increment/decrement layer.
- **lite-o1 reuse (never fork, never vendor).** `RandomSet` (O(1) random eligible draw for
  P2C), `SparseSet` (eligible set with O(1) add/remove), `AliasTable` (WeightedRandom, M10),
  `MonoDeque`/`RingLog` (sliding-window latency for PeakEWMA/BoundedLoad). Consumed as an
  OPTIONAL PEER dependency (`peerDependenciesMeta.optional: true`), NOT inlined and NOT a
  hard dep: zero-deps law = zero HARD deps, and the suite composes via optional peers (the
  LiteQuery model). The kernel runs over raw TypedArrays with zero peers present; a peer is
  declared only when a shipped code path imports it -- lite-o1 lands at M3 (P2C), not before.
- **Deterministic PRNG.** Instance-local xorshift32 (seed arg, `reset()`), so the balance
  benchmark (the anchor) is reproducible. No `Math.random` on a gated path.
- **Fail-closed contract.** Whole pool ineligible -> `pick()` returns -1 by default
  (configurable throw); NEVER a silent dead pick. null is not zero.

---

## 2. Design calls to settle per session (lifted from RESEARCH.md, so they are not a surprise)

- **M1 RoundRobin:** SETTLED (ADR 0003) -- Option A, the stateless bitmap forward-scan
  (owns only a cursor, reads the one shared eligibility view). Option B (a lite-o1
  SparseSet of eligibles, an optional peer) is revisited at M3 when P2C needs the random
  eligible draw. Foil: `i++ % n` (eligibility-blind -> the dead-pick trap RR avoids).
- **M2 SmoothWRR:** SHIPPED (ADR 0004). nginx smooth algorithm (`current += weight; pick
  max; current -= total`), the weighted default. Weights are the caller's Uint32Array, the
  balancer the sole writer via cold `setWeight`; Float64 accumulators; eligibility toggles
  reset the accumulator (epoch-bounded, anti-flap). O(cap) per pick (NOT O(1) -- corrected),
  0 B/op. Foil: naive weight-expansion WRR (bursty) -- beaten on smoothness (max-run 3 vs 10
  for weights [10,3,2,1]) at exact fairness. The witness gained a per-strategy complexity
  flag ('linear' asserts flat work-rate ops/ms*n).
- **M3 P2C:** rejection-sample two DISTINCT eligible draws vs draw-from-RandomSet; the
  distinct-second-choice nudge policy; tie-break (lean: first draw wins, unbiased over
  many picks). The balance-quality gate (imbalance vs `ln ln n / ln 2`) lands here.
- **M4 LeastConn family** (the IPVS lc/wlc/sed/nq cohort, made zero-GC): P2C-least-conn (O(1))
  is the default; **SED** minimizes `(inflight+1)/weight` (IPVS `sed` -- charges the new request's
  marginal cost); **NQ** ("never queue", IPVS `nq`) sends to an IDLE endpoint immediately if one
  exists, else falls back to SED -- the best fit for the in-process/worker-pool case. The EXACT
  fewest-in-flight variant routes to a lite-logn indexed heap (O(log n) decrease-key), NOT an O(n)
  scan -- confirm the seam. All three ride the caller-owned `inflight`/`weight` views (ADR 0001).
- **M5 lite-query adapter:** counters caller-owned arrays vs kernel hooks (lean: arrays +
  adapter ergonomics). Retry MUST re-pick a DIFFERENT node; rtt feeds PeakEWMA (M7).
  Home: `lite-pick/adapters` vs the lite-query repo -- decide with the user.
- **M6 benchmark suite:** all TEN dimensions (RESEARCH section 3), framed as "parity on
  speed, superiority on the contract + balance + tail" -- NOT "X times faster" (a trivial
  RR/wrr foil matches P2C on raw ops/sec; a speed-superiority headline shows lite-pick
  losing rows and gets the whole suite discounted). The two headline charts are (1) the
  balance-quality anchor vs the P2C ceiling + random foil, and (2) the GC blast-radius:
  SERVICE-LEVEL p99.9 + max pause under a sustained mixed workload, allocating competitor
  vs lite-pick (a major GC pause freezes every in-flight request, so this is the number a
  paying/AWS evaluator actually cares about). Plus the trust gates -- consistent-hash
  disruption on a scale event, weighted-fairness convergence, and fail-closed-under-churn
  (never a dead pick) -- an honest-cost disclosure table (what allocates on the COLD path,
  so the 0 B/op hot-path claim is bounded and credible), and the "vs AWS NLB/ALB
  (complementary, not a competitor)" positioning (RESEARCH section 4: ALB's LOR =
  least-conn, ALB weighted_random+anomaly = WeightedRandom+BoundedLoad, NLB flow-hash =
  ConsistentHash -- the same family, at the in-process hop AWS does not bill). Competitor
  list stays SHARP (`load-balancers`, `loadbalance`, `wrr` + foils we write), never padded.
  Reproducibility has TEETH: pinned competitor versions, Node/CPU/OS stamped into
  `results.json`, every PRNG seeded, and a `bench:verify` that FAILS CI if README numbers
  drift from a fresh run. Node LTS + current is the CI bar; Bun/browser is a post-1.0 axis.
  Dedicated session; do not fold in piecemeal.
- **M7 PeakEWMA:** EWMA half-life; score = inflight x ewmaRtt; the Float64Array ring
  substrate (lite-o1). The documented "FE profile" (PeakEWMA + health only) is defined here.
- **M8 ConsistentHash:** Maglev table (O(1) lookup, minimal disruption, O(n) build --
  fits lite-o1's static build-once contract) vs ring-with-vnodes. Lean Maglev -- it is the
  in-kernel/production choice (Linux IPVS `mh`, Meta Katran, Cilium). Key MUST be an integer /
  buffer view -- NO per-pick string hashing (the one zero-GC hazard). Disruption disclosed.
- **M9 BoundedLoad:** consistent-hashing-with-bounded-loads (eps cap) vs occupancy/Little's
  Law (Zalando). Windowed staleness is a labeled trade (bench dim 5), not a cliff.
- **M10 WeightedRandom:** rides lite-o1 `AliasTable` verbatim (O(1) sample, O(n) rebuild);
  dynamic-weight callers are pointed at a lite-logn Fenwick instead. Docs/GUIDE capstone.

---

## 3. Gates (every session, no exceptions)

The zero-GC proof is TWO complementary tools, kept separate exactly as lite-o1 does
(torture-harness skill) -- one soak-tester, one node:test-native hard gate:

- **Torture soak:** `node --expose-gc test/torture.mjs` -- TWO jobs, kept apart:
  - **@zakkster/lite-leak** -- RETENTION: `createLeakTracker(...)`; a balancer instance
    owns no external kernel, so `tracker.size() -> 0` after a build/run/reset churn is the
    proof nothing is retained by an accidental global.
  - **@zakkster/lite-gc-profiler** -- BUDGET: `GcProfiler` / `checkNoGc` / `measureAllocs`
    over the hot `pick()` path -- 0 B/op, `maxMajor 0`, `maxPauseMs <= 2`.
  - ENTRY CONTRACT (copy lite-o1): fail fast if `globalThis.gc` is absent (remedy, not a
    stack trace); import the two devDeps AFTER the guard so a fresh clone that skipped
    `npm install` fails with a fix-it message.
- **Hard perf gate:** `node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs`
  -- **@zakkster/lite-perf-gate** `zgcSuite`: scavenge-scaling at N and k*N with the old-gen and
  external/arrayBuffers lanes PINNED to 0, plus a `grows` counter (the eligibility/score buffers'
  byteLength) that must show a 0 delta (fixed capacity never reallocates). MUST include a
  `mustFail` scenario (e.g. a `pick()` variant that builds a fresh array per call) that TRIPS the
  gate -- proving the instrument has teeth. This is the node:test-native COMPLEMENT to torture.
- **Throughput witness:** `test/witness.mjs` -- pick ops/ms stays within its flatness floor
  across the pool-size sweep (O(1)/O(d) does not decay with n).
- **Balance quality (the anchor):** `test/balance.mjs` -- measured peak-to-average within
  the strategy's theoretical bound across the workload matrix (uniform / skewed-weight /
  skewed-cost), and strictly better than the random foil where the strategy claims to be.
- **Anti-flapping (ADR 0002):** where a strategy changes routing on a signal (eligibility flip,
  bounded-load redirect, AZ escalation), a dwell/hysteresis test asserts a single noisy sample
  does NOT flip the decision -- no ping-pong.
- **Fail-closed under churn (the trust gate):** under adversarial eligibility churn (nodes flipped
  down/up between picks, up to and including all-down), `pick()` NEVER returns a down index and
  returns `PICK_NONE` when the pool is empty -- proven per strategy. For an evaluator replacing a
  trusted paid lib, "never routes to a dead node" outweighs any ops/sec bar. (Boundary suite.)
- **Pipeline:** planner -> coder -> reviewer -> qa. Reviewer REJECTED goes back to coder.
- **Release:** `/release <semver>` -- version-site sync (three places), changelog, prepublish
  gate; card sync after. User commits/publishes.

---

## 4. Post-1.0 queue (drafted, greenlit one at a time, like every strategy before)

| Session | Deliverable | Why | Version |
| --- | --- | --- | --- |
| Post-1.0 #1 | **lite-worker-pool integration** (sticky/keyed + push dispatch) | The in-process consumer beyond work-stealing: consistent-hash an item to a worker (warm caches), push/fire-and-forget dispatch, routing across heterogeneous pools. Doubles as the integration torture test. | 1.1.0 |
| Post-1.0 #2 | **lite-await hedging combinator** (`hedged()`) | The async power-of-two: race the P2C second choice past a percentile. The lite-await face of the kernel. | 1.2.0 |
| Post-1.0 #3 | **AZ-aware / zone-affinity** wrapper (sched-domains model) | Local-first, threshold-to-escalate -- modeled on Linux CFS scheduler domains (SMT->socket->NUMA, escalate a level only when imbalanced) with a latency-health escape hatch (Zalando: suppress local to a 1% probe floor at >35% rtt drift). A wrapper over PeakEWMA + a zone tag array. | 1.3.0 |
| Post-1.0 #4 | **Subsetting** (Google SRE deterministic subset) | Cap connection fan-out from a large client set to a large pool. A cold-path pool-shaping helper. | 1.4.0 |
| Post-1.0 #5 | **The visual demo** (lite-lru style) | One seeded stream -> every strategy side by side, drawn from `dump()`; headline gauge = imbalance vs the P2C ceiling, with a random foil piling load on one bin. | 1.5.0 |
| Post-1.0 #6 | **AdaptiveWeight** (WLM-style goal/feedback) | Recompute per-endpoint weights from observed latency vs a target (IBM z/OS WLM composite weight 0-64). The feedback-driven parent of PeakEWMA/bounded-load; a Tier-3 strategy. Weights written cold, read hot -- ADR 0001 ownership. | 1.6.0 |
| Post-1.0 #7 | **Observability adapter** (lite-di-signal) | Expose balancer status (per-endpoint eligibility/load, live imbalance) as DI-wired reactive signals/computeds with deterministic teardown -- the reactivity pillar beside lite-di-health. FE dashboards use lite-signal-decorators instead. WARM/COLD only, never the pick path. | 1.7.0 |
| Optional peer | **lite-fastbit32 small-pool fast path** | N <= 32 eligibility in one branchless word; internal optimization, identical `pick()`, opt-in/auto. ADR 0001 Fork 5 (most reversible fork, deferred by design). | any |

---

*First-pass build roadmap for lite-pick, modeled on lite-o1/ROADMAP.md + the suite
blueprint. Turns RESEARCH.md's strategy roster into one pipeline session each, substrate
and benchmark suite as dedicated sessions. Name SETTLED: LitePick (@zakkster/lite-pick).
Ownership forks SETTLED: decisions/0001-selection-kernel-boundary.md. Still open before M0:
the M5 lite-query adapter home (lite-pick/adapters vs the LiteQuery repo).*
