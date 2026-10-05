# lite-pick — Audit Findings, 2026-10-05 (1.1.0 + capstone)

**Scope:** commit `3f48ef0` (`main`). The library is `@zakkster/lite-pick` 1.1.0 (`Pick.js`, `Pool.js` and their `.d.ts`). This audit covers:

- the soak harness (`benchmark/soak/*`)
- the new **capstone system** `pickEcosystem/` (headless kernel, TUI, browser page over real Web Workers, hub plus GitHub Pages deploy, heartbeat, guided tour)
- CI and supply chain
- docs and packaging
- demos

It follows up on [2026-09-26](../2026-09-26/FINDINGS.md) and [2026-09-29](../2026-09-29/FINDINGS.md).

**Method:** four parallel reviews, each reproducing its claims with scripts or runs, plus my own spot-checks of every High item. I read the GitHub Actions history through the read-only API. Mutation spot-checks covered:

| Area | Mutants | Killed |
|---|---|---|
| Kernel | 31 | 28 |
| Pool | 13 | 10 |
| Capstone | 18 | 14 |

**Environment:** Node 22.22.2, Linux, 4 vCPU. The reviews ran concurrently, so load average ranged from 0.5 to 19. Every timing-sensitive result gives its load. A loaded box is a fair stand-in for a shared CI runner.

---

## Executive summary

**The library is in excellent shape.**
- No High or Medium bugs were found in the 1.1.0 kernel or Pool code.
- Of the open items from the earlier audits, 11 are verified fixed. L4 now matches a reference Finagle `observe()` exactly over 100k samples. L2's fallback went from 63/37 to 50/50. L3's probe exhaustion went from 0.77% to 0%.
- Every throw carries a `LITE_PICK_*` code, consistent across source, `.d.ts` and `llms.txt`.
- The new APIs validate thoroughly and are atomic on error: `setWeights`, `pickFrom`/`recordRttFrom`, `minCap`, `attachStats`, `describe`, `assertConsistent` and channels.
- 264/264 tests pass. `npm audit` reports 0 vulnerabilities, and the tarball ships exactly the 11 intended files.

**The problems are in the machinery around it.**

1. **CI on `main` is red, and the live site is deployed by GitHub's branch build, which bypasses the gated deploy** (§C1). Every gate passes, but the `deploy (GitHub Pages)` job fails at `configure-pages`. A separate "pages build and deployment" run (a Jekyll build of the branch) succeeds, so the whole repository is being served, not the 27-file allowlisted site.
2. **The soak fails every full run, from a flaky retention check** (§S1). The pool-lane check A6 (`tracker.size() === 0` after a short GC drain) fails about 1–5% of pool lane-cycles, purely on finalizer timing. Full soaks failed **4/4**. The nightly therefore can't go green, and its baseline can't bootstrap (§S5).
3. **The soak's allocation gate has no teeth any more** (§S2). It was made report-only to fix the earlier false positives. A mutant that allocates 40 B per pick now passes, and the M1–M4/M16 controls pass even on a clean kernel.
4. **Capstone: a circuit breaker can get stuck in HalfOpen for good** (§P1). If a worker dies during its HalfOpen probe, the supervisor restarts it healthy but it never returns to rotation. You can trigger it from the UI with `f`, then `c`.

| Severity | New findings |
|---|---|
| High | 4 (C1, S1, S2, P1) |
| Medium | 12 |
| Low | ~25 |

Carried over and still open: **N6** (not mentioned anywhere), **L7** (partial: no upper bound on M), the **N4** wording in the README, and most **T3** CI-hardening items.

---

## Results of running the scripts

| Script | Result | Notes |
|---|---|---|
| `npm test` | ✅ 264/264 (×4 runs) | about 10 s |
| `npm run test:types` | ✅ | |
| `npm run torture` / `fuzz` / `balance` | ✅ | |
| `npm run test:perf` | ⚠️ **failed 3 of 8** across two reviews | always lane 18 (WeightedRandom heavy-outage), `oldgen 2 > 0`, the memory-reducer false positive (§T1) |
| `npm run test:perf:noinline` | ⚠️ 1 of 5 failed | same lane |
| `npm run parity` / `soak:probe` | ✅ | probe passed 3/3 at load 14 |
| **`npm run soak`** (default) | ❌ **FAIL 4/4** | only `pool=A6` retention breaches, each on a different lane and cycle (§S1) |
| `npm run soak:teeth` | ✅ 85/85 | 64 min at load 0.7→19, of which PL+ML took 42.5 min |
| Long run, 1500 cycles | ✅ heap flat (7.4 → 7.7 MB) | exits 3 (INCONCLUSIVE) by design, since RoundRobin quality windows don't fill at 20k picks |
| `pickEcosystem/live npm test` | ✅ 31/31 (×2) | deterministic |
| `pickEcosystem/live npm run smoke` | ❌ **at 800 and 600 req/s (the CI rate)**; ✅ at 150 | host-speed dependent (§P4) |
| `browser-smoke` | ⚠️ couldn't reach esm.sh here | with esm.sh emulated from `node_modules`: 22/23 checks pass, the "no failed requests" check fails under load |
| `heartbeat:teeth` | ✅ 9/9 | 33 s |
| 3.5-minute real-thread capstone run, 300 req/s, faults and switches | ✅ no leak | post-GC heap 6.5 → 7.0 MB, flat after 110 s |
| GitHub Actions, HEAD run 37274662534 | ❌ | all 13 test/gate/capstone jobs ✅; **`deploy (GitHub Pages)` ❌** |

