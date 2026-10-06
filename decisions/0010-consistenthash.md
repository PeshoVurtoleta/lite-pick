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

## Amended in 1.0.1 (2026-09-27) -- clarify the cold-path allocation (audit L14)

"No allocation on any path" (Fork 4) is scoped to the `chMix32` permutation MATH, which allocates
nothing. To be exact for the honest-cost table: the weights ARE copied into a balancer-owned array
at construction (Fork 4 already says so), and each `_build` / `setWeight` / `rebuild` allocates the
Maglev table (`M x 4` bytes) PLUS the populate scratch (a few `Int32Array(N)` + a `Uint8Array(M)`),
so a rebuild leaves cold garbage. This is a COLD-path cost only; `pick()` remains 0 B/op. The
README honest-cost table is corrected to match (it no longer says weight views are "never copied").

## Amendment 2026-10-04 (1.1.0, audit 2026-09-29 L3 + L7)

- **L3: no give-up past the probe window.** 1.0.x returned `PICK_NONE` when the home slot and the next 64
  slots all mapped to down backends, even with backends up. 1.1.0 runs a cold O(M) forward sweep there
  (`_sweep`), the idea of Linux IPVS `mh-fallback`; `PICK_NONE` now means no eligible backend owns a slot.
  BoundedLoad uses the same sweep when its window holds nothing eligible (cap ignored). The fail-closed oracle
  is `reachableInTable` (was `reachableWithinBound`).
- **L7: additive stepping.** `_build` walks each permutation with `c += skip; if (c >= M) c -= M` instead of
  `(offset + j*skip) % M` -- identical tables (golden fingerprints in `test/ConsistentHash.test.js`), so an
  upgrade moves no key; 10.5 ms -> 1.3 ms per rebuild at the default M = 65537 (1.7x at 4099).
- **`setWeights(weights)`:** copy all weights, one rebuild (the soak used to write `_weights` directly).

## Amendment 2026-10-05 (1.1.0, research/1.1.0-kernel-and-api.md D6): drain vs remove -- documented, no code

Linux IPVS `mh` takes a backend out two ways: weight 0 DRAINS (the table is built from the last non-zero
weight, so the server keeps its slots; lookups skip it) and deleting the server REMOVES it (a rebuild). This
balancer already has both: `setEligible(i, false)` is the drain (the table is unchanged, the probe skips the
backend) and `setWeight(i, 0)` is the remove (a rebuild that gives it no slots). Measured on the 1.1.0 kernel,
64 backends, 200,000 keys, every backend in turn: a drain moves 0 other keys and its keys spread over all 63
others (largest share 2.9%); a remove moves a median 0.49% of other keys at M = 65537 (0.40-0.59%) and 2.5% at
M = 4099; undoing either restores every key (the build is deterministic in the weights). BoundedLoad inherits
both. No new API: RECIPES.md section 9, GUIDE.md and llms.txt document which to use and that our weight 0 is
IPVS's delete, not its weight 0.

## Amendment 2026-10-06 (1.1.1, audit 2026-10-05 K9): the table-size `M` upper bound

Fork 5 bounded `M` below (prime, `> 1`, `>= capacity`) but not above. The Maglev populate (`_build`) indexes
its per-permutation cursor through an `Int32Array` (`offset` / `cur`); for `M > 2^31 - 1` those offsets wrap
negative and the populate silently corrupts the table (a slot backfilled to backend 0), with no error. 1.1.1
adds the correctness bound to the constructor: `M > 2147483647` throws `RangeError` with code
`LITE_PICK_OPTION`. BoundedLoad inherits it through `super()`. The guard lives on the cold constructor path, so
`pick()` is byte-identical and every selection stream is unchanged (StreamParity). A regression test
(`test/ConsistentHash.test.js`) stubs `globalThis.Uint32Array` to throw a sentinel for `length > 2^30` and
asserts the ctor rejects `M = 2147483659` (a prime) with `LITE_PICK_OPTION` BEFORE allocating -- it fails on
HEAD (the sentinel is reached) and passes on the tree.

A **hard** allocation cap is still wanted: even a legal `M` near 2^31 asks for a multi-gigabyte `Uint32Array`,
and an over-large typed array is an uncatchable V8 fatal, not a `RangeError` (packaging law). The decision is
to ship only the correctness bound in 1.1.1 and defer the ergonomic `M <= 2^24` HARD cap (with a
`LITE_PICK_OPTION` did-you-mean) to 1.2.0; the docs already RECOMMEND `M <= 2^24` because the build is
`O(M x N)`. Recorded in the ROADMAP 1.2.0 queue.
