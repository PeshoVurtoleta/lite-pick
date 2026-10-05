# 0007 -- The ergonomic request layer (M5): a /pool subpath, spatial-vs-temporal retry, duck-typed fetcher

- Status: ratified
- Package: @zakkster/lite-pick 0.5.0 (M5)
- Builds on: ADR 0001 (selection-kernel boundary -- caller-owned counters, the adapter ergonomics).
- Date: 2026-09-23

## Context

M5 ships the "counter ergonomics" ADR 0001 promised: the layer that increments in-flight on
DISPATCH, decrements on SETTLE, and re-picks a DIFFERENT endpoint on failure -- plus the
integration with a query cache (lite-query). Reading lite-query's surface settled the shape:
its fetcher is just `async ({ key, signal }) => any`, a shape we can satisfy WITHOUT importing
lite-query. Four forks were settled.

## Fork 1 -- Home: a `lite-pick/pool` subpath, NOT the LiteQuery repo (ratified)

- Options: (a) a `@zakkster/lite-pick/pool` subpath in THIS repo (Pool.js, a second entry file);
  (b) an adapter living in the LiteQuery repo; (c) inline the async wrapper into the kernel Pick.js.
- Ratified: **(a) the /pool subpath.** It keeps selection knowledge in lite-pick (the query layer
  stays unaware of balancing -- putting it in LiteQuery would invert the dependency). It obeys the
  suite's single-file law where it matters: the KERNEL stays one PascalCase 0 B/op file (Pick.js);
  the async layer is a SEPARATE subpath file, exactly as lite-query ships `./stream` (StreamQuery.js)
  and `./await` (Awaitable.js) as subpath entries with optional peers. (c) is rejected outright: the
  async wrapper allocates (promises, per-run bookkeeping) and would pollute the kernel's 0 B/op
  torture/PerfGate surface. `exports` gains `./pool`; `files[]` gains Pool.js + Pool.d.ts.

## Fork 2 -- Retry ownership: SPATIAL failover here, TEMPORAL retry in the caller (ratified)