---

## Status of earlier findings

### Kernel and Pool
| Item | Status | Evidence |
|---|---|---|
| L2 biased fallback | ✅ Fixed | P2C 63.5/36.5 → 50.1/49.9; WeightedRandom 50/50, and 75/25 at weights 3:1 |
| L3 ConsistentHash probe exhaustion | ✅ Fixed | 60 of 64 down: 0.77% → 0.00% `PICK_NONE` |
| L4 PeakEWMA blend | ✅ Fixed | max relative diff 0 against a Finagle `observe()` reference over 100k samples |
| L7 unbounded M | ⚠️ Partial | Additive stepping is in (rebuild 8.99 → 2.49 ms, tables identical). There's still **no upper bound**: M = 100 000 007 is accepted and blocks for 26 s using about 500 MB |
| L8 comment | ✅ Fixed | |
| M5 tie skew | ✅ Fixed | 1000 each; NQ residual bias in §K3 |
| N1 abort penalty | ✅ Fixed | EWMA 0.67 ms after an abort (was 1e9) |
| N2 unmarked keyed balancer | ✅ Fixed | 8/8 backends |
| N3 `Math.ceil` | ✅ Fixed | BoundedLoad 0.92× of 1.0.1 (faster) |
| N4 low-load affinity | ⚠️ Partial | opt-in `minCap` works (5 same-key requests → 1 backend). `README.md:219` still says "a larger eps buys more low-load stickiness"; that needs eps > 4 at n=10 |
| **N6 failover neighbour double share** | ❌ **Not fixed, not mentioned** | ADR 0013 deferred it to 1.1.0, but 1.1.0 is silent on it. Keys homed on backend 3 fail over as `96,102,102,0,206,92,…`, so backend 4 still gets about 2× (`Pool.js:126-135, 373-379`) |
| N7 semver notes | ✅ Fixed | |
| H2, L14, N5 | 📄 Won't fix (documented) | H2 now has `assertConsistent()` to detect it |
| H4 | ⚠️ Fixed opt-in only | see N4 |

### Soak (S1–S14 of 2026-09-29)
| # | Status | Notes |
|---|---|---|
| S1 hotAlloc false positives | ⚠️ **Gone, but by removing the gate's teeth** | see §S2 |
| S2 timing gates | ✅ Fixed | Mann–Whitney confirmation held PASS under load 18 (RoundRobin late/early ratio 0.30, p = 0.155). gcPause and rebuild are now report-only |
| S3 teeth on a clean tree | ✅ Fixed | caveat: the pass-control P covers only RR/SmoothWRR/WR (`_mustfail.mjs:538`), so it never sees §S1 |
| S4 heap self-growth | ✅ Fixed | |
| S5 silent PASS | ⚠️ Partial | SIGINT → exit 3 ✅; a short `SOAK_DURATION` now FAILs instead (§S3) |
| S6 parity gate | ✅ Fixed | Low: the report prints a parity MISMATCH but still exits 0 |
| S7 P2C oracle | ✅ Fixed | calibration reproduces bit-exactly; 0 false positives in 360k out-of-sample cycles |
| S8 teeth coverage | ⚠️ Partial | manifest and meta-test exist; rebuild, gcPause and hotAlloc have no effective teeth |
| S9 DES pool lanes | ✅ Fixed | RTT p50 1.0–1.13 ms, ns units; the Little's-law identity holds exactly |
| S10 down-dispatch | ✅ Fixed | A8 plus the MP8 control |
| S11 teeth matching | ✅ Fixed | Low: any `unhandledRejection` is labelled `pool=A7` |
| S12 report integrity | ✅ Fixed for every listed tamper | new false alarms in §S4 |
| S13 probe | ✅ Fixed | |
| S14 oracles | ✅ Mostly fixed | |

