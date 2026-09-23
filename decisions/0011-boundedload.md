# 0011 -- BoundedLoad (M9): Consistent Hashing with Bounded Loads (CHBL), the note() occupancy seam

- Status: ratified (supersedes the withdrawn P2C-with-cap draft -- see Fork 0)
- Package: @zakkster/lite-pick 0.9.0 (M9)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping), ADR 0004 (SmoothWRR sole-writer state), ADR 0010 (ConsistentHash / Maglev table).
- Date: 2026-09-23

## Context

M9 ships `BoundedLoadBalancer` -- **Consistent Hashing with Bounded Loads** (CHBL: Mirrokni-Thorup-
Zadimoghaddam, Google Research 2016; Vimeo's production `eps ~ 0.25`). It is `ConsistentHashBalancer`
(the M8 Maglev table) PLUS a per-backend occupancy CAP: a key sticks to its hashed home backend
UNLESS that backend is over the cap, in which case the request OVERFLOWS along the same bounded
forward-probe to the next eligible, under-cap backend. It keeps consistent hashing's stickiness +
minimal disruption AND adds the HOTSPOT protection plain consistent hashing lacks. It is the family
AWS ALB anomaly-mitigation / NLB flow-hash-with-shedding belongs to, at the in-process hop.

## Fork 0 -- The pivot: why NOT P2C-with-a-cap (ratified, the load-bearing decision)

- The M9 draft first built the "overload" reading: P2C-over-inflight with a `(1+eps) x mean` cap,
  preferring the under-cap draw. Implementation + the occupancy anchor PROVED it byte-identical to
  plain P2C: with a live-observable inflight view, an under-cap draw ALWAYS has strictly lower inflight
  than an over-cap one, so "prefer under-cap" and P2C's "lower-of-two" pick the SAME node in every
  case (verified: identical occupancy at every load level). The cap is a **no-op** there -- not a
  distinct strategy.
- Ratified: **the cap is only LOAD-BEARING when the primary choice is fixed by something OTHER than
  load -- a hash.** That is exactly CHBL: the hashed home is sticky, and the cap is what lets a hot
  home overflow. So M9 is CHBL, the algorithm the roadmap (`M9 BoundedLoad: consistent-hashing-with-
  bounded-loads (eps cap)`) cited all along. The P2C-with-cap reading is withdrawn as non-distinct.

## Fork 1 -- Extend ConsistentHashBalancer; reuse the Maglev machinery VERBATIM (ratified)

- CHBL IS ConsistentHash + a cap, so `BoundedLoadBalancer extends ConsistentHashBalancer`. The Maglev
  table build (`_build`, the weighted populate, `chMix32`, `CH_DEFAULT_M = 65537`, `CH_PROBE_LIMIT =
  64`), `setWeight` / `rebuild` / `tableSize`, and the bounded forward-probe walk are REUSED verbatim
  -- zero duplication. Only `pick(keyHash)` is overridden (cap-aware), plus `note` / `totalInflight`
  added. It is-a ConsistentHashBalancer and (transitively) a BalancerBase.

## Fork 2 -- Balancer-owned `_total` via note(); occupancy is the caller's inflight (ratified)

- The cap needs the MEAN occupancy = `_total / live`. `inflight` is the CALLER's `Uint32Array`, read
  LIVE as the per-backend OCCUPANCY source (the ConsistentHash seam gains an inflight arg). The
  running sum `_total` is BALANCER-OWNED and its SOLE writer is the warm `note(i, delta)` feedback path
  (dispatch +1 / settle -1) -- the SmoothWRR / PeakEWMA sole-writer precedent -- so the cap's mean
  stays O(1)-current with no scan. `pick()` performs NO write -> 0 B/op; `note()` is O(1) / 0 B/op.
- CONTRACT (the SmoothWRR-weights asymmetry): when using BoundedLoad the mirrored inflight counter is
  mutated ONLY through `note()` / the /pool adapter. Direct mutation desyncs `_total` -> the cap goes
  wrong (UB). `_total` starts at 0 and `note()` CLAMPS it at 0 (an over-decrement never drives the
  mean negative). `totalInflight` exposes it for tests / observability. The fuzzer asserts
  `totalInflight === sum(inflight)` after every op.

## Fork 3 -- ctor + eps: validate typeof-first, default 0.25 (ratified, per PeakEWMA / ConsistentHash)

- `new BoundedLoadBalancer(capacity, eligible, inflight, eps = 0.25, weights = null, m = CH_DEFAULT_M,
  seed = 0x9e3779b9)`. `inflight` (required, positional 3) and `eps` are validated typeof-first
  (RangeError on a short/non-Uint32Array inflight; TypeError on a non-number eps, RangeError on
  non-finite / `<= 0`) BEFORE `super()` allocates the (cold, ~256KB) Maglev table -- these read only
  the args (no `this`), so they run before super(). `weights` / `m` / `seed` are validated by super()
  (prime `m >= capacity`, etc.). Default eps **0.25** (Vimeo).

## Fork 4 -- pick(keyHash): sticky, overflow, fail-open-on-overload, fail-closed-on-down (ratified)

- `k = keyHash >>> 0` (NaN -> 0, never throws). `live === 0` -> PICK_NONE. If `_total === 0` the cap
  test is SKIPPED entirely -> behaves as pure ConsistentHash. Else `cap = (1 + eps) * _total / live`.
- Walk the M8 probe window (home slot + `CH_PROBE_LIMIT` slots): return the FIRST backend that is
  ELIGIBLE AND UNDER cap (`inflight[b] < cap`) -- a hot home OVERFLOWS to its neighbours. Remember the
  FIRST eligible seen; if none in the window is under cap, FALL BACK to it (sticky wins -- the cap is a
  soft preference, never a dead pick).
- PICK_NONE is returned ONLY when NO eligible backend is reachable within the window (M8's fail-closed
  contract) -- NEVER merely because backends are over cap (fail OPEN on overload). O(1), 0 B/op.

## Fork 5 -- Pool note() + opts.key hook (ratified, per ADR 0009 / 0010)

- `Pool.run` gains (a) an inert-unless-duck-typed `note` hook (mirror dispatch +1 / settle -1 when the
  balancer duck-types `note`), paralleling the PeakEWMA `recordRtt` wiring; and (b) `opts.key` -- when
  supplied, Pool drives `pick(key)` (keyed / CHBL routing) instead of `pick()` / `pick(now)`. Failover
  re-picks with the SAME key; because the failed backend's occupancy stays elevated (its held
  `note(+1)` across attempts), a CHBL re-pick naturally OVERFLOWS to the next backend. A CHBL + Pool
  keyed round is net-zero on BOTH the caller inflight array AND `_total`. All hooks are inert when not
  applicable -- Pool stays generic.

