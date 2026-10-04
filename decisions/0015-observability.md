# 0015 -- Observability: error codes, a stats slab of internal events, describe(), assertConsistent()

- Status: Accepted
- Package: @zakkster/lite-pick 1.1.0
- Builds on: ADR 0001 (selection-kernel boundary: the kernel owns as little as it can), ADR 0013 Fork 1
  (setEligible is the only eligibility writer; the Eligibility object waits for 2.0).
- Research: `research/1.1.0-kernel-and-api.md` section 7, decision D7 (accepted 2026-10-04).
- Date: 2026-10-04

## Context

1.0.x threw plain TypeError / RangeError with messages only (Pool's six run-time rejections already had a
`code`), counted nothing, and printed as a dump of private fields. Operators of Envoy, HAProxy and IPVS
expect stable error codes, counters, and a status snapshot. The kernel's constraint: none of it may touch
the healthy pick path (0 B/op, ns-scale).

## Fork 1 -- Error codes: `LITE_PICK_*` on the existing classes

Every throw keeps its class and gains `code`. Node's rule: messages may change, codes are API. Codes are
coarse on purpose (8 kernel codes: CAPACITY, ARRAY, INDEX, WEIGHT, OPTION, ARGUMENT, ABSTRACT,
INCONSISTENT), so a new validation lands in an existing code instead of growing the list.

Deviation from the research text: D7 proposed `LITE_PICK_ERR_*`. Pool has shipped `LITE_PICK_NONE`,
`LITE_PICK_ABORTED`, `LITE_PICK_FEEDBACK`, `LITE_PICK_KEY_REQUIRED`, `LITE_PICK_CLOCK_REQUIRED` and
`LITE_PICK_CLOCK_INVALID` since 0.5.0-1.0.1; renaming them is a breaking change and two prefixes in one
package is worse than one. New codes follow the shipped `LITE_PICK_*` prefix. (Still not `ERR_*`, which
reads like Node's own.)

## Fork 2 -- Counters: only what the caller cannot see, only off the healthy path

A caller-owned `Float64Array` (exact to 2^53; a Uint32Array wraps in ~7 minutes at 10M/s; BigUint64Array
allocates), indices `STAT_*` only ever appended, never reset by the library. Attached with
`attachStats(slab)`; without one the sites write a shared scratch slab, so no counting site branches.

Deviation from the research text: D7 listed `STAT_PICKS` and `STAT_PICK_NONE`. Measured (darwin arm64,
Node 26, 256 nodes): one `this._stats[0] += 1` per pick took RoundRobin from 2.1 to 5.7 ns (a
read-modify-write of one memory slot every pick serializes the loop), P2C +2%, ConsistentHash +5%. The
caller already sees every pick and every PICK_NONE, so counting them in the kernel buys nothing it cannot
count itself. Shipped instead, each on a cold or already-slow branch:

- `STAT_FALLBACK_SCANS` -- the P2C / PeakEWMA (now a cold module function `_kthEligible`, out of the hot
  `_draw`) and WeightedRandom very-sparse fallbacks, the ConsistentHash / BoundedLoad full-table sweep.
- `STAT_REBUILDS` -- every CH / BL / WR table build.
- `STAT_DISPLACED` -- a CH / BL keyed pick that leaves its home backend: the affinity-loss signal no caller
  can compute without re-deriving the table. On the probe branch only: 0 cost when the home serves;
  measured +8-12% (CH) / +2-8% (BL) per pick with HALF the pool down, ~0.5 ns per displaced pick.

## Fork 3 -- describe() and util.inspect

A cold, allocating, JSON-safe snapshot (plain arrays, copied) with base fields and per-strategy state,
for logs and admin endpoints (Envoy `/clusters`, HAProxy `show stat`). Node's inspect hook is installed by
its registry symbol `Symbol.for('nodejs.util.inspect.custom')`: no `node:util` import, a dead key in
browsers. `toJSON` was not added: `JSON.stringify(lb.describe())` is explicit and costs nothing.

## Fork 4 -- assertConsistent() (audit H2, until the 2.0 Eligibility object)

Opt-in, O(cap), throws `LITE_PICK_INCONSISTENT`: recount `live` from `eligible[]` (and reject a byte other
than 0/1 -- setEligible writes only those), SmoothWRR's eligible-weight total, WeightedRandom's table weight
sum, and BoundedLoad's noted total against the inflight sum. It detects the misuses, it does not repair them
(a repair would hide the caller's bug). For tests and debug builds.

## Consequences

- No healthy-path cost: PerfGate 34/34 at 0 B/op on Node 22 and 26 with the counting sites in place.
- The stats layout and the code list are semver API; both may only grow.
- Pool's dispatch/settle events are not counters here: they belong to B5 (`diagnostics_channel`).
