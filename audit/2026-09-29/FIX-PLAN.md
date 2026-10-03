# lite-pick — Fix and Implementation Plan (for audit 2026-09-28)

This is the companion to [FINDINGS.md](./FINDINGS.md). For every finding it gives what to change, where, and how to prove the change works. Section 9 surveys how other projects (the Linux kernel, IBM/Eclipse OpenJ9, FoundationDB, TigerBeetle, Jepsen, stress-ng, syzkaller, JMH, the Node.js core benchmarks, Envoy and gRPC) build long-running soak and torture harnesses, and lists the ideas worth borrowing.

Finding IDs (S*, N*, T*, D*, L*) refer to FINDINGS.md.

---

## 0. Guiding rules for the fixes

1. **A gate is only as good as its false-positive rate.** A gate that is red on a clean tree trains people to ignore red. Before tightening anything, make the clean pass-control reliably green: 20 of 20 runs on a loaded 2-vCPU box.
2. **Every gate gets three controls:**
   - a clean *pass-control* that must be green
   - a *must-fail* mutant that must trip **that gate, with that breach text**
   - a *meta-test* that proves every gate in the code has both
3. **Separate what you measure from where you measure it.**
   - Allocation claims are measured in an isolated, monomorphic process.
   - Selection quality is measured on the post-chaos frozen state.
   - Drift is measured as time series with robust statistics.
   - Don't let one of these contaminate another.
4. **The soak's own footprint must be O(1) in run length.** The JSONL on disk is the record, and memory holds only accumulators.
5. **Any run that ends without enough evidence is INCONCLUSIVE (exit 3), never PASS.** That includes interrupted runs, runs that are too short, and runs where a gate never activated.

---

## Phase 0 — Make the soak trustworthy (P0; do this before relying on the nightly)

### 0.1 S1: allocation probe isolation
**Goal:** hotAlloc measures the *kernel*, not the harness's JIT state.

**Step A (quick, same day).**
- Add `--no-concurrent-recompilation` to the `soak` npm script and the nightly command.
- Assert it in `hot.mjs#assertPinnedFlags` alongside the semi-space flags.
- Record it in the header's `execArgv`.

**Step B: a persistence re-measure in `measureHotBytesPerOp`.** A real per-op allocation persists; a tier-up transient doesn't.

```js
// hot.mjs
export function measureHotBytesPerOp(ctx, step, ops, windows, bias, { rewarm = 200_000, retries = 2 } = {}) {
  let r = measureOnce(ctx, step, ops, windows, bias);            // current two-pass min
  for (let k = 0; k < retries && r.bop !== null && r.bop > HOTALLOC_MAX; k++) {
    for (let i = 0; i < rewarm; i++) step(ctx);                  // let TurboFan land
    r = measureOnce(ctx, step, ops, windows, bias);
  }
  r.retriesUsed = /* k */;
  return r;                                                      // report retriesUsed in the cycle record
}
```

**Step C (the structural fix): per-lane fork, the JMH `@Fork` model.** Move the zero-GC proof out of the chaos process.

- **New file** `benchmark/soak/alloc-probe.mjs`. It takes `(laneName, cap, seed)`, builds one balancer and one monomorphic step clone, warms it, and prints `{bop, pass1, pass2, gcFree}` as JSON.
- **Wiring:** `main.mjs` spawns it with `process.execPath` + `--expose-gc --min/max-semi-space-size=4 --no-concurrent-recompilation` once per lane per K cycles. The default is every cycle for kernel lanes and every 3rd cycle for tiny lanes.
- **Monomorphic clones:** generate them with `new Function` from the family template, or give each lane its own module instance via a query-string import (`import('./hot.mjs?lane=NQ')`). Each lane then gets its own feedback vectors, so there's no cross-lane polymorphism.
- **Kept in-process:** the drift gates stay in the chaos process. They measure time-series trends, not an absolute zero.

**Proof:**
- `SOAK_LANES=<all>` clean: 20/20 green on a loaded box (run `stress-ng --cpu 4` alongside).
- The existing M1–M4/M16 allocation mutants still trip `hotAlloc` 20/20.
- A new mutant, "allocate a 16-byte object every 2nd pick in `NqBalancer.pick`", trips 20/20.