### CI, docs and demos
| Item | Status |
|---|---|
| T1 `test:perf` flakiness | ⚠️ Partial: detector validation is fixed (8/8 with lite-perf-gate 1.4.3); lane 18 still flakes (§T1) |
| T2 SmoothWRR A5 | ✅ Fixed (the mutant is killed by A5b) |
| T3 `failurePenaltyNs` test | ✅ Fixed |
| T3 `timeout-minutes` on `ci.yml` jobs | ❌ None of the 6 jobs has one (the nightly has them) |
| T3 SHA-pinned actions + Dependabot | ❌ |
| T3 `typescript@5` as a devDependency | ❌ still `npx -y -p typescript@5` at run time |
| T3 weekly verify/witness, mutation job, model-oracle tests | ❌ |
| T3 `bench:gc` relative limit (L20) | ❌ still an absolute 2 ms; failed 3/3 under load |
| L22 witness in CI / sparse case | ❌ |
| D1 RECIPES §8 PeakEWMA | ✅ Fixed (0.25% failures, against 48.3% for the old pattern) |
| D2 doc drift | ⚠️ Partial: the H4 statement (`CHANGELOG.md:501-502`, `0013:104-106`), "bitmap written by lite-di-health" (`README.md:24`, `Pick.js:13-15, 253`) and "M5 lite-query adapter" (`llms.txt:202,220`, `Pick.js:570,666`) remain |
| D3 `./package.json` export | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 20 and 22 |
| D4 `serve.mjs` realpath allowlist | ✅ Fixed (symlink probes return 404/403) |

---

## §C — CI, deploy and supply chain

### C1 [High] CI is red on `main`, and the site is published by an ungated branch build
**Evidence:** GitHub Actions API, run `37274662534` (HEAD `3f48ef0`, push):
- All 13 test, gate, types-compat and capstone jobs ✅.
- `deploy (GitHub Pages)` ❌, failing at `actions/configure-pages@v5` with "Get Pages site failed … Not Found".
- 16 minutes later, `pages build and deployment` (event `dynamic`, HEAD `3f48ef0`) succeeded. That is GitHub's legacy Jekyll build of the branch.
- The two pushes before it (`4b318d3`, `5fe80d2`) were also red.

**Impact:**
- **The site is not gated.** The "deploy only after every gate" design (`ci.yml:145-150`) is bypassed: whatever is on `main` is served immediately, even when tests fail.
- **The allowlist is bypassed.** `site.mjs`'s 27-file allowlist doesn't apply, so `audit/`, `research/`, `benchmark/`, `decisions/` and so on are all served. The repo is public, so nothing secret is exposed, but the site isn't what the project says it is.
- **Every push to `main` turns CI red,** which trains people to ignore red.

**Fix:**
- Settings → Pages → Build and deployment → Source = **GitHub Actions**. This disables the branch build; the current setting was inferred from run history, because the Pages API is blocked from this sandbox.
- Restrict the `github-pages` environment to `main`.
- Re-run the CI workflow and confirm `deploy` goes green and the branch build stops appearing.
- Optionally add a post-deploy smoke that fetches `/audit/` and expects 404.

### C2 [Medium] `ci.yml` hardening still missing (T3 carry-over)
- **Job timeouts:** no `timeout-minutes` on any of the 6 jobs, so the default is 6 h.
- **Pinning:** actions are pinned by tag, not SHA, and there's no `.github/dependabot.yml`.
- **Outside the lockfile:** `types-compat` installs `typescript@5` through `npx`.
- **Missing scheduled jobs:** no workflow-level `concurrency`, and no weekly verify, witness or mutation job.
- **Deploy concurrency:** the deploy job uses `cancel-in-progress: true` (`ci.yml:163`); GitHub's Pages template uses `false`, so a deployment in flight isn't cancelled.
- **Deprecated runtimes:** `checkout@v4`, `setup-node@v4` and `configure-pages@v5` trigger the runner's "Node 20 is deprecated" warning.

### C3 [Low] No release tags; HEAD isn't what's published as 1.1.0
There are no git tags. The npm 1.1.0 tarball is byte-identical to commit `2a08567`. HEAD still says 1.1.0 but packs a different `CHANGELOG.md`, `README.md`, `RECIPES.md` and `package.json` (an `[Unreleased]` section, the live-site link, and the lite-logn devDependency). The library code is identical. There are no npm provenance attestations.

**Fix:** tag `v1.1.0` at `2a08567`, and publish from CI with `--provenance`.

### C4 [Info] Mislabelled commit
`5f408f1` carries a lite-sketch commit message ("H2.4 … Sketch.js", `test/lanes/natives.mjs`, neither of which is in this tree). Its diff is actually lite-pick **1.1.0 B1** (`setWeights` and the L2/L3 fixes), so `git log --grep B1` will never find it. It's the only mismatch among 67 commits. Don't rewrite `main`; add a line to the CHANGELOG or ROADMAP that says "B1 landed as 5f408f1 (mislabelled)".

