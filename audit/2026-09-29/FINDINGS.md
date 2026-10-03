# lite-pick — Re-audit Findings (1.0.1 + soak redesign)

**Scope:** commit `1848f7b` (`main`), version `1.0.1`. This re-audit follows up on [`audit/2026-09-26/`](../2026-09-26/FINDINGS.md). It covers:

- the kernel and Pool fixes (`8c1ecc7..1848f7b`)
- the new soak harness (`benchmark/soak/*`, ADR 0014)
- tests, CI, types, docs, packaging and demos

The **soak harness gets the deepest treatment**, as requested.

**Method:** I read every changed file, reproduced every claim below with a script or a run, and wrote a mutant or control wherever a gate was supposed to "have teeth".

**Environment:** Node 22.22.2 (the Node version the nightly soak pins), Linux, 4 vCPU. Several audit jobs ran in parallel, so load average reached 3–8 at times. Every timing-sensitive result says whether it was measured under load. A loaded box is a fair stand-in for a shared GitHub runner.

---

## Executive summary

The 1.0.1 release fixes most of the previous audit:

- **Tests:** 189 unit tests (up from 138). A mutation spot-check killed 24 of 27 kernel/Pool mutants.
- **Gates with real teeth:** torture now has a must-fail control, and PerfGate catches injected allocations.
- **Types:** there is a types-compat matrix that fails when it should.
- **Security:** the demo server is locked down.
- **CI:** a working CI workflow now exists.

The **new soak** is ambitious and mostly well-designed: per-lane time-axis gates, post-GC heap sampling, quality oracles, Pool lanes, a teeth battery, an integrity-checking report tool, and provenance. But **as shipped it is not yet trustworthy as a gate**:

1. **`npm run soak` fails on the clean kernel.** It failed in both default full-roster runs (15 breaches across 12 lanes in the one I analysed), and also in several subset runs. Most breaches come from **harness-induced JIT state**: the kernel measures 0 B/op when isolated. The rest are timing gates that can't absorb noise (§S1, §S2).
2. **`npm run soak:teeth` fails on the clean tree**, because its pass-control trips those same false positives (§S3).
3. **The harness's own memory growth trips its heap gate on long runs.** It keeps every cycle record in memory, and the heap gate false-FAILs after about 3,000 records. At about 24 records per full cycle that is roughly 110–125 cycles, about 30–35 minutes on this box, so a 45-minute nightly will likely fail and an 8-hour burn-in certainly will (§S4).
4. **Interrupted or short runs report PASS (exit 0)**, even though the ADR says "never a silent PASS" (§S5).
5. **The kernel-hash ("parity") gate named in ADR 0014 does not exist** (§S6). The pool lanes don't use the discrete-event model the ADR describes (§S9), and several gates and modes have no teeth, or teeth that do nothing (§S8).

Outside the soak:

- `test:perf` is still intermittently red: 3 of 11 runs failed (§T1).
- RECIPES §8 still teaches the PeakEWMA black-hole pattern the kernel fix removed (§D1).
- One SmoothWRR test is vacuous, so a mutant that reverts the eligibility reset survives (§T2).

| Severity | New findings |
|---|---|
| High | 5 (all in the soak) |
| Medium | 13 (8 soak, 2 Pool regressions, 3 tests/docs) |
| Low | ~25 |

On top of those, **7 findings from the previous audit remain open**: L2, L3, L4, L7 and L8 with no code change and no mention anywhere; M5 and L14 deferred and documented as such. H2 is also deferred and documented, and H4 is only partially resolved (see §K).

---

## Results of running the scripts

| Script | Result | Notes |
|---|---|---|
| `npm test` | ✅ 189/189 | Node 22; also Node 18.20.8 |
| `npm run test:types` + consumer fixture (TS 5.9: node16/node10/bundler/ES2022) | ✅ | The fixture has teeth: removing `typesVersions` or `exports["./pool"]` breaks it |
| `npm run torture` | ✅ | The must-fail control trips at 40 B/op |
| `npm run witness` | ✅ | 191 s under load |
| `npm run balance` / `fuzz` | ✅ | |
| `npm run verify` | ✅ one full run (257 s) | But see `test:perf` |
| `npm run test:perf` | ⚠️ **8 of 11 passed** | #2 detector validation failed twice (once at load 1.0). #18 WeightedRandom heavy-outage failed once with `oldgen 2 > 0` under load |
| `npm run bench:verify` | ✅ | |
| `npm run bench:gc` | ⚠️ failed 3/3 under load, passed 2/2 quiet | absolute `maxPause ≤ 2 ms`; not in `verify` or CI |
| **`npm run soak` (default, 7 cycles)** | ❌ **FAIL on the clean kernel** (both full-roster runs) | about 115 s; breaches listed in §S1/§S2 |
| **`npm run soak:teeth`** | ❌ **FAIL on the clean tree** | 4 min 15 s; the pass-control `P` failed 3/3 |
| `npm run demo` / `scope:frames` | ✅ | |
| CI workflow syntax | ✅ | actionlint clean; least-privilege `contents: read`; no script injection |

---

## §S — The soak harness (`benchmark/soak/*`)