### 0.2 S2: robust timing gates
- **Time-sized batches.** Replace `HOTOPS_BATCH = 500000` with "repeat until ≥ 50 ms elapsed, then take the median of 5 repeats". Report `ops/s` and `repeats`.
  ```js
  function timeFor(step, ctx, minMs, reps) {
    let n = 1024; while (timeBatch(step, ctx, n, 0, 1) < minMs) n <<= 1;   // calibrate once per lane-cycle
    return { n, ms: timeBatch(step, ctx, n, 0, reps) };
  }
  ```
- **Larger windows for drift.** Raise `GATE_N` to 5, so the gate is active from 11 cycles. Keep the default `SOAK_CYCLES` equal to the floor.
- **A noise-aware verdict.** Borrowed from the Node.js `benchmark/compare.R` approach (§9): with ≥ 5 samples per side, FAIL only if
  - the late median is below the early median by more than `max(ratio bound, 3 × MAD_early)`, **and**
  - a one-sided Mann–Whitney U test gives p < 0.01.

  Keep `HOTOPS_RATIO = 0.60` as a hard floor for catastrophic decay.
- **gcPause:**
  - Gate on the *p90 of all pauses in the cycle* (the GC profiler already has the entries), not the per-cycle max.
  - Use an absolute floor of `max(early_p90 × 2, early_p90 + 5 ms)`.
  - Keep the max pause as report-only telemetry.
- **Latency p99:** keep the gate as it is (it was stable in every run here), but use the same Mann–Whitney confirmation.

**Proof:** clean runs 20/20 green under `stress-ng --cpu 4`. The `decay` and `decaysparse` mutants still trip, and trip *their own* gate (see 2.2).

### 0.3 S4: O(1) soak memory
- **Streaming accumulators.** Build a `laneAcc = new Map(laneId → { heap: EarlyLate, rss: EarlyLate, ops, opsSparse, pause, latP99, latSamples, rebuild…, gcMajorMax, hotAlloc… })`. `main.mjs` updates it per record, then drops the record once it's written to JSONL.
- **Pure gate function.** `computeGates` takes the accumulators, not raw rows. Keep a pure `computeGatesFromRows(rows)` for `SoakReport.mjs`: it can afford memory, and it proves the two agree.
- **Bounded RSS series.** The RSS runaway guard needs a band-center median. Use a fixed-size reservoir (1024 samples) plus the last-quarter ring.

**Proof:**
- A new teeth *pass-control* `PL`: `SOAK_LANES=RoundRobin SOAK_CYCLES=3000 SOAK_PICKS=20000` must pass the heap gate, which currently fails.
- A new *must-fail* `ML`: the same run with an injected 1 KB retained per cycle must fail the heap gate.

### 0.4 S5: runs without enough evidence are INCONCLUSIVE
In `main.mjs#summarize`:
```js
const underFloor = !cfg.smoke && gate.perLane.some(l => l.postWarmupCycles < 2 * cfg.gateN);
if (verdict === VERDICT.PASS && (underFloor || reason === 'signal')) verdict = VERDICT.INCONCLUSIVE;
```
- **Output:** print `soak: PASS (smoke)` only when `cfg.smoke` is set. Print `soak: INCONCLUSIVE -- ran N cycles, gates need M` otherwise.
- **Duration:** in `SOAK_DURATION` mode, compute the expected cycle time after cycle 0. If the remaining budget can't reach the floor, warn early. Also check the deadline *per lane* (not only per cycle) and stop cleanly between lanes.

**Proof:** teeth cases `I1` (SIGINT after 1 cycle → exit 3) and `I2` (`SOAK_DURATION=10s` with the full roster → exit 3).

### 0.5 S3: re-baseline teeth
Once 0.1–0.4 land:
- make the pass-control `P` run the full roster and require exit 0
- in the nightly, run teeth **after** the burn-in, so a flaky teeth run doesn't hide the burn-in evidence
- upload both outputs

---

## Phase 1 — Shipped-code regressions and user-facing correctness (P0, 1.0.2)

### 1.1 N1: no latency penalty on caller abort
**File:** `Pool.js`, in the `catch` branch. Move the abort check **before** the penalty:
```js
} catch (err) {
  lastErr = err;
  if (signal && signal.aborted) throw err;            // caller cancelled: not the endpoint's fault
  if (rtt) { /* penalty feedback as today */ }
  continue;
}
```
Also consider recording the penalty in the EWMA only, keeping it out of the lifetime mean `_samp`, for example with a `recordPenalty(i, ns, now)` that skips `_samp`. That way one outage can't permanently re-price cold nodes.

**Tests:**
- 100 settles at 1 ms, then an abort mid-flight: that endpoint's `ewmaAt` stays ≤ 2 ms, and its hit share afterwards is within ±5% of the others.
- A mutant that reverts the order must fail this test.

