# Changelog

All notable changes to `@zakkster/lite-pick` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-23

The **roster-complete** release: ten selection strategies + the `/pool` request layer + the benchmark
suite + the docs/GUIDE capstone. Roster complete **for now, not closed** -- AZ-aware routing, the
lite-await hedging combinator, and subsetting are queued post-1.0 (see [ROADMAP.md](./ROADMAP.md)).

### Added

- **`WeightedRandomBalancer` (M10)** -- O(1) weighted-random selection via an inline **Vose/Walker alias
  table** (one column draw + one probability compare -> a candidate) with **rejection-sampling
  eligibility** (retry an ineligible candidate up to a bounded 64, then a 0-B/op rotated linear eligible
  scan) -- the ADR 0005 / P2C discipline. The alias table is built **cold** over the eligible-independent
  weights, so a **weight-0 node is never a column** (never returned) and rejecting the ineligible draws
  **renormalizes** the weight distribution over the surviving eligible mass (each eligible node's share
  converges to `weight[i] / sum(eligible weights)`). `weights` is the caller's `Uint32Array` (the
  SmoothWRR/SED seam); the balancer is the **sole writer** of its derived table (`_prob` / `_alias`) via
  cold `setWeight` / `rebuild` -- an eligibility flap **never** rebuilds (anti-flap). Validates
  typeof-first before allocating the table. `pick()` is **O(1)**, **0 B/op**, never throws; `PICK_NONE`
  only when `live === 0` or no eligible node has a positive weight. It is the **stateless** O(1) weighted
  sampler (no accumulator to desync) for very large pools where SmoothWRR's O(cap) scan hurts -- trading
  smoothness for sampling variance. `peerDependencies` stays `{}` (the Vose build is inlined; a lite-o1
  `AliasTable` and a lite-logn Fenwick tree are deferred optional peers, imported by nothing).
  ([ADR 0012](./decisions/0012-weightedrandom.md)).
- **Fairness anchor** (`test/balance.mjs`) -- n=64, skewed weights [1..16], 8e6 seeded draws: every node's
  observed share is within **2% relative** of `weight[i]/sum` (measured worst ~0.84%), and a cumsum-linear
  O(n) foil matches the same fairness. The O(1) alias sample beats that O(n) foil by **~107x ops/ms** at
  n=4096 (gate: >=3x). Under half the pool down (1e6 picks): **0 ineligible / 0 weight-0** returns,
  survivor shares within **3% relative** of `weight[i]/sum(eligible)` (measured worst ~1.77%), and all-zero
  weights -> `PICK_NONE`. Thresholds are the sampling-variance floor from a correct run (N sized so the
  band holds with margin) -- the band is never widened to pass.
- **`GUIDE.md`** -- the "which of the ten strategies do I pick?" decision guide (a decision tree + table
  keyed by keyed-vs-load-vs-latency-vs-weighted, O(1) vs O(cap), state owned, and when each wins),
  distinct from `RECIPES.md` (how-to wiring). Added to the published `files[]` (the tarball is now 11 files).
- Gates extended for the new strategy: `test/WeightedRandom.test.js` boundary + behaviour suite;
  `test/fuzz.mjs` keyed-agnostic subject + `checkWeightedRandom` (structural + no-weight-0-column + the
  sum-reconstruction invariant, after every op) + a 1000-flap **0-rebuild** anti-flap assertion;
  `test/torture.mjs` retention + a `pick()` 0 B/op phase (phase 14); `test/perf/PerfGate.test.mjs`
  `weightedRandomPick` zero-alloc scenario + a boxed `mustFail` tooth; `test/witness.mjs` 'const'
  flat-work subject; `benchmark/Matrix.mjs` throughput + fairness subject; `benchmark/Report.mjs`
  Weighted-random parity row now times `WeightedRandomBalancer` vs `wrr` (both O(1) weighted-random --
  previously a pending SKIP); `Pick.d.ts` + `test/types/pick.test-d.ts` typed surface.

### Changed

- **`Pick.js` header roster/count** nine -> **ten**, and the `VERSION` stamp `0.9.0` -> `1.0.0` (the
  three-place sync: `package.json`, the `VERSION` const, `llms.txt`). This session appends **one** class;
  every other strategy in `Pick.js` is byte-identical.
- **`package.json`** version `1.0.0`, the description roster gains WeightedRandom + a GUIDE.md pointer,
  keywords gain `alias-method` / `vose` (`weighted-random` was already present), and `files[]` gains
  `GUIDE.md`. `peerDependencies` stays `{}`.
- Sibling boundary documented explicitly (so 1.0.0's WeightedRandom does not look duplicative with
  `@zakkster/lite-random`): lite-random is a **game RNG** returning an item, not eligibility-aware, no
  reusable table; lite-pick WeightedRandom returns an endpoint index, honours the shared eligibility
  bitmap (fail-closed), and owns a persistent alias table -- different domain, not a peer (GUIDE.md,
  llms.txt, ADR 0012).

## [0.9.0] - 2026-09-23

### Added