### What's good
- **Configuration fails closed.** Bad, unknown or out-of-range `SOAK_*` values exit 2, with a did-you-mean hint for typos. `SOAK_CYCLES=abc`/`-5` and `SOAK_PICKS=xyz` now fail as they should.
- **Per-lane early/late gates across cycles, with an explicit SMOKE state.** This fixes the lane-versus-lane and JIT-warm-up problems of the old harness.
- **Heap is sampled strictly after the forced GC, and the GC profiler is reset around it.** The workload's major-GC and pause figures are no longer polluted by the forced GCs.
- **Distinct seeds per lane and cycle.** Seeds are derived from an fmix32 bijection and self-checked for collisions at startup.
- **The PeakEWMA oracle discriminates well.** An RTT-ignoring mutant and a uniform-random mutant were both flagged 10/10 at 100% and 60% eligibility; the real kernel was flagged 0/10.
- **The DES heap is correct.** It had 0 mismatches against a sorted reference over 200 × 5000 random operations, the clock is monotone, and mean service is ≈1000 µs for both distributions.
- **The Pool lanes are deterministic and fail closed.** The same seed gives identical records, and a lost run is caught by the batch deadline plus the `beforeExit` hook.
- **The teeth runner checks the breach text, not just the exit code.** The 1.0.0-revert case fails closed in a shallow clone.
- **The report tool detects most tampering:** an edited verdict, dropped or duplicated cycles, truncation, empty or missing files, a fatal-only stream, and a flipped pool assertion. Its HTML escapes every string field.

### S1 [High] The hotAlloc gate false-FAILs on the clean kernel because of JIT state the harness induces
**Files:** `benchmark/soak/hot.mjs:178-255`, `benchmark/soak/main.mjs:253, 490`, `benchmark/soak/gates.mjs:146-187`

**Evidence.** In a default `npm run soak`, the clean kernel failed with:
`hotAlloc[NQ] max=7.867`, `hotAlloc[PeakEWMA] … in 5 cycles`, `hotAlloc[NQ#tiny] max=7.861`, `hotAlloc[BoundedLoad#tiny] max=7.862`, `hotAlloc[LeastConn#tiny] …`, `hotAlloc[PeakEWMA#tiny] …`.

The values are *quantized*: 7.86, 10.53, 11.72, 14.53, 15.65 and 19.78 B/op, which is about one 16-byte HeapNumber every 1–2 operations. They appear in some cycles and not others. Two subset runs (`SOAK_LANES=NQ,PeakEWMA,BoundedLoad`) failed the same way.

**Root-cause isolation:**

| Experiment | B/op |
|---|---|
| Same lane step, kernel replaced by a stub | **0.00** in all cases |
| NQ / PeakEWMA, 1st measurement in a fresh process | 8.04 / 11–14 |
| NQ / PeakEWMA, 2nd–6th fresh instance | 0.00 |
| Same, with 3M warm-up operations | still 7.84 / 13.91 on the 1st measurement |
| Same, with `--no-concurrent-recompilation` | **0.00–0.01** (kernel lanes) |
| PeakEWMA at cap=8, `recordRtt` stubbed vs `pick` stubbed | allocation is in `recordRtt` (15.55), not `pick` |
| **Plain monomorphic loop, 3 instances × 5M `recordRtt` calls** | instance 1: 0.23 B/op (warm-up); instances 2–3: **0 B** |

`--trace-deopt` shows `hotLatency`/`hotLoad` being deoptimized ("reason: code dependencies") and recompiled when each lane-cycle builds new balancer and context instances. Until the recompile lands, the step runs unoptimized code that boxes doubles.

The four family step functions are shared by up to 20 lanes (kernel and tiny tiers). Each lane-cycle constructs a new balancer, `HotCtx` and `EventQueue`, so the probe regularly lands in a deopt/recompile window. How often depends on V8 version and CPU contention, because recompilation is concurrent.

**Conclusion:** the kernel is 0 B/op; PerfGate and my isolated loops agree. The soak's B/op probe measures harness JIT state. Because the cross-cycle recurrence rule counts every lane-cycle, a harness pattern that recurs every cycle is guaranteed to read as a "periodic allocation".

**Fix (any one of these; the first two are cheapest):**
1. Add `--no-concurrent-recompilation` to the `soak` script and the nightly command, and assert it the way semi-space pinning is asserted. This alone cleaned the kernel lanes after cycle 0 in my runs. The tiny lanes still failed, so combine it with 2 or 3.
2. Before accepting a positive B/op, re-warm and re-measure up to K times. Count it only if it persists: a real per-op allocation persists, a tier-up transient doesn't.
3. Run the B/op probe in a fresh child process (or `Worker`) per lane with monomorphic, per-lane step clones. That is the same isolation PerfGate uses, and it is where the zero-GC proof belongs anyway.
4. Or use `--allow-natives-syntax` and `%GetOptimizationStatus(step)` to assert the step is TurboFan-optimized before measuring, and report INCONCLUSIVE instead of FAIL otherwise.

### S2 [High] Timing gates can't absorb normal noise (gcPause, hotOps, hotOpsSparse)
**File:** `benchmark/soak/gates.mjs:21-23, 212-227`

**Evidence (clean kernel):**

| Breach | Where |
|---|---|
| `gcPause[BoundedLoad] late=4.96ms > limit=3.46ms` | default run |
| `gcPause[LeastConn#tiny] 4.44 > 3` | default run |
| `gcPause[PeakEWMA] 8.68 > 6.78` | subset run |
| `gcPause[PeakEWMA#tiny] 6.45 > 2.4` | subset run |
| `hotOpsSparse[SED] late=1346203 < limit=1377405` | default run |
| `hotOps[RoundRobin] dense late=80576217 < limit=116933033` | 8 s duration run |
| `hotOps[RoundRobin] … 135112130 < 153645391` | 1500-cycle run |
| `gcPause[RoundRobin#tiny] 2.66 > 2.33` | teeth pass-control |

The reasons:

