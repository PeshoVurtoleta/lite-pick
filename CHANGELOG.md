# Changelog

All notable changes to `@zakkster/lite-pick` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tests and one RECIPES sentence; no library code changes.

### Added

- **`test/LognSeam.test.js` and a PerfGate lane pin the RECIPES section 17 snippet.** `@zakkster/lite-logn` is a
  devDependency (never a peer; `peerDependencies` stays `{}`). The snippet is extracted from RECIPES.md and run
  verbatim (`test/recipe17.mjs`): it fails closed, every pick equals a brute-force lower bound through reweights
  and up/down flips, 1,000,000 picks follow the weights, and both ends of the draw are forced by steering the
  Prng (a random run reaches them once in 2^30 draws). Mutants caught: a draw that can be 0 or exceed the total,
  a reweight that ignores eligibility, a missing fail-closed guard, and the boxing `search(u)` (also caught by
  the perf lane with inlining off). On Node < 20 with no install (the CI Node 18 job) the file skips; anywhere
  else a missing devDependency fails.

### Fixed

- **PerfGate flaked on CI: the B6 1.7e15-clock lanes read 1 scavenge (N:1 8N:1) on GitHub's ubuntu runner.**
  Cause: lite-perf-gate warms a lane with one 20000-iteration call, and on a slow runner V8's concurrent
  optimizer had not installed the optimized code by the measured window; the lower tiers box every double.
  Reproduced locally with `--concurrent-recompilation-delay=20/100` (Node 22: N:32-84). Changing the sample to an
  integer did not help (the clock and the kernel's own doubles still box). Each gated lane now warms until two
  20000-iteration chunks leave heapUsed within 32 KB (cap 1500 ms); the gate itself is unchanged (0 scavenges at
  N and 8N). A per-op allocation never goes quiet and still fails: a lane switched to the plain `recordRtt` and
  the pre-1.1.0 PRNG (8 lanes) both fail with inlining off.

## [1.1.0] - 2026-10-05

Kernel fixes, new API and observability, decided in `research/1.1.0-kernel-and-api.md` (D1-D8) and built in seven
bursts: B1 the plain fixes, B2 rotating ties and the BoundedLoad `minCap`, B3 PeakEWMA's update rule and pool mean,
B4 observability (decisions/0015), B5 Pool's diagnostics_channel events, B6 zero-box buffer APIs (decisions/0016),
B7 docs. No API is removed. Behaviour changes are listed under Changed, plus the L2 and L3 fixes under Fixed.

### Added

- **Zero-box siblings: `pickFrom(buf, i)` (PeakEWMA, ConsistentHash, BoundedLoad) and `recordRttFrom(i, buf, j)`
  (PeakEWMA) (D8, research/1.1.0-buffer-apis.md).** The number is read from a caller-owned typed-array slot --
  the clock / `[sampleNs, now]` from a `Float64Array`, the key from a `Uint32Array` -- so a nanosecond clock, a
  fractional rtt or a hash >= 2^31 never crosses a call boxed. Identical selection and errors to the plain
  methods (`pickFrom` never throws; `recordRttFrom` adds `LITE_PICK_ARRAY` for a bad buffer). Measured 0 B/op
  even with V8 inlining switched off, where the plain methods cost 16-32 B/op; this closes the 1.0.1 KNOWN
  LIMITATION. `pickFrom` costs what `pick` costs; `recordRttFrom` ~1 ns more than `recordRtt`.
- **`npm run test:perf:noinline`** -- the whole perf gate again with `--max-inlined-bytecode-size=0` (in `verify`
  and CI), plus five gated realistic-magnitude lanes for the `From` methods. The pre-1.1.0 kernel fails 12 lanes
  of the no-inline run.
- **Error codes on every throw (D7).** Each error keeps its class (TypeError / RangeError / Error) and carries a
  stable `code`, which is semver API (messages are not): `LITE_PICK_CAPACITY`, `LITE_PICK_ARRAY`,
  `LITE_PICK_INDEX`, `LITE_PICK_WEIGHT`, `LITE_PICK_OPTION`, `LITE_PICK_ARGUMENT`, `LITE_PICK_ABSTRACT`,
  `LITE_PICK_INCONSISTENT`; Pool's constructor, `run` argument and `liteQueryFetcher` errors gain codes too.
  The prefix is Pool's shipped `LITE_PICK_*` (not the research's `LITE_PICK_ERR_*`: renaming six shipped codes
  would break callers). Type: `LitePickErrorCode`.
- **Stats slab: `attachStats(slab)`, `stats`, `STAT_FALLBACK_SCANS`, `STAT_REBUILDS`, `STAT_DISPLACED`,
  `STAT_COUNT` (D7).** A caller-owned `Float64Array` the balancer adds to and never resets. Only events the
  caller cannot see are counted, and only off the healthy pick path: the very-sparse fallback / full-table sweep,
  table builds, and keyed picks that leave their home backend. A per-pick counter was measured and left out
  (RoundRobin 2.1 -> 5.7 ns); a displaced pick pays ~0.5 ns. P2C's sparse fallback moved into a cold module
  function, out of the hot `_draw`.
- **`describe()` on every balancer, and Node `util.inspect` output (D7).** A cold, JSON-safe snapshot (strategy,
  capacity, live, counters, per-strategy state such as BoundedLoad's current cap or PeakEWMA's pool mean);
  `console.log(lb)` prints it under the class name instead of the private fields.
- **`assertConsistent()` (audit H2).** Opt-in O(cap) recount of the cached state; throws
  `LITE_PICK_INCONSISTENT` after a direct `eligible[i]` / `weights[i]` write, a weight write without
  `rebuild()`, or a BoundedLoad inflight change without `note()`. RECIPES section 16 shows all four tools.
- **Pool `node:diagnostics_channel` events: `lite-pick:pool:dispatch` and `lite-pick:pool:settle` (D7).** One of
  each per attempt (`POOL_CHANNEL_DISPATCH` / `POOL_CHANNEL_SETTLE`; types `PoolDispatchMessage` /
  `PoolSettleMessage`). Guarded by `hasSubscribers`: with nobody subscribed a run measures the same time and bytes
  as 1.0.x. ONE reused message object per channel, references cleared after each publish (it never retains a Pool
  or an error); a subscriber costs ~10 ns per event and allocates nothing. Loaded with `process.getBuiltinModule`,
  so Node >= 20.16 / 22.3 only -- browsers and Node 18 get no channels, and the module has no top-level await.

- **`BoundedLoadBalancer` opt-in `minCap` (8th constructor argument, default 0; readonly `minCap`).**
  `cap = max(minCap, ceil((1 + eps)(T + 1) / live))`. The paper's capacity (and HAProxy's) is 1 at low load,
  so a second concurrent request for the same key always leaves its home: with 10 backends and eps 0.25, five
  concurrent same-key requests land on five backends. `minCap = k` keeps up to k at home, at the price of a
  looser bound while the pool is nearly idle. Our extension (no reference implementation has the knob);
  default 0 is bit-identical to 1.0.x. Validated integer in [0, 2^32 - 1] (TypeError / RangeError).
- **`setWeights(weights)` on `ConsistentHashBalancer`, `BoundedLoadBalancer` (inherited) and
  `WeightedRandomBalancer`.** Replace every weight at once with ONE table rebuild; `setWeight` rebuilds per
  call, so retuning N backends cost N rebuilds. The array is copied (CH/BL into the balancer-owned weights,
  WeightedRandom into the weights array it was built with) and validated before any write (RangeError).
- **Docs: drain vs remove for ConsistentHash / BoundedLoad (D6, no new API).** `setEligible(i, false)` drains
  (table unchanged, 0 other keys move, undo restores every key); `setWeight(i, 0)` removes (a rebuild; a median
  0.49% of other keys move at M = 65537, 2.5% at M = 4099; restoring the weight restores every key). Measured on
  64 backends and 200,000 keys. Our weight 0 is IPVS's delete, not IPVS's weight 0 (which drains). RECIPES
  section 9, GUIDE, llms.txt, ADR 0010 amendment.
- **Docs: the dynamic-weight seam is named -- lite-logn `Fenwick.searchFrom(buf, i)` (>= 1.4.0).** RECIPES section
  17 wires it beside lite-pick (lite-pick imports nothing; `peerDependencies` stays `{}`). The snippet, run
  verbatim against lite-logn 1.5.1: fails closed on an empty tree, never returns a weight-0 or down node over
  5,000,000 picks, 0 B/op with V8 inlining off (plain `search(u)`: 16 B/op). At 1000 endpoints ~57-98 ns per pick
  and ~12-22 ns per weight change, vs WeightedRandom's ~16 ns pick and ~10-17 us rebuild. Replaces the "deferred
  lite-logn Fenwick tree" wording in README, GUIDE, llms.txt and Pick.js; ADR 0012 amendment.

### Fixed

- **The PRNG boxed whenever V8 did not inline it.** `Prng.next()` returns a uint32, >= 2^31 half the time;
  `nextBelow` called it, so each draw crossed a call boxed (~16 B) in a caller V8 would not inline -- P2C,
  PeakEWMA and WeightedRandom paid ~16 B/op there. `nextBelow` now runs the xorshift step itself and
  WeightedRandom's uniform draws run it inline. Bit-identical streams (golden fingerprints), so no seeded result
  changes.
- **Closed: the 1.0.1 "recordRtt in isolation" FINDINGS.** Root cause established: the 1.0.x blend
  `sampleNs > e ? sampleNs : e + ...` merged the tagged argument with a double, and Maglev boxed the merge
  whenever the blend branch ran (5 of 30 windows when the lane ran alone; 0 of 30 with only that line changed).
  B3's rewrite had already removed it; the lane is now gated.
- **P2C, PeakEWMA and WeightedRandom: the very-sparse fallback was biased (audit L2).** After 64 rejected
  draws the 1.0.x fallback took the first eligible node after a random start, so a node that follows a long
  run of down nodes won more often: nodes {0, 1} of 100 up gave 63.5% / 36.5%. P2C/PeakEWMA now draw a
  uniform k-th eligible node (50.1% / 49.9%); WeightedRandom walks the cumulative eligible weight, so its
  fallback keeps the weight ratio like its fast path. Only the >= 64-miss path changes; 0 B/op (PerfGate
  heavy-outage lane, Node 22 and 26).
- **ConsistentHash and BoundedLoad: no `PICK_NONE` while a backend is reachable (audit L3).** When the home
  slot and the next 64 slots all mapped to down backends, `pick` returned `PICK_NONE` even with backends up.
  It now sweeps the whole table (cold, O(M), only on that path) -- the idea of Linux IPVS `mh-fallback`.
  `PICK_NONE` now means no eligible backend owns a table slot. Behaviour change: a key that used to fail
  closed under a near-total outage now reaches a far backend.

### Changed

- **LeastConn, SED and NQ: ties rotate (audit M5).** Through 1.0.x the lowest index won every exact tie, so at
  low load one endpoint took everything (8 idle endpoints, one request at a time: 100% to endpoint 0). A
  cursor now moves past each pick and the scan runs [cursor, cap) then [0, cursor): tied endpoints take turns
  (12.5% each) and NQ's idle endpoints take turns. NGINX, HAProxy and Envoy spread ties too; Linux IPVS does
  not. The tie order was documented as unspecified since 1.0.1; which tied endpoint wins is still not a
  contract. Cost per pick at 256 endpoints: LeastConn +5-8%, SED +2-7% (two scans split at the cursor -- a
  single wrapped loop cost +55-85% and was rejected); NQ stops at the first idle endpoint after the cursor
  (~10 ns where 1.0.x returned the always-idle endpoint 0 in ~7 ns). The fuzzer's NQ check now accepts any
  idle endpoint, and still catches an NQ that ignores idle endpoints.
- **PeakEWMA: the update is Finagle's exactly (audit L4).** 1.0.x decayed the estimate and then blended,
  `ewma x w^2 + sample x (1 - w)`, so it forgot a slow period faster than designed: 10 ms, one tau, then a 5 ms
  sample gave 4.51 ms. It is now `ewma x w + sample x (1 - w)` (6.84 ms, pinned by a test), and the peak test
  compares the sample with the STORED estimate (1.0.x compared with the decayed one, so 8 ms after a 10 ms
  peak snapped to 8 ms; it now blends to 8.74 ms). The rule is now continuous where the old one jumped. One
  deliberate difference stays: Finagle and tower fold a 0 sample in on every read, so their estimate depends
  on how often a node is read; ours depends only on the samples and the clock.
