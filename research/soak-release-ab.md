# Research: a release-time relative soak A/B (ROADMAP Post-1.0 #8b)

**Status:** ACCEPTED / IMPLEMENTED (benchmark-only; see ADR 0017, 2026-10-06). The design here (R1-R9,
section 8; user decisions, section 10) is built: `benchmark/soak/{ab-analyse,ab-pack,SoakAB,_ab-teeth}.mjs`,
`.github/workflows/soak-ab.yml`, the `SOAK_TIERS` / `SOAK_HOTOPS_N` knobs, and the `soak:ab` / `soak:ab:teeth`
scripts. The kernel, `parity.json` and the release skill are unchanged. ONE parameter is still provisional:
K (=10 to start) is to be FIXED from the first hosted A/A dispatch's measured process-to-process CV via the
section 5.3 power table (user decision 6). Decisions R1-R9 are in section 8; the open questions in section 9
were answered in section 10.
**Question:** `research/soak-baseline.md` (option C, accepted 2026-10-04) put "run the previous release
and the new one INTERLEAVED in one job on the SAME runner, compared per lane with the exact Mann-Whitney
test" on the roadmap as the only trustworthy timing-regression signal on hosted runners. Before building
it: what exactly is "the previous release", how should the two be interleaved, how many runs does the
test need to see a 5% or 10% slowdown, which metrics gate and on what rule, where does it run, how does
it fail closed, and how do we prove it has teeth?

**Short answer:** the idea holds, but three details of the obvious design are wrong for this harness.
(1) The unit of evidence must be a whole PROCESS, not a lane-cycle: cycles inside one Node process share
one JIT and GC history, so treating them as independent samples overstates confidence (Node's own
`compare.js` and its newer scatter analysis use one value per process for exactly this reason). (2) The
two kernels must never share a process: the soak's hot step functions are shared per strategy family, so
loading both kernels into one process doubles the receiver classes at every `pick()` call site and
measures both in an inlining state neither ships in. (3) Strict ABAB order is biased: in our own A/A run on
this machine throughput drifted down (median ~6-8%, up to 20%) over 13 minutes, and with B always second
identical code read slower in 15 of 20 comparisons -- small (0.5% on average), but a bias that more
rounds do not remove (section 4.1). A scratch mutant that slows ONE lane by ~11% without changing any
behavior was caught on that lane (every B process slower than every A process) and on no other (4.2).
The design: K rounds, each round one A process and one B process in a seeded-random order, the CURRENT
harness against both kernels (both loaded from packed tarballs through
the existing `SOAK_KERNEL` / `SOAK_POOL` seams), one median per lane per process, an exact one-sided
Mann-Whitney test per lane, Holm-corrected across the 20 gated comparisons, FAIL only when significant
AND the estimated slowdown is beyond 5%. With K = 10-12 rounds it reliably catches a 10% per-lane
slowdown if the hosted runner's process-to-process noise is <= 4-6%, and a 20% slowdown up to ~8% noise;
5% is out of reach on hosted runners (it is not out of reach on this laptop). Budget: roughly 20-35
minutes on a hosted runner, by hand (`workflow_dispatch`) before `npm publish`.

---

## 1. Concepts, in plain words

New terms only; `research/soak-baseline.md` section 1 covers baseline, noise, CV, effect size,
significance, Mann-Whitney, interleaving and multiple comparisons.

- **A/B test:** run the old code (A) and the new code (B) under identical conditions and compare.
  **A/A test:** the same, with B a byte-identical copy of A. It must come out "no difference" -- it is
  how you measure a method's false-alarm rate.
- **The unit of replication:** the thing you repeat to get independent samples. If you time 10 cycles
  inside one process, you have 10 samples of that process's luck (its JIT decisions, its heap layout,
  its CPU core), not 10 samples of the code. Variation BETWEEN processes is usually larger than
  variation between cycles of one process; a test that counts cycles as independent samples will call
  that between-process luck "significant". (Statisticians call the mistake pseudo-replication.)
- **Interleaving orders:** AABB = all A runs then all B runs (any slow drift of the machine lands on one
  side); ABAB = alternate (drift is shared, but B is always second in each pair); ABBA / randomized =
  alternate AND swap who goes first, so the "second slot" is not always the same side. RMIT --
  Randomized Multiple Interleaved Trials -- is the published name for the randomized version.
- **Power:** the chance a test catches a real effect of a given size. **Minimum detectable effect (MDE):**
  the smallest effect caught with a chosen power (usually 80%). Power grows with the number of runs and
  falls with noise.
- **Tolerance (T) vs resolution (R):** two different numbers. T is the smallest slowdown we would FAIL a
  release for ("anything significantly worse than 5%"). R is the slowdown we can RULE OUT when we say
  PASS ("we are 95% sure no lane got more than 15% slower"). With small samples and noise, R is larger
  than T; between them is "not proven either way".
- **Family-wise error rate (FWER):** the chance of at least one false alarm across ALL the comparisons in
  a run. **Holm-Bonferroni** keeps it at a chosen level (5%) and is never weaker than plain Bonferroni.
  **Benjamini-Hochberg (BH)** instead controls the share of false alarms among the alarms (FDR) -- right
  for discovery, wrong for a gate where one false alarm blocks a release.
- **Hodges-Lehmann estimate:** the effect size that goes with the Mann-Whitney test: the median of all
  A-vs-B pairwise ratios. Its confidence bound comes from the same rank arithmetic, no normality needed.
- **Three-way verdict:** DIFFERENT / SAME / UNKNOWN (Chromium Pinpoint) = FAIL / PASS / INCONCLUSIVE
  here. "Not significant" is not "no regression": PASS must be earned by data precise enough to rule
  out a regression of size R.

## 2. How mature projects do it

