# 0014 -- Soak harness redesign (benchmark-only)

- Status: Accepted
- Date: 2026-09-28
- Supersedes the soak parts of [ADR 0008](./0008-benchmark-suite.md) (the `Soak.mjs` scaffold).
- Follows the external audit at `audit/2026-09-26/` (RECOMMENDATIONS section 1).

## Context

The post-1.0 #8 scaffold (`benchmark/Soak.mjs`) shipped a JSONL stream and drift gates, but the audit
showed the gates measured the wrong thing: they split a cycle-major, ten-lane series into "early" and
"late" quarters, so the memory gate compared *different strategies' heaps* rather than drift over time;
the throughput gate compared halves of a single warm-up cycle; the heap sample was taken mid-cycle and
included the harness's own `JSON.stringify` / `memoryUsage` garbage; and nothing checked that
*selection quality* survived millions of chaotic operations. It also never soaked the `/pool` async
layer. A soak whose gates cannot fail is not a soak.

This is a **benchmark-only** change. `Pick.js`, `Pool.js`, `Pick.d.ts`, `Pool.d.ts` and
`test/invariants.mjs` are byte-identical to their pre-redesign state (a sha256 parity gate enforces it),
`files[]` and the tarball are untouched, and there is no version bump.

## Decision

Replace `benchmark/Soak.mjs` with `benchmark/soak/*`:

- **Time-axis gates.** Per lane, compare the median of the first N post-warmup cycles against the last N
  (`gates.mjs`, a pure module also used by the report tool). Gates report `active` only with enough
  cycles, else `SMOKE`. Verdicts are PASS / FAIL / INCONCLUSIVE / SMOKE / STUB; **INCONCLUSIVE and an
  unverifiable state exit 3** (fail closed), never a silent PASS.
- **Heap after the forced GC.** The lane-boundary sequence closes the workload GC window, forces GC
  until retention drains, and only then samples the heap -- so the leak signal excludes floating
  garbage. Throughput is timed over the pick loop only (a dense batch and a fixed-seed ~95%-down sparse
  batch), never over the cold checkpoint work.
- **A discrete-event load model** (`des.mjs`): a typed-array min-heap of `(completeAt, node)` with
  per-node service times, processor-sharing scaling, and hung-node parking -- so `inflight` behaves like
  a real queue and PeakEWMA sees real RTTs.
- **Quality invariants** (`quality.mjs` + `oracles.mjs`), evaluated on the FROZEN post-chaos state:
  RoundRobin max-min <= 1; SmoothWRR / WeightedRandom weight-fairness (deterministic bound / chi-square);
  P2C balance; LeastConn/SED/NQ **argmin** (not the audit's spread bound, which does not hold once real
  departures exist); ConsistentHash stickiness across membership changes; BoundedLoad reference-walk
  cap; PeakEWMA slow-node / hung-node share (H1).
- **`/pool` lanes** (`pool-lane.mjs`): async dispatch/settle/failover/abort driven by the DES, with a
  per-outcome oracle (success/failover/failAll/hung/abort), `totalInflight === sum(inflight)` checked
  in flight, a lost-run deadline, and zero-unhandled-rejection + retention assertions.
- **Latency** (`latency.mjs`): per-pick timing into a pre-allocated ring, fed cold into a strict-range
  DDSketch (`@zakkster/lite-sketch`). **The gate is on p99, not p999**: individual sub-microsecond pick
  p999 is dominated by OS-scheduling jitter, so a 1.5x p999 ratio false-fails a clean kernel; p99 is the
  robust kernel tail. The granularity floor is `2 * timerFloorNs` (from provenance), not a hard-coded
  constant. p999/max stay in the record, informational.
- **Hot-path 0-B/op probe** (`hot.mjs`): the per-window byte delta is taken over ALL V8 data spaces
  (new + old + large-object), not new-space only, so a large-object or retained leak is visible. The
  within-cycle estimator is the MIN of two independent passes' means (a one-off runtime event lands in
  one pass and is excluded; a periodic allocation lands in both and is caught), and a **cross-cycle
  recurrence rule** (`max(pass1,pass2) > bound` in >= 2 cycles) catches a periodic allocation rarer than
  one pass. The warm bias is the MIN of no-op windows (never over-subtracts), fail-closed above a
  plausibility ceiling.
