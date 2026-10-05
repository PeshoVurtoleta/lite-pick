# Research: a baseline for the nightly soak

**Status:** DECIDED 2026-10-04 -- all section-7 recommendations accepted ("they can always be improved
with evidence"): (1) nightly timing diffs report-only; (2) storage = workflow artifacts; (3) option C on
the roadmap with its own research note first (ROADMAP Post-1.0 #8b); (4) option B later, conditional (#8c).
Option A is implemented: `soak:report --baseline` semantics + the `soak-baseline` artifact in
`.github/workflows/soak-nightly.yml`. Refined 2026-10-05: the baseline is selected by ARTIFACT (newest
non-expired `soak-baseline` on this branch), not by last green workflow run, and a `seed_baseline`
workflow_dispatch input can bootstrap the first baseline on a new branch (both detailed in sections 5-6).
**Question:** the audit's fix plan (2026-09-29) says: keep the last green nightly's JSONL as a
"baseline artifact" and run `soak:report --baseline` against it every night, "which is what LKP/0-day
and the Node.js benchmark CI provide for their projects". Before copying that, how do those projects
actually do it, and does it work on GitHub's hosted runners?

**Short answer:** not as written. Every system we looked at refuses to trust one run against one run on
different machines. Our own measurements show a single soak run's throughput moving 16.6% between two
runs on the SAME machine, minutes apart -- over the report's 15% threshold. So a nightly
"tonight vs last green" timing diff would go red on noise. The recommendation (section 7) keeps the
baseline, but gates only on what does not depend on the machine, reports timing with context, and adds
real statistics later.

---

## 1. Concepts, in plain words

- **Baseline:** a previous measurement you compare against. "Did this commit make things slower?" needs
  a "before".
- **Noise:** the same code, measured twice, gives different numbers. Causes: CPU frequency scaling,
  other processes, cache state, the JIT compiling at different moments, and -- in the cloud -- a
  different physical machine each time.
- **Coefficient of variation (CV):** standard deviation / mean, as a percent. "CV 3%" means a typical
  run lands within about +/-3% of the average. If the CV is 10% and your threshold is 15%, you WILL see
  false alarms.
- **Effect size:** how big a change is (e.g. -18%). **Significance:** how sure you are it is not noise
  (e.g. p < 0.01). Good systems require BOTH: big enough to matter AND unlikely to be noise. A big
  change measured once is not significant; a tiny change measured a million times can be significant
  but irrelevant.
- **Statistical tests you will see below:**
  - *Welch's t-test* compares two means without assuming equal spread (Node.js).
  - *Mann-Whitney U* compares two sets by ranks -- "do the after-values tend to sit above the
    before-values?" -- and does not care about the shape of the distribution (Go's benchstat; our own
    soak gates already use an exact one-sided Mann-Whitney since S2).
  - *IQR fence:* the interquartile range (Q3 - Q1) measures typical spread; a value beyond Q3 + k x IQR
    is an outlier (rustc-perf, k = 3).
- **Interleaving:** run old, new, old, new... instead of all-old then all-new, so slow drift in the
  machine (heat, background load) hits both equally.
- **Multiple comparisons:** compare 20 metrics at p < 0.05 and, on average, one looks "significant" by
  pure chance. Systems correct for it (stricter threshold, Holm-Bonferroni).

## 2. How established projects do it

### 2.1 Intel LKP / 0-day CI (Linux kernel performance)
- Tests each kernel commit and auto-bisects when performance regresses.
  [Intel LKP overview](https://www.intel.com/content/www/us/en/developer/topic-technology/open/linux-kernel-performance/overview.html)
- **Baselines:** for change detection it pools results from the nearest release/rc tags before the commit
  (about 3 tags / 9 samples) and needs at least 3 samples per metric; a published report compares a
  commit with its parent, showing `mean +/- %stddev` on both sides.
  [lib/changed_stat.rb](https://github.com/intel/lkp-tests/blob/master/lib/changed_stat.rb),
  [example report](https://lkml.iu.edu/hypermail/linux/kernel/2309.1/00481.html)
- **Rule:** not a t-test -- the two runs' value ranges must SEPARATE (the new minimum above the old
  maximum, roughly), after trimming outliers; changes of <= 1% are ignored, <= 5% unless the metric is a
  listed perf metric. [lib/stats.rb](https://github.com/intel/lkp-tests/blob/master/lib/stats.rb)
- **Hardware:** results from virtual machines are skipped outright -- the code comment is "virtual
  hosts are dynamic and noisy". Runs use named physical machines with the CPU governor pinned to
  `performance`.
- **Lesson for us:** LKP's whole approach rests on dedicated, controlled hardware. We do not have that.

### 2.2 Node.js core benchmarks (`benchmark/compare.js` + `compare.R`)
- Runs the old and new `node` binaries **interleaved, on the same machine, in the same session**,
  30 runs each by default; can pin to CPU cores.
  [compare.js](https://github.com/nodejs/node/blob/main/benchmark/compare.js),
  [docs](https://github.com/nodejs/node/blob/main/doc/contributing/writing-and-running-benchmarks.md)
- **Rule:** Welch's t-test per benchmark, shown as stars (`*` p<0.05, `**` p<0.01, `***` p<0.001). The
  docs warn that with 20 benchmarks one will look significant by chance and suggest `**`; no stars = no
  conclusion. Newer `--max-regression N` fails only if a corrected one-sided test AND the whole 95%
  confidence interval are beyond -N% -- "the point estimate alone cannot fail the command".
- **Lesson for us:** the comparison is RELATIVE (both versions on one machine, now), never against a
  number stored from another machine.

### 2.3 Others, briefly
- **rustc-perf (Rust compiler):** measures instruction counts instead of wall time because wall time
  "has high variance" -- in a no-op change, instruction counts moved +/-1.3% while wall time moved
  +/-9%. A change is flagged when it is outside Q3 + 3 x IQR of the changes over the previous 30
  commits. [why instructions](https://internals.rust-lang.org/t/what-is-perf-rust-lang-org-measuring-and-why-is-instructions-u-the-default/9815),
  [comparison.rs](https://github.com/rust-lang/rustc-perf/blob/master/site/src/comparison.rs)
- **Mozilla Perfherder:** compares a window of 12-24 previous pushes with the next 12, a t statistic
  with threshold 7 AND at least a 2% change.
  [perfalert](https://github.com/mozilla/treeherder/blob/master/treeherder/perfalert/perfalert/__init__.py)
- **Go benchstat:** median + confidence interval, Mann-Whitney U at alpha 0.05, "run at least 10
  times", "interleave before and after runs", on an idle machine.
  [benchstat](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat)
- **Bencher.dev:** many threshold models (percentage, z-score, t-test, IQR...); for noisy CI it
  recommends "relative continuous benchmarking" -- base and head in the same CI job.
  [thresholds](https://bencher.dev/docs/explanation/thresholds/)
- **github-action-benchmark** (the common GitHub Action): says hosted runners vary "about +- 10~20%"
  and defaults its alert threshold to 200%, i.e. a 2x slowdown.
  [repo](https://github.com/benchmark-action/github-action-benchmark)

## 3. Noise on GitHub-hosted runners (outside evidence)
- Every job gets a fresh VM (public repos: 4 vCPU / 16 GB).
  [GitHub docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- The CPU model changes between runs: CodSpeed saw AMD EPYC 7763 in 9/10 runs and Intel Xeon 8370C in
  1/10 on the same pinned image; even instruction counts moved ~1.5% between the two.
  [CodSpeed, 2026](https://codspeed.io/blog/unrelated-benchmark-regression)
- Reichelt, Jung & van Hoorn (2024): the smallest change detectable on GitHub Actions was 4.41% vs 1.94%
  on bare metal -- with repeated, controlled measurement. [arXiv 2411.05491](https://arxiv.org/html/2411.05491)
- Laaber, Scheuner & Leitner (EMSE 2019): cloud CV from 0.03% to over 100% by benchmark and instance;
  running old and new on the SAME instance in randomized order detects <= 10% slowdowns reliably.
  [Chalmers](https://research.chalmers.se/en/publication/511491)

## 4. Our own measurements (this machine, Apple M4, 2026-10-04)
Late-window median throughput (picks/s, median of the last 5 cycles), clean kernel, 11-cycle soak:

| lane | within-run CV | run A (node 26) | run B (node 26) | run C (node 22) | heap MB A / B / C |
|---|---|---|---|---|---|
| RoundRobin | 2.8% | 235.0M | 235.0M | 237.2M | 8.0 / 8.0 / 7.5 |
| SmoothWRR | 3.3% | 2.7M | 2.6M | 3.4M | 8.0 / 8.0 / 7.5 |
| PeakEWMA | 4.1% | 6.4M | 6.3M | 5.1M | 8.1 / 8.1 / 7.6 |
| ConsistentHash | 1.2% | 178.8M | 169.0M | 167.5M | 8.0 / 8.0 / 7.5 |
| WeightedRandom | 4.6% | 60.7M | **70.8M** | 71.1M | 8.1 / 8.1 / 7.6 |

- Runs A and B: same machine, same Node, same kernel, minutes apart. WeightedRandom differs by 16.6%:
  **over the report's 15% threshold with no code change and no machine change.** (A and B differ only in
  the B/op probe, which runs after the timed segments.)
- Node 22 vs 26 (C vs B): SmoothWRR +26%, PeakEWMA -19% -- a Node upgrade alone would "regress".
- Heap is steady: within 0.5 MB across all three runs (the report's heap threshold is 2 MB).

## 5. What our `--baseline` does today, and why a nightly gate on it would be flaky
`soak:report --baseline other.jsonl` (after S12) fails the run on: throughput down > 15%, p99 up > 25%,
heap up > 2 MB, quality violations 0 -> > 0, a pool lane failing where it passed, or a lane missing. It
compares ONE late-window median per metric per lane against ONE from the baseline: a raw percentage of
one sample versus one sample.

- **Timing (throughput, p99):** single sample vs single sample, different VM, different CPU model
  possible, a 15% bar against 10-20% runner noise and 16.6% same-machine noise. Every project above says
  this does not work. As a gate it would go red on noise, and a gate that cries wolf gets ignored.
- **Heap:** independent of CPU speed; depends on the Node/V8 version. A 2 MB bar is well above what we
  see (0.5 MB). Reasonable to gate, provided the baseline ran the same Node major.
- **Correctness (quality / pool / lanes):** machine-independent, but tonight's soak already FAILs on any
  of these by itself. The baseline diff adds nothing here except catching a lane that silently vanished.

## 6. The options

| | what | catches | cost / risk |
|---|---|---|---|
| A | Last-green baseline; **gate** only heap (same Node major) + lane presence; **report** timing diffs (no fail) | memory creep release-over-release; dropped lanes | cheap; timing only informs |
| B | A, plus a **history window**: keep ~14 nightly summaries, flag a timing change outside Q3 + 3 x IQR of the night-to-night changes (rustc-perf style) AND > 5% | sustained timing shifts, with the noise level learned from our own history | needs ~2 weeks of history before it can judge; more code |
| C | **Relative A/B on one runner** (Node.js / benchstat / Bencher style): on a release tag, run the previous release and the new one interleaved in one job, Mann-Whitney per lane (we already have the exact test in `gates.mjs`) | real release-over-release timing regressions, at the 5-10% level | doubles that job's runtime; release-time only |
| D | Gate timing on the last green run as the fix plan wrote it | -- | false alarms on noise (section 4); not recommended |

**Where to store the baseline** (GitHub Actions):
- **Workflow artifacts (recommended):** already uploaded by the nightly; kept 90 days; the next run
  downloads a prior run's artifact with `actions: read` only -- no write access to the code. The
  artifact is selected by ARTIFACT, not by "last green workflow run": `gh api
  .../actions/artifacts?name=soak-baseline&per_page=100`, filtered to non-expired artifacts whose
  `.workflow_run.head_branch` equals this branch (jq `$ENV.GITHUB_REF_NAME`, never shell-interpolated),
  newest `.workflow_run.id` wins. This decouples "has a baseline" from "the whole workflow went green":
  a teeth-only failure on an earlier night no longer strands the burn-in without a baseline, and every
  `gh` call fails OPEN (a `::warning::` + `exit 0`), so a missing baseline is bootstrap, never a burn-in
  failure.
- **actions/cache:** silently evicted after 7 days unused; cache poisoning warnings in the docs.
- **A dedicated branch or release asset:** never expires, but needs `contents: write` -- the job could
  then write to the repository. Not worth it for this.
- Whatever we pick, the restored file is untrusted input: S12 already makes `--baseline` check the
  baseline's own integrity and refuse an overridden stream.

**Seed path (bootstrap a new branch).** A branch with no prior artifact has no baseline, which is fine
for the report but means the branch never gets one unless a fully green night happens to produce it. A
manual `workflow_dispatch` with the boolean input `seed_baseline=true` uploads tonight's stream as the
baseline even when the report REGRESSED -- but only when the soak step itself succeeded
(`steps.soak.outcome == 'success'`) and the stream is its OWN evidence: the stage step re-runs
`node benchmark/soak/SoakReport.mjs <stream>` with no baseline and refuses to upload unless the output
shows `re-derived=PASS` and `[integrity OK]`. So the seed bypasses a report-vs-baseline regression only,
never a non-PASS or tampered stream. A scheduled night (`inputs.seed_baseline` null) is unaffected: the
baseline still uploads only on full `success()`.

## 7. Recommendation
1. **Now -- option A.** Upload a baseline, download the last green one, run `--baseline` every night.
   Split the report's verdict: heap (same Node major) and lane presence FAIL; throughput and p99 are
   printed with the change and marked report-only. Plus the S12 leftover from the fix plan: warn when a
   baseline value is zero (a "+inf %" is not information).
2. **Later -- option C at release time** (when a release is cut): the only way on hosted runners to get a
   timing regression signal we could trust. This is "borrowing" the Node.js/benchstat method, so it would
   get its own short research note on interleaving design first.
3. **Maybe -- option B,** if the report-only timing numbers turn out to be useful to watch.

**What we would NOT copy:** LKP's dedicated hardware (we have none); rustc-perf's instruction counts
(no portable instruction counter from Node on hosted runners, and CodSpeed shows they shift with the CPU
model too); a write-access branch for storage.

## 8. Decisions needed from you
1. Timing diffs in the nightly: **report-only** (recommended) or gating?
2. Storage: **workflow artifacts** (recommended), cache, or a branch?
3. Release-time relative A/B (option C): put it on the roadmap (with its own research note first)?
4. History window (option B): now, later, or never?