- **PeakEWMA: an unsampled-but-busy node is priced at a DECAYING pool mean (research D4).** 1.0.x used the
  lifetime mean of every sample ever recorded, so a slow first hour priced new nodes high forever. The sum and
  the count now both decay by `exp(-dt/tau)` (the balancer's own tau) since the newest sample, so every sample
  is weighted by `exp(-age/tau)`; after a regime change from 10 ms to 1 ms the mean reads ~1 ms within a few
  tau (the lifetime mean read 5.5 ms). `_samp` grows a third cell (the newest-sample time). An overflowed sum
  restarts after a long gap instead of staying `+Infinity`. `recordRtt` costs no more: 8.8 -> 8.6 ns when every
  sample blends (two `exp` now, one before), 5.8 -> 4.9 ns when every sample is a peak (no `exp` for the node).
  0 B/op (PerfGate; a first draft merged a double with the `sampleNs` argument in one ternary and Maglev boxed
  it, ~16 B/op -- caught by the gate, fixed).
- **PeakEWMA: no busy-since stamp; set a per-attempt timeout (research D5).** The 1.0.1 docs promised a
  per-dispatch stamp for 1.1.0. Finagle, tower and Linkerd keep none, and it would need a new call on every
  dispatch. The documented answer to a request that never returns is a timer on each ATTEMPT, inside `fn`: the
  attempt throws and Pool records `max(elapsed, failurePenaltyNs)` as a peak, then fails over (new test C1c).
  Aborting the run's own `signal` is a caller cancel and still records nothing. RECIPES section 8 shows the
  `AbortSignal.any` pattern.
- **ConsistentHash / BoundedLoad tables build ~8x faster at the default M (audit L7).** Additive Maglev
  stepping (`c += skip`) instead of `(offset + j * skip) % M`: 10.5 ms -> 1.3 ms per rebuild at M = 65537,
  1.7x at 4099. The tables are IDENTICAL to 1.0.x (golden fingerprints in the tests), so upgrading moves no key.
- `Prng.nextBelow`'s comment now says what it does (a scaled floor with relative bias <= n / 2^32, not a
  multiply-shift) (audit L8).