### 1.2 N2: keep 1.0.0 key semantics for unmarked balancers
**File:** `Pool.js:180, 252`
```js
const marked = ctor && (ctor.KEYED === true || ctor.LATENCY === true);
const pickArg = keyed ? key : latency ? now : (opts && typeof opts.key === 'number' ? opts.key : undefined);
const i = pickArg === undefined ? b.pick() : b.pick(pickArg);
```
Document it: "unmarked balancers receive `opts.key` as 1.0.0 did; mark your class `static KEYED = true` to get key validation."

**Test:** a plain-object wrapper around ConsistentHash with 200 keys reaches ≥ 6 of 8 backends.

### 1.3 N3: drop `Math.ceil`
**File:** `Pick.js:1227`. Use `const cap = (1 + eps) * (total + 1) / live;` and keep the comment explaining that `inf < cap` over integers is equivalent to the ceil form.

**Proof:** the BoundedLoad microbenchmark recovers to within 5% of 1.0.0, and the oracle and test suite stay green (the teeth `revert` case still catches the 1.0.0 formula).

### 1.4 D1: fix the RECIPES §8 PeakEWMA recipe
Mirror Pool: record the plain RTT only on success, and `max(elapsed, penaltyNs)` on failure, never on abort. Update the cost description to the 1.0.1 formula.

Add a **doc-test**: extract the RECIPES §8 snippet into `test/docs/recipes-peakewma.test.js` and run the fast-fail simulation (node 0 fails in 1 µs); the failure rate must be ≤ 5%. This prevents recipe drift for good.

### 1.5 T2: make SmoothWRR A5 bite
Use 21 picks (not a multiple of the cycle length 5), toggle node 0 down and up, then assert `b._current[0] === 0` **and** the exact next 10 picks, captured from the correct implementation.

**Proof:** the "delete `_current[i] = 0`" mutant now fails the test.

### 1.6 Semver hygiene (N7)
Add a "Behaviour changes" block to the 1.0.1 CHANGELOG, listing string indices, `RangeError` vs `TypeError`, required key and clock, and the `.d.ts` arity. Or ship the next release as **1.1.0**. Give the pre-dispatch clock error a `.code` (`LITE_PICK_CLOCK_INVALID`).

---

## Phase 2 — Gates that provably have teeth (P1)

### 2.1 S6: a real parity gate
- **Script:** `scripts/parity.mjs` computes sha256 of `Pick.js`, `Pool.js`, `Pick.d.ts`, `Pool.d.ts` and `test/invariants.mjs`, and compares them to `benchmark/soak/parity.json`, which is committed and updated only by a deliberate `npm run parity:update`.
- **CI:** run it in the `gates` job on any PR labelled `benchmark-only`. More simply, in `soak-nightly`, fail if the soak header's `kernelOverride`/`poolOverride` is true outside teeth.
- **Provenance:** in `provenance.mjs`, hash the *loaded* `KERNEL_URL`/`POOL_URL` and record `kernelOverride`/`poolOverride`. `SoakReport.mjs` refuses to call an overridden stream a release soak.

### 2.2 S8 + S11: complete teeth coverage and strict matching
**A teeth manifest.** `benchmark/soak/teeth.json` lists `{case, env, wantExit, wantGate}`, for example `wantGate: "gate:hotOpsSparse[SED]"`.

**Structured failure lines.** `main.mjs` emits one line per failure, in a fixed format:
```
soak: BREACH gate=hotOpsSparse lane=SED detail=...
soak: BREACH pool=A4 lane=PoolP2C detail=...
soak: BREACH quality lane=SmoothWRR kind=weightZero
```
The runner parses **only** `^soak: BREACH ` lines and requires `wantGate` to be present. It treats `uncaughtException`, `mainRejection` or `TypeError` anywhere in stderr as a MISS unless the case expects it. It passes `timeout: 10 * 60_000` to `execFileSync`, spawns `process.execPath`, and removes its temp directory in `finally`.

**A coverage meta-test** (`test/soak-teeth-coverage.test.js`). It imports the gate names from `gates.mjs` (export a `GATE_NAMES` array), the oracle names from `oracles.mjs`/`quality.mjs`, and the pool assertion ids. It then asserts:
- every one appears as `wantGate` in `teeth.json`
- every `MUSTFAIL_MODES` entry in `config.mjs` is exercised by some case