**Verified fine:**
- actionlint and shellcheck are clean.
- No `pull_request_target`; fork PRs can't reach `deploy`.
- `pages: write` and `id-token: write` are scoped to the deploy job.
- No `github.event.*` in any `run:`.
- The nightly baseline takes artifacts only from successful scheduled runs on the same branch.
- `npm audit` reports 0 vulnerabilities in both lockfiles.
- No install scripts; every package resolves from the registry with integrity.

---

## §K — Kernel and Pool (1.1.0): new findings (all Low)

| # | Finding | Evidence | Fix |
|---|---|---|---|
| K1 | **`recordRtt` blend path is about 45% slower than 1.0.x** on Node 22/x64 (12.6 → 18.9 ns). `CHANGELOG.md:145` and ADR 0009:149 claim "8.8 → 8.6 ns, costs no more", likely measured on darwin/arm64 Node 26. The cause is the second `exp()` for the decaying pool mean (`Pick.js:1128-1135`). | interleaved A/B, min of 5–7 reps | Compute one `exp` when node `dt` equals pool `dt` (the single-clock case); state platform-specific numbers |
| K2 | **The WeightedRandom heavy-outage fallback is 1.2–1.5× slower**: the L2 fix walks the array twice. This is what pushes PerfGate lane 18 past V8's ~8 s memory-reducer timer (§T1). `Pick.js:1939-1958` | 8.4 / 10.4 / 16.2 s lane times | Cache the eligible weight sum (maintained by `setEligible`/`setWeight[s]`), or shrink the PerfGate lane |
| K3 | **Rotating ties leave a positional bias in NQ.** With weights `[1,1,1,1,4,4,4,4]` at load 0.9, the weight-4 group got 20.6 / 20.1 / 19.8 / 19.6%, stable across seeds and following group position. LeastConn and SED are fair. `Pick.js:852-883` | Poisson simulation | A seeded uniform choice among ties (a reservoir pick within the same scan) |
| K4 | **`assertConsistent()` on WeightedRandom only checks the weight *sum*.** Swapping weights `[1,2,3,4]` → `[4,2,3,1]` without `rebuild()` passes, and picks keep following the stale table. The CHANGELOG claims it detects "a weight write without rebuild()". `Pick.js:1971-1978` | reproduced | Keep a copy of the weights the table was built from and compare element by element (cold path), or narrow the claim |
| K5 | **`WeightedRandom.setWeights` corrupts an overlapping view of the same buffer.** With own weights = `buf.subarray(1)` and argument `buf.subarray(0,4)`, the result is `9,9,9,9` (wanted `9,1,2,3`). `Pick.js:1894-1895` | reproduced | `wt.set(weights.subarray(0, cap))`, which handles overlap; or reject overlapping buffers |
| K6 | **A negative clock disables PeakEWMA.** `_stamp < 0` doubles as the "never sampled" marker, so with `now < 0` every node stays "unsampled" (`describe().sampled = 0`), with no blend, no busy floor and no pool-mean decay. The contract only says "finite". | | Validate `now >= 0`, or use a separate sampled bitmap |
| K7 | **A BigInt `now` throws an uncoded `TypeError` on any PeakEWMA pick**, even on a cold pool. 1.0.x only threw after the first sample. `process.hrtime.bigint()` is the natural ns clock. The docs say "`pick(now)` never throws". | `Pick.js:1148-1151` | Document Number-only `now`, and mention `Number(process.hrtime.bigint())` |
| K8 | **All-zero weights mean different things per strategy.** ConsistentHash/BoundedLoad `setWeights(all 0)` falls back to equal quotas and routes everywhere, even though "weight 0 = remove". WeightedRandom returns `PICK_NONE`. Undocumented. | `Pick.js:1384-1389` | Pick one semantics, preferably fail closed, or document the difference |
| K9 | **L7 residual:** no upper bound on M (see the status table) | | Validate `M ≤ 2^24` (16 777 213 is prime) |
| K10 | **N6 residual** (see the status table) | | Re-derive the failover start index from a second hash when it lands on the failed node |
| K11 | Mutants that survive: NQ wrap-around idle pick not advancing the cursor; ConsistentHash `setWeights` skipping the last index; Pool nested *settle* publish clobbering the outer message; `REPICK_LIMIT = 0`; unkeyed `_scanCursor` not rotating | 6 survivors in 44 mutants | Add the 5 targeted tests |

