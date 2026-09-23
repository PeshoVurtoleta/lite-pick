# 0009 -- PeakEWMA (M7): latency-aware P2C, decay-on-read, the Finagle peak rule

- Status: ratified
- Package: @zakkster/lite-pick 0.7.0 (M7)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping), ADR 0005 (P2C draw).
- Date: 2026-09-23

## Context

M7 ships `PeakEwmaBalancer` -- Twitter Finagle's peak-EWMA, framed as latency-aware
power-of-two-choices: the two-choice draw of ADR 0005, but comparing a LATENCY cost instead of a
raw in-flight count. It is the strategy the multi-region / front-end case wants, because it steers
AROUND a slow-but-up node that a pure in-flight strategy keeps re-probing (a slow node drains its
queue between visits, so its in-flight looks attractive again). Several forks had to be settled.

## Fork 1 -- Cost function: latency-aware P2C, O(d)=O(1) (ratified)

- `cost(i) = (inflight[i] + 1) x ewmaAt(i, now)`. Two distinct eligible draws (ADR 0005's
  rejection-sampling `_draw`, REUSED verbatim via `P2cBalancer.prototype._draw.call(this)` -- not
  re-implemented, not moved to the base, so every other strategy stays byte-identical), lower cost
  wins, ties to the first draw. `d = 2` fixed. O(d) = O(1) per pick.
- The `(inflight + 1)` factor folds in-flight INTO the latency signal, so PeakEWMA also degrades to
  least-connections when latencies are equal, and never divides by zero.

## Fork 2 -- Decay-on-READ, not on write (ratified)

- Options: (a) decay + re-store the EWMA inside `pick()`; (b) decay purely on read, `pick()` never
  writes.
- Ratified: **(b) decay-on-read.** `ewmaAt(i, now) = _ewma[i] x exp(-(now - _stamp[i]) / tau)`.
  Because `pick()` performs NO write it is a pure read -> **0 B/op** on the hot path, and it stays
  deterministic and reentrant. The stored `_ewma` / `_stamp` are advanced only by the warm
  `recordRtt` feedback path. `exp` runs ~2x per pick (one per candidate); the witness confirms the
  work-rate stays FLAT with n (O(d)=O(1)), so the documented 2^-k cached-decay-table fallback was
  NOT needed and is not shipped.

## Fork 3 -- The update rule: the Finagle PEAK rule (ratified)

- On `recordRtt(i, sampleNs, now)`: `w = exp(-(now - _stamp[i]) / tau); e = _ewma[i] * w;`
  `_ewma[i] = sampleNs > e ? sampleNs : e + (sampleNs - e) * (1 - w); _stamp[i] = now;`
- This is "peak"-EWMA: the cost SNAPS UP instantly to a higher rtt (a spike is felt on the very
  next pick) and DECAYS DOWN gently over ~tau. An ordinary symmetric EWMA would smooth a spike away
  and keep routing into a degrading node. `recordRtt` is the warm path (not gated as hot), validates
  typeof-first, and allocates nothing on the success path -- also **0 B/op**.

## Fork 4 -- Caller-supplied clock; balancer-owned state (ratified, per ADR 0001)

- `now` and `sampleNs` are CALLER-supplied nanoseconds, consistent between `pick(now)` and
  `recordRtt(..., now)`. No internal `performance.now()` on a gated path -> deterministic + testable
  + zero-GC.
- `inflight` is the caller's `Uint32Array`, read LIVE (the P2C / LeastConn seam). The EWMA state
  (`_ewma`, `_stamp`, both `Float64Array`) is BALANCER-OWNED, and the balancer is its SOLE writer
  via `recordRtt` (the SmoothWRR precedent, ADR 0004).

## Fork 4b -- Cold start: an UNSAMPLED sentinel, not `_stamp = 0` (ratified, 0.7.1 fix)

- The original 0.7.0 seeded `_ewma = 1.0`, `_stamp = 0`. Under a REAL large-magnitude clock
  (`now` in the 1e12+ range) an unsampled node then decays as `exp(-(now - 0) / tau) -> 0`, so its
  cost collapses to ~0 and a COLD pool degrades to RANDOM selection instead of the documented
  least-connections baseline. Ratified fix: seed `_stamp = -1` (a NEGATIVE "unsampled" sentinel).
- `ewmaAt(i, now)` (and the inlined `pick` cost) read the baseline UNDECAYED when `_stamp[i] < 0`
  (`return _ewma[i]`), else apply the decay. This is a cheap per-candidate compare -- `pick` stays a
  pure 0 B/op read, no allocation and no throw.
- The FIRST `recordRtt` on an unsampled node initializes the EWMA EXACTLY to the sample
  (`_ewma[i] = sampleNs`), clock-magnitude-independent; the peak rule applies only from the second
  sample on. Cold start is `(inflight + 1) x 1` -- graceful least-connections, never NaN,
  independent of the caller's clock.

## Fork 4c -- Finite-clock contract, NO hot-path guard (ratified)

- `now` (in `pick(now)` / `recordRtt`) and `sampleNs` MUST be FINITE numbers. `recordRtt` (the warm
  path) THROWS on a non-finite argument. `pick(now)` does NOT add a guard -- the "pick never throws"
  fail-closed contract holds: a non-finite `now` produces `NaN` costs, both comparisons fall through
  to the first draw, and selection degrades to P2C-random (an eligible index, never an error).

## Fork 5 -- Anti-flap = the half-life, no extra dwell (ratified, per ADR 0002)

- The EWMA half-life (tau) IS the smoothing. There is NO additional hysteresis/dwell on top: a spike
  raises the cost immediately and it relaxes over ~tau, which is exactly the epoch-bounded,
  no-stale-credit behaviour ADR 0002 asks for. Adding a second smoothing layer would double-damp.

## Fork 6 -- DDSketch p99 variant: DEFERRED (ratified)

- A tail-aware variant scoring `inflight x p99Rtt` via a per-node `@zakkster/lite-sketch` `DDSketch`
  (`add` is worst-case O(1) / 0 B/op on the warm path; `quantile` carries a hard relative-error
  bound) is an OPTIONAL-PEER complement, documented in llms.txt.
- Ratified: **defer it.** The EWMA-mean score is the shipped, zero-peer default; `peerDependencies`
  STAYS `{}` and lite-sketch is added only when a shipped code path imports it (the suite's
  optional-peer discipline, ADR 0001).

## Consequences

- Byte-identical siblings: the only Pick.js changes are the appended `PeakEwmaBalancer`, the header
  roster/count word, and the `VERSION` bump. `_draw` is reused, not copied or relocated.
- `Pool.run` gains an OPT-IN latency feedback hook: when a `clock` is supplied AND the balancer
  duck-types `recordRtt`, Pool drives `pick(now)` and records the settled rtt; otherwise it is inert
  and the in-flight counter stays net-zero, keeping Pool generic and abort/failover unchanged.
- The latency anchor (test/balance.mjs): a node at 10x rtt receives <= 25% of P2C's share for it and
  PeakEWMA's service p99 is >= 20% below P2C-over-inflight, with the random foil worse than both.
- Bound: O(d) = O(1) per pick; 0 B/op on BOTH `pick()` and `recordRtt()` (torture + PerfGate).