- **`BoundedLoadBalancer` (M9)** -- **Consistent Hashing with Bounded Loads** (CHBL: Mirrokni et al.,
  Google Research; Vimeo's `eps = 0.25`). It **extends `ConsistentHashBalancer`** (the Maglev table) and
  adds a per-backend occupancy cap `cap = (1 + eps) x _total / live`: `pick(keyHash)` sticks a key to its
  hashed home **unless** that backend is over cap, in which case the request **overflows** along the same
  bounded forward-probe to the next eligible, under-cap backend. If none in the probe window is under cap
  it falls back to the first eligible seen (**sticky wins; the cap is a soft preference, never a dead
  pick**); `_total === 0` skips the cap entirely, behaving as pure consistent hashing. This keeps
  consistent hashing's stickiness + minimal disruption **and** adds the **hotspot protection** plain
  consistent hashing lacks. The Maglev build, probe walk, and `setWeight` / `rebuild` / `tableSize` are
  reused verbatim. The running occupancy sum `_total` is **balancer-owned** (starts at 0) and written
  **solely** via the warm `note(i, delta)` seam (dispatch `+1` / settle `-1`), so the cap's mean stays
  O(1)-current without a scan; `inflight` is the caller's `Uint32Array`, read **live** as the per-backend
  occupancy. `pick()` and `note()` are both **O(1)** / **0 B/op**. `eps` is validated typeof-first
  (TypeError non-number, RangeError non-finite / `<= 0`) before the table is allocated; `note()` validates
  `i` in range and `delta` as an integer, and clamps `_total` at 0. `totalInflight` exposes `_total`.
  `PICK_NONE` only when no eligible backend is reachable within the probe window -- **never** for
  over-cap (fail open on overload). **Contract:** the mirrored inflight counter is mutated **only** through
  `note()` / the `/pool` adapter -- direct mutation desyncs `_total` (UB, the SmoothWRR-weights asymmetry).
  ([ADR 0011](./decisions/0011-boundedload.md)).
- **The pivot** (ADR 0011): the first M9 draft built the "overload" reading -- P2C-over-inflight with a
  `(1 + eps) x mean` cap -- and it was proven **byte-identical to plain P2C** (an under-cap draw always
  has lower inflight than an over-cap one, so "prefer under-cap" and "lower-of-two" pick the same node).
  The cap is only *load-bearing* when the primary choice is a **hash**, so M9 is CHBL -- the algorithm
  the roadmap cited. The P2C-with-cap reading is withdrawn as non-distinct.
- **Hotspot anchor** (`test/balance.mjs`) -- 64 backends, a Zipfian-skewed key stream (6 hot keys, 85% of
  traffic), a fixed concurrency window: plain ConsistentHash pins a hot key on one backend -- measured
  **max occupancy 129** vs a mean of **10** (a ~13x hotspot) -- while CHBL's cap holds **max occupancy 13**
  (`cap = (1 + eps) x mean = 12.5`) by overflowing to neighbours, materially below ConsistentHash's max
  (the foil FAILS the bounded-occupancy band). Both keep **~1.55%** minimal disruption on a scale event
  (`<= 2/N`). Thresholds are measured from a correct run with a small margin and noted -- the impl is
  never bent to a number.
- Gates extended for the new strategy: `test/BoundedLoad.test.js` boundary suite (ctor + eps validation,
  sticky same-key routing, overflow when a home is over cap, fail-open, PICK_NONE only pool-down,
  pure-ConsistentHash when `_total === 0`, `note()` validation + clamp, `totalInflight` tracking, minimal
  disruption, a Pool `opts.key` net-zero round-trip); `test/fuzz.mjs` keyed note-driven subject +
  `checkBoundedLoad` (`totalInflight === sum(inflight)` after every op) + the ConsistentHash structural
  invariant; `test/torture.mjs` retention (small-instance CHBL loop) + `pick(keyHash)` and `note()` 0 B/op
  phases; `test/perf/PerfGate.test.mjs` `boundedLoadPick` + `boundedLoadNote` zero-alloc scenarios + a
  `mustFail` alloc tooth; `test/witness.mjs` O(1) const flat-work keyed subject; `benchmark/Matrix.mjs`
  subject (dims throughput/balance/gc over the skewed-cost workload); `Pick.d.ts` +
  `test/types/pick.test-d.ts` typed surface.

### Changed

- `Pool.run` gains an **inert-unless-duck-typed `note` hook** (mirror each dispatch as `note(i, +1)` and
  each settle as `note(i, -1)`, net-zero per run) paralleling the PeakEWMA `recordRtt` wiring, and an
  **`opts.key`** option -- when supplied, Pool drives `pick(key)` (keyed / CHBL routing); failover
  re-picks with the same key, and because the failed backend's occupancy stays elevated a CHBL re-pick
  naturally overflows to the next backend. All hooks are inert when not applicable -- Pool stays generic,
  in-flight stays net-zero, abort/failover unchanged.
- `Pick.js`: STRATEGY-APPEND only -- the other eight strategies are **byte-identical**; the sole changes
  are the header roster/count (eight -> nine), the `VERSION` bump, and the appended `BoundedLoadBalancer`
  (which **extends `ConsistentHashBalancer`**, reusing its Maglev build + probe verbatim; ConsistentHash
  itself is unchanged).
- `VERSION` bumped 0.8.0 -> **0.9.0** across the three sync sites (package.json, `Pick.js`, llms.txt);
  package `description` roster updated (keywords already carried `bounded-load`). `peerDependencies`
  stays `{}` (CHBL reuses M8 -- imports nothing new).

## [0.8.0] - 2026-09-23

### Added

- **`ConsistentHashBalancer` (M8)** -- sticky / cache-affinity routing via a prebuilt **Maglev
  lookup table** (the in-kernel/production choice: Linux IPVS `mh`, Meta Katran, Cilium).
  `pick(keyHash)` maps a caller-supplied **integer** key to a backend (`slot = keyHash % M`, a table
  read, and a bounded forward-probe past down slots) -- **O(1)**, **0 B/op**. The key is coerced
  `>>> 0` (NaN -> 0) and `pick` never throws (fail-closed). Per-pick *string* hashing is the one
  zero-GC hazard, so callers hash string keys themselves (cold); `lite-pick` adds **no hashing
  dependency**. The balancer owns the lookup `Uint32Array` (`M x 4` bytes -- ~256KB at the `65537`
  default `M`, a disclosed **cold** one-time allocation; `M` is configurable down for small pools)
  and an internal weights array; `setWeight(i, w)` / `rebuild()` rebuild the table cold, while a
  **health flap never rebuilds** -- the bounded probe (<= 64 slots) absorbs it. Weighted Maglev
  populate gives each backend a per-backend slot quota proportional to its weight (unweighted = equal).
  Fails closed (`PICK_NONE`) when the pool is down or no eligible backend is reachable within the bound.
  Exports `CH_DEFAULT_M` (65537) and `CH_PROBE_LIMIT` (64) alongside the class. ([ADR 0010](./decisions/0010-consistenthash.md)).
- **Minimal-disruption anchor** -- removing 1 of 64 backends remaps only **~1.6%** of keys (`test/balance.mjs`,
  `benchmark/Disruption.mjs`), versus the naive-modulo foil's **~98%**. `benchmark/Disruption.mjs`
  replaces its M6 explicit ConsistentHash **SKIP** row with a real measured Maglev row (vs the modulo
  foil and the `1/n` ideal); `benchmark/results.json` + the README fences regenerated (bench:verify green).
- Gates extended for the new strategy: `test/ConsistentHash.test.js` boundary suite; `test/fuzz.mjs`
  keyed subject + `checkConsistentHash` / `reachableWithinBound` invariants; `test/torture.mjs` retention
  + a `pick(keyHash)` 0 B/op phase (build excluded, cold); `test/perf/PerfGate.test.mjs`
  `consistentHashPick` scenario + a `mustFail` alloc tooth; `test/witness.mjs` O(1) const flat-work
  subject; `benchmark/Matrix.mjs` subject; `Pick.d.ts` + `test/types/pick.test-d.ts` typed surface.

### Changed

- `Pick.js`: STRATEGY-APPEND only -- the other seven strategies are **byte-identical**; the sole
  changes are the header roster/count (seven -> eight), the `VERSION` bump, and the appended
  `ConsistentHashBalancer` (+ the `chMix32` / `chIsPrime` cold helpers and the `CH_*` constants).
- `VERSION` bumped 0.7.2 -> **0.8.0** across the three sync sites (package.json, `Pick.js`, llms.txt);
  package `description` + `keywords` (added `consistent-hash`, `sticky`) updated. `peerDependencies`
  stays `{}` (the deferred `@zakkster/lite-filter` hot-key-oracle and `@zakkster/lite-o1` `EliasFano`
  ring seams import nothing until a shipped path uses them).

## [0.7.2] - 2026-09-23

### Added

- `RECIPES.md` -- a beginner-to-advanced usage guide that builds the selection kernel up into a
  real load balancer (health/eligibility wiring, caller-owned in-flight counters, the
  dispatch/settle loop, `/pool` failover, PeakEWMA rtt feedback, the FE profile, a strategy
  decision table, suite composition, zero-GC discipline, and gotchas). Added to the published
  package (`files[]`) and linked from the README.

Docs-only release: no source or behavior change from 0.7.1 (the `VERSION` stamp is bumped for the
three-place sync).

## [0.7.1] - 2026-09-23

### Fixed

- PeakEWMA cold-start / unsampled-node scoring under real large-magnitude clocks. An unsampled node
  now scores at its UNDECAYED baseline (`_stamp` initialized to a negative sentinel, read as the
  1.0 baseline) = graceful least-connections, instead of `exp(-now/tau)` underflowing to 0 and
  collapsing a cold pool to random selection. The FIRST `recordRtt` sample now initializes the EWMA
  EXACTLY to the sample (clock-magnitude-independent); the Finagle peak rule applies from the second
  sample on. `pick()` stays a pure 0 B/op read (a per-candidate sentinel compare, no allocation).

### Changed

- Completes the 0.7.0 packaging: synced the `llms.txt` version stamp, added the PeakEWMA
  README / CHANGELOG sections + `decisions/0009-peakewma.md`, and regenerated the benchmark
  `results.json`. Documented that `pick(now)` / `recordRtt` require a FINITE `now` -- `recordRtt`
  throws on a non-finite argument; `pick(now)` never throws (fail-closed) and degrades a non-finite
  `now` to P2C-random selection. No API or behavior change beyond the cold-start fix.

## [0.7.0] - 2026-09-23

M7: `PeakEwmaBalancer` -- latency-aware power-of-two-choices (Twitter Finagle's peak-EWMA). A
STRATEGY-APPEND session: one class is added to `Pick.js`; the other strategies are byte-identical,
only the header roster/count and the `VERSION` stamp change. `peerDependencies` stays `{}`.

### Added

- `PeakEwmaBalancer extends BalancerBase` (`Pick.js`, `Pick.d.ts`) -- `new PeakEwmaBalancer(capacity,
  eligible, inflight, tauNs, seed?)`. `pick(now)` draws two distinct eligible endpoints (reusing
  `P2cBalancer`'s rejection-sampling `_draw`) and returns the lower `cost = (inflight + 1) x
  ewmaAt(now)`, tie to the first draw; `O(d)=O(1)`. `ewmaAt(i, now)` decays ON READ
  (`_ewma[i] * exp(-(now - _stamp[i]) / tau)`), so `pick()` never writes and is **0 B/op**.
  `recordRtt(i, sampleNs, now)` is the warm feedback path (the Finagle peak rule: snap up to a
  larger sample, decay down over `~tau`), also **0 B/op** on the success path. `now` / `sampleNs`
  are caller-supplied nanoseconds. The EWMA state (`_ewma` / `_stamp`, `Float64Array`) is
  balancer-owned; `inflight` is the caller's `Uint32Array` read live. Cold start seeds the EWMA to
  `1.0` -> graceful least-connections, never `NaN`. Constructor and `recordRtt` validate
  typeof-first, before allocation. Anti-flap = the half-life, no extra dwell.
- `Pool.run` opt-in latency feedback (`Pool.js`, `Pool.d.ts`): when `opts.clock` (a caller-owned
  nanosecond source) is supplied AND the balancer duck-types `recordRtt`, Pool drives `pick(now)`
  and records the settled rtt on success. Otherwise the hook is inert -- Pool stays generic, the
  in-flight counter stays net-zero, and abort/failover are unchanged.
- `test/PeakEWMA.test.js` -- the boundary suite (cold-start valid + never-NaN, snap-up, decay to
  sample/e at dt=tau within ~1%, slow-node avoidance, fail-closed, tie-break to the first draw =
  identical to P2C on the same seed, constructor + recordRtt validation throws, flap churn).
- `test/balance.mjs` -- the LATENCY ANCHOR: a closed-loop single-server-per-node queue with one node
  at 10x service time. Measured: PeakEWMA slow-node share ~0.007% vs P2C ~1.47% (<= 25% of P2C);
  PeakEWMA service p99 ~1950ns vs P2C ~14500ns (>= 20% lower); random foil worse than both.
- `test/torture.mjs` -- PeakEWMA retention + `pick(now)` and `recordRtt()` 0 B/op phases.
- `test/perf/PerfGate.test.mjs` -- `PeakEwmaBalancer.pick(now)` + `recordRtt()` zero-alloc scenarios
  and a `pick(now)`-boxed-into-a-fresh-array `mustFail` tooth.
- `test/witness.mjs` -- PeakEWMA subject, `const` (O(d)=O(1)) flat flag; work-rate flatness ~0.89
  (the `Math.exp` runs ~2x/pick and stays flat -- the cached 2^-k decay-table fallback was NOT
  needed).
- `test/fuzz.mjs` -- PeakEWMA subject: `_ewma` / `_stamp` stay finite and `PICK_NONE` holds iff the
  pickable mass is 0 under a `recordRtt` / `pick(now)` / `setEligible` barrage.
- `test/types/pick.test-d.ts` -- PeakEwmaBalancer type-surface smoke.
- `benchmark/Matrix.mjs` PeakEWMA throughput subject; PeakEWMA lanes in `benchmark/GcBlastRadius.mjs`
  (same maxMajor 0 / 0 B/op / bounded-pause contract) and `benchmark/Fairness.mjs` (latency
  steering); `benchmark/results.json` regenerated (version 0.7.0), `bench:verify` green.
- `decisions/0009-peakewma.md` -- the ADR (latency-aware P2C, decay-on-read, the Finagle peak rule,
  caller-supplied clock, balancer-owned state, deferred DDSketch-p99, anti-flap = half-life).

### Changed

- `Pick.js` header roster/count (six -> seven strategies), `VERSION` 0.6.0 -> 0.7.0; `package.json`
  version + description; `llms.txt` version + PeakEWMA surface + the FE-profile note + the deferred
  DDSketch-p99 note; `README.md` PeakEWMA section + FE profile + the AWS anomaly-mitigation mapping
  row.

## [0.6.0] - 2026-09-23

M6: the benchmark suite (ROADMAP.md M6). An EVIDENCE session -- no API change. `Pick.js` and
`Pool.js` are byte-identical to 0.5.0 apart from the `VERSION` stamp; the kernel gates
(torture / PerfGate / witness / balance / fuzz) are unchanged and green. Everything added lives
under `benchmark/` and is NOT in the published tarball (`files[]` unchanged).

### Added

- `benchmark/GcBlastRadius.mjs` -- the GC blast-radius headline (dimension 3). The same sustained
  mixed workload (n=1024, 2,000,000 requests) through two lanes: the lite-pick lane (`P2cBalancer`
  over caller-owned typed arrays) measures `major=0`, pick `B/op=0`, `maxPause` ~0.1-0.3ms; the
  allocating foil lane (collect-candidates-sort idiom with a retained in-flight request context)
  measures `major=13-14`, `maxPause` ~2.5-4ms. GC sampled via `@zakkster/lite-gc-profiler`
  (`GcProfiler` + `checkNoGc`, the torture.mjs machinery); `B/op` via `measureAllocs`.
- `benchmark/Fairness.mjs` -- weighted convergence + burstiness (dimension 8). SmoothWRR weights
  [10,3,2,1]: exact fairness (counts == k*weight) over 500 cycles, max-run 3 vs the bursty
  weight-expansion foil's 10. SED weights [1,2,3,4,6,8,12,16]: worst share drift < 0.0001 from the
  weight target; weighted-imbalance ~0.00 vs a weight-blind random foil's ~5.5.
- `benchmark/Disruption.mjs` -- consistent-hash disruption (dimension 7). Naive-modulo foil over
  100,000 seeded keys remaps 98.4% (remove node 64->63) / 98.5% (add node 64->65) of keys vs a good
  consistent hash's ~1.6% / ~1.5% ideal. Explicit SKIP row for `ConsistentHash` (Maglev, M8) -- no
  stub in `Pick.js`.
- `benchmark/Report.mjs` -- emits `benchmark/results.json` stamping Node version, V8, CPU model,
  core count, arch, OS, and every PRNG seed alongside the measured numbers; renders the README
  `<!-- bench:ID -->` fenced tables from it. `--verify` mode is the `bench:verify` drift check:
  ALGORITHMIC numbers (balance peak-gap, disruption remap %) recomputed FRESH and compared EXACT;
  TIMING numbers (GC pauses) compared to `results.json` within +/-15%. Exits non-zero on any drift.
  (Fixes the previously-broken `bench:report` script, which pointed at an absent `Report.mjs`.)
- `benchmark/Soak.mjs` -- the endurance-soak scaffold (post-1.0 #8): ONE P2C lane, continuous
  mixed-chaos load (flap storms + whole-pool-down troughs + load feedback), emits a JSONL
  time-series to `benchmark/soak.jsonl`, and RUNS `test/invariants.mjs:checkBase` at every
  checkpoint. `tracker.size()` returns to 0 after each cycle; invariants green at all checkpoints.
  `SOAK_CYCLES=0` runs forever -- the harness the `caffeinate -i` overnight burn-in plugs into.
- `benchmark/Matrix.mjs` -- extended (not rewritten): each SUBJECT gained a `dims` flag, and the
  file now exports the SHARED SEEDED workload matrix (`buildWorkload` over uniform / skewed-weight
  / skewed-cost), `SEEDS`, `SUBJECTS`, `SIZES`, and `measureThroughput`, reused by every dimension
  file. The standalone throughput runner is behind a main guard so importing it runs no sweep.
- `decisions/0008-benchmark-suite.md` -- the ADR: the parity framing, the real-competitors + foils
  baseline, the drift-check teeth, and the ConsistentHash SKIP.
- README: the *Evidence* section -- balance anchor + GC blast-radius headlines (fenced), the
  consistent-hash disruption trust gate, the honest COLD-path cost table, and the vs-AWS NLB/ALB
  "complementary, not a competitor" positioning.
- devDependencies: `load-balancers@1.3.52`, `loadbalance@1.0.0`, `wrr@1.0.0` -- REAL npm
  competitors, pinned to exact versions, loaded via `createRequire` (all three are CommonJS) and
  timed into `results.json` beside our in-repo foils; a package that fails to load becomes a
  labeled `unavailable` row rather than being silently dropped. Each incumbent is rendered side by
  side with the SAME-complexity lite-pick strategy on the SAME n=1024 pool in the README
  `<!-- bench:competitors -->` throughput fence. Parity is claimed only on EQUAL-work rows: P2C is
  parity (~60k vs ~61k ops/ms); RoundRobin is ~22% slower (~260k vs ~335k) and the gap is OWNED --
  `loadbalance` is a bare `i++ % n` with no liveness, while lite-pick's `RoundRobinBalancer`
  forward-scans the eligibility bitmap to skip down nodes (never a dead pick), and that scan is the
  constant-factor cost of a guarantee the incumbents do not offer. The weighted-random row is a
  disclosed SKIP -- lite-pick's O(1) `WeightedRandom` (alias table) lands at M10, so `wrr` is not
  raced against our O(cap) `SmoothWRRBalancer` (a different complexity class). No "faster"/"Nx".
- Scripts: `bench:gc`, `bench:fairness`, `bench:disruption`, `bench:verify`, `soak`.

### Changed

- Version bumped to 0.6.0 in the three sync sites (`package.json`, `Pick.js` `VERSION`, `llms.txt`).
  `peerDependencies` stays `{}`.

## [0.5.0] - 2026-09-23

M5: the ergonomic request layer at the `@zakkster/lite-pick/pool` subpath -- dispatch/settle
in-flight counters + distinct-endpoint failover + a duck-typed query-cache fetcher (ROADMAP.md M5).

### Added

- `@zakkster/lite-pick/pool` (`Pool.js`) -- a new SUBPATH export (the kernel `Pick.js` stays a
  single 0 B/op file; the async layer lives outside it, the lite-query `/stream` + `/await`
  precedent, ADR 0007).
- `Pool` -- wraps a balancer + the caller-owned in-flight view. `run(fn, opts?)` picks an endpoint,
  increments in-flight on dispatch, awaits `fn(endpoint, signal)`, decrements on settle (in a
  `finally` -- net-zero per run, even on throw). On a thrown error it keeps the failed endpoint's
  count ELEVATED and re-picks, so a load-aware strategy (P2C/LeastConn/SED/NQ) steers the next
  attempt to a DISTINCT endpoint -- up to `opts.tries` attempts (default 1 = no failover), then
  rejects with the last error. Rejects a `code:'LITE_PICK_NONE'` error when no endpoint is eligible;
  `opts.signal` is passed to `fn` and, once aborted after a failure, stops failover. NOT a 0 B/op
  path (the kernel `pick()` is) -- a normal async wrapper, disclosed.
- `liteQueryFetcher(pool, perEndpoint, opts?)` -- returns a `({ key, signal }) => Promise` fetcher
  for a query cache (lite-query's `fetcher`, or any fetcher-shaped consumer). Imports NOTHING from
  lite-query -- duck-typed, so `peerDependencies` stays empty. `opts.tries` is the spatial failover
  count. BOUNDARY: Pool owns SPATIAL failover across the pool; the cache owns TEMPORAL retry/backoff.
- `test/Pool.test.js` -- 12 tests: dispatch/settle in-flight balance (success AND throw), fail-closed
  coding, distinct-endpoint failover, tries exhaustion (last error), abort-stops-failover, signal
  passthrough, a 200-way CONCURRENT-consistency check (in-flight drains to all-zero -- no leak), and
  the duck-typed fetcher.
- `Pool.d.ts` + `test/types/pool.test-d.ts` -- the typed surface (the type-test tsconfig gains the
  `DOM` lib for `AbortSignal`).
- `demo/fanout.mjs` (`npm run demo`) -- the integration moat: least-connections fan-out over a flaky
  pool with a replica killed mid-run, proving 0 dead picks + 0 leaked in-flight + live failover, and
  showing the lite-query fetcher wiring. (`demo/` is not in `files[]`.)
- `decisions/0007-pool-adapter.md` -- the /pool-subpath home, spatial-vs-temporal retry ownership,
  the explicit 0 B/op boundary, and the duck-typed (zero-peer) fetcher.

### Changed

- Version 0.4.0 -> 0.5.0 across `package.json`, `Pick.js` `VERSION` (re-exported by `Pool.js`), and
  `llms.txt`. `exports` gains `./pool`; `files[]` gains `Pool.js` + `Pool.d.ts`.
- `peerDependencies` stays `{}` -- the fetcher adapter is duck-typed (ADR 0007 Fork 4).

## [0.4.0] - 2026-09-23

M4: the exact LeastConn family (IPVS `lc` / `sed` / `nq` made zero-GC) + the seeded invariant
fuzzer (ROADMAP.md M4).

### Added

- `LeastConnBalancer extends BalancerBase` -- EXACT fewest-in-flight (IPVS `lc`). A full O(cap)
  scan of the caller-owned in-flight view returning the eligible node with the lowest count
  (lowest index on a tie); the deterministic complement to P2C's O(1) approximation. In-flight
  is read LIVE (no `setWeight`, no derived aggregate -- the caller may mutate it directly).
  0 B/op. Fails closed (`PICK_NONE`) when the whole pool is down.
- `SedBalancer extends BalancerBase` -- shortest-expected-delay (IPVS `sed`). Returns the
  eligible, positive-weight node minimizing `(inflight + 1) / weight`. BOTH inflight and weights
  are caller-owned, read live. A weight-0 eligible node is not a candidate; all-zero-weight fails
  closed even with the pool up. O(cap), 0 B/op.
- `NqBalancer extends BalancerBase` -- never-queue (IPVS `nq`). Returns the FIRST idle eligible
  positive-weight node (in-flight 0) if one exists, else the SED minimum -- the worker-pool fit.
  O(cap) worst case, O(1) when an early node is idle, 0 B/op.
- **The invariant fuzzer** (`test/fuzz.mjs` + the reusable `test/invariants.mjs` checker): a
  seeded, property-based state-machine attack asserting STATE-SYNCHRONISATION invariants after
  EVERY op (strict mode) per strategy -- `live` and (SmoothWRR) `_totalEligibleWeight` stay EXACT
  vs a manual recompute, owned Float64 accumulators stay finite, `PICK_NONE` holds IFF the
  pickable mass is 0, and LeastConn/SED/NQ return the true optimum (NQ its idle-first rule). Prints
  the seed on failure for byte-for-byte replay; CI runs a fixed seed + a random seed + a regression
  corpus + a pathological corpus (max-weight 0xFFFFFFFF summed, all-zero-weight while live>0,
  single-node). Retrofits M2 SmoothWRR. Wired into `npm run fuzz` and `npm run verify`.
- `test/LeastConn.test.js` (10), `test/SED.test.js` (8), `test/NQ.test.js` (10) -- boundary +
  behaviour suites (exact minimum, weight-0 exclusion, feedback-loop balance, idle-first fan-out,
  never-a-down-index under 200k churned picks).
- Balance anchors (`test/balance.mjs`): LeastConn is greedy-perfect (max-minus-min <= 1, tighter
  than P2C's gap; peak <= P2C's on the same run); SED converges to load proportional-to-weight
  (< 1% drift; weighted-imbalance far below a random foil); NQ fans the first n dispatches out to
  n distinct idle workers.
- Gates extended for all three: torture (retention + 0 B/op `pick()` phases 6-8), PerfGate
  (three `zgcSuite` scenarios + three `mustFail` teeth-checks), witness (`linear` complexity ->
  flat work-rate), benchmark matrix (LeastConn/SED/NQ subjects + a per-pick-allocating
  `lc-array` foil).
- `decisions/0006-leastconn-family.md` -- P2C-is-already-least-conn (no redundant alias), exact-
  O(cap)-scan-first, caller-owned live-read counters (the documented asymmetry with SmoothWRR),
  and the confirmed-but-deferred lite-logn `BinaryHeap` exact-O(log n) peer seam.

### Changed

- Version 0.3.0 -> 0.4.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Folded the invariant-fuzz testing methodology (RESEARCH s3, ROADMAP s3/s0) into an adopted,
  shipped gate: vectors 2 (flap chaos) + 3 (zero-GC soak) were already covered; the net-new
  seeded state-synchronisation fuzzer is now `test/fuzz.mjs`.

## [0.3.0] - 2026-09-23

M3: P2C (power-of-two-choices), the headline strategy -- and the balance-quality anchor
(ROADMAP.md M3).

### Added

- `P2cBalancer extends BalancerBase` -- power-of-two-choices. Draws two DISTINCT eligible
  endpoints uniformly at random (rejection sampling over the shared bitmap -- no peer, no
  owned draw-set) and returns the one with the lower in-flight load; ties to the first draw.
  In-flight counts are the caller's `Uint32Array` (read-only to `pick()`). O(1) per pick,
  0 B/op. Fails closed (`PICK_NONE`) when the whole pool is down. Owns only a seeded,
  deterministic PRNG (reproducible benches).
- The distinct second choice uses a BOUNDED redraw (up to 32 tries), not a single nudge, so
  the two-choices property holds even at tiny pool sizes (~2^-32 collision chance), while
  staying expected-O(1) and 0 B/op.
- `test/P2C.test.js` -- 10 tests: n=2 always-lower-load, determinism by seed, fail-closed,
  single-node, skips-down, a very-sparse-pool fallback path, a never-returns-a-down-index
  proof under 200k churned picks, and an in-suite balance smoke.
- **The balance anchor** (`test/balance.mjs`): the balls-into-bins experiment now proves the
  `ln ln n / ln 2` ceiling -- at n=1024, k=32 balls/bin, P2C peak-to-mean gap ~2 vs a random
  single-draw foil's ~21, and P2C's gap stays ~2-3 as n grows to 4096 while random's grows.
- Gates extended for P2C: torture (retention + 0 B/op `pick()`), PerfGate (`zgcSuite` scenario
  + a `mustFail` teeth-check), witness (`const` complexity -> flat throughput), benchmark
  matrix (P2C subject + a random-draw foil).
- `decisions/0005-p2c-draw.md` -- rejection sampling (no peer, RandomSet deferred), the
  bounded-distinct-redraw enrichment, and caller-owned in-flight counters.

### Changed

- Version 0.2.0 -> 0.3.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Folded lite-o1 v1.11.0's new members into the substrate map (RESEARCH s6, ROADMAP):
  `Reservoir` -> the Subsetting substrate (post-1.0 #4); `EliasFano` -> a viable ring-with-
  vnodes option for M8 ConsistentHash; `RankSelect` noted as static-only (not for the
  mutating eligibility bitmap).

## [0.2.0] - 2026-09-23

M2: SmoothWRR, the weighted default (ROADMAP.md M2).

### Added

- `SmoothWRRBalancer extends BalancerBase` -- nginx-style smooth weighted round-robin
  (`current += weight; pick max; current -= total`). Distributes picks by caller-configured
  integer weights, interleaved SMOOTHLY (weights [5,1,1] -> A,A,B,A,C,A,A), not in the
  bursts of naive weight-expansion WRR. Owns its Float64Array smoothing accumulators; the
  sole writer of the weights via the cold `setWeight(i, w)`. O(cap) per pick, 0 B/op. Fails
  closed (`PICK_NONE`) when the eligible-weight sum is 0 (all down, or all eligible weights 0).
- `setWeight(i, w)` (cold) -- reconfigure a weight, keeping the eligible-weight total exact.
  `setEligible` is overridden to maintain the total and reset the toggled node's accumulator
  (no stale credit across an eligibility epoch).
- `test/SmoothWRR.test.js` -- 12 tests: the documented [5,1,1] sequence, exact fairness over
  k cycles, smoothness (max-run strictly below the bursty foil), skips-down / redistribution,
  fail-closed (all down AND all-zero-weight), setWeight/setEligible invariants + accumulator
  reset, uint32 validation, and a never-returns-a-down-index proof under 200k churned picks.
- Gates extended for SmoothWRR: torture (retention + 0 B/op `pick()`), PerfGate (`zgcSuite`
  scenario at a realistic 256-endpoint pool -- SmoothWRR is O(cap) -- with a `grows` counter
  over all three backing arrays, plus a `mustFail` teeth-check), witness (a per-strategy
  complexity flag: `linear` asserts flat WORK RATE `ops/ms * n`), balance (exact weighted
  fairness + max-run < bursty foil).
- `benchmark/Matrix.mjs` -- SmoothWRR subject + the naive expand-WRR bursty foil.
- `decisions/0004-smoothwrr-weight-ownership.md` -- weight ownership (cold setWeight),
  Float64 accumulators, and the epoch-reset-on-eligibility-transition enrichment.

### Changed

- Version 0.1.0 -> 0.2.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Corrected the SmoothWRR complexity: O(cap) per pick, not "O(1) amortized" (ROADMAP).

## [0.1.0] - 2026-09-23

M1: the first strategy, RoundRobin (ROADMAP.md M1). The M0 harness stubs become real,
strategy-bearing gates.

### Added

- `RoundRobinBalancer extends BalancerBase` -- the baseline strategy. A wrapping cursor
  that forward-scans the shared eligibility view, skipping down nodes, to hand each LIVE
  endpoint an equal share in index order (true round-robin over the live set, not the raw
  index space). Owns only its cursor; O(1) amortized (O(cap) worst case under sparse
  eligibility); 0 B/op on `pick()`; fail-closed `PICK_NONE` when the pool is down.
- `test/RoundRobin.test.js` -- boundary + behaviour suite (11 tests): perfect fairness,
  round-robin order, skips down nodes, fail-closed, single-node, recovery, and a
  never-returns-a-down-index proof under 200k picks of adversarial eligibility churn.
- Gates wired for RoundRobin: `torture.mjs` (retention + 0 B/op `pick()` phase),
  `test/perf/PerfGate.test.mjs` (`zgcSuite` scenario + a `mustFail` teeth-check),
  `test/witness.mjs` (throughput flatness across the pool sweep), `test/balance.mjs`
  (imbalance 1.0000 on all-up, zero dead picks under partial eligibility vs the
  `i++ % n` foil's dead-pick trap).
- `benchmark/Matrix.mjs` -- the SUBJECTS registration point (RoundRobin + the `i++ % n`
  foil), a parity-check throughput slice ahead of the full M6 suite.
- `decisions/0003-roundrobin-bitmap-scan.md` -- the stateless bitmap-scan (Option A) vs
  maintained eligible-set (Option B) fork; A now, B revisited at M3 with the lite-o1 peer.

### Changed

- Version 0.0.1 -> 0.1.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Documented the composition model as OPTIONAL PEER dependencies (`peerDependenciesMeta`,
  the LiteQuery model) -- zero HARD deps, never inlined/forked; kernel runs with zero peers.

## [0.0.1] - 2026-09-22

M0 scaffold: the substrate seams only, no strategy yet (ROADMAP.md M0). This release
establishes the shared machinery every strategy (M1+) will ride and locks the ratified
ownership boundary in place before any `pick()` is written.

### Added

- `Pick.js` single-file ESM kernel with:
  - `VERSION` -- the source-of-truth version stamp (three-place sync with package.json + llms.txt).
  - `PICK_NONE` (-1) -- the fail-closed sentinel: no endpoint is ever a dead pick.
  - `Prng` -- an instance-local, deterministic xorshift32 (`next` / `nextBelow` / `reset`),
    so a strategy can draw on the hot path without `Math.random` and the balance
    benchmark stays reproducible.
  - `BalancerBase` -- the shared eligibility seam: a fixed-capacity pool over a SHARED,
    read-only `Uint8Array` eligibility view (written by `@zakkster/lite-di-health` /
    circuit breakers, read by `pick()`), an O(1) `live` count, `isEligible` / `setEligible`,
    and an abstract `pick()` that throws until a strategy overrides it.
- `Pick.d.ts` -- TypeScript declarations for the substrate surface.
- `llms.txt` -- LLM-oriented API + design summary.
- Test harness: `test/Base.test.js` (substrate boundary suite), `test/torture.mjs`
  (lite-leak retention + lite-gc-profiler 0 B/op on the substrate hot path),
  `test/perf/PerfGate.test.mjs` (lite-perf-gate `zgcSuite` hard gate + a `mustFail`
  teeth-check), `test/witness.mjs` (throughput flatness), `test/balance.mjs` (the
  random-foil baseline the strategy ceilings assert against from M1), and the
  `test/types` tsc surface check.
- `decisions/0001-selection-kernel-boundary.md` -- the five ratified ownership forks.
- `decisions/0002-anti-flapping.md` -- hysteresis/dwell/backoff on routing-state transitions.
- `RESEARCH.md`, `ROADMAP.md`, `README.md`, `LICENSE`.

### Notes

- Zero runtime dependencies. ESM only. `sideEffects: false`. Node >= 18.
- Published metadata points at `PeshoVurtoleta/lite-pick`.
- Next: **M1 RoundRobin** (0.1.0) -- the first strategy, landing the throughput witness
  and the balance gate.

[0.3.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.3.0
[0.2.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.2.0
[0.1.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.1.0
[0.0.1]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.0.1