- **Windows are too small.** With N=3, a single noisy cycle moves the median of three.
- **The gcPause gate compares a per-cycle *max* pause, which is extreme-value noise, against `early·2 + 1 ms`.**
- **RoundRobin/CH/WR dense batches are 500k picks at 60–120M ops/s, about 4–8 ms per batch**, which is too short to time reliably on a shared CPU.

**Fix:**
- Size batches by **time** (for example ≥ 50 ms per repeat), not by count.
- Gate throughput with more cycles (for example N ≥ 5, or a trimmed mean), or make the ratio adaptive to the observed early-window variance: FAIL only if `late < early − k·MAD`.
- Gate the *median* GC pause (or p90 over all pauses in the cycle), not the per-cycle max, with an absolute floor of a few ms.
- Keep the max pause as report-only telemetry.

### S3 [High] `soak:teeth` is red on the clean tree
**File:** `benchmark/soak/_mustfail.mjs`

Its first case, `P clean kernel (pass-control)`, runs the real soak on the clean kernel and expects exit 0. It hits §S1/§S2 and failed 3 of 3 attempts, each time on a different gate: `hotAlloc[RoundRobin]`, `hotOps[RoundRobin]`, `gcPause[RoundRobin#tiny]`. The `M16` mutant also tripped `hotOpsSparse[RoundRobin]` instead of its intended `hotAlloc`.

The nightly workflow runs teeth *first*, so the job will likely fail before the burn-in even starts.

**Fix:** fix S1/S2. Until then, have the pass-control assert only the non-timing families (invariants, quality, pool, retention), and move timing gates to a separate, statistically robust control run.

### S4 [High] The harness's own memory growth trips its heap gate on long runs
**File:** `benchmark/soak/main.mjs:137, 553, 633` (`rollups.push(...)`)

`main.mjs` keeps **every** cycle record in the `rollups` array for the whole run, and `computeGates` re-filters it at the end. ADR 0014 and `gates.mjs` describe the gate accumulators as O(1) memory, but the input they're fed is unbounded.

**Evidence:** `SOAK_CYCLES=1500 SOAK_PICKS=20000 SOAK_LANES=RoundRobin` (2 lanes, 3000 records). Post-GC `heapUsedMB` grew linearly:

| Cycle | 1 | 100 | 500 | 1000 | 1499 |
|---|---|---|---|---|---|
| heapUsedMB | 7.1 | 7.5 | 8.3 | 9.3 | 10.2 |

That is about **1 KB per record**. The run ended with `heap[RoundRobin#tiny] late=10.2MB > limit=9.9MB` → **FAIL**. The records are about 1.1 KB of JSON each, with about 24 records per full-roster cycle.

**Consequences:**
- The heap gate's slack (`early × 1.10 + 2 MB` ≈ 2.8 MB on an 8 MB heap) is used up by the harness after about 2,800 records. For the full roster that is roughly 110–125 cycles, about 30–35 minutes at the ~16 s per cycle measured on this box.
- A 45-minute nightly will likely false-FAIL. An 8-hour `SOAK_DURATION` burn-in certainly will.

**Fix:**
- Feed each record into per-lane `EarlyLate` accumulators as it's produced, and keep only those accumulators, the last-N ring, and the RSS list, capped, or keep median/p95 sketches. The JSONL on disk is already the durable record for `soak:report`.
- Add a teeth case: a clean soak with 2,000+ cycles on a fast lane must PASS the heap gate. A clean long run should itself be a pass-control.

### S5 [High] Interrupted and short duration-bound runs report PASS (exit 0)
**Files:** `benchmark/soak/main.mjs:215-222, 517-518`, `benchmark/soak/gates.mjs:193-199`, `config.mjs`

ADR 0014 says: "INCONCLUSIVE and an unverifiable state exit 3 (fail closed), never a silent PASS."

**Evidence:**

| Run | Result |
|---|---|
| `SOAK_LANES=SED,NQ,SmoothWRR`, non-smoke, **SIGINT after 1 of 7 cycles** | summary `reason:"signal"`, `verdict:"PASS"`, all drift gates `SMOKE`, **exit 0** |
| `SOAK_DURATION=10s`, same lanes, non-smoke | 2 cycles run; every drift gate `SMOKE`; prints **`soak: PASS`** (no smoke caveat, because `gate.active = !opts.smoke`); **exit 0** |

The gates only treat "below the active floor" as SMOKE, and SMOKE never fails a run, even when the user did *not* ask for a smoke run.

The same applies to a nightly cancelled by `timeout-minutes` (SIGTERM → `summarize('signal')` → PASS). GitHub still marks the step failed on timeout, but a local or cron wrapper wouldn't.

**Fix:** when `!cfg.smoke` and any lane has `post < 2N`, the overall verdict is **INCONCLUSIVE (exit 3)**. That covers signals, too-short durations, and a `SOAK_CYCLES` below the floor, which is already rejected. Print "PASS (smoke)" only when `cfg.smoke` is set.

A related issue: the deadline is checked only at cycle start (`main.mjs:518`), so a run overshoots by up to one cycle (about 16 s here). That's fine for a 45-minute budget, but worth documenting.

### S6 [Medium] The kernel sha256 "parity gate" in ADR 0014 doesn't exist
**Files:** `decisions/0014-soak-redesign.md` (Context), `benchmark/soak/provenance.mjs`

The ADR says: "`Pick.js`, `Pool.js`, `Pick.d.ts`, `Pool.d.ts` and `test/invariants.mjs` are byte-identical … (a sha256 parity gate enforces it)."