**Info:**
- The `LitePickErrorCode` doc says "TypeError for a wrong type", but `LITE_PICK_ARRAY` and `LITE_PICK_CAPACITY` throw `RangeError`.
- `describe().cap` is unrounded, while the docs say `ceil(…)`.
- `setWeights` always rebuilds, even with unchanged weights.
- There are no runtime error-code constants or typed error interface, so `(e as Error).code` doesn't compile.
- `STAT_COUNT` is typed `number`, not `3`.
- A throwing channel subscriber crashes the process through `uncaughtException`. That's Node's semantics, but worth a line in the docs.
- The `types-compat` consumer fixture doesn't touch any 1.1.0 API, though a hand-written one compiles under TS 5.9 and 7.

---

## §S — Soak harness

**What's good:**
- A parity gate, plus refusal of streams run against an overridden kernel.
- Strict BREACH-line matching across 85 teeth controls, with a coverage meta-test.
- Bit-reproducible P2C calibration with a real margin.
- A deterministic pool simulation with realistic RTTs and an exact Little's-law check.
- O(lanes) memory.
- Mann–Whitney timing gates that hold up at load 18.
- Fail-closed configuration.
- Every listed report tamper is detected.

### S1 [High] Pool retention check A6 is a timing flake that fails every full soak
**Files:** `benchmark/soak/boundary.mjs:60` (8× `gc()` + `setTimeout(0)` drain), `main.mjs:592`

| Run | Result |
|---|---|
| default `npm run soak` | **4/4 failed**, only on `pool=A6 … tracker.size()=2`, each time a different lane and cycle (load 1.5 to 16) |
| standalone diagnostic `a6diag.mjs`, at load 0.5–1.0 (my run) | **3 / 240** pool lane-cycles failed |
| reviewer's runs at load 2.7–10 | 13 / 400 and 9 / 200 |

In **every** case the tracker drained after only 1–8 more `gc()` + 5 ms waits. That's finalizer timing, not a leak. Swapping in the pre-1.1.0 `Pool.js` gives the same rate.

At about 1–5% per pool lane-cycle, a default run (4 pool lanes × 7 cycles) fails roughly 30–75% of the time, and a 45-minute burn-in (about 400 pool lane-cycles) is effectively certain to fail.

The teeth pass-control P covers only RR/SmoothWRR/WR, so `soak:teeth` stays green and hides this.

**Fix:** a time-bounded drain: poll `tracker.size()` with `gc()` + `setTimeout(10)` for up to about 2 s, recording the tries. Breach only if it's still non-zero, and keep the tries count as telemetry. Make the pass-control full-roster.

### S2 [High] The allocation gate (hotAlloc) no longer fails anything a real per-op allocation would produce
**Files:** `benchmark/soak/gates.mjs:330-345`; `_mustfail.mjs:207` (M1–M4/M16)

To fix the earlier false positives (2026-09-29 S1), hotAlloc now FAILs only at the "gross" tier: every window scavenged, about 512+ B/op, or a non-finite measurement. Anything above the 0.02 B/op bound but below that is **report-only** (a STUB verdict plus a NOTE).

**Evidence:**
- A mutant where `RoundRobin.pick` allocates a 2-field object per pick (**40 B/op**) gives `soak: PASS`, exit 0.
- Clean `SOAK_LANES=RoundRobin` runs printed the very NOTE line (`hotAlloc[RoundRobin] max=0.143`) that M1–M4/M16 assert, in 2 of 3 runs. Those controls accept "exit 0 or 1 plus the NOTE", so **they pass even if the mutant does nothing**.

The comment says "PerfGate owns per-op 0 B/op". That's a reasonable split, but then the soak shouldn't claim an allocation gate, and its teeth shouldn't count as coverage.

The S1 false positives are no longer visible on HEAD: clean post-warm-up max was 0.026 B/op, and passMax 0.092 over 660 lane-cycles. So a middle tier is now safe.

**Fix:** FAIL at ≥ 1 B/op if it recurs in ≥ 2 post-warm-up cycles, and keep 0.02 as the NOTE level. Make M1–M4/M16 assert a FAIL with a magnitude.

### S3 [Medium] A short duration run FAILs `totalPicks` instead of being INCONCLUSIVE
**Files:** `gates.mjs:416-418`; `teeth.mjs:71` claims `gate=totalPicks` is unreachable

`SOAK_DURATION=10s SOAK_LANES=SED,NQ,SmoothWRR` at load 14.6 gave **FAIL: `gate=totalPicks … the soak did nothing`**. Cycle 0 took 13.3 s, so only the warm-up cycle ran, and `lanePicks` counts only post-warm-up cycles. Teeth I2 passes only because cycle 0 usually takes under 10 s, so it depends on load.

**Fix:** count warm-up picks in `totalPicks`, or report INCONCLUSIVE when `post === 0`. Correct the "unreachable" note.