**New or fixed cases.** Case IDs are free-form; these are suggestions.

| Case | Mechanism | Must trip |
|---|---|---|
| `MH` heap | retain 1 KB per lane-cycle (exists as the `heap` mode) | `gate:heap` |
| `MR` rss | `rss` mode | `gate:rss` or `gate:gcMajor`: pick one and make the mode target it |
| `MG` gcMajor | allocate a 64 MB array mid-cycle (inside the workload window) | `gate:gcMajor` |
| `MO` hotOps | `decay` mode | `gate:hotOps` |
| `MOS` hotOpsSparse | fix `decaysparse` so only the sparse batch spins (today it slows the dense path too) | `gate:hotOpsSparse` |
| `MP` gcPause | a forced `gc()` inside late cycles' timed window | `gate:gcPause` |
| `MRB` rebuild | once 2.4 lands: sleep inside `rebuild()` | `gate:rebuild` |
| `M0` totalPicks | `SOAK_PICKS` below the floor fails config; instead add a debug hook that skips the loop | `gate:totalPicks` |
| `MRT` retention | pin the kernel balancer (exists as the `leak` mode) | `retention` |
| `MPH` phases | a mode that disables one chaos phase | `phasesNotFired` |
| `MI` inconclusive | SIGINT after cycle 1 | exit 3 |
| `MA4` pool codes | `poolbadcode` mode | `pool=A4` |
| `pooldrop` | **implement it** (drop one settle, so accounting mismatches), or delete it from `MUSTFAIL_MODES` | `pool=A3` |
| `weight0` | apply the direct write to SmoothWRR's weights **and** skip `setWeight`, so the accumulator path is exercised; target SmoothWRR explicitly | `quality lane=SmoothWRR kind=weightZero` |

**Replace A3's tautology.** Count resolves and rejects *in `fn`/`then` handlers* and compare them against `launched` before `allSettled`. A dropped settle then shows up as a mismatch, not only as a lost run.

### 2.3 S12: `soak:report` integrity
- Require the summary counters (`rollups`, `cyclesRun`); if either is missing → INTEGRITY FAIL.
- Require `seq` to be contiguous from 0 to n−1 with no duplicates.
- For cycle-bound runs, the grid height must equal `header.config.cycles` and cycle indices must be contiguous. For duration runs, it must be the same across lanes, ±1 for the final partial cycle.
- Treat any `fatal` record as FAIL, even one after `end`.
- Baseline diff:
  - use `totalViolations`
  - include pool lanes (their launched/rejected mix and pool assertions)
  - run the integrity check on the baseline too
  - warn on zero baselines
- Accept `breaches` as array-or-string, and fail closed on a type mismatch.
- The HTML gets an integrity banner, the fatal messages (escaped) and the issue list.
- Optional: an HMAC over each line with a CI secret (`SOAK_HMAC_KEY`) closes the "consistent forgery" residual that ADR 0014 accepts.

**Proof:** add a `test/soak-report.test.js` with one fixture stream per tamper type: dropped cycle plus deleted counters, seq gap, fatal after end, weightZero regression, missing pool lane, and string breaches.

### 2.4 Rebuild-latency gate (S8)
Either:
- (a) add a dedicated **rebuild micro-bench** per keyed/weighted lane: 2 × 256 timed `rebuild()` calls per cycle in the cold boundary, outside the workload GC window, with the sketch p99 gated at N ≥ 5 cycles. This also covers per-rebuild B/op (L14) in a forked probe; or
- (b) mark the gate `reportOnly` explicitly in `computeGates` and in the verdict output.

Prefer (a).

### 2.5 S13: `_probe.mjs`
- Run it under the same isolation as 0.1.
- Add the missing failure line.
- Wire it into `soak:teeth` as a pass-control `PP`, plus one must-fail that injects allocation into the latency sampler.

---

## Phase 3 — Model fidelity (P1)

### 3.1 S9: make the pool lanes a real discrete-event simulation
Today the pool lanes rely on microtask order. Replace that with a **deterministic simulated scheduler**, the FoundationDB/TigerBeetle pattern (§9):

1. `fn(i, signal)` returns a promise whose resolver is **parked** in the `EventQueue`, keyed by `completeAt = clk + service(i)`, where service is in **ns**.
2. A driver loop pops the earliest completion, advances `clock()`, resolves that run's promise, and `await`s one microtask so Pool's continuation runs. That is one event per step.
3. Real "hung" runs park with no completion. They are released (rejected with `ETIMEDOUT`) at phase end or by a simulated caller timeout.
4. `clock()` returns `clk_ns`, so Pool and PeakEWMA see realistic RTTs.
5. Processor-sharing uses per-node concurrency (`1 + inflight[i] / perNodeConc`), not a global `conc`.