- The hazard (RESEARCH, and lite-query's own `withRetry` boundary note): double-owning retry.
- Ratified: **Pool owns SPATIAL failover only** -- on a thrown error, try up to `tries` DISTINCT
  endpoints, once each, then surface the last error. The caller / the query cache owns TEMPORAL
  retry (backoff, staleness, dedup -- lite-query's `retry`). They compose without overlap: Pool
  moves ACROSS the pool once (fast, in-process, connection-failure failover); the cache retries the
  whole logical operation over TIME. Default `tries: 1` (no failover) so the lean path is opt-out.
- Distinct-endpoint mechanism (the elegant part): on a failure Pool KEEPS the failed endpoint's
  in-flight count ELEVATED and re-picks. A load-aware strategy (P2C/LeastConn/SED/NQ) then reads
  that elevated count and STEERS the next pick elsewhere -- so "re-pick a different node" emerges
  from the existing selection logic, NO avoid-last hack, correct for every load-aware strategy. All
  counts a run raised are released in a `finally` (net-zero per run, even on throw). For a single
  live node it re-picks the same node (correct -- nowhere else to go); for RoundRobin the cursor
  advances anyway. (An earlier avoid-last-via-redraw idea was rejected: it cannot escape a
  DETERMINISTIC balancer like LeastConn, which returns the same index until load changes.)

## Fork 3 -- The 0 B/op boundary is EXPLICIT, not walked back (ratified)

- The kernel `pick()` is 0 B/op (torture + PerfGate). `Pool.run` is a NORMAL async function: the
  request it wraps already allocates a promise; Pool adds its own promise, frame and one await per
  attempt. Ratified: **disclose the boundary loudly** (llms.txt, README,
  the class doc) rather than imply the async layer is 0 B/op. Honesty over a hollow claim -- the
  same discipline as the SmoothWRR O(cap) and P2C "2^-32 escape hatch" disclosures.

### Amendment (Pool cost gate) -- "disclose loudly" STANDS; the NUMBER is now measured and gated

The original wording quantified Pool's cost as "O(1) integer counter ops per attempt plus one small
per-run `held` array". That understated it: Pool.run is an async function, so each run inherently
allocates a promise and a frame and one await per attempt. The ladder in
`test/perf/pool-cost-lanes.mjs` (one lane per child, FIXED 3,000,000-run warm-up, young gen pinned to
1 MiB, allocation RATE by scavenge count -- `npm run bench:pool`) attributes Pool's OWN share as the
lane delta above the bare-`await` driver floor L1:
- a run that SETTLES ON ATTEMPT 0 (any `tries`): **L3 - L1 = ~900 B/run** (Node 22 v22.23.3 904.0;
  Node 26 v26.8.2 865.9);
- each extra FAILOVER attempt: **L6 - L3 = ~375 B/run** (Node 22), so the one-failover share
  **L6 - L1 = ~1280 B/run**.

ADR 0015's **~1331 B/run** was a FULL-run P2C figure (4443 scavenges / 3.5M runs) that counts `fn` AND
the driver's own await loop -- NOT Pool's own share; the like-for-like comparison is HEAD's Pool-own
share L3 - L1 (~1254 B/run on Node 22, ~1210 on Node 26) dropping to F1's ~904 / ~866.

The claim is now **gated** by `test/perf/PoolCost.test.mjs` at **`CEIL = measured share + 8 B`**, keyed
by EXACT `process.version` (V8 fixes the per-run byte cost; under the fixed warm-up + 1 MiB pin the
scavenge counts are stable to +/-1, ~0.7 B/run; 8 B is below one boxed double so a single boxed value
crossing a call trips the gate yet never flakes -- except the Node-26 failover lane L6, bimodal under
CPU contention, whose row pins the UPPER mode so the low mode only passes): attempt-0 `<= 912 B`/run,
failover `<= 1288 B`/run and clocked `<= 944.2 B`/run on Node 22 (the CI perf job, pinned to node
22.23.3); attempt-0 `<= 873.9 B`, failover `<= 1284.3 B` and clocked `<= 936.8 B` on Node 26 (v26.8.2).
The **clocked** row gates a latency-aware balancer (PeakEWMA) driven by a 1.7e15 epoch-ns clock, which
V8 boxes at the non-inlined `pick()`/`recordRtt` boundary (read twice per successful attempt): ~32 B/run
more than L3 on Node 22, ~63 on Node 26. (Abort BEFORE dispatch, lane L7 ~1374 B/run on Node 22, is
ungated and ABOVE a successful run -- abort must never be quoted as cheap.) Teeth: an escaped
boxed-double (`PL_BOX`/`PL_BOX6`/`PL_BOX8b`) and an escaped `{a:i}` (`CTRL_OBJ`/`CTRL_OBJ6`) must trip
their ceilings; a PROMOTE control must force an old-gen collection (so the oldGen==0 assertion is not
vacuous -- a RETAINED, pretenured per-run object does not raise the B/run scavenge rate and is only
caught here); a deliberately retained Pool must keep the leak tracker non-empty. A `process.version`
with no row fails closed, printing the measured shares. Never widen a ceiling to pass.

**F1 (the one shipped code change):** a run that never fails over keeps attempt 0 in scalars
`d0`/`e0`/`n0` (a SEPARATE `d0` dispatched flag, so `e0` is never used as a truthiness test -- a
duck-typed balancer may return undefined / NaN / a negative / a non-number, which an `e0 >= 0` test
would mis-handle) and builds the `held`/`noteApplied` arrays LAZILY (with `push`, not a `[e0]` literal
that would reallocate on the first failover) only when a second attempt begins. So a run that settles on
attempt 0 allocates no per-run bookkeeping array -- and this ALSO covers a `tries >= 2` pool's common
case (a request that succeeds on attempt 0: lane L6S = L3, ~344/~350 B/run cheaper than 1.1.0).

**Failover regression, disclosed (NOT gone):** because 1.1.0 allocated the arrays unconditionally, its
L3 already paid for them and its L6 added ~nothing on Node 26 (L6 == L3). F1 defers the arrays to the
failover branch, so an ACTUAL one-failover run (lane L6, attempt 0 throws) now costs **~67 B/run MORE
than 1.1.0 on Node 26** (1324.2 vs 1257.5) and **~16 B/run LESS on Node 22** (1484.5 vs 1500.2). A
considered variant (allocate the arrays up front whenever `tries > 1`) removes the Node-26 failover
regression but regresses the far more common `tries >= 2` success path (L6S) back to 1.1.0's ~344 B/run,
so it was rejected: the net is better to save on every success and pay ~67 B only on the rare
Node-26 failover. The gate pins L6 at its F1 value, so the failover path cannot regress FURTHER.

Measured attempt-0 saving ~344 B/run (Node 26) / ~350 B/run (Node 22); ~10% faster per run on Node 22,
~3-5% on Node 26 (best-of-5 of 2M awaited attempt-0 runs). Behaviour is byte-identical: a golden trace
(every balancer x tries 1/2/3 x success/throw/abort/no-endpoint/feedback-failure/throwing-note, PLUS
non-sentinel picks, a throwing note(+1) on a failover attempt, a throwing cleanup note(-1), a throwing
subscriber, a nested run, PICK_NONE / scan exhaustion on a later attempt) has an UNCHANGED sha256 HEAD
vs the working tree, and every suite passes with no test edits. Your `fn`'s closure, promise and I/O
still come ON TOP -- a submit-shaped `fn` adds ~310 B/run (ladder L10-L3); the capstone's full request
wiring measured ~2.9 KB/request end to end on 1.1.0, before this change. For 0 B/request, hand-wire
`pickFrom` + settle.

## Fork 4 -- lite-query coupling: DUCK-TYPED, zero peers (ratified)

- Options: (a) declare `@zakkster/lite-query` an optional peer and import its types; (b) duck-type
  the fetcher shape and import nothing.
- Ratified: **(b) duck-typed.** `liteQueryFetcher(pool, perEndpoint, opts?)` returns a value shaped
  like lite-query's `({ key, signal }) => Promise` fetcher WITHOUT importing lite-query, so
  `peerDependencies` STAYS EMPTY through M5 and the same helper serves any fetcher-shaped consumer
  (a custom cache, a route loader). lite-pick declares a peer only when a shipped code path IMPORTS
  a sibling (ADR 0001); the fetcher shape is a structural contract, not an import.

## Consequences

- Two exports at `@zakkster/lite-pick/pool` (Pool.js): `Pool` (dispatch/settle + failover) and
  `liteQueryFetcher` (the duck-typed cache adapter), + a re-exported `VERSION`.
- `peerDependencies` stays `{}` (Fork 4). The kernel's gates (torture/PerfGate/witness/balance/fuzz)
  are unchanged -- Pool is async and gated instead by a node:test boundary suite (dispatch/settle
  balance, distinct-endpoint failover, fail-closed coding, abort-stops-failover, and a 200-way
  CONCURRENT-consistency check proving in-flight drains to all-zero -- no counter leak).
- `demo/fanout.mjs` is the moat: least-conn fan-out over a flaky pool with a node killed mid-run,
  proving 0 dead picks + 0 leaked in-flight + live failover, and showing the lite-query fetcher wiring.
- M5 is an ADAPTER session, not a strategy append: it does NOT add a row to the s0 single-file
  strategy-accounting table (that table governs Pick.js strategies); it touches Pool.js/.d.ts,
  package.json (exports/files), llms.txt, test/Pool.test.js + the type test, the demo, and the docs.
