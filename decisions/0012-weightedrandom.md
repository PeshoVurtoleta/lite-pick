# 0012 -- WeightedRandom (M10): inline Vose alias table + rejection-sampling eligibility, the 1.0.0 roster-completer

- Status: ratified
- Package: @zakkster/lite-pick 1.0.0 (M10)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping), ADR 0004 (SmoothWRR sole-writer weight state), ADR 0005 (P2C rejection-sampling draw).
- Date: 2026-09-23

## Context

M10 ships `WeightedRandomBalancer` -- O(1) weighted-random selection via a Vose/Walker ALIAS TABLE (one
column draw + one probability compare), the tenth and roster-completing strategy for the 1.0.0 release.
It is the STATELESS O(1) weighted sampler: unlike SmoothWRR (deterministic, smooth, but O(cap) per pick
with per-endpoint accumulator state that can desync), it owns only a static table and draws from it with
the in-repo PRNG. It is the AWS ALB `weighted_random` family at the in-process hop. Four forks settled.

## Fork 0 -- The build: inline Vose vs the lite-o1 AliasTable peer (ratified: inline)

- Options: (a) INLINE the ~15-line standard small/large Vose worklist build; (b) declare `@zakkster/lite-o1`
  `AliasTable` a hard/optional peer and build the table through it.
- Ratified: **(a) inline, cite ADR-0005 Fork 1.** The Vose build is a COLD one-time (per reweight) ~15-line
  worklist -- exactly the "no peer, no owned draw-set, no synchronization burden" call ADR 0005 made for the
  P2C eligible draw. `peerDependencies` STAYS `{}` (the zero-HARD-deps law): the kernel builds over a raw
  `Uint32Array` with zero peers present. The lite-o1 `AliasTable` remains a DEFERRED duck-typed optional-peer
  upgrade for the build path, imported by NOTHING until a shipped code path imports it. Re-implementing a
  cold 15-line build is not a fork worth a dependency; re-implementing a HOT substrate would be.
- Also deferred (RESEARCH): a `@zakkster/lite-logn` Fenwick / BinaryIndexedTree for the DYNAMIC-weight case
  (O(log n) update + O(log n) sample) -- the mutable-weight complement to this static table's O(1) sample /
  O(cap) rebuild. Rule of thumb: fixed-ish weights -> this alias table; frequently-changing weights -> a
  Fenwick tree. Not declared as a peer until a shipped path imports it.

## Fork 1 -- Eligibility: static table + rejection-sampling renormalization (ratified)

- The alias table is built over the ELIGIBLE-INDEPENDENT weights -- eligibility is NOT baked into the table
  (which would force a rebuild on every health flap, violating ADR 0002 anti-flapping). Instead `pick()`
  draws a candidate and, if it is ineligible, REJECTION-RETRIES up to a bounded 64 (mirroring ADR-0005's P2C
  bounded retry), then falls back to a 0-B/op rotated linear eligible scan from a random start for the
  degenerate heavy-outage case.
- Because the table is built over ALL positive-weight nodes and a weight-0 node is NEVER a column (see Fork
  2), every candidate is a positive-weight node. Rejecting the ineligible candidates is therefore rejection
  sampling of the weight distribution RESTRICTED to the eligible subset -- it RENORMALIZES weight-
  proportionality over the SURVIVING eligible mass: each eligible node's long-run share converges to
  `weight[i] / sum(eligible weights)`. This is the contract stated in llms.txt and proven by test/balance.mjs
  (half the pool down: survivor shares within 3% of the renormalized target, 0 ineligible / 0 weight-0 returns).
- The rare fallback scan (rejection failed 64x) returns the first eligible positive-weight node from a random
  offset -- a correctness net (never a dead pick), NOT a proportional path.
- Ownership (ADR 0004 precedent): `weights` is the CALLER's `Uint32Array` (the SmoothWRR/SED seam); the
  balancer is the SOLE writer of its DERIVED table (`_prob` / `_alias`) via cold `setWeight` / `rebuild`.
  Direct weight-array mutation desyncs the table (UB). An eligibility flap NEVER rebuilds (anti-flap).

## Fork 2 -- ctor validation + all-zero-weights fail-closed (ratified)

- `new WeightedRandomBalancer(capacity, eligible, weights, seed = 0x9e3779b9)`. `weights` is validated
  typeof-first (RangeError on a short / non-Uint32Array) BEFORE the table is allocated (the PeakEWMA /
  ConsistentHash / BoundedLoad discipline). The PRNG is the reused in-repo xorshift32 `Prng` (seeded) -- NO
  `Math.random` on the gated path.