A repo-wide search finds sha256 **only** in `provenance.mjs`. There it records `pickSha256`/`poolSha256` in the header and compares them against nothing. `Pick.d.ts`, `Pool.d.ts` and `invariants.mjs` aren't hashed at all.

In addition, `provenance.mjs:23` hashes the in-tree `Pool.js` even when `SOAK_POOL` points at a mutant, so the header records the wrong hash (verified: the header said `28a1041e…` while the mutant was `5859cfff…`). There is also no `poolOverride`/`kernelOverride` flag in the header.

**Fix:**
- Add the parity check the ADR describes, as a CI step or a teeth case: hashes pinned in a JSON file, or compared against `git show <base>:<file>`.
- Hash the *loaded* `KERNEL_URL`/`POOL_URL` and record `KERNEL_OVERRIDE`/`POOL_OVERRIDE`.
- Have `soak:report` refuse to treat an overridden-kernel stream as a release soak.

### S7 [Medium] The P2C quality oracle's bound is 3–4× too loose to catch partial regressions
**File:** `benchmark/soak/oracles.mjs:62-80`

The bound is `4·log2(ln live) + 4`, which is 13.9 at live=256, 12.2 at 64 and 9.9 at 16. Measured over 400 seeds × 32 balls per bin, the healthy P2C *max* gap was **3 at every size**.

| Mutant | Detection rate (live ≈ 100% / 25% / 6%) |
|---|---|
| Uniform random (one choice) | 20/20 · 20/20 · 18/18 |
| **Ignores load on 50% of picks** | **0/20 · 0/20 · 0/18** (gap p50 3–5, p99.75 6–11, all under the bound) |
| Ignores load on 80% of picks | 16/20 · 9/20 · 5/18 |

**Fix:** calibrate from the healthy distribution, for example `ceil(log2(ln live)) + 3` (6 at live=256), which is still at least 2× the observed healthy maximum. Add the 50%-ignore mutant to teeth.

### S8 [Medium] Several gates and modes have no teeth, or teeth that do nothing
**Files:** `benchmark/soak/_mustfail.mjs`, `benchmark/soak/config.mjs:41-44`

- **No teeth case at all:** `heap`, `rss`, `gcMajor`, `hotOps`, `hotOpsSparse`, `gcPause`, `rebuild`, `totalPicks=0`, kernel-lane retention, `phasesNotFired`, the INCONCLUSIVE exit 3, findings/warnings, and pool A4 (rejection codes).
  - The `leak`, `heap`, `rss`, `decay` and `poolbadcode` *modes* exist and do trip their gates when run by hand, but teeth never runs them.
- **Modes that do nothing:**
  - `SOAK_MUSTFAIL=pooldrop` is accepted by `config.mjs`, whose comment claims every mode is wired to trip a gate, but it is **implemented nowhere**: `SOAK_LANES=PoolP2C SOAK_MUSTFAIL=pooldrop` gives `PASS`, exit 0.
  - `weight0` on SmoothWRR gives PASS (default picks) or exit 3 (20k picks). It only trips WR and CH.
  - `decaysparse` trips dense `hotOps` and `hotAlloc`, not `hotOpsSparse`.
- **The rebuild-latency gate can never activate.** It needs `LAT_MIN_SAMPLES = 2000` samples per early/late window, but rebuilds are capped at 8 per cycle (`main.mjs:315`), so every lane reports `STUB insufficientSamples` forever. It is dead code presented as a gate.
- **Pool A3 "accounting"** (`resolved + rejected === launched`) is true by construction once `allSettled` resolves (`pool-lane.mjs:190`). It can only fail through `lostRun`.

**Fix:**
- Add a teeth case per gate, and a meta-test asserting that every gate name in `gates.mjs`, every oracle and every pool assertion appears in at least one teeth case.
- Implement or remove `pooldrop`.
- Make `weight0` target SmoothWRR.
- Either give the rebuild gate enough samples (a dedicated rebuild micro-bench) or label it report-only in the verdict output.

### S9 [Medium] The pool lanes don't use the discrete-event model, and PeakEWMA gets meaningless RTTs
**File:** `benchmark/soak/pool-lane.mjs:107, 122, 129`

The ADR says pool lanes are "driven by the DES". In practice they only do `vclock += q.sampleServiceUs(i)`. They never call `pushCompletion`/`pop`, so completion order is microtask order. `EventQueue.now()` and `parkHung` are never called anywhere.

All 128 runs in a batch dispatch at the same `vclock`, so each RTT is roughly the batch's *summed* service time. Instrumented PoolPeakEWMA RTTs (mean service 1000 µs):

| min | p10 | p50 | p90 |
|---|---|---|---|
| 25,542 | 43,387 | 142,711 | 1e9 |

1,064 of 2,822 samples were the 1e9 failure penalty.

- **Units are mixed:** the clock is in µs, while Pool and PeakEWMA are configured in ns (`tauNs=1e6`, `failurePenaltyNs=1e9`).
- **"hung" is just failAll with a different code;** nothing ever hangs.
- **Kernel lanes:** `hotLatency`'s `ctx.now` (+1..1024 per pick) isn't tied to the DES clock either.
- **Processor-sharing uses a global `conc = cap >> 1`,** so the slowdown is about 1.004× except during the +50 "hung" phase.

**Fix:** drive pool settles from `q.pop()` order with a `clock()` in ns, park hung runs for real and release them at phase end. Or correct the ADR/header claims so the soak doesn't advertise a queueing model it doesn't run.

### S10 [Medium] The pool assertions can't see a dispatch to a down node
**File:** `benchmark/soak/pool-lane.mjs`

