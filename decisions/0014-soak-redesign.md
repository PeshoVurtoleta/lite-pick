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
`test/invariants.mjs` are byte-identical to their pre-redesign state (checked by hand with `diff` at the
time -- correction, audit 2026-09-29 S6: an earlier wording said "a sha256 parity gate enforces it"; no
such gate existed then. It does since the S6 amendment below: `npm run parity`),
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

## Amendment 2026-10-03 -- audit 2026-09-29 (S1, S5)

The redesign was validated only on Node 26 / Apple M4 / an idle machine. On Node 22 (the nightly's pin)
it false-FAILs a correct kernel. Two decisions change:

- **hotAlloc is report-only below the gross tier (S1).** In one long-lived process running 20 lanes,
  shared step functions plus a fresh balancer per lane-cycle drive V8 into deopt windows that box doubles:
  a correct kernel reads 8-20 B/op in some cycles (quantized ~16 B HeapNumbers), and the cross-cycle
  recurrence rule turns that into a FAIL. `--no-concurrent-recompilation` cleans the kernel lanes but not
  the tiny lanes. A forked per-lane probe (the audit's option C) would measure a fresh balancer in a fresh
  process -- which is what PerfGate (`test:perf`) already does, with isolated scavenge counting -- so it
  would add a second copy of PerfGate rather than soak evidence. Decision: the soak keeps measuring and
  prints `soak: NOTE -- hotAlloc[lane] ...` (verdict STUB) when a lane is over 0.02 B/op; it still FAILs
  on the gross tier (every window scavenged, i.e. >= one 4 MB semi-space per 8192-pick window, ~512 B/op)
  and on a non-finite measurement. Per-op 0 B/op is owned by PerfGate (verified to FAIL on the same
  allocation mutants the soak used: M1-M4, M16); retention by `torture` and the soak's heap drift gate.
  The teeth controls M1-M4/M16 now assert the NOTE (the probe still sees the allocation), exit 0.
- **No evidence, no PASS (S5).** A non-smoke run where any kernel/tiny lane has fewer than 2N post-warmup
  cycles (all its drift gates SMOKE), or a bounded run interrupted before its end, is INCONCLUSIVE
  (exit 3) with one `soak: INCONCLUSIVE -- <why>` line per reason. A forever run (`SOAK_CYCLES=0`) ends
  only by a signal, so a signal is its normal end (the 2N floor still applies). A crash (`reason:'fatal'`)
  is FAIL. `computeGates` takes `interrupted` so `soak:report` re-derives the same verdict; the report
  accepts a `reason:'signal'` stream as legitimate evidence (it re-derives INCONCLUSIVE). Teeth: I1
  (SIGINT after cycle 1 -> exit 3) and I2 (`SOAK_DURATION=10s` -> exit 3).
- **The nightly is manual-only** until the remaining Node 22 false-FAILs (S2 timing noise, S3 teeth, S4
  harness heap growth) are fixed and 20/20 runs are green on Node 22 under load.

## Amendment 2026-10-03 -- audit 2026-09-29 (S4)

- **O(lanes) harness memory.** The gate accumulators were O(1) but `main.mjs` fed them from an array of
  every cycle record, kept for the whole run (~1 KB of heap per record), so a long clean run FAILed its own
  heap gate. Records now stream into `GateAccumulator` (per-lane `EarlyLate` windows, scalar counters, a
  bounded RSS series) and are dropped after the JSONL write. `computeGates(rows)` wraps the same
  accumulator for `soak:report`. The RSS runaway guard keeps a deterministic decimating sample of 1024
  values (every value, then every 2nd, 4th, ...) for the band center and the last 256 values for the
  late-quarter p95 -- identical to the unbounded list up to 1024 samples per lane.
- Teeth: PL (clean `SOAK_CYCLES=1500 SOAK_PICKS=70000 SOAK_LANES=RoundRobin` must PASS) and ML (the same
  with `SOAK_MUSTFAIL=slowleak`, ~1 KB retained per lane-cycle, must FAIL `heap`).

## Amendment 2026-10-03 -- audit 2026-09-29 (S2)

- **Timing gates are noise-aware.** On a shared CPU the clean kernel FAILed `gcPause` (a per-cycle MAX
  pause -- extreme-value noise), `hotOps` (500k-pick dense batches of 4-8 ms) and `hotOpsSparse` (one
  repeat), with N=3 windows where one noisy cycle moves the median. Now: (1) hotOps batches are sized by
  time -- each lane calibrates once, in its warm-up cycle, to the smallest power-of-two length taking
  >= 25 ms, then times 5 repeats of that fixed length (median); (2) `GATE_N` = 5 (active floor 11 cycles);
  (3) a timing drift FAILs only if it breaches its ratio bound AND an exact one-sided Mann-Whitney test
  (early vs late, 5 vs 5, smallest p = 1/252) gives p < 0.01; (4) `gcPause` gates the MEAN workload pause.
  The audit also suggested "drop > 3 early MADs"; it is recorded but NOT gated, because a gradual decay
  widens its own early window and the rule rejected exactly that (the decay teeth: p = 0.004 and the ratio
  breached, yet drop < 3 MAD).
- Teeth: MT1 (`decay`) trips `hotOps`, MT2 (`decaysparse`) trips `hotOpsSparse` and NOT `hotOps`. Under the
  decay modes the batch re-calibrates per cycle with the spin, which dominates the pick cost. `gcPause`
  still has no mutant control (audit S8; Phase 2 teeth coverage).

## Amendment 2026-10-03 -- audit 2026-09-29 (S3) and the nightly

- **Acceptance (Node 22.23, Apple M4, 12 cores).** The full teeth battery: 51/51 controls as required.
  20 clean full-roster runs (11 cycles, default picks) under 16 busy threads: 20/20 PASS. Worst margins
  under that load: dense throughput late/early 0.60, sparse 0.51 (bound 0.60, not significant); 35
  lane-gates crossed their ratio bound and were held by the Mann-Whitney requirement (closest p = 0.016).
- **Open risk -- gcPause.** 31 of those 35 were `gcPause`. A lane-cycle has only 1-2 GC events, so the
  "mean" pause is effectively the max again; quiet, a scavenge reads ~0.1 ms, under oversubscription
  0.5-22 ms (the OS preempting the process mid-GC), and late cycles read higher than early ones even under
  constant load (unverified: likely thermal throttling). The gate still has no mutant control (S8). If it
  false-FAILs a nightly, the decision is to make it report-only (as hotAlloc) or to give it a real signal
  (pauses aggregated over many lane-cycles) plus a mutant -- not to widen its bound.
- **Nightly shape.** Three parallel jobs on separate runners: `burn-in` (`SOAK_DURATION=45m`,
  `SOAK_REQUIRE_PROVENANCE=1`, report + artifacts always), `teeth` (`MUSTFAIL_ONLY='^(?!PL |ML )'`) and
  `teeth-long` (`'^(PL|ML) '`) -- the union is the full battery. Teeth no longer share a machine with the
  burn-in (the battery is ~42 minutes, 32 of them PL/ML, and its load would distort the burn-in's timing
  gates). The audit's parity step and `--baseline` comparison against the last green nightly are not in
  yet (Phase 2: S6 parity script, baseline artifact).

## Amendment 2026-10-04 -- audit 2026-09-29 (S6)

- **A real parity gate.** `benchmark/soak/parity.mjs` (`npm run parity`) checks the sha256 of
  `Pick.js`, `Pool.js`, `Pick.d.ts`, `Pool.d.ts` and `test/invariants.mjs` against the committed
  `benchmark/soak/parity.json`; a difference exits 1, a missing/malformed pin file exits 2. A change to
  shipped code must re-pin (`npm run parity:update`) in the same commit -- a deliberate acknowledgment, so
  a "benchmark-only" commit that touches the kernel by accident fails CI (`gates` job) and the nightly
  burn-in. (The repo is pushed to directly, so a PR-label rule would not run; pins do.)
- **Provenance hashes what was loaded.** The header hashed the in-tree `Pool.js` even when `SOAK_POOL`
  loaded a mutant; it now hashes the resolved pool and records `poolUrl`/`poolOverride` beside
  `kernelOverride`, plus `parity: { ok, mismatched, error }` for the in-tree files. Schema 3 (the report
  imports `SCHEMA_VERSION` from `provenance.mjs`; S2 had already added record fields without a bump).
- **`soak:report` refuses an overridden stream** (exit 1, "NOT A RELEASE SOAK") unless
  `--allow-override`; it prints kernel/pool hashes, override flags and parity. Teeth: `RPT overridden pool`.

## Amendment 2026-10-04 -- audit 2026-09-29 (S11)

- **Structured failure lines.** One `soak: BREACH <family> k=v ... detail=<text>` line per failure, written
  when it is detected (families: `gate=<name>`, `quality` with `kind=`, `invariants`, `retention`,
  `pool=A1..A7`, `phases`, `tracker`), then one `soak: FAIL -- <counts>` summary. An unhandled rejection is
  `pool=A7` by definition; any other uncaught error is `soak: CRASH -- <kind>: <stack>`.
- **Strict teeth matching.** A control's spec is either a line prefix (`soak: NOTE -- ...`,
  `soak: INCONCLUSIVE -- ...`) or a token set that ONE BREACH line must carry exactly; a crash is a MISS
  for every control. The old `stderr.indexOf(want)` accepted a stack trace or a mutant's file name.


## Amendment 2026-10-04 -- audit 2026-09-29 (teeth coverage)

- **A manifest of what the teeth must cover.** `benchmark/soak/teeth.mjs` lists every check that can
  decide a verdict: each gate in `GATE_NAMES` (now exported from `gates.mjs`), each roster lane's quality
  oracle, each quality `kind`, invariants (and `kind=freeze`), retention, pool A1..A7, phases, tracker, the
  INCONCLUSIVE causes, the hotAlloc NOTE, and every `SOAK_MUSTFAIL` mode (now exported from `config.mjs`).
- **A meta-test in `npm test`** (`test/SoakTeeth.test.js`) lists the battery with `MUSTFAIL_LIST=1`
  (builds every mutant, runs nothing, < 1 s) and fails when a check has no control and is not a declared
  gap, when a declared gap has become covered, when a control's spec names an unknown family / gate / lane /
  kind, when the manifest drifts from what the soak code emits, or when the nightly's two `MUSTFAIL_ONLY`
  jobs stop partitioning the battery. A stale patch anchor now fails `npm test`, not the nightly.
- **Declared gaps (28 of 55 checks)** are in `teeth.mjs` `GAPS`, each with its reason; they are the next
  burst's work and the list may only shrink. A new gate ships with its control, never with a gap line.
- **Burst 9c1 (2026-10-04).** Every `SOAK_MUSTFAIL` mode has a control (MM1-MM7), quality specs name their
  `kind`, a control may assert several lines, and REVERT must catch H3/H4/H1 by name. Finding: `weight0`
  was hollow on SmoothWRR (the harness weight array IS the kernel's; a live-reading kernel correctly skips a
  zeroed node), so its control targets WeightedRandom. `pooldrop` was never wired and is removed. Gaps 28 ->
  11; the rest are new kernel mutants (9c2: hotAlloc gross tier, SED, NQ) and checks main.mjs cannot reach
  from a kernel or mode (9c3: gcPause, rebuild, totalPicks, freeze, phases, tracker, two INCONCLUSIVE causes).
- **Burst 9c2 (2026-10-04).** Kernel mutants M17 (SED weight-blind), M18 (NQ never-queue removed) and M19
  (~2 KB per pick). M19 found that the hotAlloc gross tier -- the soak's only HARD allocation gate since S1
  -- was hollow for heavy allocation: snapshot-based GC detection aliases once a window runs several
  scavenges (~90% of windows read "GC-free" at ~54 B/op), so a 2 KB/op allocator produced only a NOTE.
  `sampleWindows` now brackets each window with `v8.GCProfiler` (synchronous stop(), every GC listed) and
  keeps the snapshot checks as a second condition. Clean lanes read 0 B/op as before; ~4% runtime. Gaps 8,
  all for 9c3.
- **Burst 9c3 (2026-10-04) -- no declared gaps.** M20 (`setEligible(i, true)` ignored -> `invariants
  kind=freeze` on SED) and MM8 (new mode `phaseskip` -> `phases`). `teeth.mjs` gains `UNREACHABLE`: checks
  no kernel/Pool mutant or mode can reach through main.mjs, each proven in `npm test` instead -- `totalPicks`
  and "hotAlloc measured nothing" by unit runs of `GateAccumulator`, `tracker` by a source pin (main.mjs
  registers no lite-leak kernel, so findings/warnings cannot occur; retention via `tracker.size()` is the
  live check).
- **gcPause and rebuild are report-only (`REPORT_ONLY_GATES`).** This closes the gcPause open risk above.
  The search for a gcPause mutant showed the gate has no independent teeth: with the semi-space pinned at
  4 MB a scavenge copies at most ~4 MB, so the mean pause plateaus near 1 ms on an Apple M4 (a growing
  ring of young survivors: 0.07 -> 1.05 ms, limit ~1.2 ms), and every mutant that raised it promoted
  objects and failed the hard `gcMajor` = 0 gate (and heap/hotOps) first. A gate that can fire only on
  noise is the flake risk without the protection, so it now records `wouldFail` and never FAILs. `rebuild`
  never reached `LAT_MIN_SAMPLES` (~8 timed rebuilds per lane-cycle vs 2000 per window) and was a STUB on
  every run; it is now report-only by declaration. The meta-test feeds both gates input far past their
  bounds and fails if either can FAIL again; re-enabling one requires a control. A missing `gcPauseAvgMs`
  no longer makes a run INCONCLUSIVE.

## Amendment 2026-10-04 -- audit 2026-09-29 (S12)

- **`soak:report` integrity fails closed.** Required summary counters (a deleted one is an issue, not a
  skipped check); contiguous `seq`; per-lane cycle grids with no hole or duplicate, and exactly
  `header.config.cycles` per lane for a cycle-bound run that ended; any `fatal` record re-derives FAIL; a
  second summary is accepted only as the fatal handler's. `--baseline` uses `totalViolations`, diffs pool
  lanes, and validates the baseline (integrity, not overridden). The HTML carries the integrity status,
  issues and fatal messages. The remaining residual is unchanged: consistent forgery of the cycle records
  themselves needs a MAC (out of scope).
- **Teeth.** `RPT S12 ...` controls tamper with genuine streams (dropped cycles plus deleted counters, a seq
  gap, a fatal after the end, string breaches through the HTML path, a weight-0 and a pool regression vs a
  clean baseline, a tampered baseline); each must exit 1 naming its issue. Against the pre-S12 report all
  seven MISS (six exit 0, the string case's HTML path threw a TypeError). Genuine cycle-bound, duration-bound
  and mixed kernel+pool streams still pass integrity.

## Amendment 2026-10-04 -- audit 2026-09-29 (S13)

- **The probe's failure was real allocation, in the clock.** Node 22: latency sampler 32.02 B/op on every
  run (not a JIT transient, so the S1 isolation the fix plan suggested does not apply); the kernel lanes
  read <= 0.006. Node 22's `performance.now()` returns a boxed double, 16 B per read, and the sampler reads
  twice; Node 26 returns it unboxed (0.000). In the soak this is ~3 MB per lane-cycle inside the latency
  segment (at most ~1 scavenge, one sample of ~96000) and outside every gated B/op window.
- **Fix.** The probe measures the clock reads alone (the sampler's code minus the kernel step), gates
  `sampler - clock <= 0.05 B/op`, bounds `clock <= 33 B/op` (two boxed doubles + 1 B), and reports whether
  the runtime boxes. Clean Node 22: sampler adds 0.011-0.019 over 6 runs. Each failure prints `probe: FAIL --
  <what>`; a pass prints `probe: ok`. `soak:teeth` runs PP (clean, must pass) and PM
  (`PROBE_MUSTFAIL=sampleralloc`, must FAIL: +32 B/op on Node 26, +43.5 on Node 22).

## Amendment 2026-10-04 -- the nightly baseline (decided in research/soak-baseline.md)

- The fix plan's "keep the last green nightly as the baseline" was researched before adoption (LKP/0-day,
  Node.js compare.js, rustc-perf, Perfherder, benchstat, GitHub-runner noise studies) and measured here:
  one run against one run is not a timing signal on hosted runners (same-machine run-to-run 16.6% on
  WeightedRandom throughput; runners +/-10-20%). Decided: `--baseline` gates heap (same Node major),
  quality, pool and lane presence; throughput/p99 are report-only NOTEs; the baseline is the last fully
  green run's `soak-baseline` workflow artifact (`actions: read` only), validated by S12 before use.
  Release-time same-runner interleaved A/B (ROADMAP #8b, research note first) is the path to a real timing
  gate; a history window (#8c) only if the report-only notes prove useful.

## Amendment 2026-10-04 -- audit 2026-09-29 (S9 + S10): the pool lanes are a deterministic simulation

- **Design** (researched first: `research/s9-deterministic-simulation.md`, `research/phase3-primer.md`):
  Poisson arrivals and attempt completions are events in the pool lane's own event heap (`SimQueue`,
  plain arrays: the lane allocates by design); an attempt parks its promise resolver at `now + service`
  (exponential, mean 1 ms, x (1 + inflight[node] / 2) processor-sharing slowdown -- the existing des.mjs
  sampler with conc = per-node concurrency); the driver pops one event, releases that promise, and
  yields one macrotask (`setImmediate`) so every microtask -- Pool's settle, failover, feedback --
  finishes before the next event. Ties at equal times pop in push order (sequence number).
- **The 0-B/op `EventQueue` stays byte-identical.** A first version added ids and a sequence number to
  it; no single change allocated, but together they shifted V8's inlining on Node 22 so that the clean
  probe's latency step (PeakEWMA + queue + two clock reads) boxed ~11.5 B/op -- deterministically with
  `--no-concurrent-recompilation`, in ~50% of runs without. The PP teeth control caught it; the design
  was changed rather than the gate. Pool/PeakEWMA read nanoseconds. Hung attempts park with no
  completion and are released (SIM_RESET) only when the queue is empty; queue empty + nothing parked +
  runs pending = a lost run (deterministic; the real-time batch deadline is removed).
- **Determinism is tested**, not assumed: `test/SoakPool.test.js` (in `npm test`) runs each pool lane
  twice per seed and requires an identical trace hash, and a different seed to differ.
- **New assertions.** A8 (S10): no dispatch to a down node (fn checks `eligible[i]` at dispatch). A9:
  Little's law as an identity -- integral of sum(inflight) dt == sum over runs of (run end - attempt start)
  for every attempt (Pool holds a failed attempt's slot until its run settles). Teeth: MP8 (`_scanUntried`
  ignores eligibility), MP9 (in-flight double-counted and double-released: A2-blind, A9 trips).
- **Self-check by mean and identity, not median**: the fix plan's "p50 ~ mean service x slowdown" was
  dropped -- under processor sharing the median is not that (research note); the per-dispatch slowdown is
  an approximation of processor sharing, documented as such. RTT p50/p99/mean and mean service are
  recorded per pool cycle (report-only).
- Stream schema 4. `soak:report --baseline` with an older-schema baseline prints "not compared" and
  continues (teeth: `RPT baseline: older schema`).

## Amendment 2026-10-04 -- audit 2026-09-29 (S7): the P2C oracle is calibrated, not derived

- **Why** (researched first: `research/s7-p2c-oracle-bound.md`): the balls-in-bins theorems (Azar et al.,
  Berenbrink et al.) give the SHAPE of a healthy P2C's gap -- log2(ln n) + O(1) -- but no usable
  constant, and a P2C that ignores its comparison a share of the time (Peres-Talwar-Wieder's
  (1+beta)-choice process) differs from a healthy one by only a few units at n <= 256. The per-trial
  bound `4 log2(ln live) + 4` sat 3-4x above any healthy gap, so the 50%-broken P2C (M8b) passed every
  cycle. A threshold that thin has to come from measurement.
- **Statistic:** the SUM of the 8 trial gaps. With every pick on an eligible node the mean is exactly 32,
  so each gap is an integer and the sum is exact -- no float threshold. Averaging is what separates the
  two distributions: one trial's gap is a noisy integer; the mean of eight moves by 1-3 units.
- **Calibration:** `benchmark/soak/_calibrate-p2c.mjs` drives the real `P2cBalancer` through the same
  `p2cTrials()` the oracle calls, at the soak's shape -- cap 256 with a fresh random eligible subset per
  cycle, because `_draw`'s fallback scan (taken on ~13% of draws at live 8 of 256) favors a node that
  follows a run of down nodes, so the healthy distribution depends on WHICH nodes are up, not only on how
  many. 100,000 clean cycles per live count, 8..256: 0 backstop, 0 lost picks; largest clean sum 13 at
  live 8 rising to 20 at 256. Limit = running maximum over live counts <= n, + 4 (monotone because the
  healthy gap grows with n). Tail at live 200: sum 18 in 0.4% of cycles, 19 in 0.009%, limit 24. A
  resumed run reproduces an uninterrupted one exactly (a live count's seed never depends on the job split;
  231 live counts cross-checked).
- **Backstop and lost picks:** fewer than 2 of 8 trials may exceed `ceil(log2(ln live)) + 3` (the fix
  plan's rule, kept for gross breakage), and every pick must land on an eligible node.
- **Teeth:** M8b (ignore 50%) and M8c (ignore 80%) are kernel mutants through main.mjs; power per live
  count is in `benchmark/soak/p2c-power.json`. Weakest point: the 50% mutant at live 8-11 is caught in
  58-65% of cycles (the two distributions overlap most at small n), so detecting it there takes a few
  cycles, not one; at the soak's frozen live counts (~165-200) every cycle catches it.
- **Not done:** the oracle shape (32 x live balls from empty, no completions) is unchanged. Changing it,
  CAP, or the kernel's `_draw` requires re-running the calibration -- `test/SoakP2C.test.js` only guards
  the table against the evidence file, not the evidence against a changed kernel. The `_draw` fallback's
  "unbiased" comment is inaccurate at sparse eligibility; a kernel note for 1.1.0, not a soak change.