- A weight-0 node must NEVER be returned. In the Vose build a weight-0 node has scaled probability 0, so it
  is popped once, assigned `_prob = 0` + a POSITIVE-weight alias, and NEVER reaches the prob-1 drain -- its
  column always redirects to a positive node. `pick()` therefore never returns a weight-0 index (proven by
  the fuzzer's structural + sum-reconstruction invariant, test/invariants.mjs `checkWeightedRandom`).
- Fail-closed (ADR 0001): `pick()` returns `PICK_NONE` (-1) IFF `live === 0` OR no eligible node has a
  positive weight (all-zero weights, tracked as `_psum === 0`; or every eligible node's weight is 0, caught
  by the fallback scan finding no eligible positive-weight node). NEVER a dead pick; `pick()` never throws.

## Fork 3 -- Positioning: vs SmoothWRR + vs @zakkster/lite-random (ratified)

- **vs SmoothWRR** (the other weighted strategy): SmoothWRR is DETERMINISTIC, SMOOTH, and LOW-VARIANCE, but
  O(cap) per pick and owns per-endpoint accumulator state (`_current`) that must be maintained in lockstep.
  WeightedRandom is a STATELESS O(1) sample (no accumulator to desync) that pays SAMPLING VARIANCE -- any
  single pick is random; the law of large numbers delivers the weight ratios over a run. The fit is VERY
  LARGE pools where SmoothWRR's O(cap) scan hurts: test/balance.mjs shows the O(1) alias sample beats an
  O(n) cumsum-linear foil (same fairness) by >=3x ops/ms at n=4096, while the witness holds 'const' flatness.
- **vs @zakkster/lite-random** (the sibling that also does weighted random -- addressed EXPLICITLY so 1.0.0
  does not look duplicative): lite-random is a GAME RNG (Mulberry32; loot tables, particles, gaussian) whose
  `weighted(items, weights) -> T` returns an ITEM one-shot, is NOT eligibility-aware, exposes NO reusable
  persistent table, and uses a DIFFERENT PRNG. lite-pick's WeightedRandom returns an endpoint INDEX, honours
  the shared eligibility bitmap (fail-closed), owns a PERSISTENT alias table rebuilt only on reweight, and
  uses the in-repo xorshift32. Different domain + contract -> NOT a peer, NOT a substrate. GUIDE.md carries
  the pointer: "for game loot tables use lite-random; lite-pick WeightedRandom is the eligibility-aware LB
  selector." `peerDependencies` stays `{}`.

## Consequences

- Byte-identical siblings: the only Pick.js changes are the appended `WeightedRandomBalancer` (extending
  `BalancerBase`, inlining the Vose build), the header roster/count word (nine -> TEN), and the `VERSION`
  bump to 1.0.0. `peerDependencies` stays `{}` (the Vose build is inlined -- imports nothing new).
- The fairness anchor (test/balance.mjs): n=64, skewed weights [1..16], >=2e6 seeded draws -- every node's
  observed share within 2% RELATIVE of `weight[i]/sum`; the cumsum-linear O(n) foil matches the same
  fairness but WeightedRandom wins ops/ms by >=3x at n=4096. Under half the pool down, survivor shares are
  within 3% of `weight[i]/sum(eligible)` with 0 ineligible / 0 weight-0 returns; all-zero weights ->
  PICK_NONE. Thresholds are the sampling-variance floor from a correct run (N sized so the band holds with
  margin) -- the band is NEVER widened to pass.
- Gated like every sibling: `test/WeightedRandom.test.js` (boundary + behaviour), `test/fuzz.mjs`
  (`checkWeightedRandom` after every op + a 1000-flap 0-rebuild anti-flap assertion), `test/torture.mjs`
  (retention + a 0 B/op pick() phase), `test/perf/PerfGate.test.mjs` (`weightedRandomPick` zero-alloc + a
  boxed `mustFail` tooth), `test/witness.mjs` ('const' flat-work), `benchmark/Matrix.mjs` (a throughput +
  fairness SUBJECT), `Pick.d.ts` + `test/types/pick.test-d.ts` (typed surface), GUIDE.md + README + this ADR.
- 1.0.0 is roster-complete FOR NOW, not closed: AZ-aware routing, the lite-await hedging combinator, and
  subsetting are queued post-1.0 (ROADMAP.md).

## References

- Vose, "A Linear Algorithm for Generating Random Numbers with a Given Distribution" (IEEE TSE, 1991) -- the
  O(n)-build / O(1)-sample alias method used here.
- Walker, "An Efficient Method for Generating Discrete Random Variables with General Distributions" (ACM TOMS,
  1977) -- the original alias method.
- ADR 0005 (this package) -- the rejection-sampling eligible-draw precedent (bounded retry + zero-alloc scan).
