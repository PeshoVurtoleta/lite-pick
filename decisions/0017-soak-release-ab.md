# 0017 -- Release-time relative soak A/B (#8b)

- Status: Accepted
- Package: @zakkster/lite-pick (benchmark-only; first gates 1.1.1)
- Builds on: ADR 0014 (the soak redesign -- reused unchanged for both sides; see its 2026-10-06 amendment
  for the two selector knobs and three exports this ADR needs).
- Research: `research/soak-release-ab.md` (decisions R1-R9 section 8; user decisions section 10, 2026-10-06).
- Date: 2026-10-06

## Context

`research/soak-baseline.md` (option C, accepted 2026-10-04) put "run the previous release and the candidate
INTERLEAVED on the SAME runner, compared per lane with the exact Mann-Whitney test" on the roadmap as the
only trustworthy timing-regression signal on hosted runners, and kept the nightly's timing report-only until
it exists. `research/soak-release-ab.md` then measured the method on this machine and fixed three details of
the obvious design: the unit of evidence is a whole PROCESS, not a lane-cycle (cycles share one JIT/GC
history); the two kernels never share a process (the soak's hot step functions are shared per family, so a
second kernel doubles the receiver classes at every `pick()` call site); and the order is balanced-seeded,
not strict ABAB (a drifting machine makes the second slot read slow -- a bias, not noise). This ADR records
the build.

## Decision

The full rule is in the research note (R2-R8) and `ab-analyse.mjs`; the summary:

- **The two sides (R2).** A = the previous REGISTRY tarball (`npm pack @zakkster/lite-pick@<prev>`, sha512
  checked three ways: tarball bytes, `npm view dist.integrity`, the `--json` integrity field). B = `npm pack`
  of the tree, whose `Pick.js`/`Pool.js` sha256 must equal `benchmark/soak/parity.json` and whose `VERSION`
  must equal `package.json`. Both load through the existing `SOAK_KERNEL`/`SOAK_POOL` seams from equal-length
  sibling paths `<out>/A/package` and `<out>/B/package`. The CURRENT harness runs both sides.
- **Shape (R3, R4).** One kernel per process; K rounds, each one A and one B process in a balanced seeded
  order (`balancedOrder`: exactly `ceil(K/2)` AB, the rest BA, Fisher-Yates/mulberry32); one fixed workload
  seed, lane roster and cycle count (smoke: 1 warm-up + 2 measured) for every process. One CALIBRATION
  process per side first, then every round PINS `max(N_A, N_B)` per lane+metric via `SOAK_HOTOPS_N`. The
  sample for a lane x metric is the per-process median over the measured cycles. K = 10 to start.
- **The gate (R5, D7).** 10 kernel lanes x {hotOpsDense, hotOpsSparse} = 20 comparisons. Per comparison:
  s = Hodges-Lehmann slowdown (1 - median of the KxK ratios b/a), the exact one-sided Mann-Whitney p, Holm
  step-down over 20. FAIL = `pHolm < 0.05 AND s > T` (T = 5%); PASS = not FAIL AND the 95% upper bound
  `sU < R` (R = 15%); else INCONCLUSIVE. Report-only, never gating: `latencyP99` (median A vs B), the
  per-side CV and detrended CV, and improvements (`s < -T`) are printed per comparison and stored in
  `analysis.json`. The tiny and pool lanes are NOT run (kernel tier only). A per-version `ab-accept.json`
  admits an intentional slowdown (FAIL only if `sL > maxSlowdown`); its lane must be one of the ten kernel
  lanes (an unknown lane is an exit-2 error with a did-you-mean hint, never a silently ignored bound).
- **Fail closed (R6).** A registry/pack failure, an integrity/version/hash/header mismatch, a batch-length
  mismatch, an A process that is not PASS, fewer than K valid rounds, a timeout or signal: all INCONCLUSIVE
  (exit 3). A B process that FAILs its own soak is FAIL (exit 1). Exit codes 0/1/3, 2 for bad configuration.