Record `rtt p50/p99` per pool lane in the cycle record, and assert `p50 ≈ mean service × slowdown` within ±20% as a model self-check.

### 3.2 S10: eligibility check inside `fn`
`if (!eligible[i]) { downDispatch++; }`, and treat any non-zero `downDispatch` as pool assertion **A8**. Add the teeth case "`_scanUntried` ignores `isEligible`" → `pool=A8`.

### 3.3 S7: calibrate the P2C oracle
Bound = `ceil(log2(ln live)) + 3`. Keep 8 trials and FAIL if **≥ 2** trials exceed the bound, which keeps the healthy false-positive rate negligible. Add teeth cases for the 50%-ignore and 80%-ignore mutants.

### 3.4 S14: oracle hardening
- **LeastConn/SED/NQ:** accept `pick ∈ argmin set` (ties allowed), so the planned 1.1 rotating tie-break doesn't break the oracle.
- **BoundedLoad/ConsistentHash property oracles**, independent of the kernel's walk:
  - **Cap property:** when any eligible under-cap backend exists within the probe window, the chosen backend's `inflight < cap`.
  - **Disruption property:** removing 1 of N backends moves ≤ `1/N + 2%` of keys.
  - **Low-load affinity metric:** report-only until N4 is decided.
- **WeightedRandom chi-square power:** add a 10%-perturbed-weight mutant; the rejections must exceed the budget.
- **PeakEWMA oracle drain pattern:** use `d = rng.nextBelow(cap)` so all nodes drain.
- **Private-field coupling:** add a public `setWeights(Uint32Array)` to ConsistentHash, BoundedLoad and WeightedRandom (one rebuild), and use it in chaos and oracles instead of `_weights`.

---

## Phase 4 — Kernel items still open (P1/P2, 1.1.0)

| Item | Plan |
|---|---|
| **L2** biased fallback scan (P2C `_draw`, WeightedRandom) | Two-pass uniform fallback: count `live` (already known), draw `k = nextBelow(live)`, walk to the k-th eligible. Still O(cap), 0 B/op, and only on the ≥ 64-miss path. Test: nodes {0,1} eligible out of 100 → 50/50 ± 1% over 200k picks. |
| **L3** ConsistentHash probe exhaustion | After the 64-slot window: a cold O(M) sweep from `slot`, returning the first eligible. Test: 60 of 64 down → 0% `PICK_NONE`. Report the fallback count via the planned stats counters. |
| **L4** PeakEWMA blend | Use Finagle's formula (`ewma·w + s·(1−w)`, with the peak comparison against the undecayed `ewma`), or document the deviation in ADR 0009 with a numeric example. Add a unit test pinning whichever is chosen. |
| **L7** unbounded M | Validate `M ≤ 2^24` (16 777 213 is prime), and switch `_build` to additive stepping (`c += skip; if (c >= M) c -= M`). |
| **L8** `nextBelow` comment | Fix the wording, or implement true multiply-shift: `((x >>> 0) * n) / 4294967296 >>> 0` is exact while `n < 2^21`. |
| **M5 / N6** tie and fallback spread | Rotating cursor for LeastConn/SED/NQ ties (1.1 plan); failover start re-derived from a second hash. |
| **N4 / H4** low-load affinity | Add an opt-in `minCap` to BoundedLoad (`cap = max(minCap, …)`), default 0 (paper behaviour). Document the trade-off honestly in the README. |
| **N5** hung unsampled node | The planned "busy-since" stamp: record `stamp` on the 0→1 in-flight transition, and apply the `dt` floor to unsampled-busy nodes too. |
| **H2** eligibility ownership | The 2.0 `Eligibility` object, as planned. Until then, consider a dev-mode `assertConsistent()` that recounts `live` (O(cap), opt-in). |

---

## Phase 5 — Tests, CI and docs (P1/P2)

- **T1 `test:perf` stability.**
  - Size the WeightedRandom heavy-outage phase by time, at ≤ 2.5 s quiet, so it stays under 8 s even with 3× slowdown. Or add `--no-memory-reducer` to the script.
  - Retry detector validation once before failing.
  - Record machine load (`os.loadavg()`) in the output.