Eligibility is constant within a batch and `fn` never checks `eligible[i]`. A Pool mutant whose `_scanUntried` ignores eligibility **exited 0 across all 4 pool lanes**.

**Fix:** have `fn` fail its assertion when `eligible[i] !== 1` at dispatch.

### S11 [Medium] Teeth matching is a loose substring search over all of stderr, stack traces included
**File:** `benchmark/soak/_mustfail.mjs:93`

`stderr.indexOf(wantBreach)` matches anything. The A7 cases (`MP7`, `MPm3`) never reach the A7 counter: the fatal `unhandledRejection` handler exits first, and the string `unhandled` in its message matches. Mutant file names embed the case name (`pool-40-MP7poolunhandledA7.js`), so any crash with a stack frame in the mutant matches too.

Verified: a mutant that throws an *uncaught exception* in a `setTimeout` "passes" the A7 case. Similarly `'quality'` would match a crash inside `quality.mjs`.

**Fix:**
- Match only lines beginning `^soak: FAIL -- (gate|quality|pool assertion …)`.
- Have `main.mjs` print the failed pool assertion's id (A1–A7).
- Treat any `uncaughtException`/`mainRejection`/`TypeError` in stderr as a MISS unless the case expects it.

### S12 [Medium] `soak:report` integrity can be bypassed by deleting fields
**File:** `benchmark/soak/SoakReport.mjs:129-130, 84, 300-307`

- **Missing counters are skipped, not failed.** The cycle counts are checked only when `typeof summary.rollups/cyclesRun === 'number'`. Dropping 8 of 12 cycle records *and* deleting those two summary keys gives `re-derived=PASS [integrity OK]`, exit 0, even though `header.config.cycles` shows cycles are missing.
- **`seq` is ignored,** so gaps and duplicates in the sequence numbers go unnoticed.
- **A `fatal` record after an `end` summary is ignored.**
- **`--baseline` quality compares `quality.violations`, not `totalViolations`,** so weight-0 and chi-square regressions don't register (verified: a `weightZero=1` regression gave "no regression", exit 0).
- **Pool lanes are excluded from the baseline diff,** and the baseline's own integrity is never checked.
- **A string-typed `summary.breaches` crashes the tool** with a TypeError.
- **The HTML shows neither the integrity status nor any fatal messages.**

**Fix:** require the counters (fail closed); require `seq` to be contiguous from 0 to n−1; require a full cycle grid equal to `header.config.cycles` for cycle-bound runs; treat any `fatal` record as a failure; use `totalViolations`; include pool lanes in the baseline diff; validate the baseline; and render integrity status and fatal messages in the HTML.

### S13 [Medium] `_probe.mjs` fails on the clean tree and says nothing about why
**File:** `benchmark/soak/_probe.mjs:144`

It reported `latency sampler B/op = 31.9 / 43.5 / 31.9` in 3 runs, against a limit of 0.05, and exited 1. The detail block has no line for this failure, and the probe isn't wired into any script or CI job, so nobody would notice. Its failure also contradicts the "0-B/op latency sampler" claim in `main.mjs:258-260`. That is likely the same JIT-state issue as §S1, but the probe is the one place that's supposed to prove it.

**Fix:** wire it into `soak:teeth`, give it a failure line, and apply the §S1 isolation.

### S14 [Low] Soak smaller items
| Location | Issue |
|---|---|
| `oracles.mjs:23-39` | The LeastConn/SED/NQ oracle hard-codes "tie → lowest index". The kernel now documents tie order as *unspecified* (rotating tie-break planned for 1.1.0), so that planned change will break the oracle. Check `pick ∈ argmin set` instead. |
| `oracles.mjs:121-151`, `invariants.mjs` | The BoundedLoad and ConsistentHash oracles re-implement the kernel's walk (reading `_m`, `_lookup` and `_eps`). They catch regressions but not *design* errors, since a bug shared by both passes. Add property oracles: max inflight ≤ cap+1 when an under-cap node is reachable; stickiness ≥ X% at low load; ≤ ~1/N keys moved on removal. |
| `oracles.mjs:174` | The PeakEWMA oracle's drain pattern `(d & 7) === (t & 7)` inside `(t & 3) === 0` only ever drains nodes with `d & 7 ∈ {0, 4}`; 75% of nodes are never drained. The oracle still discriminates (see above), but it doesn't model what its comment says. |
| `main.mjs:307-310, 366-370`, `oracles.mjs:127` | Chaos writes `built.b._weights` directly because the kernel has no batch-reweight API. A kernel rename would silently turn the `allZero` phase into a no-op (`if (bw)`). Add a public `setWeights(array)` (one rebuild), or assert the private field exists. |
| `quality.mjs:163-188` | The WeightedRandom chi-square's only must-fail is "everything to node 0", so its power is unproven. Add a teeth case perturbing one weight by 5–10%. |
| `pool-lane.mjs` | The A1 cap check uses a `T` that already includes the whole batch; it catches "no cap" but not the H4 off-by-one (0/20). Each key is used once per cycle, so per-key failover stability is never exercised. |
| `_mustfail.mjs:60, 82` | `execFileSync` has no `timeout`, so a mutant stuck in a loop hangs until the 60-minute CI limit. It spawns `'node'` from PATH rather than `process.execPath`, and never removes its temp directory. |
| `provenance.mjs:35` | Runs git with no `cwd` (the SHA depends on where you start the process) and lets "fatal: not a git repository" through to stderr. `dirty` counts untracked files. |
| `gates.mjs:25` | The constant `LAT_P999_MULT` gates p99; rename it. |
| ADR 0014 | Mentions `latency.mjs`, which doesn't exist (the sampler is inlined in `main.mjs`). |
| `.github/workflows/soak-nightly.yml` | Budget: teeth ≈ 4 min + 45 min + ≤ 16 s overshoot + setup ≈ 51 min against `timeout-minutes: 60`, so there's headroom, but the real risk is §S1–§S4. |