- **Where (R1).** A hand-run `workflow_dispatch` workflow (`.github/workflows/soak-ab.yml`, Node pinned to
  22.23.3 == the ci.yml gates job), inputs threaded through `env:` only; the same `npm run soak:ab` runs
  locally to investigate a FAIL (it prints NOT RELEASE EVIDENCE in `--a-dir`/`--b-dir` control mode).

Files: `benchmark/soak/ab-analyse.mjs` (pure, imports `gates.mjs` only), `ab-pack.mjs`, `SoakAB.mjs`,
`_ab-teeth.mjs`, `ab-accept.json` (optional), `soak-ab.yml`; the `soak:ab` / `soak:ab:teeth` scripts; the
`SOAK_TIERS` / `SOAK_HOTOPS_N` knobs and three `export`s (ADR 0014 amendment). #8b changes no library file:
`Pick.js`, `Pool.js`, the `.d.ts` files and `parity.json` are untouched BY THIS WORK (1.1.1's own kernel
changes land separately); `SCHEMA_VERSION` stays 5.

## The must-fail battery, measured

`npm run soak:ab:teeth` (`_ab-teeth.mjs`) drives the REAL runner end to end through `--a-dir`/`--b-dir` over
the 1.1.0 tarball base (its `Pick.js` sha256 asserted `== git show 2a08567:Pick.js` = `b07731bb...`, D11).
The slowdown mutants add a read-only extra scan every 8th pick whose COUNTER (`__abn`, masked below 2^31)
and SINK (`__abs`, forced `| 0`) stay in integer Smi slots, so they add TIME only -- a boxed module `let`
double would allocate per pick and trip the soak's own hotAlloc FAIL tier, confounding the signal. REP (the
scans-per-call) is the only tuned knob; it was set from single-lane smoke pairs (SmoothWRR.pick REP=1 ->
s_dense 0.054, REP=2 -> 0.113, REP=4 -> 0.204, REP=5 -> 0.240; `_kthEligible` REP=8 -> P2C sparse 0.190).
Final: REP_SLOW20 = 4, REP_SLOW10 = 2, REP_SPARSE = 8.

Measured K=10, M4 Pro, Node 22.23.3, serial, machine idle (load ~1.5-2.5), 2026-10-06:

| control | exit | wall | result |
|---|---|---|---|
| AB-AA | 0 | 413 s | PASS, 0 of 20 INCONCLUSIVE (false-alarm control) |
| AB-SLOW20 | 1 | 416 s | SmoothWRR dense s=0.2008 (sU 0.2058) + sparse s=0.2608 (sU 0.2676) FAIL, pHolm 1.08e-4; no other FAIL |
| AB-SLOW10 | 1 | 416 s | SmoothWRR dense s=0.1150 (sU 0.1194) and sparse s=0.1599 (sU 0.1704) FAIL, pHolm 1.08e-4 each, nothing else (expectation corrected, see below; first run 396 s: 0.1117 / 0.1565) |
| AB-SPARSE | 1 | 410 s | P2C sparse s=0.1915 + PeakEWMA sparse s=0.1360 FAIL, pHolm 1.08e-4; zero dense FAIL |
| AB-FAST | 0 | 404 s | PASS, SmoothWRR dense s=-0.2472 (improvement never FAILs) |
| AB-COMPAT | 3 | 6 s | INCONCLUSIVE -- `baseline (A) process` (the pre-setWeights 8c1ecc7 kernel the harness cannot run) |
| AB-BFAIL | 1 | 37 s | FAIL -- `B process` (setEligible(up) ignored; the B soak FAILs its own run) |

Assertion 5, over the AB-AA out-dir: 22 streams x 10 lanes x 3 cycles = **660** kernel cycle records, all
with `gcMajor` 0 and `trackerSize` 0 (**660**), and all **440** post-warm-up records with
`hotBytesPerOp <= 0.3` -- the one-line check prints `660 660 440`.

## Consequences and the SLOW10 note (K is still provisional)