- **T3.**
  - Add a `failurePenaltyNs <= 0` rejection test.
  - Add `timeout-minutes: 20` to every `ci.yml` job.
  - Pin actions by SHA (Dependabot keeps them fresh).
  - Add `typescript@5` as a devDependency (alias `typescript5`) for the node10 lane.
  - Add a **weekly** `verify` + `witness` job.
  - Make `bench:gc`'s pause limit relative (`p99 ≤ baseline × 2 + 2 ms`), or report-only.
- **Model-oracle property tests.** The fuzzer kills only 2 of 27 mutants, so add the lockstep reference-model tests from RECOMMENDATIONS §4.4.
- **Mutation testing in CI.** Run a weekly Stryker job on `Pick.js`/`Pool.js` (the 27-mutant spot check already shows 24/27). Track the score in the README.
- **D2–D4:**
  - Fix the CHANGELOG/ADR 0013 H4 statement and the nonexistent "revert-check".
  - Remove the leftover "bitmap written by lite-di-health" wording.
  - Export `./package.json`.
  - Run `isAllowed` on the realpath in `serve.mjs`.
  - Update the stale comments.

---

## 6. Suggested sequencing and effort

| Step | Contents | Effort (rough) | Exit criterion |
|---|---|---|---|
| 1.0.2 | Phase 1 (N1, N2, N3, D1, T2, N7 notes) | ½ day | tests plus new mutants killed |
| soak-2c | Phase 0 (S1 A+B, S2, S4, S5, S3) | 2–3 days | clean `soak` and `soak:teeth` 20/20 green under `stress-ng --cpu 4`; `PL`, `ML`, `I1` and `I2` teeth pass |
| soak-2d | Phase 2 (S6, S8, S11, S12, S13, rebuild gate) | 2–3 days | coverage meta-test green; every gate has a pass-control and a must-fail |
| soak-2e | Phase 3 (true DES pool lanes, A8, oracle calibration) plus S1 step C (forked probe) | 3–4 days | pool RTT model self-check within ±20%; the new oracle mutants are killed |
| 1.1.0 | Phase 4 kernel items plus the observability work already planned | per ROADMAP | L2, L3 and L7 tests; minCap documented |
| continuous | Phase 5 CI | 1 day | weekly verify, witness and mutation jobs green |

---

## 7. Definition of done for "the soak is an A+ gate"

1. `npm run soak` on a clean tree: **20/20 PASS** on (a) a quiet dev machine and (b) a 2-vCPU box under `stress-ng --cpu 2`. Record both in the ADR.
2. `npm run soak:teeth`: **every** gate, oracle and pool assertion trips for the intended reason (structured-line match), and the coverage meta-test is green.
3. A 45-minute and an 8-hour clean burn-in both PASS, with heap and RSS gate headroom above 50%.
4. `soak:report` detects every tamper fixture, and diffs pass or fail correctly against a baseline.
5. The soak's memory footprint is independent of run length: heap after GC stays flat within ±1 MB over 3,000 cycles.
6. Any interrupted, short or overridden-kernel run is INCONCLUSIVE, never PASS.

---

## 8. Nightly workflow shape after the fixes

```yaml
jobs:
  soak:
    timeout-minutes: 75
    steps:
      - checkout (fetch-depth: 0), setup-node 22, npm ci
      - name: parity (benchmark-only guarantee)
        run: node scripts/parity.mjs
      - name: soak (45m burn-in)
        env: { SOAK_DURATION: 45m, SOAK_REQUIRE_PROVENANCE: '1' }
        run: npm run soak            # flags incl. --no-concurrent-recompilation live in the script
      - name: soak:teeth
        if: always()
        run: npm run soak:teeth
      - name: soak:report (+ baseline = last green nightly artifact)
        if: always()
        run: node benchmark/soak/SoakReport.mjs --baseline baseline.jsonl --out benchmark/out/soak-report.html
      - upload artifacts (jsonl, html, teeth log)
```

Keep the last green nightly's JSONL as the baseline artifact, via `actions/cache` or a dedicated branch. `--baseline` then gives release-over-release drift detection, which is what LKP/0-day and the Node.js benchmark CI provide for their projects.

---

## 9. How others build soak and torture harnesses, and what to borrow

This compares public, well-documented practice with lite-pick's harness. It covers approaches, not exact configurations.