### S4 [Medium] `soak:report` labels a genuine failure as tampering
- **A real A6 failure reads as tampering.** `SoakReport.mjs:245/253`: `trackFail` counts pool cycles, but `main.mjs` counts pool retention under `poolFailures`. Untampered streams with a real A6 breach report **"INTEGRITY MISMATCH"**, exit 1. Combined with §S1, every nightly failure would be reported as tampering. **Fix:** filter by `tier !== 'pool'`.
- **[Low] A signal-interrupted stream is called tampered.** `SoakReport.mjs:203`: SIGINT mid-cycle gives "ragged lane × cycle grid", INTEGRITY MISMATCH. The ADR says a signal stream is legitimate evidence. **Fix:** allow a partial final cycle when `reason === 'signal'`.
- **[Low] Red or skipped baselines are accepted.** A FAIL stream as `--baseline` gives "no regression", masking quality regressions because the check is `baseQ === 0 && curQ > 0`. A baseline that claims another schema skips integrity entirely. **Fix:** refuse a non-PASS baseline, and check integrity before the schema skip.
- **[Low] A parity MISMATCH still exits 0.**

### S5 [Medium] The nightly baseline can never bootstrap while §S1 exists
**File:** `soak-nightly.yml:64`

Baseline selection is sound: the last successful run on the same branch, staged only on `success()`, with `actions: read`. But the burn-in will almost never be green, so the run is never "success", `soak-baseline` stays empty, and the regression diff stays in bootstrap mode forever.

Also (Low): the fetch step runs `set -euo pipefail` under `if: always()`, so a transient API error fails the job.

### S6 [Medium] Heartbeat: an interrupted bounded run reports PASS
**File:** `pickEcosystem/live/test/heartbeat.mjs:237, 323`

`HB_CYCLES=40` with SIGINT after cycle 12 gives `heartbeat: PASS -- 14 cycles`, exit 0, `reason:"signal"`. The soak's S5 rule would give INCONCLUSIVE, and `heartbeat:teeth` has no signal control.

Otherwise the gate reuse is correct: same `EarlyLate`, `GATE_N`/`WARMUP`, heap formula and Mann–Whitney test. One small difference: the heartbeat's latency floor is 1 ms, while the soak's is 2 timer ticks.

### S7 [Low] Soak smaller items
- Any `unhandledRejection` is labelled `pool=A7` (`jsonl.mjs:74`), even when it has nothing to do with the pool.
- gcPause and rebuild are report-only by declaration, so they have no teeth; say so in ADR 0014's gate table.
- The ±20% RTT model self-check is telemetry, not an assertion.
- Eligibility never changes while an attempt is in flight in the pool simulation.
- Arrivals are batch-closed (128, then a full drain) rather than a steady open loop.
- With 2048 runs and 4096 keys, per-key failover stability is never exercised.
- ADR 0014's "20/20 PASS" acceptance predates S9/S10/S14 and 1.1.0, and hasn't been re-recorded.
- Teeth jobs upload only the log, and a MISS line shows just 110 characters of the first breach.

---

## §P — Capstone `pickEcosystem/`

**What's good:**
- A single `setEligible` funnel.
- BoundedLoad in lockstep under engine A (G8 calls `assertConsistent`).
- PeakEWMA gets a clock and failure penalties under engine A.
- Supervisor, escalation and reset are correct.
- 1000 respawns and 200 scope rebuilds were all collected, and a 3.5-minute run showed no heap trend.
- Engine A's zero-allocation gate has real teeth: a per-request allocation mutant was caught at 42.6 B/req.
- No XSS sinks fed with external data, and no `message` listeners.
- The site build and the composition graph are byte-exact.
- Tests are deterministic.

### P1 [High] A breaker gets stuck in HalfOpen when its probe's worker dies
**Files:** `pickEcosystem/live/fleet.js:154` (`onResult` returns early for `LWP_WORKER_DOWN`/`LWP_DISPOSED`), `_bringUp` (117-147), `tick` (196)

`onDispatch` sets `probeOut[i] = 1` for the single HalfOpen probe. If that probe's worker crashes or is killed, `onResult` ignores the result. `probeOut` stays 1, `bState` stays `half`, and `_bringUp` resets neither. After the supervisor restarts the worker healthy, the breaker never sends another probe, never closes, and never escalates. The worker is permanently out of rotation, and the event log's last word is "w1 restarted by its supervisor".

**Repro** (reproduced by me): `probe-h4e.mjs`, 20 s virtual. The final state is `bState:'half', probeOut:1, eligible:0`. A kill during the probe (`probe-h4b.mjs`) gives the same result. From the UI: `f` on a worker until its breaker opens, then `c` on it.

