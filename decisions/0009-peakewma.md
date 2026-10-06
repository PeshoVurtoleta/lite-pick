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

## Amended in 1.0.1 (2026-09-27) -- cold-start pricing, hung-node floor, failure feedback (audit H1, L5, L6, M1)

Fork 4b's cold start priced an unsampled node at `(inflight + 1) x 1.0` and Fork 2/3 decayed the
estimate with no lower bound and no clamp. The audit (H1) showed the failure mode: a fast-failing or
hung node that never records a sample keeps the tiny 1.0 ns baseline (or decays toward 0), so it
becomes the CHEAPEST pick -- a black hole that doubled failure rates. Refinements:

- **Cost is now three cases** (still a pure read, 0 B/op): an unsampled node costs **0 while idle**
  (graceful least-connections; it holds one probe request in flight until its first sample) and
  `(inflight + 1) x lifetime-mean-sampled-rtt` **once busy** (a balancer-owned running mean over all
  samples, 1.0 only before the first), so a cold-but-busy node is not mistaken for a 1.0 ns node. A
  sampled node costs `(inflight + 1) x max(decayedEWMA, dt)` **while busy** (else `x decayedEWMA`),
  so a hung node -- `dt` grows, no completion -- gets MORE expensive over time, not less.
- **`dt` is clamped `>= 0`** (L6): a non-monotonic clock can no longer inflate the estimate via
  `exp(+x)`.
- **Failure feedback lives in Pool** (H1): a thrown attempt feeds
  `recordRtt(i, max(elapsed, opts.failurePenaltyNs), done)` (default 1e9 ns), so a failing node is
  priced expensive and re-probed roughly every `tauNs x ln(failurePenaltyNs / healthyRttNs)`.
- **"Half-life" -> "time constant"** (L5): `tau` is the EWMA time constant; half-life = `tau x ln2`.
- **Index validation** (M1): `recordRtt` now throws `RangeError` for a non-integer / out-of-range
  index -- INCLUDING a numeric string like `'2'` (which used to coerce and work); a string index now
  throws `RangeError`, not `TypeError`.
- **Accepted caveats (1.1.0 items):** an idle-then-busy node is priced by time-since-last-response
  until that response completes (no exact per-dispatch "busy since" stamp yet -- 1.1.0); the lifetime
  mean never forgets a latency-regime change (a decaying mean is a 1.1.0 item). The buffer-based
  clock API that avoids boxing `now` is also 1.1.0 (shipped: `pickFrom` / `recordRttFrom`, ADR 0016).

## Amendment 2026-10-04 (1.1.0, audit L4, research D3-D5): Finagle's update, a decaying mean, no busy-since stamp

Fork 3's rule decayed first and then blended: `e = ewma x w; ewma = sample > e ? sample : e + (sample - e)(1 - w)`,
which is `ewma x w^2 + sample x (1 - w)`. Finagle's `PeakEwma.observe` and tower's `RttEstimate::update` are
`sample > ewma ? sample : ewma x w + sample x (1 - w)`, the peak compared with the STORED estimate. 1.1.0 adopts
theirs exactly (10 ms, one tau, then 5 ms: 6.84 ms, was 4.51 ms; pinned in test L4). Kept different, on purpose:
both of them call the update with a 0 sample on every load read, so their estimate also depends on how often a
node is read; `pick()` here stays a pure read, so the estimate is a function of the samples and the clock only.

The unsampled-busy price was the lifetime mean `sum / count`. It is now a decaying mean: on each sample both
decay by `exp(-dt/tau)` since the newest sample (any node), then take the sample at weight 1. Every sample
weighs `exp(-age/tau)`; with no decay it IS the old mean, and the read in `pick()` is unchanged (the two decay
factors cancel in the ratio). Chosen over a time-weighted blend (`mean x w + sample x (1 - w)`), which would
weigh each sample by the gap before it rather than equally. Finagle's busy-unsampled Penalty and tower's
caller-chosen default RTT were the other options (research section 5.2); the 1.0.1 failure penalty still
guards the black hole. A backwards reading folds in at weight 1 and does not move the pool stamp; when the
decay underflows to 0 the sum restarts, so an overflowed sum never becomes `Infinity x 0 = NaN`.

The 1.0.1 "busy since" stamp is dropped (research section 5.3): no reference keeps one, `inflight` is
caller-owned so the kernel cannot see the 0 -> 1 transition, and a per-attempt timeout already turns a hung
request into a penalized peak sample (Pool test C1c). The busy floor (`max(decayedEWMA, dt)` while busy) stays.
recordRtt measured 8.8 -> 8.6 ns all-blend (two `exp` now), 5.8 -> 4.9 ns all-peak (the node skips `exp`); 0 B/op
on both paths (PerfGate). Zero-box note: the NaN guard multiplies first and maps NaN to 0, so it merges two
doubles; a `pw > 0 ? ... : sampleNs` ternary merged a double with the tagged argument and Maglev boxed it.

## Amendment 2026-10-06 (1.1.1, audit 2026-10-05 K1): the "costs no more" claim is platform-specific; the single-`exp` fix was measured and REVERTED

The 2026-10-04 amendment above claimed `recordRtt` "costs no more: 8.8 -> 8.6 ns all-blend" (line 149) and
the matching 1.1.0 CHANGELOG entry said the decaying mean "costs no more". The 2026-10-05 audit (K1) showed
that claim is **platform-specific**: it was measured on darwin / arm64 Node 26. On **Node 22 / x64** the audit
measured the blend path at **12.6 -> 18.9 ns** (1.0.x -> 1.1.0; interleaved A/B, min of 5-7) --
a real regression caused by the SECOND `exp()` the decaying pool mean now computes per sample. The slowdown is
accepted: it buys a pool mean that FORGETS a latency-regime change (the whole point of the 1.1.0 amendment),
and the 1.0.1 failure penalty still guards the black hole. The universal "costs no more" phrasing was the only
defect; the CHANGELOG `[Unreleased]` carries the correction (the released 1.1.0 text is left as shipped).

K1 proposed a fix: when the node's recorded stamp equals the pool's newest stamp -- one caller clock, the
recorded node also holding the pool's newest sample (back-to-back same node, or a batch sharing one `now`) --
reuse the node-decay factor `w` for the pool decay instead of a second `exp()`. It was implemented (pool-decay
block hoisted above the node branch; blend arm `const w = dt === pdt ? pw : Math.exp(-dt / this._tau)`),
measured, and **REVERTED**. Measurements, arm64 / darwin, a HEAD-copy vs the tree in separate processes
(an in-process A/B went polymorphic), min of 7, machine load 1.4-2.0 (new / HEAD, lower is better):

| Node | back-to-back (same node) | interleaved (the common path) |
|---|---|---|
| v22.23.3 | 0.82 | 1.12 |
| v26.8.2  | 0.96 | 1.08 |

x64 was not re-measured. Likely root cause of the revert (a HYPOTHESIS, not a verified mechanism): hoisting
the pool decay and gating the blend arm on `dt === pdt` **may serialise the two independent `exp()` calls
behind a branch** -- HEAD lets V8 overlap them -- so the rare same-stamp case saves one `exp` while the common
interleaved path pays ~8-12%. `_recordAt` is
therefore left **byte-identical to 1.1.0** (confirmed by the prototype-`toString` diff: PeakEWMA is absent
from the changed-method set). The single-`exp` idea is not re-queued; a cheaper decaying mean would need a
different structure, not a reordering.
