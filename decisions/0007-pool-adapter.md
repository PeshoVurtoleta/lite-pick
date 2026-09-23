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

- The kernel `pick()` is 0 B/op (torture + PerfGate). `Pool.run` is a NORMAL async wrapper: the
  request it wraps already allocates a promise; Pool adds only O(1) integer counter ops per attempt
  plus one small per-run `held` array. Ratified: **disclose the boundary loudly** (llms.txt, README,
  the class doc) rather than imply the async layer is 0 B/op. Honesty over a hollow claim -- the
  same discipline as the SmoothWRR O(cap) and P2C "2^-32 escape hatch" disclosures.

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