**Fix:** on `WORKER_DOWN`/`DISPOSED` while `bState === B_HALF && probeOut === 1`, clear `probeOut` and send `probeFail` to the statechart. Or reset the breaker to Closed/Open in `_bringUp`. Add a gate (G12) with a must-fail control.

### P2 [Medium] Under engine B, switching strategy to BoundedLoad leaves its occupancy total wrong
**Files:** `balancers.js:56-59`, `engine.js:97-99`

`Balancers.set` seeds the new balancer with every request in flight, but engine B's in-flight requests settle through the **old** Pool, so their `note(i, -1)` goes to the old balancer.

**Evidence** (`probe-h1.mjs`): engine A ends with `total 0` and `assertConsistent` OK. Engine B ends with `totalAfterQuiesce: 21` while `inflight` is 0, and `assertConsistent` throws. The cap inflates, and the inspector's "occupancy cap" is wrong. G8 only covers engine A, and the "engine B doesn't rebind its Pool" mutant survives.

**Fix:** give Pool a stable facade balancer that forwards to the current `bal.lb`, or drain and rebind at the switch. Run G8 under both engines.

### P3 [Medium] A DEADLINE shutdown leaves workers and timers running
**Files:** `kernel.js:213-227`, `page.js:283-292`

After `kernel.shutdown()` resolves with `code 2` (the orchestrator deadline), all 8 real threads are still ready and the cron keeps ticking (19 fleet ticks in the next second, `probe-h2.mjs`). The page then says "every worker retired" and lets the visitor boot a second system alongside the first. G11 only checks the exit code.

**Fix:** on a non-zero code, call `cron.stop()` and `set.dispose()` (terminate) before resolving. Word the page message by exit code. Extend G11 to assert zero live threads and zero timer ticks after shutdown.

### P4 [Medium] Overload is never shed, so the smoke gate and "0 failed" depend on the host
**Files:** `engine.js:89`, `kernel.js` DEFAULTS, `surface.js`, `test/smoke.mjs`

- **`S_SHED` can't fire.** The request table (`maxRequests` 1024) is larger than the fleet's queue capacity (8 × (2+32) = 272). Overload therefore becomes refused posts → failover → `failed`; a virtual run at 10k req/s gave 9202 failed and 0 shed.
- **Job cost is calibrated only in the browser.** `run.mjs`, the smoke and the TUI assume the reference machine's 180k units/ms; this box measured 59k under load.
- **The smoke result depends on the host.** At 800 req/s (the default) **and at 600 (the CI rate)** it fails here, with 8–9k of about 16k requests failed, failures starting at 1 s (before any fault), and a "crash loop → escalated" check missed. At 150 req/s it passes all 10 checks. CI is green only because GitHub runners are fast enough.

**Fix:** shed at admission once inflight reaches fleet capacity (count it as shed, not failed). Calibrate job cost on the Node surfaces as the browser does, or derive the smoke rate from a measured capacity, for example 50% of calibrated throughput.

### P5 [Medium/Low] Third-party code runs on the Pages origin with no integrity check
- **No integrity on the CDN modules.** There's no CSP on any page, and no SRI on the esm.sh import map (documented as a trade-off).
- **The drift test doesn't check content.** W1 compares URL strings with `package.json`, not file contents. An esm.sh rebuild or compromise therefore changes the deployed site without a commit, and deploys depend on esm.sh being reachable.
- **Not every module is pinned.** `lite-charts` imports `lite-scene` and `lite-axis` at runtime; they aren't in the import map, so esm.sh resolves `^1.0.0`/`^1.0.1` itself. "Every module is pinned" isn't literally true.

**Fix:** have `site.mjs` vendor the pinned entry files (the copies in `node_modules`) into the site, map them to same-origin paths, and add `Content-Security-Policy: script-src 'self'` (a meta tag on Pages). This also removes the runtime dependency on esm.sh for the deployed site.