---

## §K — Kernel and Pool fixes (verification of the 2026-09-26 findings)

**Gates:**
- **The zero-allocation claim holds for every new code path.** A 1 MB semi-space probe over 4M operations each saw **0 minor GCs**, while a must-allocate control saw 126. The paths covered:
  - SmoothWRR with weight-0 nodes
  - BoundedLoad's ceil cap
  - PeakEWMA's busy floor and unsampled-busy pricing
  - `_vIdx` churn
  - `note`
- **Tree-shaking still works:** an entry that imports only RoundRobin keeps just `BalancerBase`, `RoundRobinBalancer` and `_vIdx`, under both esbuild and rollup.
- **`Pool.js` stays browser-safe:** no `node:` imports, `process` or top-level await.

**Old-versus-new benchmark on the same machine, interleaved:**
- **SmoothWRR:** about **−18 to −22%**. This is the cost of skipping weight-0 nodes in the loop; it is acceptable, but disclose it.
- **BoundedLoad:** about **−21% on average** (−12 to −32%), mostly from `Math.ceil` (see N3).
- **Everything else:** within noise.

| # | Status | Evidence |
|---|---|---|
| H1 PeakEWMA black hole | ✅ **Fixed** (Low residual: N5) | Fast-failing node: 10/2000 failures (was 988). Hung node, unsampled and pre-sampled: 1/10 000 dispatches (was 4891) |
| H2 direct/shared eligibility writes | 📄 **Documented as undefined behaviour**; the `Eligibility` object is deferred to 2.0 | Still reproduces: `live 0`/`pick −1` with a node up; SmoothWRR `[31132, 28868, 0]` |
| H3 SmoothWRR weight-0 picks | ✅ **Fixed** | 400 seeds × 20k random ops: 0 weight-0 or ineligible picks; the total stays in sync; the accumulator sum stays bounded (max \|Σ\| 76) |
| H4 BoundedLoad low-load stickiness | ⚠️ **Partial**: the formula follows the paper (ceil, +1), but low-load behaviour is essentially unchanged, and ADR 0013 reclassifies it as by-design | n=10, eps=0.25: the 2nd same-key request still overflows; 5 concurrent same-key requests still land on 5 backends; still overflows even at eps=1.0 (see N4) |
| M1 non-integer indices | ✅ **Fixed** | `1.5`, `NaN`, `−1`, `'2'`, `Infinity`, `2^32`, `null`, `true` all throw; `live` is unchanged; `isEligible` returns false |
| M2 distinct failover | ✅ **Fixed** | ConsistentHash `tries:3` → `[3,2,4]`; WeightedRandom 0/1000 repeats; LeastConn `[0,5]` → `[0,1]`; in-flight net-zero |
| M3 keyed Pool without key / key–clock conflation | ✅ **Fixed** (but see N2) | `LITE_PICK_KEY_REQUIRED` / `LITE_PICK_CLOCK_REQUIRED`; PeakEWMA with `{key, clock}` receives `now` |
| M4 feedback throw causes a retry | ✅ **Fixed** | `fn` runs once; `LITE_PICK_FEEDBACK`; the result is preserved |
| M5 LeastConn/NQ tie skew | 📄 **Deferred to 1.1** (tie order documented as unspecified) | Still `[1000,0,0,0]` |
| L1 `run(fn, null)` | ✅ **Fixed** | |
| L2 biased fallback scan | ❌ **Not fixed, not mentioned** | 63.5/36.5 split; the "unbiased" comments remain at `Pick.js:420, 1269` |
| L3 ConsistentHash probe exhaustion | ❌ **Not fixed, not mentioned** | 60 of 64 down: 1.17% `PICK_NONE` |
| L4 PeakEWMA w² blend | ❌ **Not fixed, not documented** | 324.97 (code) vs 557.52 (Finagle) |
| L5 tau wording | ✅ **Fixed** | |
| L6 negative `dt` | ✅ **Fixed** | |
| L7 unbounded M | ❌ **Not fixed** (code inspection only) | `Pick.js:1039` is unchanged |
| L8 `nextBelow` comment | ❌ **Not fixed** | `Pick.js:124-126` |
| L14 ConsistentHash `_build` allocation | 📄 **Documented** (ADR 0010 amendment) | Code unchanged |
| L15 / L16 types | ✅ **Fixed** | |

### New kernel and Pool findings

#### N1 [Medium] A caller abort is recorded as a 1-second latency penalty
**File:** `Pool.js:292-318`