- **Fail-closed config + provenance** (`config.mjs`, `provenance.mjs`): a bad/unknown `SOAK_*` env value
  exits 2; `SOAK_DURATION` is the burn-in unit; `SOAK_REQUIRE_PROVENANCE` fails closed with no git SHA;
  the header carries schemaVersion, package version, git SHA/dirty, kernel sha256, execArgv, V8/OS/CPU,
  the seed formula, every gate constant, and the B/op bias floor.
- **`soak:teeth`** (`_mustfail.mjs`): every gate and oracle is proven to trip by a kernel/Pool mutant
  driven through the real `main.mjs` (via the `SOAK_KERNEL` / `SOAK_POOL` seams -- `Pool.js` stays
  frozen), plus the config fail-closed cases and a **1.0.0-kernel revert check** that the new quality
  gates must catch (H1/H3/H4). A control that only trips when it calls a gate module directly proves
  nothing about the production gate.
- **`soak:report`** (`SoakReport.mjs`): re-derives the verdict from the raw CYCLE records (the gate via
  the pure `gates.mjs` + the failure signals the cycles carry) and checks the stream is COMPLETE and
  consistent (record counts, a full lane x cycle grid over `header.laneRoster`, `reason==='end'`, the
  exactly-derivable counters match), so it detects an inconsistent or incomplete stream -- an edited
  summary or a dropped set of records is caught (consistent forgery of the cycle records themselves would
  need a MAC and is out of scope). It prints per-lane gate margins, diffs against a `--baseline` (FAIL on
  throughput down > 15%, p99 up > 25%, heap up > 2 MB, quality 0 -> > 0, or a baseline lane missing from
  the current run), and emits a self-contained inline-SVG HTML report. It uses NO charting peer: `@zakkster/lite-charts` is a browser-canvas module with no offline
  artifact, so the SVG is emitted directly.
- **Nightly CI** (`.github/workflows/soak-nightly.yml`): a scheduled 45-minute Linux burn-in plus the
  teeth battery, uploading the JSONL and HTML report; benchmark-only, off the PR path.

## Consequences

- The soak now catches the exact bugs the audit found (the revert check proves it) and any slow drift in
  balance, stickiness, latency steering, memory, or the `/pool` lifecycle.
- Deferred (report-only, not gated yet): the rebuild-storm p99 gate (a `rebuild()` is O(M*N), too costly
  to sample 2000x/cycle); a future rebuild micro-bench should gate per-rebuild B/op (FINDINGS L14).
- Calibration: the hot-alloc bound is 0.02 B/op (clean lanes read 0.000); the heap slack is
  `1.10x + 2 MB`; the RSS runaway guard is `1.75x band-center + 16 MB`. These are recorded in the header
  every run so a drift in the calibration itself is visible.
- `soak:report` integrity re-derives the verdict from the raw cycle records (gate + quality + invariant +
  tracker + pool asserts + the phase-fired self-check + lane conclusiveness), validates `gateN` /
  `warmupCycles` against the `config.mjs` constants, and requires a complete, non-truncated,
  `reason==='end'` stream with a full lane x cycle grid over `header.laneRoster`. It therefore catches an
  edited summary or a dropped/truncated set of records. Accepted residual (would need a MAC to close): a
  CONSISTENT edit of BOTH the cycle records AND the summary; and the three genuinely run-level counters
  not present in cycle records -- `findings`, `warnings`, `unhandledCount` -- plus `header.config.smoke`,
  which remain summary-/header-trusted.
- `soak:report` exits 0 on an internally consistent recorded FAIL (it fails only on an integrity mismatch
  or a `--baseline` regression). The `npm run soak` step's own exit code is the authoritative CI gate; the
  report is an analyser, not the gate.