- Benchmark-only: the soak uses `setWeights` instead of writing the private `_weights`, and its P2C oracle
  was re-calibrated on the fixed fallback (100,000 clean cycles per live count again; 0 backstop, 0 lost
  picks). One limit moved: live 16 is 19 (was 20). The 50%-ignore mutant is now caught in 38-63% of cycles
  at live 8-11 (it was 58-65%: the biased fallback had amplified the mutant's imbalance), 86% at 16, >= 99%
  from 31 and 100% from 49 -- the soak's frozen state has ~165-200 live.
- Benchmark-only: the REVERT teeth control (the 1.0.0 kernel must trip the H1/H3/H4 quality gates) crashed
  from B1 on, because the soak now reweights through `setWeights`, which 1.0.0 lacks; a crash counts as a
  MISS, so the teeth run failed rather than passing silently. The control now adds a `setWeights` shim to the
  old kernel that does what the soak did before (write `_weights`, one `rebuild()`), failing closed without
  `_weights`. All three gates catch it again.

- **Benchmark-only: a soak run without the evidence to judge is INCONCLUSIVE, not PASS (S5, audit
  2026-09-29).** A non-smoke run where any lane has fewer than 2N post-warmup cycles (e.g.
  `SOAK_DURATION=10s`), or a bounded run interrupted by a signal, now exits 3 with one
  `soak: INCONCLUSIVE -- <why>` line per reason; before, both printed `soak: PASS` and exited 0. A
  forever run (`SOAK_CYCLES=0`) still ends normally on a signal; a crash is FAIL. `soak:report`
  re-derives the same verdict (`computeGates` takes `interrupted`). New teeth: I1, I2.
- **Benchmark-only: the soak's hotAlloc gate is report-only below the gross tier (S1, audit 2026-09-29).**
  On Node 22 V8 JIT state in the long-lived soak process reads 8-20 B/op on a correct kernel and failed
  every run. An over-bound lane now prints `soak: NOTE -- hotAlloc[lane] ...`; the soak still FAILs when
  every probe window scavenges (~512+ B/op) or the measurement is non-finite. Per-op 0 B/op stays gated by
  `test:perf` (PerfGate), which fails on the same allocation mutants. See the ADR 0014 amendment.
- **Benchmark-only: soak failures are structured lines, and `soak:teeth` matches them exactly (S11,
  audit 2026-09-29).** Every failure is now one `soak: BREACH <family> k=v ... detail=...` line on
  stderr, written when detected: `gate=<name> lane=`, `quality lane= kind=oracle|weightZero|chiSquare`,
  `invariants lane=`, `retention lane=`, `pool=A1..A7 lane=` (each failed pool assertion named;
  before, one line listed a JSON blob), `phases lane=`, `tracker` (findings/warnings, which printed
  nothing before). An unhandled rejection is `pool=A7`; any other crash prints `soak: CRASH -- ...`.
  The teeth runner used `stderr.indexOf(want)`, so a crash whose stack trace or mutant file name
  contained the word passed (an uncaught exception from a `setTimeout` "passed" the A7 control); it now
  requires one BREACH line carrying every token of the control's spec (e.g. `gate=hotOps
  lane=RoundRobin`), and any `soak: CRASH` is a MISS. Children run on `process.execPath` with a 30-minute
  timeout, and the scratch directory is removed on exit.
- **Benchmark-only: the teeth battery's coverage is itself tested (audit 2026-09-29).** A new manifest,
  `benchmark/soak/teeth.mjs`, lists every gate, quality oracle and kind, invariant, pool assertion,
  INCONCLUSIVE cause and `SOAK_MUSTFAIL` mode; a new `npm test` suite, `test/SoakTeeth.test.js`, lists the
  battery without running it (`MUSTFAIL_LIST=1 npm run soak:teeth`, which still builds every mutant) and
  fails when one of them has no control and is not a declared gap, when a gap is covered, when a control's
  spec is malformed, when the manifest drifts from the code, or when the nightly's two teeth jobs no longer
  split the battery exactly. 28 of the 55 checks are declared gaps today, each with its reason.
- **Benchmark-only: every `SOAK_MUSTFAIL` mode now has a control, and the controls name what they trip
  (audit 2026-09-29).** Seven new mode controls (MM1-MM7: leak, heap, weight0, imbalance, rss, poolbadcode,
  poolretain) and I3 (a lane whose quality windows never fill is INCONCLUSIVE). Writing them found that
  `weight0` never tripped SmoothWRR: it zeroes the weight array the kernel reads live, which a correct
  SmoothWRR treats as a drain; it only bites where weights are cached (WeightedRandom's alias table,
  CH/BL's Maglev table), so its control now runs on WeightedRandom. Quality specs assert the `kind=`
  (`oracle` / `weightZero` / `chiSquare`; the matcher accepts `kind=a,b` lines), a control may assert
  several lines (`rss` trips both the rss and gcMajor gates), and the 1.0.0-revert control must now catch
  H3, H4 and H1 each by name instead of "some quality breach". The never-wired `pooldrop` mode is removed
  (A3 is proven by the real Pool.js mutant MP3). Declared gaps: 28 -> 11 of 54 checks.
- **Benchmark-only: the soak's hard allocation gate could not see heavy allocation (audit 2026-09-29,
  teeth M19).** The B/op probe decided "a GC ran in this window" by comparing heap snapshots. At ~2 KB
  per pick a window runs several scavenges, and the snapshot comparison catches one only by chance: ~90%
  of windows read GC-free with a meaningless ~54 B/op, so the gross tier ("every window scavenged",
  FAIL) never fired and the run printed only the report-only NOTE. Each window is now bracketed by
  `v8.GCProfiler`, whose synchronous `stop()` lists every collection in it; a window counts as GC-free only
  if it saw none (and the snapshots agree). Clean kernels still read 0 B/op; cost ~4% of soak runtime.
  New kernel mutants: M17 (SED weight-blind score), M18 (NQ never-queue shortcut removed), M19 (2 KB per
  pick -> hotAlloc gross tier). Declared gaps: 11 -> 8.
- **Benchmark-only: the teeth battery covers every check that can decide a soak verdict (audit
  2026-09-29).** No declared gaps remain. New controls: M20 (a kernel whose `setEligible(i, true)` is
  ignored -> the freeze self-check) and MM8 (new mode `phaseskip` -> the chaos-phase self-check). Three
  checks no kernel, Pool mutant or mode can reach are listed as `UNREACHABLE` in `teeth.mjs`, each with a
  proof in `npm test`: the zero-work `totalPicks` gate and the "hotAlloc measured nothing" INCONCLUSIVE
  (unit runs of the real gate code), and the lite-leak `tracker` findings line (main.mjs registers no
  kernel, so it cannot report; pinned to the source).
- **Benchmark-only: two soak gates are report-only (audit 2026-09-29).** `rebuild` could never activate
  (~8 timed rebuilds per lane-cycle against 2000 samples needed per window). `gcPause` could not trip
  on its own: with the semi-space pinned at 4 MB the mean scavenge pause plateaus near 1 ms (Apple M4),
  below its early x 2 + 1 ms bound, and every mutant that pushed it higher promoted and failed the hard
  `gcMajor` gate first; its only effect was near-miss noise under load. Both are still computed and
  recorded (`gcPause.wouldFail`), never a FAIL, and a missing `gcPauseAvgMs` no longer makes a run
  INCONCLUSIVE. `npm test` fails if either becomes FAIL-capable again without a control.
- **Benchmark-only: `soak:report` fails closed on a tampered stream or baseline (S12, audit
  2026-09-29).** Deleting fields used to skip checks: dropping 8 of 11 cycles per lane and deleting
  `summary.rollups`/`cyclesRun` re-derived "integrity OK". Now every summary counter is required, `seq`
  must run 0..n-1, a cycle-bound run that ended must hold exactly `header.config.cycles` cycles per lane
  (no holes, no duplicates), and any `fatal` record re-derives FAIL, also one written after the end
  summary. `--baseline` compares all quality violations (`totalViolations`: a weight-0 regression used
  to read "no regression"), diffs pool lanes too, and refuses a baseline that fails integrity or ran an
  overridden kernel/pool. A string `summary.breaches` is an issue instead of a TypeError, and the HTML
  shows the integrity status, every issue and every fatal message. Each issue is also printed to stderr
  as `soak:report: ISSUE <text>`. Seven new teeth controls (`RPT S12 ...`) edit genuine streams and must
  be caught; all seven pass against the pre-S12 report, six of them with exit 0.
- **Benchmark-only: the hot-path clean probe passes on Node 22 for the right reason and is in the teeth
  battery (S13, audit 2026-09-29).** `_probe.mjs` failed on the clean tree on Node 22 ("latency sampler
  B/op = 32") with no line saying why, and nothing ran it. The cause is not JIT noise: Node 22's
  `performance.now()` returns a boxed double (16 B per read; the sampler reads twice), deterministic on
  every run, while Node 26 reads 0. The probe now measures the two clock reads alone, gates the
  sampler on the difference (its own work must add <= 0.05 B/op) and bounds the clock at two boxed doubles,
  printing which runtime boxes. Every failure prints a `probe: FAIL -- <what>` line. New: `npm run
  soak:probe`, and teeth controls PP (clean probe passes) and PM (`PROBE_MUSTFAIL=sampleralloc`, one small
  object per sampled pick, must FAIL). The soak's own comment claiming a 0 B/op sampler is corrected.
- **Benchmark-only: the nightly soak diffs against the last green nightly (audit 2026-09-29; decided
  in `research/soak-baseline.md`).** The burn-in downloads the last fully green run's `soak-baseline`
  artifact (90-day retention, `actions: read` only) and runs `soak:report --baseline`, then uploads its
  own stream as the next baseline if it passed; with no baseline yet it says so and runs without one.
  `--baseline` now FAILs only on what does not depend on the machine: heap up > 2 MB (only against the
  same Node major), quality violations or pool failures appearing, a lane missing. Throughput and p99
  are report-only (`soak:report: NOTE ...`): two runs on the same machine differed by 16.6%, over the
  15% bar, and hosted runners vary +/-10-20%. A zero or missing baseline value is a NOTE, never a silent
  skip. Teeth: `RPT baseline: ...` (timing only notes; heap +5 MB fails; another Node major is not
  heap-compared).
- **Demo-only (not in the package): Pool Scope cleanup.**
  - `serve.mjs` (audit 2026-09-29 D4): the allowlist is now also applied to the RESOLVED path, so a
    symlink inside the demo tree pointing at e.g. `.git/config` is 404 (it was served); the root is
    realpath'd once, so serving from a symlinked checkout no longer 403s every file.
  - Browser render layer (`web/main.mjs`), lite-law: no allocation in the per-frame loops. The colour
    ramp is a 256-entry string table built once (no `'rgb(...)'` per cell); heat cells, Lorenz points
    and scatter points are preallocated and updated in place; the scatter fade uses a numeric
    `globalAlpha` instead of an `'rgba(...' + a.toFixed(2)` string per point; dash arrays and labels are
    constants; each fallback canvas caches its 2d context and reads its size only on a ResizeObserver
    change; control and tab buttons are looked up once.
  - `web/index.html` inline scripts: `const`/`let` instead of `var`; the CDN-error banner lookup is
    cached on first use.
  - `tui.mjs`: exits 128 + signal on SIGINT/SIGTERM/SIGHUP (130/143/129) instead of 0.
  - ASCII-only source: the UI glyphs in `tui.mjs` and `web/main.mjs` are `\u` escapes now (the TUI's
    rendered frames are byte-identical).
- **Benchmark-only: the soak's pool lanes are a deterministic simulation (S9 + S10, audit 2026-09-29;
  decided in `research/s9-deterministic-simulation.md`).** Before, every run in a batch "completed" at
  the same virtual time plus the batch's summed service, completion order was Node's promise order, the
  clock was in microseconds while Pool and PeakEWMA expect nanoseconds, and nothing ever hung (PeakEWMA
  saw RTT p50 ~142 ms for a 1 ms service). Now runs arrive as Poisson events; each attempt parks its
  promise in the event queue until its simulated completion (processor sharing per node); the driver
  pops one event, releases that promise and yields one macrotask so Pool's settle and failover finish
  before the next event; Pool and PeakEWMA read a nanosecond clock (RTT p50 ~1 ms, p99 ~7 ms). Hung
  attempts really park and are released only when nothing else can happen; a run still pending when the
  queue is empty is a lost run, detected deterministically (the 4 s real-time deadline is gone; the
  lost-run control now takes 0 s instead of 44 s). The pool lane has its own event heap (equal times pop
  first-in-first-out); the kernel lanes' 0-B/op event queue is unchanged -- adding ids and a sequence
  number to it shifted V8's inlining on Node 22 enough that the clean probe's latency step boxed ~11.5
  B/op (caught by the PP control), so that design was dropped. New pool assertions: **A8**
  (S10) no attempt is dispatched to a node that is down -- the audit's "scan ignores eligibility" Pool
  mutant exited 0 on every pool lane before; **A9** Little's law as an exact identity (the time-integral
  of Pool's in-flight counters equals the attempt time), which catches in-flight bookkeeping that nets to
  zero at quiescence. Pool cycle records carry the RTTs, A8/A9 and a trace hash (stream schema 4; an
  older-schema baseline is reported as "not compared", not a crash). New `npm test` suite
  `test/SoakPool.test.js` runs every pool lane twice per seed and requires an identical trace. Teeth:
  MP8 (A8), MP9 (A9).
- **Repository: LF line endings on every OS.** A new `.gitattributes` (`* text=auto eol=lf`). Windows
  runners check out with `core.autocrlf=true`, which broke `test/RecipesDoc.test.js` (red on
  windows-latest since it was added) and `test/SoakTeeth.test.js`, and would make a Windows checkout of
  `Pick.js` fail `npm run parity`.
- **Benchmark-only: a real parity gate for the shipped code (S6, audit 2026-09-29).** ADR 0014 said a
  sha256 parity gate kept the kernel byte-identical across the soak redesign; none existed. Now
  `npm run parity` checks `Pick.js`, `Pool.js`, `Pick.d.ts`, `Pool.d.ts` and `test/invariants.mjs`
  against the committed `benchmark/soak/parity.json` (mismatch exit 1, unreadable pins exit 2), in CI's
  `gates` job and the nightly burn-in. **A commit that changes any of those files must run
  `npm run parity:update` and commit `parity.json` with it.** The soak header now hashes the pool that was
  actually loaded (it hashed the in-tree `Pool.js` even under `SOAK_POOL`), records
  `poolOverride`/`poolUrl` and the parity status (schema 3), and `soak:report` exits 1 on a stream whose
  kernel or pool was overridden unless `--allow-override` is passed.
- **Benchmark-only: `soak:teeth` is green on a clean tree, and the soak nightly is scheduled again (S3,
  audit 2026-09-29).** With S1/S2/S4/S5 fixed, the full battery passes on Node 22 (51/51 controls; it
  was red on the clean pass-control), and 20/20 clean full-roster runs PASS on Node 22 under 16 busy
  threads on a 12-core Apple M4. The nightly (04:00 UTC) now runs three parallel jobs on separate
  runners: the 45-minute burn-in, the teeth battery without PL/ML, and PL/ML (~32 of the battery's ~42
  minutes) -- teeth no longer run before the burn-in on the same machine. Each job always uploads its
  evidence. The alloc NOTE controls accept exit 0 or 1 (a gross allocator may also trip the hard gcMajor
  gate, depending on run length), `soak:teeth` prints each control's wall time, and an empty
  `MUSTFAIL_ONLY` selection FAILs.
- **Benchmark-only: the soak's timing gates absorb normal noise (S2, audit 2026-09-29).** Clean
  kernels FAILed `gcPause`, `hotOps` and `hotOpsSparse` on ordinary noise. Three changes:
  hotOps batches are sized by time (each lane calibrates once to >= 25 ms per repeat, then 5 repeats,
  median; dense was a fixed 500k picks = 4-8 ms on the fast lanes, sparse a single repeat); the drift
  windows are N=5 (active floor 11 cycles, was 3/7); and a timing drift (hotOps, hotOpsSparse, gcPause,
  latencyP99) FAILs only if it breaches its ratio bound AND an exact one-sided Mann-Whitney test of the
  early vs late window gives p < 0.01 (with N=5, near-complete separation). `gcPause` now gates the MEAN
  workload pause (`gcPauseAvgMs`); the per-cycle max stays in the record as telemetry. A record without
  `gcPauseAvgMs` makes the gate INCONCLUSIVE. New teeth MT1 (`decay` -> hotOps) and MT2
  (`decaysparse` -> hotOpsSparse only); the decay spin now dominates the pick cost (late/early 0.35-0.44
  vs the 0.60 bound) and re-calibrates per cycle, so both run in ~23 s.
- **Benchmark-only: the soak harness's own memory no longer grows with run length (S4, audit
  2026-09-29).** `main.mjs` kept every cycle record in an array for the whole run; the post-GC heap grew
  ~1 KB per record and a clean 1500-cycle RoundRobin run FAILed its own heap gate (7.5 -> 10.5 MB,
  `heap[RoundRobin] late=10.5MB > limit=10.3MB`). Records now stream into a per-lane
  `GateAccumulator` (`gates.mjs`) and are not kept; the JSONL on disk stays the full record.
  `computeGates(rows)` is now a wrapper over the same accumulator, so `soak:report` re-derives with the
  identical code path. Results are byte-identical to before for runs up to 1025 post-warmup cycles per
  lane; beyond that the RSS runaway guard's band center and late-quarter p95 come from a bounded
  decimating sample (1024) and the last 256 samples. New teeth: PL (clean 1500 cycles must PASS) and ML
  (`SOAK_MUSTFAIL=slowleak`, ~1 KB retained per lane-cycle, must FAIL the heap gate).
- **Benchmark-only: `soak:teeth` accepts `MUSTFAIL_ONLY=<regex>`** to run a subset of controls (dev aid;
  the full battery is the gate), and keeps a child's stderr on an exit-0 run too (it was discarded, so a
  control could not assert a line printed by a passing run).
- **Benchmark-only: the soak's P2C oracle is calibrated and catches a half-broken P2C (S7, audit
  2026-09-29; decided in `research/s7-p2c-oracle-bound.md`, option C).** Before, each of the 8 trials
  was judged alone against `4 log2(ln live) + 4` -- 3-4x above anything a healthy P2C produces -- so a
  P2C that ignores its load comparison on half its picks never failed a cycle (measured: the new M8b
  control exited 0 on the old oracle in all 11 cycles). Now the oracle sums the 8 trial gaps and fails
  the cycle when the sum exceeds a limit CALIBRATED per live count on the real kernel: 100,000 clean
  cycles at every live count 8..256 (24.9M cycles, `benchmark/soak/_calibrate-p2c.mjs`; the evidence is
  `benchmark/soak/p2c-calibration.json`), limit = the largest clean sum at that live count or below,
  + 4 (0.5 on the average gap). A per-trial backstop (`ceil(log2(ln live)) + 3`, fail when 2+ of 8 trials
  exceed it) and a lost-pick check (every pick must land on an eligible node) stay. Clean: 0 failures,
  0 backstop and 0 lost picks in the calibration. Mutants, share of cycles caught
  (`benchmark/soak/p2c-power.json`): ignore-the-comparison 50% -- 58-65% at live 8-11, >= 90% from 19,
  >= 99% from 31, 100% from 49 (the soak's frozen state has ~165-200 live); 80% -- 100% at every live
  count. A live count outside 8..256 is INSUFFICIENT, never a silent pass. New teeth: M8b (50%), M8c
  (80%). `test/SoakP2C.test.js` (in `npm test`) fails if the table in `oracles.mjs` and the calibration
  evidence disagree, and runs the real kernel at the soak's live range (clean never fails, 50% caught).
- **Benchmark-only: the soak's hash, tie and weighted oracles check stated properties, sized on the real
  kernel (S14, audit 2026-09-29; decided in `research/s14-hash-and-tie-oracles.md`).**
  - LeastConn/SED/NQ accept any pick in the argmin SET (tie order is unspecified; a rotating tie-break is
    planned for 1.1). Scores compare by integer cross-multiplication. New PASS control M9b (ties to the
    highest index): the old exact-index oracle failed it.
  - ConsistentHash gains two properties beside the stickiness re-walk: marking one home node down moves NO
    other key (0 in 20,000 calibration events), and a weight-0 rebuild leaves no key on the drained node,
    moves at most 8% of the other keys (measured p50 2.2%, p99 4.0%, max 5.0%) and is undone exactly by
    restoring the weight. New teeth: MH1, modulo-N hashing (the slot depends on the live count) -- caught by
    the properties only; MH2, a rebuild that reshuffles the table -- the old oracles exited 0 on it. The
    stickiness flap never restored the nodes it flapped (it re-read the eligibility it had just cleared);
    fixed.
  - BoundedLoad keeps its reference walk and adds the cap properties from the MTZ definition: home under cap
    -> the pick is home; some eligible under-cap backend in the probe window -> the pick is one of them; else
    an eligible backend in the window. M11 now asserts both kinds.
  - WeightedRandom adds a per-category binomial pass (4M controlled draws, |z| <= 6 per node) beside the
    window chi-square, which at ~180 categories cannot see a 10% error. Clean: max |z| 4.58 in 1,937 cycles.
    A +10% error is caught in 100% of cycles on every 16th node or on one weight-8 node, 83% on one weight-1
    node. New teeth M7b: a pick-level +10% bias that leaves the alias table intact -- the old checks exited 0.
  - The soak's keyed lanes use a Maglev table of M = 4099 (was 257). At 257, 63 of the 256 backends had no
    slot and weights 1-8 collapsed into two classes; at 4099 every backend's share follows its weight. Cost:
    +18% keyed-lane time, 0 major GCs. M = 25601 (Maglev's own M >= 100 N) forced 17 workload major GCs.
  - The PeakEWMA oracle drains every node (it drained only nodes with `d & 7` in {0, 4}).
  - Hygiene: chaos fails closed if a keyed balancer's private `_weights` is missing (a rename made two
    phases silent no-ops); `LAT_P999_MULT` is `LAT_P99_MULT` (it gates p99); provenance runs git in the
    repository with stderr captured and counts only tracked changes as dirty. Stream schema 5.
  - Thresholds come from `benchmark/soak/_calibrate-s14.mjs` (evidence `benchmark/soak/s14-calibration.json`);
    `test/SoakOracles.test.js` (in `npm test`) pins them and checks each property on the real kernel.

## [1.0.2] - 2026-10-03

Bug-fix release from the re-audit at `audit/2026-09-29/` (audited commit `1848f7b`; N1, N2, D1 and T2
reproduced on darwin/arm64 Node 26 before fixing). Fixes two `Pool.run` regressions that 1.0.1 shipped
(N1, N2) and the RECIPES PeakEWMA recipe (D1). No new API, no removed API; the one new observable is the
`LITE_PICK_CLOCK_INVALID` error code. Low items L2/L3/L4/L7/L8 and N4/N5/N6 are deferred to 1.1.0 and
recorded in [ADR 0013](./decisions/0013-audit-1.0.1.md).

### Fixed

- **`Pool.run` no longer penalizes an endpoint for a caller abort (N1, audit 2026-09-29).** In 1.0.1
  the H1 failure penalty (`recordRtt(i, max(elapsed, failurePenaltyNs))`) ran before the abort check,
  so a cancelled request (unmount, client-side timeout) pushed that endpoint's PeakEWMA estimate to
  1 s and inflated the lifetime mean that prices unsampled nodes (repro: 100 settles at 1 ms, one
  abort -> EWMA 1e6 -> 1e9, mean 1e6 -> 1.09e7). The abort check now runs first; a plain failure
  still feeds the penalty.
- **`Pool.run` forwards `opts.key` to an unmarked balancer again (N2, audit 2026-09-29).** 1.0.1 passed
  the key only to a class marked `static KEYED = true`, so a wrapper, decorator or custom keyed
  strategy without the marker silently got `pick()` and routed every key to one backend (repro: 200
  keys -> 1 of 8 backends). An unmarked balancer now receives the supplied key verbatim as
  `pick(key)`, as in 1.0.0 (the key wins over a clock reading, as in 1.0.0). A `LATENCY`-marked
  balancer still never receives the key. Mark a keyed class `static KEYED = true` to get key validation.
- **RECIPES section 8 no longer teaches the PeakEWMA black hole (D1, audit 2026-09-29).** The manual
  loop recorded `recordRtt(i, elapsed)` in a `finally`, so a node failing in 1 us looked like the
  fastest node: in a simulation of 4 nodes with node 0 failing in 1 us, 9824 of 20000 requests failed
  (49.1%). It also never imported `PICK_NONE`, so copied as written it threw `ReferenceError` on every
  call. The loop now mirrors Pool: the measured rtt on success, `max(elapsed, PENALTY_NS)` on failure,
  nothing on a caller abort (95 of 20000 failed, 0.48%). The cost description (RECIPES and README) now
  gives the three-case 1.0.1 cost, not `(inflight + 1) x ewma`. A new doc-test
  (`test/RecipesDoc.test.js`, in `npm test`) runs the snippet verbatim and fails above 5%.
- **The non-finite clock error has a code (N7).** `Pool.run`'s "clock() must return a finite number"
  error (pre-dispatch, and the feedback-path cause) now carries `code: 'LITE_PICK_CLOCK_INVALID'`, like
  every other Pool error. The message is unchanged.
- **`llms.txt` described the 1.0.1 key channel** ("the KEY reaches ONLY a keyed pick"); it now states
  the N2 unmarked-balancer rule and the N1 abort exemption.
- **Test-only: SmoothWRR's eligibility reset is now actually tested (T2, audit 2026-09-29).** A5 picked
  20 times (a multiple of the `[3,1,1]` cycle length), so every accumulator was already 0 and deleting
  the reset in `setEligible` passed the suite. A5b picks 21 times, asserts the reset on both
  transitions, and checks the following sequence against a reference smooth WRR; the mutant now fails.
- **Benchmark-only: the `soak:teeth` MP4 Pool anchor follows the N2 rename** (`keyed` -> `useKey` in
  the pick line); every teeth anchor resolves again.
- **CI: the lockfile matches `package.json` again** (`@zakkster/lite-adaptive` ^1.11.0; `npm ci` failed in
  every job), and the Node 18 floor job runs `npm test` with no install (the unit suites import only
  `node:*` and the package's own files).

### Changed

- **BoundedLoad `pick` no longer calls `Math.ceil` on the cap (N3, audit 2026-09-29).** For an integer
  in-flight count `inf < ceil(x)` equals `inf < x`, so behaviour is unchanged; the call was pure cost.
  Measured on a skewed 64-node table with Smi keys: +1% to +16% ops/ms (noisy; Node 26 and Node 22,
  Apple M4). The documented cap is still `ceil((1 + eps) x (_total + 1) / live)`.
- **Benchmark-only: the soak nightly is manual-only (`workflow_dispatch`).** On Node 22 the redesigned
  harness false-FAILs a correct kernel (audit 2026-09-29 S1-S4); the schedule returns once the harness
  is green there.
- **Benchmark-only: the endurance soak is redesigned (no runtime change).** Per the 2026-09-26 audit
  (RECOMMENDATIONS section 1), the old `benchmark/Soak.mjs` is replaced by `benchmark/soak/*` -- a
  harness whose drift gates measure TIME (per-lane early-vs-late medians across cycles), not lanes; a
  discrete-event load model with real service times; per-strategy quality invariants (RoundRobin
  evenness, SmoothWRR/WeightedRandom weight-fairness, P2C balance, LeastConn/SED/NQ argmin,
  ConsistentHash stickiness, BoundedLoad cap, PeakEWMA latency-steering); `/pool` lanes (async
  dispatch/settle/failover/abort); a DDSketch p99 tail gate; a hot-path 0-B/op probe that reads all V8
  data spaces; provenance + fail-closed config; a `soak:teeth` must-fail battery (every gate proven to
  trip through the production path, including a 1.0.0-kernel revert that the new quality gates catch);
  and a `soak:report` tool that re-derives the verdict from the JSONL and diffs runs against a
  baseline. That change left `Pick.js`/`Pool.js`/`*.d.ts` byte-identical. See
  [ADR 0014](./decisions/0014-soak-redesign.md). Known open (audit 2026-09-29): on Node 22 it
  false-FAILs a correct kernel (S1-S4), short or interrupted runs report PASS (S5), and the sha256
  parity gate ADR 0014 describes does not exist yet (S6); these are the next work items.

## [1.0.1] - 2026-09-27

Bug-fix release: the fixes from the full audit at `audit/2026-09-26/` (audited code state commit
`8c1ecc7`; H1-H4 and M1 independently reproduced on darwin/arm64 Node 26 before fixing). No new
strategy, no new public class, no removed API -- caller-visible behaviour changes only where a
documented contract was wrong or unsafe. See [ADR 0013](./decisions/0013-audit-1.0.1.md).

### Behaviour changes

Added after release (audit 2026-09-29 N7) for semver-strict consumers. Each is a fix to a documented
contract, but code that relied on the old behaviour sees a difference:

- A string index now throws: `setEligible('2', false)` is a `RangeError` (1.0.0 coerced it and
  flipped node 2). All index-taking methods share the same validation.
- `recordRtt('1', ...)` throws `RangeError` (1.0.0 threw `TypeError`).
- TypeScript: `PeakEwmaBalancer.pick()` and `ConsistentHashBalancer.pick()` / `BoundedLoadBalancer.pick()`
  without an argument no longer compile (`pick(now)` / `pick(keyHash)` are required on the concrete
  classes; `BalancerBase.pick` stays loose).
- `Pool.run` with PeakEWMA and no `opts.clock` rejects `LITE_PICK_CLOCK_REQUIRED`; with a keyed balancer
  and no numeric `opts.key` it rejects `LITE_PICK_KEY_REQUIRED` (1.0.0 ran both, wrongly).
- `liteQueryFetcher` over a keyed pool cannot supply a routing key, so that misconfiguration surfaces
  per fetch (`LITE_PICK_KEY_REQUIRED`), not at creation.
- Two regressions shipped here are fixed in the next release: a caller abort was recorded as a 1 s
  penalty (N1), and an unmarked balancer stopped receiving `opts.key` (N2).

### Fixed

- **PeakEWMA + Pool no longer turns a fast-failing or hung endpoint into a black hole (H1).**
  Kernel side: an unsampled node now costs 0 only WHILE IDLE (so it holds one request in flight at a
  time until its first sample); an unsampled BUSY node is priced at the LIFETIME mean of all recorded
  samples, not the old 1.0 ns baseline; a sampled node with work in flight is floored at
  time-since-last-sample, so a hung node gets MORE expensive over time instead of decaying toward 0.
  `Pool.run` side: a thrown attempt now feeds `recordRtt(i, max(elapsed, failurePenaltyNs), done)`
  (new `opts.failurePenaltyNs`, default `1e9`), so a failing node stops being the cheapest pick.
  Measured (4 PeakEWMA nodes, node 0 always throws): failure rate 49.4% (988/2000) in 1.0.0 -> ~0.05%
  (1/2000); a hung node took 1 dispatch, was 4891/10000.
- **SmoothWRR never returns a weight-0 node (H3).** `pick()` now requires a candidate to be eligible
  AND have `weight > 0` (path-independent -- covers `setWeight(i, 0)` and eligibility toggles), and
  `setWeight` resets that node's accumulated credit. A drained node is no longer selected.
- **BoundedLoad keeps key affinity at the low-load boundary (H4).** The per-backend cap is now
  `ceil((1 + eps) * (total + 1) / live)`; the `+ 1` counts the incoming request
  (Mirrokni-Thorup-Zadimoghaddam per-bin capacity), so the cap is always >= 1. The `Math.ceil` is a
  no-op for the integer `inflight < cap` test; behaviour is identical to 1.0.0 except at the boundary
  where the old cap fell below 1.
- **Non-integer, NaN, negative and string indices are rejected instead of silently desyncing state
  (M1).** One shared index-validation helper (`(i >>> 0) === i && i < capacity`) guards `setEligible`,
  `setWeight` (SmoothWRR / ConsistentHash / BoundedLoad / WeightedRandom), `note` and `recordRtt`:
  they throw `RangeError` for `NaN`, fractions (`1.5`), negatives, out-of-range, and non-numbers
  (including numeric strings like `'2'`, which previously "worked"); a rejected call changes no state.
  `isEligible` returns `false` for a non-integer instead of `true`.
- **`Pool` failover now reaches a genuinely DIFFERENT endpoint (M2).** A per-run tried set, up to 8
  re-picks, then a scan for an eligible untried endpoint from a key-derived start (keyed) or a
  rotating per-Pool cursor (unkeyed); when no untried eligible endpoint remains, failover STOPS and
  the last error is thrown (a 1-node pool with `tries: 3` now makes 1 attempt). ConsistentHash keyed
  `tries: 3` now hits 3 distinct backends (was `3, 3, 3`); a failing backend's keys spread over
  neighbours (max share ~23%, was 100% onto one neighbour in an intermediate build).
- **A `recordRtt` exception after a SUCCESSFUL call no longer re-runs `fn` (M4).** Settle-time
  feedback runs OUTSIDE the attempt's try/catch, so `fn` runs exactly once; if it fails, `run` rejects
  with a `LITE_PICK_FEEDBACK`-coded error carrying `.cause` and `.result` (fn's resolved value).
- **`Pool.run(fn, null)` works (L1).** `opts` may be omitted or `null`; the option reads are null-safe.
- **A throwing custom `note(+1)` no longer leaves an unpaired `note(-1)`** at settle: `note(-1)` fires
  only for a dispatch whose `note(+1)` actually landed, and a cleanup-time throw is swallowed so it
  never masks the error being thrown.
- **PeakEWMA `dt` is clamped `>= 0` in `pick`, `recordRtt` and `ewmaAt` (L6),** so a non-monotonic
  clock can no longer inflate the estimate via `exp(+x)`.
- **`verify` is green (H5).** The PerfGate WeightedRandom heavy-outage scenario is shrunk (`FB_CAP`
  2048; slowest phase 16.7 s -> ~3 s) so V8's memory reducer can no longer fire inside it.

### Changed

- **`Pool.run` keyed and latency channels are now separate and REQUIRED (M3).** A keyed balancer
  (`ConsistentHashBalancer` / `BoundedLoadBalancer`, marked `static KEYED = true`) requires a numeric
  `opts.key` (else `LITE_PICK_KEY_REQUIRED`); a latency balancer (`PeakEwmaBalancer`, marked
  `static LATENCY = true`) requires an `opts.clock` (else `LITE_PICK_CLOCK_REQUIRED`). The key reaches
  ONLY a keyed pick; a clock reading NEVER reaches a keyed pick. A non-keyed clocked run still passes
  the clock reading to `pick(now)` (preserving 1.0.0 behaviour for a duck-typed latency balancer that
  omits the marker). Previously a missing key routed everything to one backend, and `key` / `clock`
  were conflated.
- **`Pool.run` checks the abort signal before EVERY attempt.** An already-aborted signal now
  dispatches nothing and rejects (`throwIfAborted`, then the signal's `reason`, else
  `LITE_PICK_ABORTED`), including a structural `{ aborted: true }` signal with no `throwIfAborted`.
- **A backwards but finite clock reading on a successful settle records NO rtt sample** (a fabricated
  0 ns sample would make the node look instant); `done === now` is a real coarse-clock 0 and is
  recorded. A non-finite clock reading throws before dispatch.
- **On a failed attempt whose penalty feedback then fails, `Pool.run` throws `fn`'s original error
  object (identity preserved)** with a non-enumerable `liteFeedbackError` attached, and stops
  failover.
- **`liteQueryFetcher` forwards `clock` and `failurePenaltyNs`** to `pool.run` (validated once at
  creation). Its `ctx.key` remains the query-cache key, not a routing key.
- **PeakEWMA `tau` is documented as the EWMA TIME CONSTANT (half-life = `tau x ln2`),** correcting the
  earlier "half-life" wording (L5). No math change.
- **Static class markers added:** `ConsistentHashBalancer.KEYED` (inherited by `BoundedLoadBalancer`)
  and `PeakEwmaBalancer.LATENCY`, so `/pool` selects the right channel while staying duck-typed.
- **BoundedLoad docs corrected (M-Doc1):** update `inflight[i]` AND call `note(i, +/-1)` in lockstep
  (or drive it through `/pool`); `note` maintains `_total`, it does not write `inflight`.
- **Types tightened:** `pick(now)` / `pick(keyHash)` are now REQUIRED on the concrete
  `PeakEwmaBalancer` / `ConsistentHashBalancer` / `BoundedLoadBalancer` classes (`BalancerBase.pick`
  stays deliberately loose, `pick(arg?)`); the `KEYED` / `LATENCY` markers are typed; `Pool.d.ts` now
  uses a structural `AbortLike` type (compiles with `lib: ES2022` and no DOM, L15).

### Added

- **`opts.failurePenaltyNs`** on `Pool.run` (and `liteQueryFetcher`): the minimum rtt penalty a thrown
  attempt feeds a latency-aware balancer (finite `> 0`, default `1e9`).
- **`typesVersions`** maps `@zakkster/lite-pick/pool` -> `Pool.d.ts` for `moduleResolution: node10`
  (L16); `test:types` gains an ES2022-no-DOM lane.
- **`.github/workflows/ci.yml`:** `test` (Node 20/22/24 x ubuntu/macos/windows), `test-node18` (unit
  suites only, backing `engines >=18`), `gates` (torture, `test:perf`, `bench:verify`, an exact
  11-file tarball check), and `types-compat` (the packed tarball compiled with TypeScript 5 under
  node10 / node16 / bundler / ES2022-only on case-sensitive Linux). `package-lock.json` is now
  committed (maintainer decision; follows lite-di-container).
- **`test` is now an explicit file list** (portable to Windows / Node 20 -- no shell glob), guarded by
  `test/suite-list.test.js`, which fails if any test file under `test/` is not run.
- **Gates hardened with teeth:** `test:perf` pins the semi-space `min = max = 1 MB` (sharper than
  1.0.0's `max = 4 MB`) with a fail-closed test asserting the pin; must-fail allocations escape via a
  64-slot ring and `grows` compares buffer identity (M-T3); new intermittent must-fail controls (an
  allocation every 16 and every 32 picks). `torture` now reports RETAINED B/op, treats an unmeasured
  reading as FAIL, and has a retaining must-fail control (trips at 40 B/op) (H6); `GcBlastRadius`
  likewise, and its README column is renamed "pick retained B/op". Every `benchmark/*.mjs` entry check
  uses `pathToFileURL` (M-T2); `bench:verify` states which blocks are re-measured vs compared to stored
  `results.json` (M-T1); the fuzz single-node-down block uses one eligibility array per balancer (M-T4)
  and prints the discovery seed every run (L21).
- Demo (repo-only, not in the tarball): the Pool Scope web server binds `127.0.0.1`, serves GET/HEAD
  only, enforces a path allowlist + Host-header check + `path.relative`/`realpath` traversal guard +
  `nosniff` + port validation (M-D1, M-D2, L26); the driver keeps BoundedLoad's `totalInflight` in
  lockstep (M-D3); the TUI reset uses `DEFAULT_CONC` and restores the terminal on SIGTERM/SIGHUP with
  the alternate screen (M-D4, L23); fanout counts only distinct failovers and reports exhausted
  requests (L24).

### Known limitations

Disclosed, shipped, and slated for 1.1.0:

- **A realistic (non-small-integer) number argument boxes once per non-inlined call.** V8 boxes a
  `HeapNumber` (~16 B) for a `PeakEWMA` `pick(now ~1.7e15)`, ~16-30 B for `recordRtt` with a realistic
  clock and a fractional sample, and ~16 B for `ConsistentHash`/`BoundedLoad` `pick(keyHash >= 2^31)`.
  Small-integer arguments are 0 B/op (range is build-dependent: `< 2^31` on stock 64-bit Node, `< 2^30`
  on pointer-compressed builds); values produced by `%` or division may box even when small. 1.1.0 adds
  buffer-based variants that read the clock/key from a caller-owned typed array (prototype measured
  0 B/op at 1e15). `test:perf` prints these as report-only lines every run.
- **OPEN:** run in isolation with some integer sample patterns (e.g. mod 500000, step 1000), the
  PerfGate `recordRtt` lane shows a small allocation that scales with window length (8N: 2, 16N: 4,
  32N: 9 scavenges at the 1 MB pin); it disappears with `--no-maglev`,
  `--no-concurrent-recompilation`, or a preceding lane. Root cause not established; printed as a
  report-only line; tracked for 1.1.0.
- **M5 (LeastConn / NQ tie order) is now documented as unspecified.** A rotating tie-break lands in
  1.1.0; it was moved OUT of 1.0.1 because "lowest index" was an explicit documented promise, so
  changing it is not a patch-level fix.

### Not in this release

- The soak redesign (audit RECOMMENDATIONS section 1): the 1.0.0 soak's drift gates compared lanes
  rather than time, and its heap sample included harness bookkeeping. Redesign pending.
- Observability (section 2): zero-cost counters, `diagnostics_channel`/hooks, `describe()`, error codes.
- The `Eligibility` object as the shared unit (section 3.1) -- a breaking change deferred to 2.0.

## [1.0.0] - 2026-09-23

The **roster-complete** release: ten selection strategies + the `/pool` request layer + the benchmark
suite + the docs/GUIDE capstone. Roster complete **for now, not closed** -- AZ-aware routing, the
lite-await hedging combinator, and subsetting are queued post-1.0 (see [ROADMAP.md](./ROADMAP.md)).

### Added

- **`WeightedRandomBalancer` (M10)** -- O(1) weighted-random selection via an inline **Vose/Walker alias
  table** (one column draw + one probability compare -> a candidate) with **rejection-sampling
  eligibility** (retry an ineligible candidate up to a bounded 64, then a 0-B/op rotated linear eligible
  scan) -- the ADR 0005 / P2C discipline. The alias table is built **cold** over the eligible-independent
  weights, so a **weight-0 node is never a column** (never returned) and rejecting the ineligible draws
  **renormalizes** the weight distribution over the surviving eligible mass (each eligible node's share
  converges to `weight[i] / sum(eligible weights)`). `weights` is the caller's `Uint32Array` (the
  SmoothWRR/SED seam); the balancer is the **sole writer** of its derived table (`_prob` / `_alias`) via
  cold `setWeight` / `rebuild` -- an eligibility flap **never** rebuilds (anti-flap). Validates
  typeof-first before allocating the table. `pick()` is **O(1)**, **0 B/op**, never throws; `PICK_NONE`
  only when `live === 0` or no eligible node has a positive weight. It is the **stateless** O(1) weighted
  sampler (no accumulator to desync) for very large pools where SmoothWRR's O(cap) scan hurts -- trading
  smoothness for sampling variance. `peerDependencies` stays `{}` (the Vose build is inlined; a lite-o1
  `AliasTable` and a lite-logn Fenwick tree are deferred optional peers, imported by nothing).
  ([ADR 0012](./decisions/0012-weightedrandom.md)).
- **Fairness anchor** (`test/balance.mjs`) -- n=64, skewed weights [1..16], 8e6 seeded draws: every node's
  observed share is within **2% relative** of `weight[i]/sum` (measured worst ~0.84%), and a cumsum-linear
  O(n) foil matches the same fairness. The O(1) alias sample beats that O(n) foil by **~107x ops/ms** at
  n=4096 (gate: >=3x). Under half the pool down (1e6 picks): **0 ineligible / 0 weight-0** returns,
  survivor shares within **3% relative** of `weight[i]/sum(eligible)` (measured worst ~1.77%), and all-zero
  weights -> `PICK_NONE`. Thresholds are the sampling-variance floor from a correct run (N sized so the
  band holds with margin) -- the band is never widened to pass.
- **`GUIDE.md`** -- the "which of the ten strategies do I pick?" decision guide (a decision tree + table
  keyed by keyed-vs-load-vs-latency-vs-weighted, O(1) vs O(cap), state owned, and when each wins),
  distinct from `RECIPES.md` (how-to wiring). Added to the published `files[]` (the tarball is now 11 files).
- Gates extended for the new strategy: `test/WeightedRandom.test.js` boundary + behaviour suite;
  `test/fuzz.mjs` keyed-agnostic subject + `checkWeightedRandom` (structural + no-weight-0-column + the
  sum-reconstruction invariant, after every op) + a 1000-flap **0-rebuild** anti-flap assertion;
  `test/torture.mjs` retention + a `pick()` 0 B/op phase (phase 14); `test/perf/PerfGate.test.mjs`
  `weightedRandomPick` zero-alloc scenario + a boxed `mustFail` tooth; `test/witness.mjs` 'const'
  flat-work subject; `benchmark/Matrix.mjs` throughput + fairness subject; `benchmark/Report.mjs`
  Weighted-random parity row now times `WeightedRandomBalancer` vs `wrr` (both O(1) weighted-random --
  previously a pending SKIP); `Pick.d.ts` + `test/types/pick.test-d.ts` typed surface.

### Changed

- **`Pick.js` header roster/count** nine -> **ten**, and the `VERSION` stamp `0.9.0` -> `1.0.0` (the
  three-place sync: `package.json`, the `VERSION` const, `llms.txt`). This session appends **one** class;
  every other strategy in `Pick.js` is byte-identical.
- **`package.json`** version `1.0.0`, the description roster gains WeightedRandom + a GUIDE.md pointer,
  keywords gain `alias-method` / `vose` (`weighted-random` was already present), and `files[]` gains
  `GUIDE.md`. `peerDependencies` stays `{}`.
- Sibling boundary documented explicitly (so 1.0.0's WeightedRandom does not look duplicative with
  `@zakkster/lite-random`): lite-random is a **game RNG** returning an item, not eligibility-aware, no
  reusable table; lite-pick WeightedRandom returns an endpoint index, honours the shared eligibility
  bitmap (fail-closed), and owns a persistent alias table -- different domain, not a peer (GUIDE.md,
  llms.txt, ADR 0012).

## [0.9.0] - 2026-09-23

### Added

- **`BoundedLoadBalancer` (M9)** -- **Consistent Hashing with Bounded Loads** (CHBL: Mirrokni et al.,
  Google Research; Vimeo's `eps = 0.25`). It **extends `ConsistentHashBalancer`** (the Maglev table) and
  adds a per-backend occupancy cap `cap = (1 + eps) x _total / live`: `pick(keyHash)` sticks a key to its
  hashed home **unless** that backend is over cap, in which case the request **overflows** along the same
  bounded forward-probe to the next eligible, under-cap backend. If none in the probe window is under cap
  it falls back to the first eligible seen (**sticky wins; the cap is a soft preference, never a dead
  pick**); `_total === 0` skips the cap entirely, behaving as pure consistent hashing. This keeps
  consistent hashing's stickiness + minimal disruption **and** adds the **hotspot protection** plain
  consistent hashing lacks. The Maglev build, probe walk, and `setWeight` / `rebuild` / `tableSize` are
  reused verbatim. The running occupancy sum `_total` is **balancer-owned** (starts at 0) and written
  **solely** via the warm `note(i, delta)` seam (dispatch `+1` / settle `-1`), so the cap's mean stays
  O(1)-current without a scan; `inflight` is the caller's `Uint32Array`, read **live** as the per-backend
  occupancy. `pick()` and `note()` are both **O(1)** / **0 B/op**. `eps` is validated typeof-first
  (TypeError non-number, RangeError non-finite / `<= 0`) before the table is allocated; `note()` validates
  `i` in range and `delta` as an integer, and clamps `_total` at 0. `totalInflight` exposes `_total`.
  `PICK_NONE` only when no eligible backend is reachable within the probe window -- **never** for
  over-cap (fail open on overload). **Contract:** the mirrored inflight counter is mutated **only** through
  `note()` / the `/pool` adapter -- direct mutation desyncs `_total` (UB, the SmoothWRR-weights asymmetry).
  ([ADR 0011](./decisions/0011-boundedload.md)).
- **The pivot** (ADR 0011): the first M9 draft built the "overload" reading -- P2C-over-inflight with a
  `(1 + eps) x mean` cap -- and it was proven **byte-identical to plain P2C** (an under-cap draw always
  has lower inflight than an over-cap one, so "prefer under-cap" and "lower-of-two" pick the same node).
  The cap is only *load-bearing* when the primary choice is a **hash**, so M9 is CHBL -- the algorithm
  the roadmap cited. The P2C-with-cap reading is withdrawn as non-distinct.
- **Hotspot anchor** (`test/balance.mjs`) -- 64 backends, a Zipfian-skewed key stream (6 hot keys, 85% of
  traffic), a fixed concurrency window: plain ConsistentHash pins a hot key on one backend -- measured
  **max occupancy 129** vs a mean of **10** (a ~13x hotspot) -- while CHBL's cap holds **max occupancy 13**
  (`cap = (1 + eps) x mean = 12.5`) by overflowing to neighbours, materially below ConsistentHash's max
  (the foil FAILS the bounded-occupancy band). Both keep **~1.55%** minimal disruption on a scale event
  (`<= 2/N`). Thresholds are measured from a correct run with a small margin and noted -- the impl is
  never bent to a number.
- Gates extended for the new strategy: `test/BoundedLoad.test.js` boundary suite (ctor + eps validation,
  sticky same-key routing, overflow when a home is over cap, fail-open, PICK_NONE only pool-down,
  pure-ConsistentHash when `_total === 0`, `note()` validation + clamp, `totalInflight` tracking, minimal
  disruption, a Pool `opts.key` net-zero round-trip); `test/fuzz.mjs` keyed note-driven subject +
  `checkBoundedLoad` (`totalInflight === sum(inflight)` after every op) + the ConsistentHash structural
  invariant; `test/torture.mjs` retention (small-instance CHBL loop) + `pick(keyHash)` and `note()` 0 B/op
  phases; `test/perf/PerfGate.test.mjs` `boundedLoadPick` + `boundedLoadNote` zero-alloc scenarios + a
  `mustFail` alloc tooth; `test/witness.mjs` O(1) const flat-work keyed subject; `benchmark/Matrix.mjs`
  subject (dims throughput/balance/gc over the skewed-cost workload); `Pick.d.ts` +
  `test/types/pick.test-d.ts` typed surface.

### Changed

- `Pool.run` gains an **inert-unless-duck-typed `note` hook** (mirror each dispatch as `note(i, +1)` and
  each settle as `note(i, -1)`, net-zero per run) paralleling the PeakEWMA `recordRtt` wiring, and an
  **`opts.key`** option -- when supplied, Pool drives `pick(key)` (keyed / CHBL routing); failover
  re-picks with the same key, and because the failed backend's occupancy stays elevated a CHBL re-pick
  naturally overflows to the next backend. All hooks are inert when not applicable -- Pool stays generic,
  in-flight stays net-zero, abort/failover unchanged.
- `Pick.js`: STRATEGY-APPEND only -- the other eight strategies are **byte-identical**; the sole changes
  are the header roster/count (eight -> nine), the `VERSION` bump, and the appended `BoundedLoadBalancer`
  (which **extends `ConsistentHashBalancer`**, reusing its Maglev build + probe verbatim; ConsistentHash
  itself is unchanged).
- `VERSION` bumped 0.8.0 -> **0.9.0** across the three sync sites (package.json, `Pick.js`, llms.txt);
  package `description` roster updated (keywords already carried `bounded-load`). `peerDependencies`
  stays `{}` (CHBL reuses M8 -- imports nothing new).

## [0.8.0] - 2026-09-23

### Added

- **`ConsistentHashBalancer` (M8)** -- sticky / cache-affinity routing via a prebuilt **Maglev
  lookup table** (the in-kernel/production choice: Linux IPVS `mh`, Meta Katran, Cilium).
  `pick(keyHash)` maps a caller-supplied **integer** key to a backend (`slot = keyHash % M`, a table
  read, and a bounded forward-probe past down slots) -- **O(1)**, **0 B/op**. The key is coerced
  `>>> 0` (NaN -> 0) and `pick` never throws (fail-closed). Per-pick *string* hashing is the one
  zero-GC hazard, so callers hash string keys themselves (cold); `lite-pick` adds **no hashing
  dependency**. The balancer owns the lookup `Uint32Array` (`M x 4` bytes -- ~256KB at the `65537`
  default `M`, a disclosed **cold** one-time allocation; `M` is configurable down for small pools)
  and an internal weights array; `setWeight(i, w)` / `rebuild()` rebuild the table cold, while a
  **health flap never rebuilds** -- the bounded probe (<= 64 slots) absorbs it. Weighted Maglev
  populate gives each backend a per-backend slot quota proportional to its weight (unweighted = equal).
  Fails closed (`PICK_NONE`) when the pool is down or no eligible backend is reachable within the bound.
  Exports `CH_DEFAULT_M` (65537) and `CH_PROBE_LIMIT` (64) alongside the class. ([ADR 0010](./decisions/0010-consistenthash.md)).
- **Minimal-disruption anchor** -- removing 1 of 64 backends remaps only **~1.6%** of keys (`test/balance.mjs`,
  `benchmark/Disruption.mjs`), versus the naive-modulo foil's **~98%**. `benchmark/Disruption.mjs`
  replaces its M6 explicit ConsistentHash **SKIP** row with a real measured Maglev row (vs the modulo
  foil and the `1/n` ideal); `benchmark/results.json` + the README fences regenerated (bench:verify green).
- Gates extended for the new strategy: `test/ConsistentHash.test.js` boundary suite; `test/fuzz.mjs`
  keyed subject + `checkConsistentHash` / `reachableWithinBound` invariants; `test/torture.mjs` retention
  + a `pick(keyHash)` 0 B/op phase (build excluded, cold); `test/perf/PerfGate.test.mjs`
  `consistentHashPick` scenario + a `mustFail` alloc tooth; `test/witness.mjs` O(1) const flat-work
  subject; `benchmark/Matrix.mjs` subject; `Pick.d.ts` + `test/types/pick.test-d.ts` typed surface.

### Changed

- `Pick.js`: STRATEGY-APPEND only -- the other seven strategies are **byte-identical**; the sole
  changes are the header roster/count (seven -> eight), the `VERSION` bump, and the appended
  `ConsistentHashBalancer` (+ the `chMix32` / `chIsPrime` cold helpers and the `CH_*` constants).
- `VERSION` bumped 0.7.2 -> **0.8.0** across the three sync sites (package.json, `Pick.js`, llms.txt);
  package `description` + `keywords` (added `consistent-hash`, `sticky`) updated. `peerDependencies`
  stays `{}` (the deferred `@zakkster/lite-filter` hot-key-oracle and `@zakkster/lite-o1` `EliasFano`
  ring seams import nothing until a shipped path uses them).

## [0.7.2] - 2026-09-23

### Added

- `RECIPES.md` -- a beginner-to-advanced usage guide that builds the selection kernel up into a
  real load balancer (health/eligibility wiring, caller-owned in-flight counters, the
  dispatch/settle loop, `/pool` failover, PeakEWMA rtt feedback, the FE profile, a strategy
  decision table, suite composition, zero-GC discipline, and gotchas). Added to the published
  package (`files[]`) and linked from the README.

Docs-only release: no source or behavior change from 0.7.1 (the `VERSION` stamp is bumped for the
three-place sync).

## [0.7.1] - 2026-09-23

### Fixed

- PeakEWMA cold-start / unsampled-node scoring under real large-magnitude clocks. An unsampled node
  now scores at its UNDECAYED baseline (`_stamp` initialized to a negative sentinel, read as the
  1.0 baseline) = graceful least-connections, instead of `exp(-now/tau)` underflowing to 0 and
  collapsing a cold pool to random selection. The FIRST `recordRtt` sample now initializes the EWMA
  EXACTLY to the sample (clock-magnitude-independent); the Finagle peak rule applies from the second
  sample on. `pick()` stays a pure 0 B/op read (a per-candidate sentinel compare, no allocation).

### Changed

- Completes the 0.7.0 packaging: synced the `llms.txt` version stamp, added the PeakEWMA
  README / CHANGELOG sections + `decisions/0009-peakewma.md`, and regenerated the benchmark
  `results.json`. Documented that `pick(now)` / `recordRtt` require a FINITE `now` -- `recordRtt`
  throws on a non-finite argument; `pick(now)` never throws (fail-closed) and degrades a non-finite
  `now` to P2C-random selection. No API or behavior change beyond the cold-start fix.

## [0.7.0] - 2026-09-23

M7: `PeakEwmaBalancer` -- latency-aware power-of-two-choices (Twitter Finagle's peak-EWMA). A
STRATEGY-APPEND session: one class is added to `Pick.js`; the other strategies are byte-identical,
only the header roster/count and the `VERSION` stamp change. `peerDependencies` stays `{}`.

### Added

- `PeakEwmaBalancer extends BalancerBase` (`Pick.js`, `Pick.d.ts`) -- `new PeakEwmaBalancer(capacity,
  eligible, inflight, tauNs, seed?)`. `pick(now)` draws two distinct eligible endpoints (reusing
  `P2cBalancer`'s rejection-sampling `_draw`) and returns the lower `cost = (inflight + 1) x
  ewmaAt(now)`, tie to the first draw; `O(d)=O(1)`. `ewmaAt(i, now)` decays ON READ
  (`_ewma[i] * exp(-(now - _stamp[i]) / tau)`), so `pick()` never writes and is **0 B/op**.
  `recordRtt(i, sampleNs, now)` is the warm feedback path (the Finagle peak rule: snap up to a
  larger sample, decay down over `~tau`), also **0 B/op** on the success path. `now` / `sampleNs`
  are caller-supplied nanoseconds. The EWMA state (`_ewma` / `_stamp`, `Float64Array`) is
  balancer-owned; `inflight` is the caller's `Uint32Array` read live. Cold start seeds the EWMA to
  `1.0` -> graceful least-connections, never `NaN`. Constructor and `recordRtt` validate
  typeof-first, before allocation. Anti-flap = the half-life, no extra dwell.
- `Pool.run` opt-in latency feedback (`Pool.js`, `Pool.d.ts`): when `opts.clock` (a caller-owned
  nanosecond source) is supplied AND the balancer duck-types `recordRtt`, Pool drives `pick(now)`
  and records the settled rtt on success. Otherwise the hook is inert -- Pool stays generic, the
  in-flight counter stays net-zero, and abort/failover are unchanged.
- `test/PeakEWMA.test.js` -- the boundary suite (cold-start valid + never-NaN, snap-up, decay to
  sample/e at dt=tau within ~1%, slow-node avoidance, fail-closed, tie-break to the first draw =
  identical to P2C on the same seed, constructor + recordRtt validation throws, flap churn).
- `test/balance.mjs` -- the LATENCY ANCHOR: a closed-loop single-server-per-node queue with one node
  at 10x service time. Measured: PeakEWMA slow-node share ~0.007% vs P2C ~1.47% (<= 25% of P2C);
  PeakEWMA service p99 ~1950ns vs P2C ~14500ns (>= 20% lower); random foil worse than both.
- `test/torture.mjs` -- PeakEWMA retention + `pick(now)` and `recordRtt()` 0 B/op phases.
- `test/perf/PerfGate.test.mjs` -- `PeakEwmaBalancer.pick(now)` + `recordRtt()` zero-alloc scenarios
  and a `pick(now)`-boxed-into-a-fresh-array `mustFail` tooth.
- `test/witness.mjs` -- PeakEWMA subject, `const` (O(d)=O(1)) flat flag; work-rate flatness ~0.89
  (the `Math.exp` runs ~2x/pick and stays flat -- the cached 2^-k decay-table fallback was NOT
  needed).
- `test/fuzz.mjs` -- PeakEWMA subject: `_ewma` / `_stamp` stay finite and `PICK_NONE` holds iff the
  pickable mass is 0 under a `recordRtt` / `pick(now)` / `setEligible` barrage.
- `test/types/pick.test-d.ts` -- PeakEwmaBalancer type-surface smoke.
- `benchmark/Matrix.mjs` PeakEWMA throughput subject; PeakEWMA lanes in `benchmark/GcBlastRadius.mjs`
  (same maxMajor 0 / 0 B/op / bounded-pause contract) and `benchmark/Fairness.mjs` (latency
  steering); `benchmark/results.json` regenerated (version 0.7.0), `bench:verify` green.
- `decisions/0009-peakewma.md` -- the ADR (latency-aware P2C, decay-on-read, the Finagle peak rule,
  caller-supplied clock, balancer-owned state, deferred DDSketch-p99, anti-flap = half-life).

### Changed

- `Pick.js` header roster/count (six -> seven strategies), `VERSION` 0.6.0 -> 0.7.0; `package.json`
  version + description; `llms.txt` version + PeakEWMA surface + the FE-profile note + the deferred
  DDSketch-p99 note; `README.md` PeakEWMA section + FE profile + the AWS anomaly-mitigation mapping
  row.

## [0.6.0] - 2026-09-23

M6: the benchmark suite (ROADMAP.md M6). An EVIDENCE session -- no API change. `Pick.js` and
`Pool.js` are byte-identical to 0.5.0 apart from the `VERSION` stamp; the kernel gates
(torture / PerfGate / witness / balance / fuzz) are unchanged and green. Everything added lives
under `benchmark/` and is NOT in the published tarball (`files[]` unchanged).

### Added

- `benchmark/GcBlastRadius.mjs` -- the GC blast-radius headline (dimension 3). The same sustained
  mixed workload (n=1024, 2,000,000 requests) through two lanes: the lite-pick lane (`P2cBalancer`
  over caller-owned typed arrays) measures `major=0`, pick `B/op=0`, `maxPause` ~0.1-0.3ms; the
  allocating foil lane (collect-candidates-sort idiom with a retained in-flight request context)
  measures `major=13-14`, `maxPause` ~2.5-4ms. GC sampled via `@zakkster/lite-gc-profiler`
  (`GcProfiler` + `checkNoGc`, the torture.mjs machinery); `B/op` via `measureAllocs`.
- `benchmark/Fairness.mjs` -- weighted convergence + burstiness (dimension 8). SmoothWRR weights
  [10,3,2,1]: exact fairness (counts == k*weight) over 500 cycles, max-run 3 vs the bursty
  weight-expansion foil's 10. SED weights [1,2,3,4,6,8,12,16]: worst share drift < 0.0001 from the
  weight target; weighted-imbalance ~0.00 vs a weight-blind random foil's ~5.5.
- `benchmark/Disruption.mjs` -- consistent-hash disruption (dimension 7). Naive-modulo foil over
  100,000 seeded keys remaps 98.4% (remove node 64->63) / 98.5% (add node 64->65) of keys vs a good
  consistent hash's ~1.6% / ~1.5% ideal. Explicit SKIP row for `ConsistentHash` (Maglev, M8) -- no
  stub in `Pick.js`.
- `benchmark/Report.mjs` -- emits `benchmark/results.json` stamping Node version, V8, CPU model,
  core count, arch, OS, and every PRNG seed alongside the measured numbers; renders the README
  `<!-- bench:ID -->` fenced tables from it. `--verify` mode is the `bench:verify` drift check:
  ALGORITHMIC numbers (balance peak-gap, disruption remap %) recomputed FRESH and compared EXACT;
  TIMING numbers (GC pauses) compared to `results.json` within +/-15%. Exits non-zero on any drift.
  (Fixes the previously-broken `bench:report` script, which pointed at an absent `Report.mjs`.)
- `benchmark/Soak.mjs` -- the endurance-soak scaffold (post-1.0 #8): ONE P2C lane, continuous
  mixed-chaos load (flap storms + whole-pool-down troughs + load feedback), emits a JSONL
  time-series to `benchmark/soak.jsonl`, and RUNS `test/invariants.mjs:checkBase` at every
  checkpoint. `tracker.size()` returns to 0 after each cycle; invariants green at all checkpoints.
  `SOAK_CYCLES=0` runs forever -- the harness the `caffeinate -i` overnight burn-in plugs into.
- `benchmark/Matrix.mjs` -- extended (not rewritten): each SUBJECT gained a `dims` flag, and the
  file now exports the SHARED SEEDED workload matrix (`buildWorkload` over uniform / skewed-weight
  / skewed-cost), `SEEDS`, `SUBJECTS`, `SIZES`, and `measureThroughput`, reused by every dimension
  file. The standalone throughput runner is behind a main guard so importing it runs no sweep.
- `decisions/0008-benchmark-suite.md` -- the ADR: the parity framing, the real-competitors + foils
  baseline, the drift-check teeth, and the ConsistentHash SKIP.
- README: the *Evidence* section -- balance anchor + GC blast-radius headlines (fenced), the
  consistent-hash disruption trust gate, the honest COLD-path cost table, and the vs-AWS NLB/ALB
  "complementary, not a competitor" positioning.
- devDependencies: `load-balancers@1.3.52`, `loadbalance@1.0.0`, `wrr@1.0.0` -- REAL npm
  competitors, pinned to exact versions, loaded via `createRequire` (all three are CommonJS) and
  timed into `results.json` beside our in-repo foils; a package that fails to load becomes a
  labeled `unavailable` row rather than being silently dropped. Each incumbent is rendered side by
  side with the SAME-complexity lite-pick strategy on the SAME n=1024 pool in the README
  `<!-- bench:competitors -->` throughput fence. Parity is claimed only on EQUAL-work rows: P2C is
  parity (~60k vs ~61k ops/ms); RoundRobin is ~22% slower (~260k vs ~335k) and the gap is OWNED --
  `loadbalance` is a bare `i++ % n` with no liveness, while lite-pick's `RoundRobinBalancer`
  forward-scans the eligibility bitmap to skip down nodes (never a dead pick), and that scan is the
  constant-factor cost of a guarantee the incumbents do not offer. The weighted-random row is a
  disclosed SKIP -- lite-pick's O(1) `WeightedRandom` (alias table) lands at M10, so `wrr` is not
  raced against our O(cap) `SmoothWRRBalancer` (a different complexity class). No "faster"/"Nx".
- Scripts: `bench:gc`, `bench:fairness`, `bench:disruption`, `bench:verify`, `soak`.

### Changed

- Version bumped to 0.6.0 in the three sync sites (`package.json`, `Pick.js` `VERSION`, `llms.txt`).
  `peerDependencies` stays `{}`.

## [0.5.0] - 2026-09-23

M5: the ergonomic request layer at the `@zakkster/lite-pick/pool` subpath -- dispatch/settle
in-flight counters + distinct-endpoint failover + a duck-typed query-cache fetcher (ROADMAP.md M5).

### Added

- `@zakkster/lite-pick/pool` (`Pool.js`) -- a new SUBPATH export (the kernel `Pick.js` stays a
  single 0 B/op file; the async layer lives outside it, the lite-query `/stream` + `/await`
  precedent, ADR 0007).
- `Pool` -- wraps a balancer + the caller-owned in-flight view. `run(fn, opts?)` picks an endpoint,
  increments in-flight on dispatch, awaits `fn(endpoint, signal)`, decrements on settle (in a
  `finally` -- net-zero per run, even on throw). On a thrown error it keeps the failed endpoint's
  count ELEVATED and re-picks, so a load-aware strategy (P2C/LeastConn/SED/NQ) steers the next
  attempt to a DISTINCT endpoint -- up to `opts.tries` attempts (default 1 = no failover), then
  rejects with the last error. Rejects a `code:'LITE_PICK_NONE'` error when no endpoint is eligible;
  `opts.signal` is passed to `fn` and, once aborted after a failure, stops failover. NOT a 0 B/op
  path (the kernel `pick()` is) -- a normal async wrapper, disclosed.
- `liteQueryFetcher(pool, perEndpoint, opts?)` -- returns a `({ key, signal }) => Promise` fetcher
  for a query cache (lite-query's `fetcher`, or any fetcher-shaped consumer). Imports NOTHING from
  lite-query -- duck-typed, so `peerDependencies` stays empty. `opts.tries` is the spatial failover
  count. BOUNDARY: Pool owns SPATIAL failover across the pool; the cache owns TEMPORAL retry/backoff.
- `test/Pool.test.js` -- 12 tests: dispatch/settle in-flight balance (success AND throw), fail-closed
  coding, distinct-endpoint failover, tries exhaustion (last error), abort-stops-failover, signal
  passthrough, a 200-way CONCURRENT-consistency check (in-flight drains to all-zero -- no leak), and
  the duck-typed fetcher.
- `Pool.d.ts` + `test/types/pool.test-d.ts` -- the typed surface (the type-test tsconfig gains the
  `DOM` lib for `AbortSignal`).
- `demo/fanout.mjs` (`npm run demo`) -- the integration moat: least-connections fan-out over a flaky
  pool with a replica killed mid-run, proving 0 dead picks + 0 leaked in-flight + live failover, and
  showing the lite-query fetcher wiring. (`demo/` is not in `files[]`.)
- `decisions/0007-pool-adapter.md` -- the /pool-subpath home, spatial-vs-temporal retry ownership,
  the explicit 0 B/op boundary, and the duck-typed (zero-peer) fetcher.

### Changed

- Version 0.4.0 -> 0.5.0 across `package.json`, `Pick.js` `VERSION` (re-exported by `Pool.js`), and
  `llms.txt`. `exports` gains `./pool`; `files[]` gains `Pool.js` + `Pool.d.ts`.
- `peerDependencies` stays `{}` -- the fetcher adapter is duck-typed (ADR 0007 Fork 4).

## [0.4.0] - 2026-09-23

M4: the exact LeastConn family (IPVS `lc` / `sed` / `nq` made zero-GC) + the seeded invariant
fuzzer (ROADMAP.md M4).

### Added

- `LeastConnBalancer extends BalancerBase` -- EXACT fewest-in-flight (IPVS `lc`). A full O(cap)
  scan of the caller-owned in-flight view returning the eligible node with the lowest count
  (lowest index on a tie); the deterministic complement to P2C's O(1) approximation. In-flight
  is read LIVE (no `setWeight`, no derived aggregate -- the caller may mutate it directly).
  0 B/op. Fails closed (`PICK_NONE`) when the whole pool is down.
- `SedBalancer extends BalancerBase` -- shortest-expected-delay (IPVS `sed`). Returns the
  eligible, positive-weight node minimizing `(inflight + 1) / weight`. BOTH inflight and weights
  are caller-owned, read live. A weight-0 eligible node is not a candidate; all-zero-weight fails
  closed even with the pool up. O(cap), 0 B/op.
- `NqBalancer extends BalancerBase` -- never-queue (IPVS `nq`). Returns the FIRST idle eligible
  positive-weight node (in-flight 0) if one exists, else the SED minimum -- the worker-pool fit.
  O(cap) worst case, O(1) when an early node is idle, 0 B/op.
- **The invariant fuzzer** (`test/fuzz.mjs` + the reusable `test/invariants.mjs` checker): a
  seeded, property-based state-machine attack asserting STATE-SYNCHRONISATION invariants after
  EVERY op (strict mode) per strategy -- `live` and (SmoothWRR) `_totalEligibleWeight` stay EXACT
  vs a manual recompute, owned Float64 accumulators stay finite, `PICK_NONE` holds IFF the
  pickable mass is 0, and LeastConn/SED/NQ return the true optimum (NQ its idle-first rule). Prints
  the seed on failure for byte-for-byte replay; CI runs a fixed seed + a random seed + a regression
  corpus + a pathological corpus (max-weight 0xFFFFFFFF summed, all-zero-weight while live>0,
  single-node). Retrofits M2 SmoothWRR. Wired into `npm run fuzz` and `npm run verify`.
- `test/LeastConn.test.js` (10), `test/SED.test.js` (8), `test/NQ.test.js` (10) -- boundary +
  behaviour suites (exact minimum, weight-0 exclusion, feedback-loop balance, idle-first fan-out,
  never-a-down-index under 200k churned picks).
- Balance anchors (`test/balance.mjs`): LeastConn is greedy-perfect (max-minus-min <= 1, tighter
  than P2C's gap; peak <= P2C's on the same run); SED converges to load proportional-to-weight
  (< 1% drift; weighted-imbalance far below a random foil); NQ fans the first n dispatches out to
  n distinct idle workers.
- Gates extended for all three: torture (retention + 0 B/op `pick()` phases 6-8), PerfGate
  (three `zgcSuite` scenarios + three `mustFail` teeth-checks), witness (`linear` complexity ->
  flat work-rate), benchmark matrix (LeastConn/SED/NQ subjects + a per-pick-allocating
  `lc-array` foil).
- `decisions/0006-leastconn-family.md` -- P2C-is-already-least-conn (no redundant alias), exact-
  O(cap)-scan-first, caller-owned live-read counters (the documented asymmetry with SmoothWRR),
  and the confirmed-but-deferred lite-logn `BinaryHeap` exact-O(log n) peer seam.

### Changed

- Version 0.3.0 -> 0.4.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Folded the invariant-fuzz testing methodology (RESEARCH s3, ROADMAP s3/s0) into an adopted,
  shipped gate: vectors 2 (flap chaos) + 3 (zero-GC soak) were already covered; the net-new
  seeded state-synchronisation fuzzer is now `test/fuzz.mjs`.

## [0.3.0] - 2026-09-23

M3: P2C (power-of-two-choices), the headline strategy -- and the balance-quality anchor
(ROADMAP.md M3).

### Added

- `P2cBalancer extends BalancerBase` -- power-of-two-choices. Draws two DISTINCT eligible
  endpoints uniformly at random (rejection sampling over the shared bitmap -- no peer, no
  owned draw-set) and returns the one with the lower in-flight load; ties to the first draw.
  In-flight counts are the caller's `Uint32Array` (read-only to `pick()`). O(1) per pick,
  0 B/op. Fails closed (`PICK_NONE`) when the whole pool is down. Owns only a seeded,
  deterministic PRNG (reproducible benches).
- The distinct second choice uses a BOUNDED redraw (up to 32 tries), not a single nudge, so
  the two-choices property holds even at tiny pool sizes (~2^-32 collision chance), while
  staying expected-O(1) and 0 B/op.
- `test/P2C.test.js` -- 10 tests: n=2 always-lower-load, determinism by seed, fail-closed,
  single-node, skips-down, a very-sparse-pool fallback path, a never-returns-a-down-index
  proof under 200k churned picks, and an in-suite balance smoke.
- **The balance anchor** (`test/balance.mjs`): the balls-into-bins experiment now proves the
  `ln ln n / ln 2` ceiling -- at n=1024, k=32 balls/bin, P2C peak-to-mean gap ~2 vs a random
  single-draw foil's ~21, and P2C's gap stays ~2-3 as n grows to 4096 while random's grows.
- Gates extended for P2C: torture (retention + 0 B/op `pick()`), PerfGate (`zgcSuite` scenario
  + a `mustFail` teeth-check), witness (`const` complexity -> flat throughput), benchmark
  matrix (P2C subject + a random-draw foil).
- `decisions/0005-p2c-draw.md` -- rejection sampling (no peer, RandomSet deferred), the
  bounded-distinct-redraw enrichment, and caller-owned in-flight counters.

### Changed

- Version 0.2.0 -> 0.3.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Folded lite-o1 v1.11.0's new members into the substrate map (RESEARCH s6, ROADMAP):
  `Reservoir` -> the Subsetting substrate (post-1.0 #4); `EliasFano` -> a viable ring-with-
  vnodes option for M8 ConsistentHash; `RankSelect` noted as static-only (not for the
  mutating eligibility bitmap).

## [0.2.0] - 2026-09-23

M2: SmoothWRR, the weighted default (ROADMAP.md M2).

### Added

- `SmoothWRRBalancer extends BalancerBase` -- nginx-style smooth weighted round-robin
  (`current += weight; pick max; current -= total`). Distributes picks by caller-configured
  integer weights, interleaved SMOOTHLY (weights [5,1,1] -> A,A,B,A,C,A,A), not in the
  bursts of naive weight-expansion WRR. Owns its Float64Array smoothing accumulators; the
  sole writer of the weights via the cold `setWeight(i, w)`. O(cap) per pick, 0 B/op. Fails
  closed (`PICK_NONE`) when the eligible-weight sum is 0 (all down, or all eligible weights 0).
- `setWeight(i, w)` (cold) -- reconfigure a weight, keeping the eligible-weight total exact.
  `setEligible` is overridden to maintain the total and reset the toggled node's accumulator
  (no stale credit across an eligibility epoch).
- `test/SmoothWRR.test.js` -- 12 tests: the documented [5,1,1] sequence, exact fairness over
  k cycles, smoothness (max-run strictly below the bursty foil), skips-down / redistribution,
  fail-closed (all down AND all-zero-weight), setWeight/setEligible invariants + accumulator
  reset, uint32 validation, and a never-returns-a-down-index proof under 200k churned picks.
- Gates extended for SmoothWRR: torture (retention + 0 B/op `pick()`), PerfGate (`zgcSuite`
  scenario at a realistic 256-endpoint pool -- SmoothWRR is O(cap) -- with a `grows` counter
  over all three backing arrays, plus a `mustFail` teeth-check), witness (a per-strategy
  complexity flag: `linear` asserts flat WORK RATE `ops/ms * n`), balance (exact weighted
  fairness + max-run < bursty foil).
- `benchmark/Matrix.mjs` -- SmoothWRR subject + the naive expand-WRR bursty foil.
- `decisions/0004-smoothwrr-weight-ownership.md` -- weight ownership (cold setWeight),
  Float64 accumulators, and the epoch-reset-on-eligibility-transition enrichment.

### Changed

- Version 0.1.0 -> 0.2.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Corrected the SmoothWRR complexity: O(cap) per pick, not "O(1) amortized" (ROADMAP).

## [0.1.0] - 2026-09-23

M1: the first strategy, RoundRobin (ROADMAP.md M1). The M0 harness stubs become real,
strategy-bearing gates.

### Added

- `RoundRobinBalancer extends BalancerBase` -- the baseline strategy. A wrapping cursor
  that forward-scans the shared eligibility view, skipping down nodes, to hand each LIVE
  endpoint an equal share in index order (true round-robin over the live set, not the raw
  index space). Owns only its cursor; O(1) amortized (O(cap) worst case under sparse
  eligibility); 0 B/op on `pick()`; fail-closed `PICK_NONE` when the pool is down.
- `test/RoundRobin.test.js` -- boundary + behaviour suite (11 tests): perfect fairness,
  round-robin order, skips down nodes, fail-closed, single-node, recovery, and a
  never-returns-a-down-index proof under 200k picks of adversarial eligibility churn.
- Gates wired for RoundRobin: `torture.mjs` (retention + 0 B/op `pick()` phase),
  `test/perf/PerfGate.test.mjs` (`zgcSuite` scenario + a `mustFail` teeth-check),
  `test/witness.mjs` (throughput flatness across the pool sweep), `test/balance.mjs`
  (imbalance 1.0000 on all-up, zero dead picks under partial eligibility vs the
  `i++ % n` foil's dead-pick trap).
- `benchmark/Matrix.mjs` -- the SUBJECTS registration point (RoundRobin + the `i++ % n`
  foil), a parity-check throughput slice ahead of the full M6 suite.
- `decisions/0003-roundrobin-bitmap-scan.md` -- the stateless bitmap-scan (Option A) vs
  maintained eligible-set (Option B) fork; A now, B revisited at M3 with the lite-o1 peer.

### Changed

- Version 0.0.1 -> 0.1.0 across `package.json`, `Pick.js` `VERSION`, and `llms.txt`.
- Documented the composition model as OPTIONAL PEER dependencies (`peerDependenciesMeta`,
  the LiteQuery model) -- zero HARD deps, never inlined/forked; kernel runs with zero peers.

## [0.0.1] - 2026-09-22

M0 scaffold: the substrate seams only, no strategy yet (ROADMAP.md M0). This release
establishes the shared machinery every strategy (M1+) will ride and locks the ratified
ownership boundary in place before any `pick()` is written.

### Added

- `Pick.js` single-file ESM kernel with:
  - `VERSION` -- the source-of-truth version stamp (three-place sync with package.json + llms.txt).
  - `PICK_NONE` (-1) -- the fail-closed sentinel: no endpoint is ever a dead pick.
  - `Prng` -- an instance-local, deterministic xorshift32 (`next` / `nextBelow` / `reset`),
    so a strategy can draw on the hot path without `Math.random` and the balance
    benchmark stays reproducible.
  - `BalancerBase` -- the shared eligibility seam: a fixed-capacity pool over a SHARED,
    read-only `Uint8Array` eligibility view (written by `@zakkster/lite-di-health` /
    circuit breakers, read by `pick()`), an O(1) `live` count, `isEligible` / `setEligible`,
    and an abstract `pick()` that throws until a strategy overrides it.
- `Pick.d.ts` -- TypeScript declarations for the substrate surface.
- `llms.txt` -- LLM-oriented API + design summary.
- Test harness: `test/Base.test.js` (substrate boundary suite), `test/torture.mjs`
  (lite-leak retention + lite-gc-profiler 0 B/op on the substrate hot path),
  `test/perf/PerfGate.test.mjs` (lite-perf-gate `zgcSuite` hard gate + a `mustFail`
  teeth-check), `test/witness.mjs` (throughput flatness), `test/balance.mjs` (the
  random-foil baseline the strategy ceilings assert against from M1), and the
  `test/types` tsc surface check.
- `decisions/0001-selection-kernel-boundary.md` -- the five ratified ownership forks.
- `decisions/0002-anti-flapping.md` -- hysteresis/dwell/backoff on routing-state transitions.
- `RESEARCH.md`, `ROADMAP.md`, `README.md`, `LICENSE`.

### Notes

- Zero runtime dependencies. ESM only. `sideEffects: false`. Node >= 18.
- Published metadata points at `PeshoVurtoleta/lite-pick`.
- Next: **M1 RoundRobin** (0.1.0) -- the first strategy, landing the throughput witness
  and the balance gate.

[0.3.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.3.0
[0.2.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.2.0
[0.1.0]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.1.0
[0.0.1]: https://github.com/PeshoVurtoleta/lite-pick/releases/tag/v0.0.1