### P6 [Low] Capstone smaller items
| Location | Issue |
|---|---|
| `traffic.js:41-48` | Arrivals are capped at about 745 per tick: `exp(-mean)` underflows, so any tick whose expected arrivals exceed ~745 yields ~745 (at 2000/s with 400 ms or 1000 ms ticks: 745.8). Stalls over ~372 ms under-offer load, and `rateUp` has no ceiling. **Fix:** draw in chunks with mean ≤ 500, and cap the rate. |
| `fleet.js:137-142` | `onDispatch` writes eligibility (`setEligible(false)`) but emits no event, despite the "tick is the only writer" claim in the header and README. Every HalfOpen logs "back in rotation" while the worker is out, and a tripped breaker keeps receiving traffic until the next 20 Hz tick (up to 50 ms; observed at 1548 → 1555). |
| `site.mjs` | Publishes any repo file a page references, dot-directories included: adding links to `../.github/workflows/ci.yml` and `../CHANGELOG.md` put both in the site, and S1 still passed, because its blocklist matches names only. It doesn't realpath-check symlinks, and its walk skips side-effect imports (`import './x'`). **Fix:** allowlist by directory and extension, reject dot-segments, realpath-check. |
| Tests | Surviving mutants: no `recordRtt` on a failed attempt; no failure-penalty floor (so no gate covers PeakEWMA avoiding a failing worker); engine B not rebinding (P2); HalfOpen admitting many requests instead of one probe. The hidden-tab pause/resume (`page.js`) has no test. |
| Hub / README | "Ten scenario gates, each with a control that must fail": G3, G7, G8, G9, G10 and G11 have no break control (G3 says so itself), and the README omits G11. The README cites "0 scavenges / 1.9M", while the test and hub use 960K and Node 22 gives 2 scavenges. |
| TUI | The "data X B/op (measured)" badge uses a retained-heap delta, the method the P1 spec's F1 correction rejected. |
| Version skew | The capstone depends on the *published* `@zakkster/lite-pick` 1.1.0, while the simulated page and G10 use the in-tree kernel. They're identical today, but once they diverge the deployed site will run two lite-pick versions, and capstone CI won't test the repo's kernel. Consider a CI variant with `npm i ../..` (link to the repo's own lite-pick), or a check that fails on divergence. |

---

## §T / §D — Tests, docs and packaging

### T1 [Medium] `test:perf` lane 18 still flakes, and the kernel change made it worse
**File:** `test/perf/PerfGate.test.mjs:69-78` (claims the lane finishes "well under 8 s")

The lane took 7.9–8.8 s at load 0.7–3.7, and 11.8–16.2 s under load. It failed 3 of 8 `test:perf` runs and 1 of 5 `test:perf:noinline` runs, always `oldgen 2 > 0` with 0 scavenges: V8's memory reducer firing at about 8 s. Running only that lane at load 15 failed 2/2 without `--no-memory-reducer` and passed 2/2 with it. K2 (the 1.2–1.5× slower fallback) is what pushed it over. `FB_CAP` is still 2048, and `os.loadavg()` isn't logged.

**Fix:** add `--no-memory-reducer` to both `test:perf` scripts (cheapest, and the most robust), or cut `FB_CAP` to 512, or fix K2. Log the load average.

### D1 [Low] Docs and packaging
- **D2 carry-overs:**
  - the H4 statement (`CHANGELOG.md:501-502`, `0013:104-106`)
  - "bitmap written by lite-di-health" (`README.md:24`, `Pick.js:13-15, 253`)
  - "M5 lite-query adapter" (`llms.txt:202,220`, `Pick.js:570,666`)
  - N4 wording (`README.md:219`)
- `Pick.js:1764-1765` still calls WeightedRandom's fallback "unbiased first-after-offset", which no longer matches the cumulative-weight walk.
- Broken anchor at `README.md:219, 249` (`#consistenthash--sticky--cache-affinity-routing-v080`; GitHub's slug has four hyphens). These are the only broken links across 60 relative links in 41 files.
- The `./package.json` export is still missing (D3).
- The `types-compat` consumer fixture doesn't exercise any 1.1.0 API.
- `PerfGate.test.mjs:12` still has the stale `grows` comment.
- **Info:** the tarball is now 136.4 kB packed / 411 kB unpacked (was 95.5 / 297), and `CHANGELOG.md` alone is 91 kB. Consider shipping a trimmed changelog, or linking to it.

**Verified fine:**
- 30 README/RECIPES snippets run against the packed tarball, with every `// ->` claim correct.
- ESM import works, and `require()` works on Node 20 and 22.
- The `.d.ts` exports match the runtime.
- `VERSION` is 1.1.0 everywhere.
- The demos run (TUI exits 143 on SIGTERM).
- `serve.mjs` passes every traversal, symlink, Host and method probe.

---

## Suggested fix order

1. **C1:** switch the Pages source to GitHub Actions and re-run CI. This takes minutes and turns `main` green.
2. **S1 + S5:** a time-bounded retention drain and a full-roster pass-control. This unblocks the nightly and its baseline.
3. **P1** (the breaker stuck in HalfOpen), with a gate.
4. **S2:** restore a hotAlloc FAIL tier and real teeth. **T1:** `--no-memory-reducer` for `test:perf`.
5. **P2, P3, P4:** capstone correctness under engine B, shutdown on deadline, admission shedding with calibrated rates.
6. **S3, S4, S6:** remaining INCONCLUSIVE and report-labelling issues.
7. **C2, C3:** CI hardening, tags and provenance. **P5:** vendor the CDN modules and add a CSP.
8. The Low items, including K1–K11, N6, L7 and docs.
