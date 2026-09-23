# Changelog

All notable changes to `@zakkster/lite-pick` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