### 9.1 Linux kernel: `rcutorture` / `locktorture` / `refscale` (+ `kvm.sh`)
- **What they are:** in-kernel torture modules for RCU and locking. They are driven by module parameters (duration, number of reader and writer threads, `stutter` pauses, `onoff` CPU-hotplug churn, `shuffle` of thread placement). They print periodic statistics lines and end with a single greppable `SUCCESS` / `FAILURE` line. `tools/testing/selftests/rcutorture/bin/kvm.sh` runs a **matrix of configurations** (scenario files) in guest VMs for a given duration, then post-processes the console logs.
- **Borrow:**
  - **Scenario files.** Name lite-pick's chaos mixes (`TREE01`-style: `dense-flap`, `sparse-outage`, `reweight-storm`, `clock-chaos`) as small JSON presets. A nightly then runs a *matrix of presets* rather than one fixed mix, and each failure names its scenario.
  - **`stutter`/`onoff` as first-class knobs.** lite-pick's idle trough and membership churn are exactly these; expose them as parameters with defaults.
  - **One greppable verdict line plus a periodic stats line.** The structured `soak: BREACH …` lines in 2.2 follow this.

### 9.2 IBM / Eclipse OpenJ9 and Adoptium AQA system tests (STF, load tests)
- **What they are:** IBM contributed its Java *system test* suites to the AdoptOpenJDK/Adoptium test ecosystem (the "STF" system test framework and the `openjdk-systemtest` load tests). A **load-test harness** runs a weighted *mix* of many small test units across multiple threads for a time limit or iteration count, and reports each unit's pass/fail counts. The same suites run over many JVM builds and platforms in Jenkins, with results aggregated in the Test Results Summary Service (TRSS) dashboards.
- **Borrow:**
  - **Weighted inventory of small workload units instead of one monolithic loop.** Describe each chaos phase and oracle as a unit with a weight. The runner samples units by weight for a duration. This makes "add a regime" a one-line change and naturally supports the scenario presets from 9.1.
  - **Cross-build and cross-platform result tracking.** Keep per-nightly summaries in a small results store (even a JSON file on a branch) and chart the gate margins over time. That is a tiny TRSS for one library.

### 9.3 FoundationDB simulation and TigerBeetle VOPR (deterministic simulation testing)
- **What they are:** the whole system runs in a **single-threaded, deterministic simulator** with a simulated clock, network and disk. Faults are injected by seeded PRNG ("BUGGIFY" in FoundationDB). Thousands of seeds run continuously, and any failure is reproduced exactly from its seed. TigerBeetle's VOPR does the same for its consensus and storage, with liveness and safety checkers.
- **Borrow:**
  - **Make the pool lanes a true deterministic simulation (Phase 3.1).** The scheduler, not microtask order, decides completion order.
  - **BUGGIFY-style fault points.** Add optional, seed-controlled hooks in the *harness* (never the kernel), such as "delay this settle", "throw from `fn`" or "abort now", enabled per seed. That gives thousands of distinct fault interleavings.
  - **Seed farms.** Beyond the 45-minute burn-in, run a **"many short seeds"** job: 1,000 seeds × 1 cycle each. Many short randomized runs find different bugs from one long run, and a failure prints `SOAK_SEED=… SOAK_LANES=… SOAK_CYCLES=…` as a one-line repro.

### 9.4 Jepsen (history plus checker)
- **What it is:** a *generator* issues operations, a *nemesis* injects faults, every operation's invocation and completion is recorded in a **history**, and **checkers** (Knossos, Elle) analyse the history offline.
- **Borrow:** record a **compact pick history** (ring-buffered and sampled: `{t, lane, op, arg, result, eligibleEpoch}`) into the JSONL for the quiet windows, and let `soak:report` run the oracles *offline* against that history. This decouples checking from the hot process, so oracles can be arbitrarily expensive. It also lets you re-check old streams when an oracle improves.

