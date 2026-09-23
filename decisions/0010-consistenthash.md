# 0010 -- ConsistentHash (M8): the Maglev table, bounded-probe eligibility, caller-integer key

- Status: ratified
- Package: @zakkster/lite-pick 0.8.0 (M8)
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0002 (anti-flapping), ADR 0004 (SmoothWRR sole-writer weights).
- Date: 2026-09-23

## Context

M8 ships `ConsistentHashBalancer` -- sticky / cache-affinity routing: the same key must map to the
same backend, and a scale event must move as few keys as possible (the direct cache-affinity
selling point, RESEARCH dimension 7). It is the family AWS NLB flow-hash (5-tuple) belongs to,
brought to the in-process hop AWS never sees. Several forks had to be settled.

## Fork 1 -- Maglev table over ring-with-vnodes (ratified)

- Options: (a) a Karger **ring** with vnodes (successor query over sorted hashes, O(log n) or an
  `EliasFano` `nextGEQ` O(1)-typical); (b) a prebuilt **Maglev** lookup table (Eisenbud et al.,
  NSDI 2016): O(1) lookup, minimal disruption, O(n) build.
- Ratified: **(b) Maglev.** It is the in-kernel/production choice (Linux IPVS `mh`, Meta Katran,
  Cilium) and its flat, prebuilt `Uint32Array` lookup is the zero-GC O(1) fit -- the pick path is a
  modulo, a table read, and a bounded probe, with no successor search and no per-pick structure walk.
  The build is O(M x N) and COLD, which fits lite-o1's static build-once/immutable honesty contract.
- The `EliasFano` ring remains a DEFERRED optional-peer alternative (a ring lookup IS a `nextGEQ`
  successor query); it is documented, not shipped, and imports nothing.

## Fork 2 -- Caller-supplied INTEGER key; NO per-pick string hashing (ratified, per RESEARCH s5)

- ConsistentHash/sticky requires a key hash; a JS **string** hash allocates -- the one zero-GC
  hazard. Ratified: `pick(keyHash)` takes a caller-supplied **integer**, coerced `keyHash >>> 0`
  (`NaN >>> 0 = 0` deterministically). The caller hashes string keys themselves, COLD (FNV-1a is a
  fine default -- shown in README / RECIPES); `lite-pick` adds **no hashing dependency**.
- `pick` does NOT throw on a bad key (the "pick never throws" fail-closed contract, the PeakEWMA
  `pick(now)` precedent): a non-number coerces via `>>> 0` to a deterministic slot, never an error.
  Constructor args ARE validated typeof-first (RangeError/TypeError), BEFORE the table is allocated.

## Fork 3 -- Eligibility by BOUNDED FORWARD-PROBE, not rebuild (ratified, per ADR 0002)

- `pick(keyHash)`: `slot = keyHash % M`; if `lookup[slot]` is eligible, return it; else forward-probe
  up to `CH_PROBE_LIMIT = 64` slots (`slot = (slot + 1) % M`) for the next eligible backend; past the
  bound, return `PICK_NONE`.
- This is the minimal-disruption mechanism: removing a backend is just `setEligible(i, false)` -- the
  table is UNCHANGED, so every key NOT on that backend keeps its EXACT backend (0 remap) and only its
  ~1/N keys probe forward. A health flap is absorbed by the probe and NEVER triggers a rebuild
  (anti-flap aligned, ADR 0002). The table is rebuilt ONLY on a membership / weight change.
- The bound is a fail-closed limit: under a near-total outage `pick` may return `PICK_NONE` even if a
  far eligible slot exists. That is SAFE (never a dead pick, never a scan-the-whole-table stall on the
  hot path) and over-conservative only under mass outage -- the correct trade for a 0 B/op O(1) pick.

## Fork 4 -- Weighted Maglev populate; balancer-owned weights (ratified, per ADR 0004)

- Each backend b gets a permutation `permutation[j] = (offset + j*skip) % M`, with `offset = h1(b) %
  M` and `skip = h2(b) % (M-1) + 1`; h1/h2 come from a deterministic integer mix (`chMix32`) of the
  backend INDEX plus the ctor seed -- NO string hashing, NO new dependency, no allocation on any path.
- Each backend takes a per-backend slot QUOTA proportional to its weight (unweighted = equal quota),
  the quotas summing to EXACTLY M; the standard Maglev populate loop then fills the table honoring the
  quotas. Because a permutation is surjective over all M slots, a backend with remaining quota can
  always reach an empty slot while one exists -> the populate never stalls.
- Weights are BALANCER-OWNED (the SmoothWRR sole-writer precedent, ADR 0004): copied at construction,
  then mutated only via the cold `setWeight(i, w)` (which rebuilds) or `rebuild()`. Eligibility stays
  the shared read-only bitmap from BalancerBase.

## Fork 5 -- Build-cost guard; M default 65537, configurable (ratified)

- BUILD-COST GUARD (fail closed): the ctor requires `M` to be a **prime integer > 1** (primality is
  what makes a skip yield a full permutation) and `capacity <= M` (more members than slots would
  overfill M / starve backends -- a clear-message `RangeError`, not a silent stall). The proportional
  quota (summing to exactly M) bounds the populate; it cannot overfill.
- M default = **65537** (a prime, 2^16 + 1). The lookup table is `M x 4` bytes -- **~256KB** at the
  default -- a COLD one-time allocation, disclosed in the README honest-cost table and the class doc.
  M is configurable **down** for small pools (any prime `>= capacity`).

## Fork 6 -- Deferred optional peers (ratified, per ADR 0001)

- A `@zakkster/lite-filter` hot-key / known-key oracle (Bloom / BlockedBloom / Cuckoo / XorFilter /
  BinaryFuse, `keys:'int'` zero-alloc, 0 false negatives) is the seam at the KEY-routing layer -- a
  cheap "known-key / hot-key?" check for warm-affinity + admission. WARM/COLD only; the integer
  `pick()` NEVER consults it. And the `EliasFano` ring (Fork 1) is the alternative table structure.
- Ratified: **defer both.** `peerDependencies` STAYS `{}`; a peer is declared only when a shipped code
  path imports it (the suite's optional-peer discipline, ADR 0001).

## Consequences

- Byte-identical siblings: the only Pick.js changes are the appended `ConsistentHashBalancer` (+ the
  `chMix32` / `chIsPrime` cold helpers and the `CH_DEFAULT_M` / `CH_PROBE_LIMIT` constants), the header
  roster/count word (seven -> eight), and the `VERSION` bump.
- The disruption anchor (test/balance.mjs, benchmark/Disruption.mjs): removing 1 of 64 backends remaps
  ~1.6% of 1e5 keys (<= 2/N = 3.13%), versus the naive-modulo foil's ~98% -- the trap quantified.
- Bound: O(1) per pick (modulo + table read + bounded probe), 0 B/op. Build is O(M x N), COLD, disclosed.