In the `catch` branch, the H1 penalty `recordRtt(i, max(elapsed, failurePenaltyNs))` runs **before** the `if (signal && signal.aborted)` check. A user cancel (a query cancelled on unmount, a request timeout on the caller's side) therefore pushes that endpoint's EWMA to 1e9 through the peak rule, and permanently inflates the lifetime mean `_samp` that prices unsampled-busy nodes.

Repro: 100 settles at 1 ms, then one abort mid-flight:
- the EWMA becomes `[1e6, 1e6, 1e9, 1e6]`
- the lifetime mean goes from 1e6 to 1.09e7
- the aborted endpoint is shunned (the next 1000 hits are `[269,263,200,268]`)

**Fix:** skip the penalty when `signal?.aborted` (or when the error is an `AbortError`) at catch time. Consider keeping penalty samples out of `_samp` entirely: record them in the EWMA only.

#### N2 [Medium] `opts.key` no longer reaches a duck-typed keyed balancer (backward-compat regression)
**File:** `Pool.js:180, 252`

In 1.0.0, `run(fn, {key})` called `pick(key)` on any balancer. 1.0.1 passes the key only when `constructor.KEYED === true`. A wrapper, decorator, or custom consistent-hash balancer without the marker now silently receives `pick()`, so the key becomes 0 and everything goes to one backend. That is the M3 foot-gun, now hitting callers who *did* pass a key.

Repro: a plain-object wrapper around ConsistentHash with 200 distinct keys reached **1 backend**; direct `pick(key)` reaches 8. The CHANGELOG keeps 1.0.0 behaviour for unmarked *latency* balancers, but not for keyed ones.

**Fix:** if `opts.key` is supplied and the balancer is unmarked, call `pick(key)` as 1.0.0 did. Alternatively throw `LITE_PICK_KEY_UNSUPPORTED`, but never silently drop the key.

#### N3 [Low, performance] `Math.ceil` in the BoundedLoad cap is a no-op that costs 15–20%
**File:** `Pick.js:1227`

The code's own comment (and ADR 0013) says `ceil` changes nothing for the integer test `inf < cap`. A microbenchmark gave 100–102k ops/ms without it and 80–89k with it, which is most of the BoundedLoad regression.

**Fix:** drop `Math.ceil` and keep the comment explaining the equivalence.

#### N4 [Low, docs/behaviour] "A larger eps buys low-load stickiness" is misleading
**Files:** `README.md:213`, ADR 0013 Fork 4

For a 2nd concurrent same-key request to stay home you need `(1+eps)·2/live > 1`, which means eps > 4 at n=10 and eps > 31 at n=64. At those values hotspot protection is effectively off.

**Fix:** state plainly that CHBL gives up affinity at low concurrency. Or add an opt-in `minCap` (for example `max(minCap, ceil(...))`) so users can keep affinity for the first k concurrent requests per backend.

#### N5 [Low] A hung, never-sampled node has no time-based cost floor
**File:** `Pick.js:845-846`

Its cost `(inflight+1)·mean` grows only with in-flight count. A sampled busy node, by contrast, is floored at `dt` and gets more expensive over time. Under concurrency 128, an unsampled hung node absorbed 49 stuck requests (38% of concurrency), against 24–30 per healthy node. This is bounded and small, and client timeouts turn it into the penalty path.

**Fix:** the planned 1.1 "busy-since" stamp.

#### N6 [Low] Keyed failover gives the failed backend's neighbour a double share
**File:** `Pool.js:50-56, 262-264`

The fallback scan picks the "first untried eligible after a start point", so a start that lands on the failed node rolls on to its neighbour. For keys homed on backend 3 of 16, backend 4 received 159 of the failed-over keys against about 77 for every other backend. This is the same pattern as L2.

**Fix:** if the start index is the failed node, re-derive it from a second hash.

#### N7 [Info] Behaviour changes in a patch release (intended, but flag them for semver-strict consumers)
- String indices (`setEligible('2', …)`) now throw.
- `recordRtt('1', …)` now throws `RangeError`, where 1.0.0 threw `TypeError`.
- TypeScript: `pe.pick()` and `ch.pick()` without an argument no longer compile.
- PeakEWMA without a clock, and keyed balancers without a key, now reject.
- `liteQueryFetcher` misconfiguration (a keyed pool with no key) is detectable only per fetch, not at creation.
- The pre-dispatch "clock() must return a finite number" error has no `.code`, unlike the other Pool errors.

**Suggestion:** list these under a "Behaviour changes" heading in the 1.0.1 CHANGELOG entry, or consider calling the release 1.1.0.

---

## §T — Tests and CI

### T1 [Medium] `test:perf` (and so `verify` and the CI `gates` job) is still intermittently red
**File:** `test/perf/PerfGate.test.mjs:67` (FB_CAP), and the detector control inside `lite-perf-gate`

| Failure | Details |
|---|---|
| #2 detector validation | failed 2/11 runs: its negative control saw 1–2 scavenges (once at load 1.0) |
| #18 WeightedRandom heavy-outage | failed 1/11 with `oldgen 2 > 0` under CPU stress; it took 13.2 s, which crosses V8's ~8 s memory-reducer timer again |

The phase takes about 4.9 s when quiet, so a 1.6× slowdown is enough to fail it. That makes H5 from the previous audit only **partially fixed**.

**Fix:** size that scenario by time, keeping it well under 8 s even with 3× slowdown, or add `--no-memory-reducer` to `test:perf`. Retry the detector validation once, or widen its negative control.

### T2 [Medium] SmoothWRR test A5 is vacuous; the eligibility-reset mutant survives
**File:** `test/SmoothWRR.test.js:125-138`

After 20 picks with weights `[3,1,1]`, `_current` is `[0,0,0]` because 20 is a multiple of the cycle length 5, and the test only checks long-run counts. Deleting `this._current[i] = 0` from `setEligible` passes both `npm test` and the fuzzer, even though the next picks differ (`0102001020` vs `1020010200` after 21 picks and a toggle).

**Fix:** use a pick count that isn't a multiple of the cycle length, and assert `_current[i] === 0` after the toggle, or the exact following sequence.

### T3 [Low] Other test and CI gaps
- **Untested validation:** no test rejects `failurePenaltyNs <= 0` in `Pool.run`; a mutant that drops the check (`Pool.js:212`) survives.
- **The fuzzer alone kills only 2 of 27 mutants** (unit tests kill 24). Add the model-oracle property tests from RECOMMENDATIONS §4.4.
- **CI:**
  - No `timeout-minutes` on any `ci.yml` job (the default is 6 h).
  - Actions are pinned by tag, not SHA.
  - `types-compat` pulls `typescript@5` through `npx` at run time, outside the lockfile.
  - **`witness` and `verify` as a whole never run in CI.**
- **`bench:gc`**: the absolute 2 ms `maxPause` limit fails 3/3 under load (not in `verify` or CI).
- **Torture:** the lite-leak tracker phase has no must-fail control (Info).
- **Stale comment:** `PerfGate.test.mjs:12` still says `grows` uses `.buffer.byteLength`; the code now uses buffer identity.

---

## §D — Documentation, packaging and demos

### D1 [Medium] RECIPES §8 still teaches the PeakEWMA black hole
**File:** `RECIPES.md:201, 206-227`

The manual loop calls `recordRtt(i, nowNs() - start, …)` in `finally`, so a fast failure is recorded as a tiny RTT. Simulated with 4 nodes, node 0 failing in 1 µs and the others taking 1 ms: node 0 got **9913 of 20000 picks, a 49.6% failure rate**, the same as 1.0.0's 49.4%. The Pool path is fixed; the recipe isn't. The intro (`:201`) also still gives the old `(inflight+1) × ewma` cost.

**Fix:** record `max(elapsed, penaltyNs)` in `catch` and the plain RTT only on success, mirroring Pool. Update the cost description.

### D2 [Low] Documentation drift
| Location | Issue |
|---|---|
| `CHANGELOG.md:47-49`, ADR 0013 Fork 4 | Says the H4 behaviour is identical to 1.0.0 "except at the boundary where the old cap fell below 1". In fact it's identical *wherever the old cap was below 1*, and differs wherever `(1+eps)·total/live` is an exact integer (for n=10, eps=0.25: totals 8, 16, 24, …; 12 of the first 100). |
| `decisions/0013-audit-1.0.1.md` (Consequences) | Claims "a revert-check runs each new gate against `git show HEAD:<file>`". No such script exists; only the soak teeth use `git show`. |
| `README.md:22, 440, 442`, `RECIPES.md:8`, `Pick.js:13-15, 170-171` | Leftover "shared bitmap written by lite-di-health" wording contradicts the new one-writer, one-array-per-balancer contract. |
| `llms.txt:180`, `Pick.js:388` | Still say "the M5 lite-query adapter". |

### D3 [Low] Packaging
- `./package.json` is not exported: `import`/`require` of `@zakkster/lite-pick/package.json` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- There is still no `require` condition.
- For reference, the tarball is 11 files, 95.5 kB packed / 296.6 kB unpacked. Versions are consistent (`1.0.1` everywhere), and all 22 README/RECIPES snippets run against the packed tarball, with every `// ->` claim matching.

### D4 [Low] Demo server: a symlink can still expose a file that isn't on the allowlist
**File:** `demo/pool-scope/web/serve.mjs:137-148`

The allowlist is checked against the *lexical* path, and `realpath` is only checked against ROOT. A symlink `demo/pool-scope/web/gitlink.txt → ../../../.git/config` returned 200 with `.git/config`'s contents. The repo contains no symlinks today.

**Fix:** also run `isAllowed('/' + realRel)`.

All other demo findings from the previous audit are **fixed**:
- The server binds to loopback, allowlists paths, blocks traversal, rejects methods with 405 and bad Host headers with 421.
- The TUI restores the terminal on SIGTERM/SIGHUP/SIGINT/ESC and uses the alternate screen.
- The driver keeps `Σ inflight === totalInflight` across all 8 scenarios.
- fanout's counters add up.

Info: the TUI exits 0 on SIGTERM/SIGHUP (143/129 are conventional).

---

## Status of the previous audit (2026-09-26) outside §K

| Status | Items |
|---|---|
| **Fixed** | H6, M-T1, M-T2, M-T3, M-T4, M-Doc1, M-Doc2, M-D1, M-D2 (with D4), M-D3, M-D4, L13, L15, L16, L21, L23, L24, L26; CI now exists |
| **Mostly fixed** | M-T5 (everything covered except shared eligibility, which is now documented as undefined behaviour) |
| **Partial** | H5 (see T1); H2 docs (see D2) |
| **Not fixed** | L20 (`bench:gc` absolute limit), L22 (`witness` isn't in CI) |

---

## Suggested fix order

1. **Make the soak trustworthy:**
   - S1: B/op isolation, or `--no-concurrent-recompilation` plus persistence re-measure
   - S2: time-sized batches, robust gcPause and throughput statistics
   - S4: stop retaining rollups
   - S5: INCONCLUSIVE for runs below the floor

   Then re-run `soak` and `soak:teeth` on a clean tree 5× and require 5/5 green before trusting the nightly.
2. **N1 and N2**, the two Pool regressions in shipped code. Both are small: a reordered check, and an unmarked-balancer key path.
3. **S6** parity gate, and **S8/S11** teeth coverage and matching, so every gate is proven to trip for the intended reason.
4. **T1** `test:perf` stability (so the CI `gates` job isn't flaky), and **T2**.
5. **D1**: fix the RECIPES PeakEWMA recipe, since it's user-facing.
6. S7, S9, S10, S12, S13; N3–N6; the still-open L2/L3/L4/L7/L8 (or explicitly WONTFIX them in ADR 0013); then the remaining Low items.