AB-SLOW10 is the threshold control and the design flagged it as the most fragile (research RISK note). Its
first run FAILed SmoothWRR dense as planned (s=0.1117) but ALSO FAILed SmoothWRR SPARSE (s=0.1565, pHolm
1.08e-4), which the planned "dense only" expectation forbade. The expectation was wrong, not the gate:
SmoothWRR's `pick()` scans all CAP every call but skips the per-node credit update for down nodes, so the
sparse pick is CHEAPER than the dense one (5.5M vs 3.6M ops/s) and the SAME fixed extra scan is a LARGER
share of it -- single-lane tuning measured s_sparse 0.151 vs s_dense 0.113 at REP 2. A ~16% sparse slowdown
is a real regression above T = 5%, and the gate's job is to FAIL it; expecting a noisier runner to turn it
INCONCLUSIVE would be counting on the gate to miss. The control now expects BOTH SmoothWRR comparisons to
FAIL, each inside the window its own measured effect predicts (dense [0.08, 0.13], sparse [0.11, 0.20]),
and nothing else to FAIL. Re-run (K=10, M4 Pro, Node 22.23.3, load 2.9): exit 1, dense s=0.1150 (sU 0.1194),
sparse s=0.1599 (sU 0.1704), pHolm 1.08e-4 each, no other FAIL, 416 s -- OK. Only the control's expected
outcome changed; the decision rule and REP did not.

This is the same reason **K = 10 is provisional**: the honest MDE and the dense/sparse split depend on the
runner's real process-to-process CV. Per user decision 6, a throwaway hosted A/A dispatch (mode=aa) measures
that CV first; K is then FIXED from the 5.3 table (<= 4% CV -> K=8, <= 6% -> K=12, else K=16) and recorded in
an amendment to this ADR, before the first real release-mode run gates 1.1.1 (published 1.1.0 vs the
candidate). The decision rule (T=5%, R=15%, alpha 0.05, Holm over 20) and the FAIL/PASS windows were NOT
moved; only REP was tuned and the SLOW10 expectation corrected as above.

## Amendment 1 (2026-10-06): K = 16 on hosted runners

The first hosted A/A dispatch (soak-ab run 37412882822, commit 6629796, ubuntu-latest, Node 22.23.3, K = 10,
`--aa` with 1.1.0 on both sides) PASSED 20/20: no FAIL, worst sU +0.0537 (NQ sparse), well inside R. The
process-to-process CV of the per-process medians was 0.2-2.4% on most lanes, 3.7-5.3% on P2C dense, NQ
sparse and SmoothWRR dense, and **8.12% (detrended 8.01%) on SmoothWRR sparse, side B** (side A 5.31%).

Every lane is gated, so the NOISIEST lane sets the gate's power: K is fixed from the worst lane's CV, not a
median or pooled CV (that would quietly lower the power exactly where the noise is). 8.1% > 6%, so the 5.3
table gives **K = 16**: `soak-ab.yml`'s `rounds` default is now 16. The A/A step took 9 min 14 s at K = 10;
the first K = 16 run took 10 min 33 s, well inside the 75-minute job timeout. The decision rule (T, R, alpha, Holm over 20) is
unchanged. The CLI default stays K = 10 for LOCAL runs: this laptop's process noise is ~2% (research
section 4), where K = 10 already has full power at a 10% slowdown.

One A/A run estimates a CV from 10 processes per side (relative standard error ~24%), so 8.1% could be 6-10%;
K = 16 also covers the upper end. Revisit only with more A/A evidence, never to make a release pass.

This A/A ran AFTER 1.1.1 was published, so 1.1.1's release-mode run is a post-publish record, not a gate;
the first release that this gate blocks is the next one. That record (soak-ab run 37414241263, commit 6629796,
K = 16, published 1.1.0 vs the packed tree == 1.1.1 by parity): **PASS 20/20**, 16/16 valid rounds, worst sU
+0.0459 (SmoothWRR sparse); WeightedRandom sparse s = -0.0233 (sU -0.0188: faster with the whole interval
below 0; p99 983 -> 889 ns) -- the K2 cached eligible-weight sum, as the local K = 10 run showed (-0.0341).