## Consequences

- Byte-identical siblings: the only Pick.js changes are the appended `BoundedLoadBalancer` (extending
  ConsistentHashBalancer, reusing its Maglev build + probe verbatim), the header roster/count word
  (eight -> nine), and the `VERSION` bump. ConsistentHash itself is unchanged. `peerDependencies` stays
  `{}` (CHBL reuses M8 -- imports nothing new).
- The hotspot anchor (test/balance.mjs): n=64, a Zipfian-skewed key stream (6 hot keys, 85% of
  traffic), a fixed concurrency window. Plain ConsistentHash pins a hot key's whole load on one backend
  -- measured max occupancy **129** vs a mean of **10** (a ~13x hotspot). CHBL caps it: measured max
  occupancy **13** (cap = (1+eps) x mean = 12.5), materially below ConsistentHash's max -- the overflow
  spreads the excess to neighbours. The measured cap band (2.0x mean = the 1.25x continuous cap +
  integer/probe quantization slack) is taken from a correct run with a small margin and noted; the impl
  is never bent to a number, and ConsistentHash (the foil) FAILS the band. CHBL also inherits minimal
  disruption: removing a backend remaps ~1.55% of keys (<= 2/N).
- vs ConsistentHash: same stickiness + minimal disruption, PLUS hotspot protection CH lacks. vs P2C:
  P2C balances by load but is NOT sticky (no cache affinity); CHBL is sticky AND bounded. The cap is
  meaningful ONLY because the primary choice is a hash (Fork 0).
- Bound: O(1) per pick (modulo + table read + bounded cap-aware probe), 0 B/op on BOTH `pick()` and
  `note()` (torture + PerfGate). Fails closed (PICK_NONE) only when no eligible backend is reachable.

## References

- Mirrokni, Thorup, Zadimoghaddam, "Consistent Hashing with Bounded Loads" (Google Research, 2016).
- Vimeo engineering: consistent hashing with bounded loads in production (`eps ~ 0.25`).
- Eisenbud et al., "Maglev: A Fast and Reliable Software Network Load Balancer" (NSDI 2016) -- the table.