1. **Node.js core `benchmark/compare.js`.** Builds a queue `for benchmark, for iter in runs, for binary
   in [old, new]` -- strict ABAB, 30 runs per binary by default, each entry a separate child process,
   optional core pinning (`--set CPUSET=` -> `taskset`). `--analyze` runs Welch's t-test per benchmark
   with stars at p < 0.05 / 0.01 / 0.001, then Holm-adjusts the p-values across the comparison set.
   `--max-regression N` fails only when the Holm-adjusted p < 0.05 AND the 95% confidence interval lies
   entirely beyond -N% ("the point estimate alone cannot fail the command"); a comparison with no stars
   whose interval is wider than N% is printed `(inconclusive)` -- "not evidence of no regression -- the
   samples are too noisy to tell". The newer scatter analysis "reduces aggregated configurations to one
   value per outer process and uses disjoint process sets for consecutive Mann-Whitney comparisons so
   configurations sharing a process are not treated as independent samples."
   [compare.js](https://github.com/nodejs/node/blob/main/benchmark/compare.js),
   [docs](https://github.com/nodejs/node/blob/main/doc/contributing/writing-and-running-benchmarks.md),
   [compare.R](https://github.com/nodejs/node/blob/main/benchmark/compare.R)
2. **Node.js `node:bench` (v26.9, experimental).** Deliberately has no pass/fail: comparison policy is left
   to tools, which should "retain the raw sample rates", check the environments are comparable, choose
   paired vs independent analysis to match the design, and "consider effect sizes, uncertainty, and
   correction when testing multiple benchmarks". [node:bench](https://nodejs.org/api/bench.html)
3. **Go benchstat.** "Run at least 10 times", "interleave before and after runs, rather than running ...
   10 iterations of the before benchmark, and then 10 iterations of the after"; median + 95% interval,
   two-sided Mann-Whitney U at alpha 0.05, no multiple-comparison correction (the docs warn ~5% of
   comparisons will flag by chance). When a comparison cannot reach alpha with the sample size it says
   so: "need >= N samples to detect a difference at alpha level". [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat),
   [anone.go](https://github.com/golang/perf/blob/master/benchmath/anone.go)
4. **Chromium Pinpoint** (A/B "try jobs" and bisects on dedicated devices). Takes the smaller p of a
   Mann-Whitney U and a Kolmogorov-Smirnov test ("MWU is bad at detecting changes in variance, and K-S
   is bad with discrete distributions"); DIFFERENT if p <= 0.01, SAME if p is above a "high threshold"
   that depends on the sample size and on the effect size looked for (in units of the IQR), UNKNOWN in
   between -> collect more repeats. "As the sample sizes increase, the high threshold decreases until it
   crosses the low threshold. This way, there's a limit on the number of repeats."
   [compare.py](https://chromium.googlesource.com/catapult/+/HEAD/dashboard/dashboard/pinpoint/models/compare/compare.py),
   [thresholds.py](https://chromium.googlesource.com/catapult/+/HEAD/dashboard/dashboard/pinpoint/models/compare/thresholds.py)
5. **Bencher "relative continuous benchmarking".** Check out base and head in the same CI job, run both,
   compare with a percentage threshold (their example: 25%); recommended "when dealing with noisy CI/CD
   environments"; it "doubles runtime". Sequential (AABB), one run each -- the simplest form of the idea.
   [Bencher docs](https://bencher.dev/docs/how-to/track-benchmarks/)
6. **criterion.rs.** Bootstrap + t-test against the saved baseline, significance 0.05, AND a noise
   threshold (default 1%): a significant change inside +/-1% is reported as "within noise threshold".
   Both conditions, like LKP and Perfherder in the previous note. [criterion analysis](https://bheisler.github.io/criterion.rs/book/analysis.html)
7. **hyperfine.** Warm-up runs, run counts, outlier warnings, "N +/- e times faster" -- but commands run in
   blocks; interleaved execution has been an open request since 2018
   ([#21](https://github.com/sharkdp/hyperfine/issues/21)). [hyperfine](https://github.com/sharkdp/hyperfine)

## 3. What the research says

1. **Replicate at the level that varies.** Kalibera & Jones show benchmark variation sits at several levels
   (iterations inside a VM run, VM runs, builds) and that repetitions should be spent at the level with
   the most variance per unit cost; counting in-process iterations as independent samples gives
   confidence intervals that are too narrow. [Rigorous Benchmarking in Reasonable Time, ISMM 2013](https://kar.kent.ac.uk/33611/)
   Barrett et al. found JIT VMs often never reach a steady state, and whether they do differs from one
   process execution to the next (at most 43.5% of VM/benchmark pairs consistently warmed up across
   machines). [Virtual Machine Warmup Blows Hot and Cold, OOPSLA 2017](https://arxiv.org/abs/1602.00602)
2. **Interleave AND randomize.** Abedi & Brecht replayed EC2 performance traces through common
   methodologies: they reported two IDENTICAL systems as differing by 38% at 95% confidence; Randomized
   Multiple Interleaved Trials gave repeatable results.
   [ICPE 2017](https://research.spec.org/icpe_proceedings/2017/proceedings/p287.pdf)
   Laaber, Scheuner & Leitner: on cloud instances, A and B on the SAME instance in randomized order
   detect slowdowns of <= 10% reliably. [EMSE 2019](https://research.chalmers.se/en/publication/511491)
3. **Invisible setup differences bias results.** Mytkowicz et al.: changing only the size of the UNIX
   environment or the link order changed measured performance enough to flip conclusions. For us: the two
   sides' environment strings and file paths should have identical lengths, and the only difference
   between an A process and a B process should be which directory the kernel is loaded from.
   [Producing Wrong Data Without Doing Anything Obviously Wrong!, ASPLOS 2009](https://users.cs.northwestern.edu/~robby/courses/322-2013-spring/mytkowicz-wrong-data.pdf)
4. **Duet benchmarking.** Bulej et al. run A and B AT THE SAME TIME on the same cloud VM (two cores), so
   interference hits both; accuracy improved 2.3-12.5x for JVM workloads and far more for SPEC CPU. It
   needs two quiet cores per pair and synchronized iterations; it is an upgrade path, not a first step
   (section 7, option D). [Duet Benchmarking, ICPE 2020](https://arxiv.org/abs/2001.05811)
5. **Hosted runners.** From `research/soak-baseline.md` section 3: fresh VM per job, CPU model can change
   between jobs (CodSpeed: AMD EPYC 7763 9/10, Intel Xeon 8370C 1/10), smallest detectable change 4.41%
   vs 1.94% on bare metal (Reichelt et al. 2024). Current specs: public repositories 4 vCPU / 16 GB,
   private 2 vCPU / 8 GB; each job may run up to 6 hours.
   [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
   [limits](https://docs.github.com/en/actions/reference/limits)
6. **Multiple comparisons.** Holm's step-down procedure controls FWER and is uniformly more powerful than
   Bonferroni [(Holm 1979)](https://en.wikipedia.org/wiki/Holm%E2%80%93Bonferroni_method); BH controls the
   false discovery rate [(Benjamini-Hochberg 1995)](https://en.wikipedia.org/wiki/False_discovery_rate).
   With ONE lane regressed among 20 both start at the same threshold (alpha / 20), so for the common
   case they have the same power; BH only helps when many lanes move together, which a release gate does
   not need (a global slowdown fails on its strongest lane anyway).

## 4. Our own measurements (this machine, Apple M4 Pro, Node 26.8.2, 2026-10-06)

### 4.1 An A/A run, ABAB, one kernel per process
Setup: two byte-identical copies of HEAD 5319105's `Pick.js` (sha256 b07731bb..., the same bytes as the
1.1.0 release commit) and `Pool.js` in sibling scratch directories, loaded
through `SOAK_KERNEL` / `SOAK_POOL`; 10 rounds of strict ABAB = 20 processes, each a smoke soak (full
24-lane roster, 1 warm-up + 2 measured cycles, default seed), ~39 s each, ~13 minutes in all. Per
process, per kernel lane: the median of its 2 measured cycles. The machine was not otherwise idle (an
editor, and some of this note's simulations ran on other cores part of the time) -- a fair stand-in for
a shared runner.

| | hotOps dense (10 lanes) | hotOps sparse (10 lanes) |
|---|---|---|
| between-process CV of the per-process medians | 1.8-4.9% | 2.2-7.6% |
| the same after removing a straight-line trend | 1.3-3.3% | 1.2-4.5% |
| drift, first process to last (fitted trend) | -1.6% to -13.8% (median ~ -6%) | -5.4% to -19.9% (median ~ -8%) |
| B/A ratio of medians (identical code) | 0.983-1.003 | 0.973-1.008 |
| smallest one-sided Mann-Whitney p, 10 vs 10 | 0.12 | 0.20 |

Findings:
1. **No false alarm.** No comparison came near 0.0025 (Holm's first step for 20): the method behaved.
2. **The machine drifts.** Every lane slowed over the session; the trend explains a third to a half of the
   between-process spread. In AABB order this drift alone would have read as a 5-15% "regression" (the
   simulation in 5.3 turns that into a 94-100% false-FAIL rate).
3. **ABAB leaks a little of it.** B was always second in its pair: in 15 of the 20 comparisons the second
   process read slower than the first, by -0.5% on average (up to -2.5%). Small against today's noise, but
   a bias, not noise -- it does not average away with more rounds. Randomizing (or ABBA-alternating) who
   goes first turns it back into noise.
4. **Cycles inside one process are not interchangeable.** The measured cycles move SYSTEMATICALLY, the same
   way in all 20 processes: P2C's cycle 2 reads 14% below its cycle 1 (range 0.81-0.88x), NQ's 19% above
   (1.17-1.21x), BoundedLoad -11%, PeakEWMA -9%. RoundRobin's measured cycles run at 0.43x its warm-up
   cycle: in cycle 0 RoundRobin is the first lane, so the shared `hotPlain` step has seen one balancer
   class and V8 can inline it; by cycle 1 it has seen three. Two consequences: a cycle is not an
   independent sample of "the code" (it is a sample of that process's cycle-index and JIT state), and both
   sides must run exactly the same cycles, lanes, order and seeds so these effects cancel.
5. **The noise level is laptop-low.** With drift handled, process-to-process CV here is ~1-3% dense and
   ~1-4.5% sparse (ConsistentHash and RoundRobin sparse are the worst). By the 5.3 table that resolves roughly
   5% at K = 10-12 locally; a hosted runner is expected to be 2-3x noisier (3.5).
6. **Latency p99 does not discriminate.** RoundRobin and ConsistentHash p99 were identical in all 20
   processes (one tick); WeightedRandom's flipped between ticks (CV 21%).

### 4.2 A known slowdown (scratch mutant), ABBA
Setup: A = the 4.1 kernel; B = the same `Pick.js` with one change in `SmoothWRRBalancer.pick()`: on every 8th call, an extra
READ-ONLY pass over the eligibility / weight / current arrays (same loop, no writes, result stored in a
module variable) -- so picks, state and every quality/invariant check are unchanged, only time is added.
8 rounds in ABBA order, lanes SmoothWRR, RoundRobin, P2C (plus their tiny lanes), smoke shape, ~11 s per
process, ~3 minutes in all. Scratch files only; nothing in the repo was touched.

| lane x metric | estimated slowdown (Hodges-Lehmann) | one-sided p, 8 vs 8 | verdict under 5.4 |
|---|---|---|---|
| SmoothWRR dense | 11.0% | 7.8e-5 (complete separation, the smallest possible) | FAIL (Holm over 6 or 20: < 0.002) |
| SmoothWRR sparse | 11.8% | 7.8e-5 | FAIL |
| RoundRobin dense / sparse | 0.0% / 1.9% | 0.60 / 0.22 | PASS |
| P2C dense / sparse | -0.1% / 0.1% | 0.64 / 0.36 | PASS |

Findings:
1. **The method sees an ~11% slowdown on the lane that has it and nothing on the lanes that do not.**
   Every mutant process also exited 0 from its own soak (the extra pass changes no behavior), so only a
   RELATIVE test could have caught it.
2. **Every B process was slower than every A process** -- the strongest result 8 vs 8 can give. On this
   machine, at this noise, 11% is far above the floor; the hosted-runner question is how much of that
   margin survives 2-3x more noise (section 5.3).
3. **p99 saw it louder than throughput.** SmoothWRR's p99 went up by about one timer tick (B/A 1.9x): one
   pick in 8 is now about twice as slow, so the 99th percentile lands on a slow pick. A tail-shaped
   regression is exactly what a percentile catches and a mean hides; but a one-tick quantity cannot say
   whether a change is 10% or 90% (open question 8).

### 4.3 What the existing streams already say
- **latencyP99 is quantized.** On this machine the timer tick is ~42 ns; the 2026-10-05 stream's per-cycle
  p99 for the kernel lanes reads 42, 82, 125, 166, 206 ... ns -- one to a dozen ticks. RoundRobin and
  ConsistentHash read exactly 42 in every cycle (CV 0%), WeightedRandom flips between 42 and 82 (CV 35%).
  A 5-10% change in a 1-5 tick quantity is invisible until it crosses a tick boundary, and then it looks
  like +100%. The soak's own drift gate already needs a 2-tick floor for the same reason (`LAT_ADD_TICKS`).
- **Tiny lanes are noisy.** Same stream: tiny-lane dense throughput CV 2-42% between cycles (WeightedRandom
  `#tiny` 42%, sparse 102%), which is why `gates.mjs` already makes their throughput report-only.
- **A lane-cycle is ~0.5-1.0 s here.** Kernel lanes 0.47-1.0 s, tiny lanes ~0.4-0.6 s, pool lanes ~0.08 s.
  A 3-cycle (smoke) process of the full 24-lane roster took 38-40 s; its 10 kernel lanes ~20 s of that.

## 5. Answers for this repo

### 5.1 What "the previous release" is, and how to get it

- **Definition.** The newest version on the npm registry that is lower than the version being released
  (today: `1.1.0`, the `latest` dist-tag). Not a git tag: this repo has none (`git tag` is empty), and the
  release skill ends before publish/tag ("Do not publish, do not push, do not tag"). Not a release commit
  either: what users install is the tarball, and a publish from a working tree can differ from any commit.
- **A side.** `npm pack @zakkster/lite-pick@<prev>` into a scratch directory and unpack it: `npm pack`
  checks the tarball against the registry's recorded `dist.integrity` (sha512), so the bytes are the
  published bytes. Record `<prev>`, the integrity string and the sha256 of `package/Pick.js` and
  `package/Pool.js`. Assert the unpacked `Pick.js` exports `VERSION === <prev>`. (Informational: print
  whether that sha256 equals `git show <release commit>:Pick.js` -- for 1.1.0 vs HEAD 5319105 it would,
  since the committed `Pick.js` has not changed since 2a08567; `Pool.js` has, in 233de4b.)
- **B side.** `npm pack` of the release candidate (exactly what `npm publish` would upload), unpacked the
  same way. Assert its `Pick.js` / `Pool.js` sha256 equal `benchmark/soak/parity.json` (so B IS the
  pinned shipped code) and its `VERSION` equals `package.json`. Loading B from its own unpacked tarball,
  not from the repo root, keeps the two sides symmetric: same kind of path, same path length
  (`ab/A/package/Pick.js` vs `ab/B/package/Pick.js`), same seam.
- **The harness is the CURRENT one, for both sides.** Every process runs `benchmark/soak/main.mjs` from
  the release-candidate tree with `SOAK_KERNEL=<side>/package/Pick.js SOAK_POOL=<side>/package/Pool.js`.
  The seams exist for the teeth battery and already do the right thing: `kernel.mjs` imports the roster,
  `Prng`, `PICK_NONE`, `CH_PROBE_LIMIT` and `VERSION` from the override; the unpacked `Pool.js` resolves
  `./Pick.js` to its OWN side's kernel; the header records `pickSha256`, `poolSha256`,
  `kernelOverride`/`poolOverride` and the in-tree parity result, so every stream says what it ran.
  Consequences to design for:
  - `soak:report` refuses an overridden stream ("NOT A RELEASE SOAK") unless `--allow-override`. The A/B
    analyser must not reuse that refusal; it checks the hashes against the two recorded tarballs instead.
  - **Compatibility.** The harness reaches past the public API: `setWeights()` (added in 1.1.0 B1 -- the
    1.0.0 revert control already needs a shim for it), and private fields read by the lanes, oracles and
    invariant checker (`_current`, `_totalEligibleWeight`, `_ewma`, `_stamp`, `_live`, `_lookup`, `_m`,
    `_eps`, `_tau`, `_total`). If release N+1 adds an API the harness starts using, or renames an
    internal, the A side cannot run the current harness. That must be INCONCLUSIVE ("baseline not
    comparable under this harness"), never a FAIL of the release and never a silent PASS. Each A and B
    process must therefore exit with its own soak verdict PASS; an A process that FAILs or crashes makes
    the whole A/B INCONCLUSIVE (it is either a harness-compat problem or a real bug in the old release --
    both mean it is no baseline), a B process that FAILs is a FAIL (the candidate failed the soak).
  - **Batch length.** Each process calibrates each lane's hotOps batch ONCE, in its warm-up cycle, to the
    smallest power of two taking >= 25 ms. A 10%-slower B can land on the other side of a power of two and
    time twice the batch. Ops/s is meant to be length-independent above 25 ms, but this is a confound the
    A/B should remove: require equal `hotOpsDenseN` / `hotOpsSparseN` per lane across all processes, or
    pin them (a new knob that sets the lengths from the first A process). A mismatch is INCONCLUSIVE.
  - **Identical code -> skip or control.** If A and B have the same `Pick.js` sha256, the kernel lanes
    are an A/A by construction. The run is still worth doing as a free A/A control (section 5.6), but its
    verdict says "kernel unchanged".

### 5.2 Interleaving: granularity, order, warm-up and isolation

- **One kernel per process, never both in one.** The timed step functions (`hotPlain`, `hotLoad`,
  `hotLatency`, `hotKeyed` in `hot.mjs`) are shared by every lane of a family: `hotLoad` already calls
  `pick()` on four balancer classes (P2C, LeastConn, SED, NQ). V8 keeps a call site polymorphic up to four
  receiver shapes and megamorphic above; loading a second kernel puts eight classes there. Both kernels
  would be measured in an inlining state neither ships in, and whichever ran first would shape the code
  the other runs. Per-lane-cycle alternation inside one process is therefore rejected.
- **Separate processes alternate, in seeded-random order within each round.** K rounds; each round runs
  one A process and one B process; who goes first is drawn from a seeded PRNG (or fixed ABBA: round r
  starts with A when r is even). The seed is printed and recorded so the schedule is reproducible.
  Section 4.1 shows why strict ABAB is not enough: with the machine drifting slower, the second process
  of every pair reads slow.
- **What a process runs.** The unchanged soak, the default lane roster minus the pool lanes (their time
  is simulated, there is nothing to time), with ONE fixed `SOAK_SEED` for every process of the run
  (recorded). Section 4.1 finding 4 shows the measured cycles move systematically by cycle index (seeds
  are per lane x cycle, and JIT state evolves as lanes run); a different seed per round would add that
  movement as noise to an unpaired test. The A/B asks "same workload, which kernel is faster", not "over
  many workloads", so the workload is held fixed. The lane roster and order must be identical on both
  sides for the same reason (the shared step functions' polymorphism depends on which lanes ran before).
  The soak's existing structure gives each process a warm-up cycle (calibration,
  JIT tier-up, excluded from every gate) and then measured cycles. Today `SOAK_SMOKE=1` is the only way
  to run fewer than 11 cycles (1 warm-up + 2 measured); a non-smoke run below 11 is INCONCLUSIVE by
  design (S5). The A/B needs a mode that says "short, judged elsewhere" without pretending to be a smoke
  test -- an implementation detail for later.
- **Summary per process:** for each kernel lane and gated metric, the MEDIAN over that process's measured
  cycles. That one number is the sample. Cycles are never pooled across processes.
- **Pinned flags and the once-per-process warm bias.** Both sides run with the same execArgv
  (`--expose-gc --min-semi-space-size=4 --max-semi-space-size=4`, asserted by `assertPinnedFlags`), so the
  GC regime is identical. The B/op warm bias is measured once per process (ADR 0014, 2026-10-05: an
  inflated bias over-subtracts for the whole process); that is one more reason the process, not the
  cycle, is the unit -- and a reason NOT to A/B the B/op number at all (5.4).
- **Machine sanity.** Every process's header records `os.cpuModel`, `cpuCount`, `node`, `v8`, `execArgv`
  and `timerFloorNs`; all 2K headers must agree, else INCONCLUSIVE (the job moved to a different CPU
  model mid-way would be news, but a mixed-version toolchain is the realistic failure). Core pinning
  (`taskset`, as Node's `compare.js` offers) is optional on Linux and unavailable on macOS; worth trying
  on the runner once, not a requirement.

### 5.3 How many runs, and the multiple-comparison correction

- **The family:** 10 kernel lanes x {hotOps dense, hotOps sparse} = **20 gated comparisons** (5.4 says why
  not more). Holm at family alpha 0.05: the strongest comparison must reach p < 0.05/20 = 0.0025.
- **The floor from exactness.** With K processes per side, the smallest one-sided p the exact
  Mann-Whitney test can produce is 1 / C(2K, K): K=5 -> 0.0040 (can NEVER pass 0.0025: the soak's own
  5-vs-5 window would be powerless here), K=6 -> 0.0011, K=8 -> 7.8e-5, K=10 -> 5.4e-6, K=12 -> 3.7e-7.
  So K >= 6 is a hard minimum and K >= 8 leaves room.
- **Power** (simulated, 4000 trials each, through `gates.mjs` `mwOneSidedP`; one lane slowed, the
  others unchanged; noise = process-to-process CV of the per-process median; per-test alpha 0.0025):

  | K per side | CV 2% | CV 4% | CV 6% | CV 8% | CV 12% |
  |---|---|---|---|---|---|
  | 6, slowdown 10% | 1.00 | 0.72 | 0.30 | 0.14 | 0.05 |
  | 8, slowdown 10% | 1.00 | 0.93 | 0.54 | 0.28 | 0.09 |
  | 10, slowdown 10% | 1.00 | 0.98 | 0.71 | 0.38 | 0.12 |
  | 12, slowdown 10% | 1.00 | 1.00 | 0.85 | 0.49 | 0.17 |
  | 10, slowdown 5% | 0.98 | 0.35 | 0.11 | 0.06 | 0.02 |
  | 12, slowdown 5% | 1.00 | 0.47 | 0.16 | 0.08 | 0.03 |
  | 10, slowdown 20% | 1.00 | 1.00 | 1.00 | 0.99 | 0.74 |

  Reading: a 5% per-lane slowdown is caught reliably only at ~2% process noise -- this laptop's level
  (section 4), not a hosted runner's. 10% needs <= 4-6% noise at K = 10-12. 20% is caught almost always.
  The honest promise on hosted runners is therefore "a lane that got >= ~10-15% slower", with 5% as the
  tolerance below which we do not even want to FAIL.
- **False alarms.** Same simulation, A/A, 20 lanes: the family-wise false-FAIL rate was 1.1-1.3% with
  interleaving (below the nominal 5% because the exact test is discrete and conservative). With AABB order
  and a 10% linear drift over the job it was 94-100% -- every run would "find" a regression.
- **Duration.** Cost per process = startup + warm-up cycle + measured cycles. Extra cycles inside a
  process do not buy independent evidence (4.1 finding 4: they move with the cycle index, identically in
  every process); extra processes do. Start with 2 measured cycles per process (what the smoke shape
  already gives) and K = 10; measure the hosted runner's real CV in the first A/A dispatches, then fix K
  from the table above (decision R4).
- **Why not a paired test?** The rounds are natural pairs, and a paired signed-rank test would cancel
  drift exactly. But its smallest one-sided p with K pairs is 1/2^K: K=10 -> 0.00098, so it needs K >= 9
  just to be able to pass 0.0025, and it loses its advantage once the order is randomized (drift is then
  noise, not bias). Keep the unpaired Mann-Whitney the soak already has (`mwOneSidedP`, exact, ties
  counted half and rounded conservatively); print the paired sign count as information.

### 5.4 Which metrics gate, and the decision rule

| metric | in the A/B | why |
|---|---|---|
| hotOps dense, 10 kernel lanes | **gate** | the throughput number the soak is built around; CV 1.8-4.9% between processes here (1.3-3.3% without the drift) |
| hotOps sparse, 10 kernel lanes | **gate** | the fallback-scan / probe tail (where a 1.x kernel change is likeliest to cost); CV 2.2-7.6% between processes here, ConsistentHash worst (21% between cycles in the 10-05 stream), so expect this half to be the INCONCLUSIVE source |
| latencyP99, kernel lanes | report-only (open question 8) | quantized to 1-12 timer ticks (4.3): cannot resolve 5-10%; a change shows as whole ticks -- but it caught the 4.2 mutant's tail at 1.9x |
| tiny lanes (cap 1-3) | report-only | the soak already makes their throughput report-only (CV up to 42%) |
| pool lanes | not measured | simulated time (S9); Pool.run cost is `test:perf:pool`'s job |
| hotAlloc | each side's own soak gate | already ABSOLUTE (0.3 B/op FAIL tier) and owned per-op by PerfGate; a relative test of ~0 vs ~0 has no meaning |
| heap / rss / gcMajor | each side's own soak gate | absolute and machine-independent; the nightly diffs heap against the baseline |
| gcPause / rebuild | report-only | report-only in the soak itself (ADR 0014, 9c3) |

Decision rule per gated comparison (lane x metric), with the estimated slowdown s = Hodges-Lehmann
estimate of 1 - B/A (the median of all K x K pairwise ratios), Holm-adjusted one-sided p, tolerance
T = 5%, resolution R = 15% (both one-line constants, recorded in the output):

- **FAIL:** Holm-adjusted p < 0.05 **and** s > T. (Significant AND material, as criterion.rs, LKP and
  Perfherder require.) Node's stricter variant -- the whole 95% interval beyond -T -- was considered and
  simulated (K = 10): it costs ~10 points of power at a 10% slowdown (0.98 -> 0.89 at CV 4%, 0.68 -> 0.58
  at CV 6%) and can never catch a slowdown of exactly T more than half the time. Holm already keeps a
  noisy lane from failing on a lucky point estimate, which was Node's reason for it. Either is
  defensible; the looser rule is the one that matches the soak's own drift gates (bound AND p).
- **PASS:** not FAIL, and the one-sided 95% upper confidence bound of s is < R ("this lane did not get
  more than 15% slower").
- **INCONCLUSIVE:** neither -- the data cannot rule out a regression of size R (Node's "(inconclusive)",
  Pinpoint's UNKNOWN). Simulated per comparison at K = 10, R = 15%: an A/A comparison is inconclusive
  0% / 0% / 1% of the time at CV 4 / 6 / 8%; with R = 10% it is 0% / 2% / 13% -- across 20 comparisons
  that would make a third of clean runs INCONCLUSIVE at 6% noise, which is why R starts at 15%.
- **Improvements** never fail; they are printed.
- **Run verdict:** FAIL if any comparison FAILs (or any B process failed its own soak); else
  INCONCLUSIVE if any comparison is INCONCLUSIVE or any precondition failed (A process not PASS, hash or
  version mismatch, header disagreement, batch-length mismatch, fewer than K valid rounds, interrupted);
  else PASS. Exit codes as the soak: 0 / 1 / 3 (2 for bad configuration).
- **Intentional slowdowns.** 1.1.0 B2 made LeastConn ties rotate at +5-8% and SED +2-7%, on purpose. A
  release that knowingly trades speed for behavior needs a way through that is not "ignore the gate": a
  committed acceptance file (e.g. `benchmark/soak/ab-accept.json`: version, lane, metric, accepted
  slowdown bound, reason) -- the same deliberate-acknowledgment pattern as `npm run parity:update`. The
  gate then FAILs only if the measured slowdown's lower confidence bound exceeds the accepted bound.
  Entries are valid for one version only.

### 5.5 Where it runs, the time budget, and failing closed

- **There is no release workflow today.** CI runs on push/PR; the nightly runs the burn-in, teeth and
  heartbeat; publishing is a manual `npm publish` after the release skill's local gate. So "release-time"
  has to be defined.
- **Recommended: a `workflow_dispatch` workflow** (`soak-ab.yml`) with inputs `prev` (default: the
  registry's `latest`) and `rounds` (default K), run by hand on the release-candidate commit before
  `npm publish`. One job, ubuntu-latest, Node pinned to the same version as the nightly (22.x), parity
  first, then pack A and B, then the K rounds, then the analysis; always uploads every stream plus the
  analysis as an artifact. The release checklist records the run URL. A hosted runner is not quieter than
  the laptop, but it is a known, fresh, otherwise idle machine whose evidence anyone can open.
- **Local mode, same script.** `npm run soak:ab -- --prev 1.1.0` on the dev machine gives a sharper result
  (4.1: ~1-3% noise once drift is handled) and is what you would use to investigate a FAIL. Not the
  release evidence by default: a laptop under the user's own load is not reproducible by anyone else.
- **Budget (estimate, to be measured in the first dispatch).** On this M4 Pro a 3-cycle process of the 10
  kernel lanes takes ~20 s (~37 s with the tiny lanes). Assume a hosted EPYC vCPU is 2-3x slower for this
  code: ~45-65 s per kernel-lane process, ~80-110 s with tiny lanes. K = 10 rounds = 20 processes ->
  ~15-22 min kernel-only, ~27-37 min with tiny lanes; plus ~3 min for install, pack and analysis. A
  `timeout-minutes: 60` leaves headroom; the 6-hour job limit is far away. On a 2-vCPU (private) runner
  the processes are single-threaded but GC helper threads compete; expect the slower end.
- **Fail closed.** A timeout, a crash, a missing stream, an A process that is not PASS, mismatched
  hashes/versions/headers, a calibration-length mismatch: all INCONCLUSIVE (exit 3), never PASS. The
  workflow fails on any non-zero exit, so INCONCLUSIVE blocks the release until it is understood -- same
  rule as the soak. A FAIL may be investigated locally; a re-run is allowed but both runs are kept and
  reported (re-running until green is the classic way to turn a 5% false-alarm rate into a 0% detection
  rate). Pre-register the policy: one re-run with 2K rounds, its verdict final.

### 5.6 Must-fail controls (teeth)

Same principle as `soak:teeth`: every control drives the REAL A/B driver end to end, never the analysis
module alone.

- **AB-AA (must PASS, measures the false-alarm rate).** B = a byte-identical copy of A in a sibling
  directory of equal path length. Acceptance: N independent dispatches (e.g. 10 parallel jobs = 10
  different VMs, ~25 minutes of wall time), zero FAILs expected (simulated family rate ~1%; a single FAIL
  in 10 is plausible at the nominal 5% and is investigated, not hidden). Also tally INCONCLUSIVE: if it is
  above ~10%, raise K or R before trusting the gate.
- **AB-SLOW (must FAIL).** B = a scratch kernel with a known, side-effect-free extra cost on ONE lane --
  as in section 4.2, an extra read-only scan of SmoothWRR's arrays on every 8th pick (output and state
  unchanged, so every quality/invariant check still passes). Two sizes: a gross one (~20-25%: must FAIL
  in every run) and a threshold one (~10%: must FAIL in at least ~80% of runs at the chosen K, measured).
  The lanes the mutant does not touch must PASS (no collateral FAILs).
- **AB-SPARSE (must FAIL hotOpsSparse only).** Extra cost only on the fallback-scan path (taken when most
  nodes are down) -> the sparse comparison FAILs, the dense one does not. Mirrors the soak's MT2 control.
- **AB-FAST (must PASS).** B faster than A (an A that carries the extra cost): improvements never fail.
- **AB-COMPAT (must be INCONCLUSIVE).** An A kernel without `setWeights` (the 1.0.0 kernel unshimmed):
  the A processes fail -> INCONCLUSIVE, not FAIL, not PASS.
- **AB-ORDER (must PASS).** The AB-AA control with a forced strict ABAB order on a deliberately drifting
  machine is the demonstration that randomized order matters -- informational, kept as a recorded
  experiment rather than a CI control (drift cannot be produced on demand).
- **Analyser-only controls** (fast, in `npm test`): tampered/truncated streams, mixed CPU models, a hash
  that does not match the declared tarball, an acceptance-file entry for another version -> each
  INCONCLUSIVE or exit 1, like the S12 report controls.

### 5.7 Risks, and what it does NOT catch

What it does not catch:
- **Regressions below its resolution.** On hosted runners, realistically < ~10% per lane. A 3% slowdown
  passes. (The nightly's report-only notes and, later, #8c's history window are the only other eyes.)
- **Code the timed segments do not run.** hotOps times one step per family: `pick()` (plus `recordRtt`,
  `note` and the harness's own queue work) on a dense and a ~95%-down pool. Not timed: constructors,
  `rebuild()` / `setWeights()` (ConsistentHash/BoundedLoad table builds), `describe()`, the stats slab,
  everything in `Pool.js` (`Pool.run` cost is gated in bytes by `test:perf:pool`, in time nowhere).
- **Diluted effects.** The timed step includes harness work (event-queue pop/push, in-flight counters), so
  a 10% slower `pick()` shows as less than 10% on lanes where the pick is a small share of the step
  (RoundRobin's pick is a few ns). The A/B reports slowdowns of the STEP, not of the kernel call.
- **Other platforms.** One OS, one CPU vendor (whatever the runner draws), one Node major. A regression
  that only shows on Node 24/26, ARM, or under `--max-inlined-bytecode-size=0` is not seen. (A Node
  upgrade is held constant on purpose -- the A/B never blames the kernel for a V8 change.)
- **Cold start and warm-up behavior** (the warm-up cycle is excluded), **long-run drift** (the nightly's
  job), **allocation** (PerfGate and the soak's absolute gates), **behavior** (the soak's quality gates).
- **Inlining in the user's program.** The soak's call sites are polymorphic across lanes; a user's
  single-strategy call site is monomorphic and may inline differently. `bench` / PerfGate measure that.

Risks of building it:
- **Noise on the day.** A busy runner widens the confidence bounds -> INCONCLUSIVE more often. That is the
  design working (no false PASS), but a gate that is often INCONCLUSIVE gets bypassed. Mitigation: the A/A
  acceptance numbers before relying on it; R and K tuned from them.
- **Re-run-until-green and rubber-stamped acceptances.** Both turn the gate into theatre. Mitigation: the
  pre-registered one-re-run policy; acceptance entries are per version, in the diff, with a reason.
- **Harness/kernel coupling.** The private-field reads mean an internal refactor in release N+1 makes the
  A/B INCONCLUSIVE for that release (or needs a shim like REVERT_SHIM). Expected to be rare; when it
  happens it is visible, not silent.
- **A larger CI surface.** One more workflow, an analyser, an acceptance file, ~6 controls. Smaller than
  the soak itself but not free.
- **Registry dependence.** The A side needs the npm registry at run time; an outage is INCONCLUSIVE.

## 6. The design in one picture

```
pack A (npm, integrity-checked)  pack B (npm pack of the candidate; sha256 == parity.json)
            \                                   /
             round r = 1..K, order = PRNG(orderSeed) -> [A,B] or [B,A]
             each: node --expose-gc --min/max-semi-space-size=4 main.mjs  (CURRENT harness)
                   SOAK_KERNEL/SOAK_POOL = <side>/package/{Pick,Pool}.js, one SOAK_SEED for all
                   own verdict must be PASS (A: else INCONCLUSIVE; B: else FAIL)
                                   |
             per process, per kernel lane: median hotOps dense / sparse over measured cycles
                                   |
             per lane x metric (20): exact one-sided Mann-Whitney (K vs K), Holm across 20,
             Hodges-Lehmann slowdown + 95% upper bound
                                   |
             FAIL: p_holm < 0.05 AND slowdown > 5%  |  PASS: upper bound < 15%  |  else INCONCLUSIVE
```

## 7. The options

| | what | catches (hosted) | cost / risk |
|---|---|---|---|
| A | **Local-only** `soak:ab` script, run by hand before `npm publish` | 5% on this laptop at 2% noise, if the machine is otherwise idle | cheapest; evidence lives on one laptop, not reproducible; laptop drift (4.1) |
| B | **`workflow_dispatch` job** on a hosted runner, process-level interleaved A/B as in section 6; the same script runs locally | ~10-15% per lane at K = 10-12 | ~20-35 min per release; one workflow + analyser + controls |
| C | B, plus **automatic trigger** (e.g. on a `v*` tag push, or a `release-candidate` branch) | same | needs a tagging/branch convention the release flow does not have; a tag pushed after publish is too late to gate |
| D | B with **duet execution**: A and B processes run at the same time on two cores of the 4-vCPU runner, cycle-synchronized | literature: 2-12x tighter for JIT workloads -> maybe 5% | synchronization code in the harness; GC helper threads of two processes share 4 vCPUs; unproven here |
| E | **In-process** alternation (both kernels loaded, lane-cycles alternate) | -- | rejected: megamorphic call sites, order-dependent JIT state, cycles are not independent (5.2) |

## 8. Recommendation

- **R1 -- option B**, with the same script usable locally (option A) for investigation; C and D later and
  only with evidence. Release-time only, by hand, before `npm publish`; the run URL goes in the release
  notes.
- **R2 -- previous release = the registry tarball** (`npm pack @zakkster/lite-pick@<prev>`, integrity
  checked); the candidate = `npm pack` of the tree, hash-checked against `parity.json`. Both loaded through
  `SOAK_KERNEL` / `SOAK_POOL` from equal-length sibling paths; the CURRENT harness for both.
- **R3 -- one kernel per process; K rounds, seeded-random order within each round; one fixed workload
  seed, lane roster and cycle count for every process.** One median per lane per process is the sample.
- **R4 -- K = 10 to start** (2 measured cycles per process), re-sized from the first A/A dispatches'
  measured hosted CV using the table in 5.3. K below 8 is not used (6 is the exact test's hard floor at
  20 comparisons).
- **R5 -- gate hotOps dense + sparse on the 10 kernel lanes (20 comparisons), Holm at 0.05; FAIL =
  significant AND > 5% (T); PASS = 95% upper bound < 15% (R); else INCONCLUSIVE.** latencyP99 (median A
  vs B), per-side CV / detrended CV and improvements are printed per comparison, never gate; the tiny and
  pool lanes are NOT run (kernel tier only, decision 3). Allocation, heap and correctness stay with each
  side's own soak verdict.
- **R6 -- fail closed:** every precondition failure is INCONCLUSIVE (exit 3); the workflow fails on it.
- **R7 -- intentional slowdowns go through a per-version acceptance file**, in the diff, with a reason.
- **R8 -- controls before trust:** AB-AA (10 dispatches), AB-SLOW (two sizes), AB-SPARSE, AB-FAST,
  AB-COMPAT, plus analyser controls in `npm test`.
- **R9 -- keep the nightly as it is:** timing stays report-only there (this note changes nothing about
  `soak-baseline.md`'s decision). #8c (history window) stays conditional.

**What we would NOT copy:** Bencher's one-run-each percentage threshold (one sample per side is the
problem `soak-baseline.md` already rejected); strict ABAB order (Node's `compare.js` default -- fine on
pinned bare metal, biased on a drifting machine, 4.1); treating cycles as samples; benchstat's
uncorrected alpha 0.05 across 20 comparisons (one false alarm per release on average); Pinpoint's
automatic "add more repeats until decided" (sequential testing without an alpha-spending plan inflates
false alarms -- a pre-registered single re-run is the safe subset).

## 9. Decisions needed from you

1. **Where:** a `workflow_dispatch` job (recommended), local-only, or an automatic trigger -- and if
   automatic, what event marks a release candidate in this repo (there are no tags today)?
2. **Thresholds:** T = 5% (FAIL floor) and R = 15% (PASS must rule this out) as the starting constants --
   or a stricter R = 10%, accepting more INCONCLUSIVE runs on hosted runners?
3. **Budget:** is ~20-35 minutes of runner time per release acceptable? Include the tiny lanes
   (report-only, ~+70% time) or kernel lanes only (recommended)?
4. **Intentional slowdowns:** the per-version acceptance file (recommended), or simply "a FAIL may be
   overridden by a note in the CHANGELOG"?
5. **Same version on both sides?** When `Pick.js` is unchanged between releases (as for 1.1.0 -> HEAD 5319105),
   run the A/B anyway as a free A/A control (recommended), or skip it?
6. **Order of work:** measure the hosted runner's process-to-process CV first (a throwaway A/A dispatch,
   ~30 minutes, no gate) and only then fix K -- or build the full gate in one go?
7. **Node version:** pin the A/B to the nightly's Node 22 line, or also run it on the newest Node the
   package supports (doubles the time)?
8. **latencyP99:** report-only (recommended for the first version), or gate it with the soak's own
   two-tick floor (FAIL only when the p99 rises by >= 2 timer ticks AND the Mann-Whitney test agrees)?
   Section 4.2 shows it catches tail-shaped regressions that throughput dilutes; section 4.3 shows it
   cannot measure their size.

## 10. Decisions taken (2026-10-06)

The user chose to build the release A/B now and to let it gate 1.1.1 (its first real run: published 1.1.0
vs the 1.1.1 candidate, which carries the K1/K2 performance changes) -- "one more session for a bigger win
is totally acceptable ... the quality matters more". The eight questions above were answered with the
recommendations, open to revision:

1. `workflow_dispatch` (`soak-ab.yml`); the same script runs locally to investigate a FAIL.
2. T = 5% FAIL floor, R = 15% PASS bound.
3. Kernel lanes only (dense + sparse hotOps, 10 lanes, 20 comparisons); the tiny lanes are not run.
4. Intentional slowdowns go through a per-version acceptance file.
5. An unchanged `Pick.js` still runs, as a free A/A control.
6. One throwaway A/A dispatch measures the hosted runner's process-to-process CV first; K is fixed from it.
7. Node 22 only (the nightly's line).
8. latencyP99 is printed, never gated, in the first version.
