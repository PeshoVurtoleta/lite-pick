# 0004 -- SmoothWRR (M2): weight ownership, accumulator type, and epoch-reset

- Status: ratified
- Package: @zakkster/lite-pick 0.2.0 (M2)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping).
- Date: 2026-09-23

## Context

M2 ships `SmoothWRRBalancer` -- nginx smooth weighted round-robin (`current += weight; pick
max; current -= total`), the weighted default. It is the FIRST strategy that owns real
ALGORITHM state (per-endpoint smoothing accumulators), so three forks had to be settled.

## Fork 1 -- Weight ownership: caller array + cold `setWeight` (ratified)

- Options: (a) weights passed at construction as a Uint32Array, mutated ONLY via a cold
  `setWeight(i, w)` that keeps a maintained `_totalEligibleWeight` exact; or (b) caller
  mutates the array directly + calls a `resync()`.
- Ratified: **(a) cold `setWeight`, the balancer is the sole writer.** The eligible-weight
  total is a maintained invariant read on the hot path; letting the caller mutate weights
  behind the balancer's back silently desyncs it. `setWeight` updates the array and the
  total together, the same discipline as `setEligible`/`_live`. Direct external mutation of
  the weights array is documented UNDEFINED BEHAVIOUR, not a supported path.
- Consequence of the wrong choice: a `resync()` that a caller forgets to call is a silent
  fairness bug; a maintained-together invariant cannot drift.

## Fork 2 -- Accumulator type: Float64Array (ratified)

- Options: (a) `Int32Array` accumulators (nginx-faithful), or (b) `Float64Array`.
- Ratified: **(b) Float64Array.** The accumulators stay bounded in roughly `[-total, total]`
  during steady smooth operation, but eligibility/weight changes can push them past a clean
  int32 bound; Float64 absorbs the sum of uint32 weights at any realistic capacity without
  overflow, and reads/writes are still 0 B/op on the hot path (proven by torture + PerfGate).
- Consequence of the wrong choice: an int32 accumulator can overflow at a large total and
  silently corrupt selection; the correctness risk is not worth the marginal int speed.

## Fork 3 -- Eligibility transition: reset the accumulator (ratified, an enrichment)

- Options: (a) leave `_current[i]` untouched across a down/up toggle (nginx behaviour --
  the node "remembers" its credit/deficit), or (b) RESET `_current[i] = 0` on every
  eligibility transition.
- Ratified: **(b) reset on transition.** nginx never resets because its peers do not flap
  fast; a clean-room selector sitting behind a health/breaker dwell layer is better off
  EPOCH-BOUNDED. Carrying stale credit means a node that was far ahead bursts on re-admission
  (a thundering-herd smell) and one far behind is starved -- exactly the flapping ADR 0002
  guards against. Reset makes a re-admitted node start neutral: no burst, no starvation,
  trivially testable.
- Trade (disclosed): a node that blips down for a single pick loses its in-progress credit,
  a tiny one-off unfairness. The dwell before re-admission (ADR 0002) makes single-pick blips
  rare, so the trade is favourable. The gate: after a down/up toggle, fairness over a full
  cycle is still EXACT (SmoothWRR.test.js).

## Consequences

- `SmoothWRRBalancer` owns `_current` (Float64Array) + `_totalEligibleWeight`; it overrides
  `setEligible` (maintain total + reset accumulator) and adds cold `setWeight`.
- Bound is O(cap) per pick, NOT O(1) -- the ROADMAP's earlier "O(1) amortized" was wrong and
  is corrected. SmoothWRR is inherently linear in the pool size; negligible at real endpoint
  counts (dozens-to-hundreds), and 0 B/op regardless. The witness gate carries a per-strategy
  complexity flag ('linear') and asserts flat WORK RATE (ops/ms * n), not flat throughput.
- No lite-o1 peer yet -- weights are a plain Uint32Array; the first optional peer still
  arrives at M3 (P2C, lite-o1 RandomSet). `peerDependencies` stays empty.