### 9.5 stress-ng
- **What it is:** hundreds of "stressors" with `--timeout`, `--metrics` (bogo-ops/s), and a `--verify` mode where supported, which checks each stressor's results rather than only exercising it.
- **Borrow:** the **exercise vs verify split** as a CLI switch. `SOAK_VERIFY=0` gives pure throughput and endurance with minimal checking, for long burn-ins. `SOAK_VERIFY=1` gives full oracles. Report **bogo-ops** per lane (lite-pick's hotOps) consistently across modes.

### 9.6 syzkaller / syzbot and Intel 0-day / LKP
- **What they are:** continuous kernel fuzzing (syzkaller) with crash deduplication, **automatic reproducer extraction and minimization**, and **bisection** to the culprit commit. LKP (0-day) runs benchmarks on every commit and flags *statistically significant* performance changes, bisecting to the offending commit.
- **Borrow:**
  - **Auto-minimization.** On a soak breach, rerun that lane and seed with the chaos phases halved and the picks halved, and so on, until the smallest failing configuration remains. Print it.
  - **Auto-bisect** for the nightly: if tonight is red and last night was green, `git bisect run` the smallest failing configuration over the commits in between. It's cheap because the reproducer is seconds long.
  - **Statistical significance before flagging** (see 9.8).

### 9.7 JMH (Java Microbenchmark Harness)
- **What it is:** the reference answer to "JIT state pollutes measurements". It uses **forked JVMs per benchmark** (`@Fork`), explicit warm-up and measurement iterations, and a `Blackhole` to defeat dead-code elimination.
- **Borrow:** exactly the fix for S1. Fork per lane for the allocation probe, give each lane its own monomorphic step, and use separate warm-up and measurement phases with a minimum *time* per iteration. The existing ring-buffer controls already act as a Blackhole.

### 9.8 Node.js core `benchmark/` (`compare.js` + `compare.R`)
- **What it is:** it runs old and new binaries **interleaved** many times, then applies a t-test and prints a confidence level (`*`, `**`, `***`) per benchmark. A change is reported only when it's significant.
- **Borrow:** replace "median of 3 vs median of 3 × 0.6" with **interleaved samples plus a significance test** (Phase 0.2), for the drift gates and especially for `soak:report --baseline`. Report the confidence in the HTML.

### 9.9 Envoy / gRPC / Finagle (load-balancer specific)
- **What they are:**
  - **Envoy** keeps load-balancer *simulation tests* that drive LB algorithms over synthetic host sets and weights and check the resulting distribution.
  - **gRPC** ships an interop **stress-test client** that runs a weighted mix of RPC types for a duration against a server, and exposes live metrics (QPS per test) through a metrics endpoint.
  - **Finagle** has used simulation harnesses to evaluate its balancers (P2C, Aperture, peak-EWMA) under synthetic latency distributions.
- **Borrow:**
  - **Latency-distribution scenarios** for PeakEWMA/P2C quality: bimodal, heavy-tailed (Pareto), a slow-then-recovering node, and a *gray failure* (slow but not failing). Assert *steering outcomes* such as "p99 of served latency ≤ X × best node's p99", not only "slow node share ≤ bound".
  - **Live metrics** during long runs: a tiny HTTP `/metrics` or a periodic stats line. The pool-scope demo could consume it, which would turn the demo into a live soak monitor.

### 9.10 HdrHistogram / wrk2 (latency measurement)
- **What they are:** HdrHistogram records latency with fixed relative precision at negligible cost. wrk2 popularised correcting for **coordinated omission**: a stalled system also delays the requests that *would have* been issued, so naive latency sampling under-reports tails.
- **Borrow:** lite-pick's per-pick latency sampler is closed-loop (the next pick waits for the previous), so it is subject to coordinated omission during stalls such as GC pauses and deopts. For the tail gates, either use a fixed-rate *intended* schedule (record `actual − intended`), or record stalls explicitly. The DDSketch is fine as the recorder; the correction is the part to borrow.

### 9.11 Summary: what to adopt first
| Priority | Idea | Source | Fixes |
|---|---|---|---|
| 1 | Fork-per-lane allocation probe, monomorphic steps, time-based iterations | JMH | S1, S13 |
| 2 | Significance-tested drift gates, interleaved baseline comparison | Node.js compare.R, LKP | S2, S12 baseline |
| 3 | Deterministic simulated scheduler for pool lanes; seed farm with one-line repro | FoundationDB, TigerBeetle | S9, S10 |
| 4 | Structured verdict lines, scenario presets, stutter/onoff knobs | rcutorture / kvm.sh | S8, S11 |
| 5 | Auto-minimize and auto-bisect on nightly red | syzkaller, 0-day | triage time |
| 6 | History recording with offline checkers | Jepsen | oracle cost, re-checkability |
| 7 | Weighted workload-unit inventory, result dashboard | IBM/Adoptium STF load tests, TRSS | extensibility, trend visibility |
| 8 | Verify vs exercise modes; bogo-ops metrics | stress-ng | long burn-in cost |
| 9 | Coordinated-omission-aware tail latency | HdrHistogram / wrk2 | latency gate validity |
| 10 | Latency-distribution scenarios and steering-outcome assertions | Envoy, Finagle, gRPC stress client | PeakEWMA/P2C quality depth |
