# 0003 -- RoundRobin (M1): stateless bitmap forward-scan, not a maintained eligible-set

- Status: ratified
- Package: @zakkster/lite-pick 0.1.0 (M1)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping).
- Date: 2026-09-23

## Context

M1 ships the first strategy, `RoundRobinBalancer`. ROADMAP section 2 flagged the one open
fork: how does a wrapping round-robin skip ineligible nodes?

- **Option A -- bitmap forward-scan.** A single integer cursor. `pick()` advances the cursor
  and scans the shared eligibility `Uint8Array` forward (wrapping) until a set bit. Owns
  nothing but the cursor. O(1) amortized when eligibility is dense, O(cap) worst case under
  sparse eligibility (bounded by one wrap -- `_live > 0` guarantees a hit).
- **Option B -- maintained eligible-set.** A dense list of the currently-eligible indices
  (lite-o1 `SparseSet`/`RandomSet`), so round-robin is O(1) worst case over live nodes. Cost:
  the balancer OWNS a derived structure that `setEligible` must keep in lockstep with the
  shared view, and it pulls in lite-o1 as an optional peer dep before any strategy needs the
  peer's OTHER capability (a random eligible draw).

## The ratified choice: Option A for M1, Option B revisited at M3

**Option A.** Rationale:

1. **Own no state you can avoid owning (ADR 0001).** A cursor is the minimum. A maintained
   eligible-set is a second copy of eligibility that can drift from the shared view; the
   forward-scan reads the ONE source of truth and cannot diverge.
2. **Prove the eligibility SEAM on the simplest strategy.** RR-over-the-bitmap exercises
   exactly the shared-`Uint8Array` contract every later strategy depends on, with no
   intermediary structure to hide a bug.
3. **Pay for the peer when a code path needs it, not before.** Option B's real payoff is
   P2C's RANDOM eligible draw (M3), where lite-o1 `RandomSet` gives O(1) uniform sampling +
   swap-remove. That is the honest moment to declare `@zakkster/lite-o1` as an OPTIONAL peer
   dep (`peerDependenciesMeta.optional`, the suite model) and let RR adopt the shared eligible
   set too, if measurement then shows the O(cap) sparse worst case matters. Bringing the peer
   in at M1 would be a dependency with no shipped consumer.

**The worst case is disclosed, not hidden.** Under pathological sparsity (few live nodes in a
large pool) a single `pick()` scans up to `cap` bits. In practice pools are small, most nodes
are up, and the health/anti-flap layer (ADR 0002) keeps eligibility from thrashing -- so the
amortized O(1) holds. The witness gate measures the dense steady state; the sparse edge is a
documented trade, revisited at M3 with real P2C numbers.

## Consequences

- `RoundRobinBalancer` owns only `_cursor`. No lite-o1 dependency, no peer declared at M1
  (`peerDependencies` stays empty).
- Fairness is PERFECT over the live set (balance gate: imbalance 1.0000, max-min <= 1), and
  `pick()` never returns a down index nor a dead pick when the pool empties (fail-closed
  PICK_NONE) -- proven under adversarial churn (RoundRobin.test.js) and at 0 B/op (torture +
  PerfGate).
- Reversible: if M3 adopts the shared eligible-set substrate, RR can switch to Option B behind
  an unchanged `pick()` signature. This ADR is the record of why it did not lead with it.
