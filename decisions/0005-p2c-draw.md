# 0005 -- P2C (M3): rejection-sampling draw, bounded distinct redraw, caller-owned inflight

- Status: ratified
- Package: @zakkster/lite-pick 0.3.0 (M3)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0003 (RoundRobin draw fork).
- Date: 2026-09-23

## Context

M3 ships `P2cBalancer` -- power-of-two-choices, the headline strategy and the home of the
balance-quality anchor (the `ln ln n / ln 2` peak-load ceiling, Azar-Broder-Karlin-Upfal).
Three forks around the random eligible draw and the load counters had to be settled.

## Fork 1 -- Random eligible draw: rejection sampling, no peer (ratified)

- Options: (a) rejection-sample the shared eligibility bitmap (draw a random index, retry if
  its bit is 0, bounded retries + a zero-alloc fallback); (b) maintain a dense eligible set
  (lite-o1 `RandomSet`, an optional peer) for a true worst-case-O(1) uniform draw;
  (c) a static rank/select index (lite-o1 `RankSelect`) for O(1) `select1`.
- Ratified: **(a) rejection sampling, no peer.** In the common case eligibility is dense
  (most nodes up), so a draw succeeds in ~1 try -- effectively O(1) -- with NO peer, NO owned
  draw-set, and NO synchronization burden. Uniform draws hold (so the `ln ln n` guarantee is
  intact). The degenerate sparse case (few live in a big pool) falls back to a rotated linear
  scan from a random start (unbiased first-eligible-after-a-random-offset), still zero-alloc.
- Why NOT (b) yet: `RandomSet` gives worst-case O(1) but OWNS a maintained dense structure
  updated in `setEligible` -- worth it only when sparse-eligibility draw cost is MEASURED to
  matter. It is the deferred optional-peer optimization; `RandomSet` (dynamic) is the correct
  member for a MUTATING eligibility set.
- Why NOT (c): `RankSelect` is STATIC / build-once -- an O(n) rebuild on every `setEligible`
  is the wrong tradeoff for a mutating bitmap. It belongs to fixed bit patterns, not eligibility.

## Fork 2 -- Distinct second choice: a bounded redraw, not a single nudge (ratified enrichment)

- Options: (a) draw b, and if b === a, redraw ONCE (the RESEARCH s7 reference "one nudge");
  (b) redraw b in a BOUNDED loop until b !== a (up to 32 tries).
- Ratified: **(b) bounded redraw.** A single nudge collides often at small pools (n=2: ~25%
  of picks return the first draw without a compare, degrading two-choices toward random). A
  bounded redraw makes the second choice distinct with probability ~1 - 2^-32 at any live>=2,
  while staying expected-O(1) (about two draws) and 0 B/op. The two-choices balance property
  then holds at ALL pool sizes, not just asymptotically large ones. Ties (equal in-flight) go
  to the first draw -- unbiased over many picks.
- Correctness invariant is absolute regardless: the fallback returns an ELIGIBLE index (never
  a dead pick), and fail-closed `PICK_NONE` when the whole pool is down. Only balance-optimality
  carries the 2^-32 escape hatch, disclosed.

## Fork 3 -- In-flight counters: caller-owned, pure read (ratified, per ADR 0001 Fork 4)

- `inflight` is the CALLER's `Uint32Array`, passed at construction, only READ by `pick()`.
  The caller (or the M5 lite-query adapter) increments on dispatch and decrements on settle;
  lite-pick holds no request state. Validated at construction (Uint32Array, length >= capacity).

## Consequences

- `P2cBalancer` owns only its instance PRNG (seeded, deterministic -- the balance benchmark is
  reproducible). d = 2 fixed (a configurable-d variant is a possible later enhancement).
- Bound: O(d) = O(1) per pick; 0 B/op (torture + PerfGate). No peer -- `peerDependencies` stays
  empty; lite-o1 remains a deferred optional-peer optimization (Fork 1).
- The balance anchor (test/balance.mjs) demonstrates the ceiling: at n=1024, k=32 balls/bin,
  P2C peak-to-mean gap ~2 vs a random single-draw foil's ~21, and P2C's gap stays ~2-3 as n
  grows while random's grows -- the additive `ln ln n` property, measured, not asserted.
