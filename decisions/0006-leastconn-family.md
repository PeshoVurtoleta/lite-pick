# 0006 -- LeastConn family (M4): exact-O(cap) scan, live-read counters, SED/NQ, the lite-logn exact-O(log n) seam

- Status: ratified
- Package: @zakkster/lite-pick 0.4.0 (M4)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0004 (weight ownership), ADR 0005 (P2C).
- Date: 2026-09-23

## Context

M4 ships the load-aware cohort -- the IPVS `lc` / `sed` / `nq` family made zero-GC. M3's
`P2cBalancer` already reads the caller-owned in-flight view and returns the lower of two random
choices, so **P2C IS the O(1) least-connections APPROXIMATION** ("P2C-least-conn"). M4 therefore
adds the EXACT complement (a full scan) and the weighted variants, plus confirms the seam for the
exact-O(log n) variant. Four forks were settled.

## Fork 1 -- P2C-least-conn is already shipped; M4 ships the EXACT family (ratified)

- The roadmap listed "P2C-least-conn (O(1) default)" as an M4 deliverable, but P2cBalancer over
  `inflight` (M3) already IS that -- a distinct `P2cLeastConnBalancer` class would be a redundant
  alias. Ratified: **do not ship a redundant alias.** M4's net-new value is the EXACT scan family:
  `LeastConnBalancer` (exact fewest-in-flight), `SedBalancer`, `NqBalancer`. Docs make explicit
  that P2C is the O(1) approximation and LeastConn the exact-O(cap) complement (the same
  approximate/exact split lite-o1 : lite-logn draws across the suite).

## Fork 2 -- Granularity: exact O(cap) scan first, P2C-approximation deferred (ratified)

- Options: (a) exact full O(cap) scan (exact minimum, deterministic); (b) P2C-sample the SED/least
  score for O(1) (approximate).
- Ratified: **(a) exact scan first.** It is the simplest correct implementation, gives the exact
  optimum (a strong fuzzer invariant -- see Fork 4), and matches SmoothWRR's already-accepted
  honest O(cap). A P2C-approximation of SED/least-conn is a labeled O(1) fast-path variant to add
  only if the witness/benchmark shows the cap-scan cost matters at real pool sizes (dozens to
  hundreds of endpoints, where an O(cap) scan is a few ns). Exact-first, approximate-on-demand.

## Fork 3 -- Counter/weight ownership: caller-owned, read LIVE, no derived aggregate (ratified)

- `inflight` (LeastConn/SED/NQ) and `weights` (SED/NQ) are the CALLER's `Uint32Array`s, read on
  each scan. Ratified: **no `setWeight`, no maintained total.** UNLIKE SmoothWRR (ADR 0004), these
  strategies keep NO derived weight/inflight aggregate -- the score is recomputed from the live
  arrays every pick -- so there is nothing to desync, and the caller MAY mutate `inflight` and
  `weights` directly between picks. That is the whole point of the shared-counter seam (ADR 0001
  Fork 4): the feedback loop (increment on dispatch, decrement on settle) writes `inflight`
  directly; the M5 lite-query adapter provides the ergonomic layer. This is a deliberate,
  documented API asymmetry with SmoothWRR (which owns smoothing accumulators and therefore MUST be
  the sole weight writer).
- SED/NQ candidacy: an eligible endpoint with weight 0 has infinite expected delay -> it is NOT a
  candidate. If every eligible endpoint has weight 0, `pick()` fails closed (`PICK_NONE`), even
  while `live > 0`. Tie-break is the lowest index (deterministic); the feedback loop breaks a
  startup all-equal tie by raising the picked node's count.
- NQ ("never queue"): the FIRST idle eligible positive-weight node (in-flight 0) short-circuits the
  scan (O(1) when an early node is idle); with no idle node it reduces to SED (a full O(cap) scan).

## Fork 4 -- Exact-O(log n) fewest-in-flight: a deferred lite-logn `BinaryHeap` peer seam (confirmed)

- The exact minimum in O(log n) (not O(cap)) needs an addressable priority queue with an O(log n)
  decrease/change-key. Confirmed seam: **@zakkster/lite-logn `BinaryHeap`** -- an INDEXED min-heap
  over three parallel typed arrays with `changeKey(id, newKey)` O(log n), `peek()` / `keyOf` /
  `has` O(1), 0 B/op per op (llms.txt, lite-logn 0.16.0). An exact-O(log n) least-conn balancer is
  a `BinaryHeap` keyed by endpoint index: `changeKey(i, inflight[i])` on each dispatch/settle,
  `peek()` = the least-loaded endpoint. This would be lite-pick's FIRST lite-logn OPTIONAL PEER.
- Ratified: **confirm the seam, DEFER the code.** The exact-O(cap) scan is correct and 0 B/op at
  real pool sizes; the heap variant earns its peer dependency only when a large pool (thousands of
  endpoints) makes the O(cap) scan measurably hot. When it lands it is `peerDependencies:
  { "@zakkster/lite-logn": ... }` + `peerDependenciesMeta.optional: true` (the LiteQuery model,
  ADR 0001) -- never inlined, never vendored. Eligibility interplay (a down node must be excluded
  from the heap min) is the design note carried to that session.

## Consequences

- Three new classes, all `extends BalancerBase`, all O(cap)/pick (NQ O(1) when an early node is
  idle), all 0 B/op (torture phases 6-8 + PerfGate scenarios 7-9 + three `mustFail` teeth).
- `peerDependencies` stays EMPTY -- no shipped code path imports a sibling yet (lite-logn is the
  Fork 4 deferred seam). Zero HARD deps, zero peers present.
- The invariant fuzzer (test/fuzz.mjs, RESEARCH s3) is the M4 correctness headline: it asserts the
  EXACT-optimum invariant for LeastConn/SED/NQ (the chosen score equals the recomputed minimum),
  NQ's idle-first rule, weight-0 exclusion, and fail-closed-IFF -- after every op, seeded, with a
  retrofit covering M2 SmoothWRR's `_totalEligibleWeight`/`_live` state-synchronisation.
- Balance anchors (test/balance.mjs): LeastConn is greedy-perfect (max-minus-min <= 1, tighter than
  P2C's ln ln n gap); SED converges to load proportional-to-weight (< 1% drift, weighted-imbalance
  far below a random foil); NQ fans the first n dispatches out to n distinct idle workers.
