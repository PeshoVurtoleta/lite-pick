# lite-pick — Fix Plan for audit 2026-10-05

This is the companion to [FINDINGS.md](./FINDINGS.md). For each finding it gives what to change, where, a code sketch, and how to prove the fix. IDs (C*, S*, P*, K*, T*, D*) refer to FINDINGS.md.

The plan is grouped into releases or work units so each one leaves `main` green.

---

## Unit 0 — Turn `main` green (minutes; do first)

### C1: Pages source
1. Go to GitHub → Settings → Pages → Build and deployment → Source and choose **GitHub Actions**. This stops the legacy "pages build and deployment" branch build that serves the whole repo.
2. Settings → Environments → `github-pages` → Deployment branches: **only `main`**.
3. Re-run the latest CI run. Confirm that `deploy (GitHub Pages)` is green and that no new `pages build and deployment` (event `dynamic`) runs appear.
4. Add a post-deploy check job (needs: deploy). It fails if the published site contains a path that `site.mjs` didn't produce:
   ```yaml
   - name: published site == site.mjs allowlist
     run: |
       for p in audit/2026-10-05/FINDINGS.md research/ benchmark/soak/main.mjs; do
         code=$(curl -s -o /dev/null -w '%{http_code}' "${{ steps.deployment.outputs.page_url }}$p")
         test "$code" = 404 || { echo "::error::$p is published ($code)"; exit 1; }
       done
   ```
   The URL here comes from a step output, not from `github.event`, so there is no injection concern.

### T1: `test:perf` lane 18
In `package.json`, add `--no-memory-reducer` to both `test:perf` and `test:perf:noinline`. Fix the "well under 8 s" comment. Log `os.loadavg()` and each lane's wall time in the PerfGate output, so future flakes are diagnosable.

**Proof:** `test:perf` 10/10 and `test:perf:noinline` 5/5 under `stress-ng --cpu 4`.

---

## Unit 1 — Soak and heartbeat can go green (P0)

### S1: time-bounded retention drain
**File:** `benchmark/soak/boundary.mjs`
```js
// replace the fixed 8x gc()+setTimeout(0) loop
const DRAIN_BUDGET_MS = 2000;
let tries = 0, live = tracker.size();
const t0 = performance.now();
while (live !== 0 && performance.now() - t0 < DRAIN_BUDGET_MS) {
  forceGc(false); forcedGc++; tries++;
  await new Promise((r) => setTimeout(r, tries < 4 ? 0 : 10));   // let FinalizationRegistry callbacks run
  live = tracker.size();
}
return { ..., trackerSize: live, forcedGcTries: tries, drainMs: +(performance.now() - t0).toFixed(1) };
```
- Emit `forcedGcTries` and `drainMs` in every pool and kernel cycle record, as telemetry.
- In `SoakReport.mjs`, chart `drainMs`. A trend there (draining taking longer and longer) is an early leak signal even while A6 passes.
- Keep MP6 (`poolretain`) as the must-fail; a real leak never drains within 2 s.
- Make teeth `P` **full-roster**, or add a `PF` full-roster pass-control run with default picks. It will be slow, so put it in the nightly teeth job, not the PR path.

**Proof:**
- `a6diag.mjs 400` gives 0 failures at load 0.5 and at load 15.
- Default `npm run soak` passes 10/10 under `stress-ng --cpu 4`.
- MP6 still trips 10/10.

### S2: restore a hotAlloc FAIL tier
**File:** `benchmark/soak/gates.mjs:330-345`
```js
export const HOTALLOC_NOTE = 0.02;   // report-only floor (as today)
export const HOTALLOC_FAIL = 1.0;    // >= 1 B/op recurring in >= 2 post-warmup cycles -> FAIL
let failCycles = 0;                  // count cycles where hotBytesPerOp (two-pass MIN) >= HOTALLOC_FAIL
...
else if (failCycles >= 2) hotAllocVerdict = VERDICT.FAIL;
else if (hotAllocOver) hotAllocVerdict = VERDICT.STUB;   // NOTE tier
```
- The two-pass **MIN** must clear 1 B/op in two separate cycles. A tier-up transient lands in one pass of one cycle; a real per-op allocation lands in every pass of every cycle.
- **Teeth:** M1–M4/M16 must assert `BREACH gate=hotAlloc` with magnitude `≥ 1`, not just the NOTE line.
- Add an `M17` 40 B/op RoundRobin mutant (the reviewer's) and a `PA` pass-control: clean full roster with 0 hotAlloc FAILs, 20/20.
- **Calibration evidence:** record the clean max (0.026, passMax 0.092 over 660 lane-cycles) in ADR 0014, with the 1.0 B/op threshold and its margin (≈10× over the clean passMax).

### S3: short runs are INCONCLUSIVE, never "did nothing"
**File:** `gates.mjs:416-418`
- Count *all* picks, including warm-up, in `totalPicks`, and FAIL only when that is 0.
- Separately, when `!cfg.smoke` and any lane has `post === 0`, the verdict is INCONCLUSIVE ("only the warm-up cycle completed").
- Fix the `teeth.mjs:71` "unreachable" note.
- Make teeth `I2` deterministic: use a duration shorter than any real cycle (for example `SOAK_DURATION=1s`) together with a `SOAK_PICKS` large enough that cycle 0 can't finish, and assert exit 3.

### S4: report labelling
**File:** `SoakReport.mjs`
- **Line 245/253:** `trackFail = cycles.filter(c => c.tier !== 'pool' && c.trackerSize !== 0).length`. Compare pool retention against `summary.poolFailures`.
- **Line 203:** when `summary.reason === 'signal'`, allow the final cycle index to be partial. Every lane must have cycles `0..k-1`, and lanes may have `k` or `k-1`.
- **Baseline:** refuse a baseline whose re-derived verdict isn't PASS (`BASELINE NOT GREEN`, exit 1). Run integrity before any schema-version skip. A schema mismatch → `BASELINE INCOMPATIBLE`, exit 1, not "not compared, exit 0".
- **Parity:** a mismatch → exit 1, unless `--allow-parity-mismatch` is passed.
- **Tests:** add fixtures to `test/SoakTeeth` or a new `test/SoakReport.test.js` for: a genuine A6 FAIL stream (must report FAIL, not MISMATCH), a signal-interrupted stream (integrity OK, verdict INCONCLUSIVE), a red baseline (refused), and a schema-mismatch baseline (refused).

### S5: nightly baseline bootstrap
- This resolves itself once S1 lands. In addition, wrap the fetch step: `gh api … || { echo "::warning::baseline fetch failed"; exit 0; }` so a transient API error doesn't fail the job.
- Document a manual seed: `workflow_dispatch` with input `seed_baseline: true` uploads the current run's stream as `soak-baseline`, but only if its verdict is PASS.

### S6: heartbeat signal handling
**File:** `pickEcosystem/live/test/heartbeat.mjs:237, 323`. Mirror the soak's S5 rule: `reason === 'signal'` or `post < 2N` ⇒ INCONCLUSIVE (exit 3). Add a `HS` teeth control to `heartbeat-teeth.mjs`: SIGINT after cycle 3 ⇒ exit 3.

---

## Unit 2 — Capstone correctness (P0/P1)

### P1: breaker stuck in HalfOpen
**File:** `pickEcosystem/live/fleet.js`
```js
onResult(i, ok, code) {
  if (code === 'LWP_WORKER_DOWN' || code === 'LWP_DISPOSED') {
    if (this.bState[i] === B_HALF && this.probeOut[i] === 1) {
      this.probeOut[i] = 0;
      this.breakers[i].send('probeFail');      // the probe was lost: back to Open, cool down, retry
    }
    return;                                    // otherwise: the supervisor's concern, not the breaker's
  }
  ...
}
async _bringUp(i) {
  ...
  this.fails[i] = 0;
  this.probeOut[i] = 0;                        // a fresh worker never inherits an outstanding probe
  return i;
}
```
**New gate G12 "lost probe":** trip the breaker on worker *k*, crash *k* during HalfOpen, and assert that within cooldown + 2 ticks the breaker reaches Closed (after a successful probe) and *k* is eligible.

**Control:** the current code must fail G12, and the mutant "remove the `_bringUp` reset AND the `onResult` branch" must fail too.

### P2: engine B and BoundedLoad accounting across a strategy switch
**Files:** `balancers.js`, `engine.js`. Give engine B's Pool a **stable facade** that forwards to the current balancer, so settles always reach the balancer that dispatched:
```js
// balancers.js
const facade = {
  get capacity() { return self.lb.capacity; }, get live() { return self.lb.live; },
  pick(a) { return self.lb.pick(a); },
  note(i, d) { const lb = self.lb; if (typeof lb.note === 'function') lb.note(i, d); },
  recordRtt(i, s, n) { const lb = self.lb; if (typeof lb.recordRtt === 'function') lb.recordRtt(i, s, n); },
};
// static KEYED/LATENCY must be read per call: pass key/clock unconditionally from engine B and let
// the facade drop them for strategies that ignore them (Pool's marker check -> facade.constructor).
```
There is a subtlety. `Balancers.set` seeds the new BoundedLoad with the current in-flight total, so the facade must route the old in-flight requests' `note(-1)` to the new balancer. That matches the seed. Settles from the old strategy then stay correct, because in-flight is shared.

Alternative: at switch time, wait for engine B's Pool to drain (bounded), then rebind.

**Gate:** run G8 under **both** engines and end with `assertConsistent()` plus `totalInflight === Σ inflight === 0` at quiescence. The surviving M15 mutant must now fail.

### P3: shutdown on deadline
**Files:** `kernel.js:213-227`, `page.js:283-292`
```js
const code = await orchestrator.shutdown({ deadlineMs });
if (code !== 0) { cron.stop(); bus.clear?.(); await set.dispose({ force: true }); }   // terminate, don't wait
return code;
```
- `page.js`: show the message by exit code ("retired cleanly" / "deadline hit: workers terminated"). Disable the boot button until `set.disposed`.
- **G11:** assert `set.liveThreads() === 0` and 0 fleet ticks over the next 500 ms, on both the clean and the deadline path.

### P4: admission shedding and host calibration
- **`engine.js`:** before dispatch, `if (fleetInflight >= fleetCapacity) { stats.shed++; return S_SHED; }`, where `fleetCapacity = Σ(perWorkerConcurrency + queueDepth)` over *eligible* workers (272 today). Shed requests are counted separately and never as `failed`.
- **Calibration:** move the browser's job-cost calibration (`surface.js`) into a shared `calibrate.js`, and call it from `run.mjs`, `tui.mjs` and `test/smoke.mjs`.
- **Smoke rate:** derive the rate from the measured capacity, `SMOKE_RATE ?? floor(0.5 * calibratedThroughput)`. The smoke's "0 failed" check becomes "0 failed outside fault windows; shed allowed only above capacity".

**Proof:** the smoke passes at the derived rate on this 4-vCPU box under load 15. A rate of 5× capacity gives shed > 0 and failed == 0 outside fault windows.

### P5: vendor the CDN modules and add a CSP
- **Vendor in `site.mjs`:** for each import-map entry, copy the pinned package's built ESM entry *and its transitive imports* from `node_modules` into `site/vendor/<pkg>@<ver>/…`. Rewrite the import map to same-origin URLs, and add `lite-scene` and `lite-axis` explicitly (they're missing today).
- **CSP:** add `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; worker-src 'self' blob:">` to all three pages. Adjust it if the pages use inline scripts; move those to files.
- **W1 drift test:** compare the sha256 of each vendored file with the file in `node_modules`, and fail if any bare specifier in any vendored file isn't in the import map. That catches the lite-scene/axis gap.
- Keep esm.sh only for local dev, if at all.

### P6: smaller capstone fixes
- **`traffic.js`:** generate Poisson arrivals in chunks: `while (mean > 0) { const m = Math.min(mean, 500); n += poisson(m); mean -= m; }`. Cap `rateUp` at, say, 4× calibrated capacity.
- **`fleet.js` `onDispatch`:** emit an `out-of-rotation (probe)` event when it calls `setEligible(false)`, and update the "tick is the only writer" text. Also call `setEligible(i, false)` from the breaker's `onTransition` → Open, so traffic stops immediately rather than at the next tick.
- **`site.mjs`:** allowlist by **directory and extension** (`pickEcosystem/**/*.{html,css,js,mjs,svg,json}`, `demo/pool-scope/web/**`, `Pick.js`, `Pool.js`). Reject any path segment starting with `.`. Realpath every file and require it to stay inside the repo. Follow side-effect imports (`import './x'`). Extend S1 with a fixture page that links `../.github/…`, which must fail the build.
- **Tests:** add gates for "PeakEWMA avoids a failing worker" (kills the M3/M17 survivors) and "HalfOpen admits exactly one probe" (kills M18). Add a browser-smoke step for `visibilitychange` hidden → visible, asserting that traffic paused and then resumed.
- **Docs:** fix the hub's gate claim (list which gates have break controls). Add G11 to the README. Use the measured "2 scavenges / 960K on Node 22" figure. Switch the TUI badge to scavenge counting, as in F1.
- **Version skew:** add a CI step in the capstone job, `diff <(npm pack --dry-run --json ../.. | jq …) node_modules/@zakkster/lite-pick` (or a sha256 compare of `Pick.js`/`Pool.js`), that fails on divergence. Alternatively run capstone tests a second time with `npm i --no-save ../..`.

---

## Unit 3 — Kernel and Pool Low items (1.1.1)

| ID | Change | Test |
|---|---|---|
| K5 | `WeightedRandom.setWeights`: `wt.set(weights.subarray(0, cap))` (TypedArray `set` handles overlap); do the same in ConsistentHash/BoundedLoad | overlapping `subarray` case → `9,1,2,3` |
| K4 | WeightedRandom keeps `_builtWeights` (a Uint32Array copy, written in `_build`); `assertConsistent` compares element by element | swap `[1,2,3,4]→[4,2,3,1]` without rebuild → `LITE_PICK_INCONSISTENT` |
| K6 | Validate `now >= 0` in `recordRtt`/`recordRttFrom` (`LITE_PICK_CLOCK_INVALID`), and document that `pick(now)` with a negative `now` degrades to P2C on inflight. Alternatively keep a separate `Uint8Array _sampled` | negative-clock test |
| K7 | Docs: `now` must be a Number; show `Number(process.hrtime.bigint())`. Optionally coerce `typeof now === 'bigint'` → `Number(now)` (cold check, outside the hot path) | BigInt-clock test, either way |
| K8 | Decide all-zero semantics. Recommended: ConsistentHash/BoundedLoad `setWeights(all 0)` → every backend removed → `PICK_NONE` (fail closed, consistent with WeightedRandom and with "weight 0 = remove"). Document it in GUIDE's strategy table | all-zero test per strategy |
| K1 | PeakEWMA: when the pool-mean stamp equals the node stamp (single caller clock), reuse `w` for the pool decay instead of a second `exp`. Re-measure on Node 22/x64 **and** 26/arm64, and state both in the CHANGELOG/ADR | microbenchmark in the PerfGate notes |
| K2 | WeightedRandom: maintain `_eligibleWeightSum` in `setEligible`/`setWeight[s]`/`rebuild` (cold paths), so the fallback does one cumulative walk | lane 18 time halves; the distribution test is unchanged |
| K3 | NQ (and, for symmetry, LeastConn/SED): a reservoir choice among tied minima during the scan (`if (score === best && rng.nextBelow(++ties) === 0) bestIdx = i`). Seeded, 0 B/op | weighted-group Poisson test: each node within ±0.5 percentage points |
| K9 / L7 | `if (m > 16777213) throw LITE_PICK_TABLE_SIZE` (16 777 213 is prime) | M = 100000007 → throws immediately |
| K10 / N6 | Failover start: when the scan's start index is the failed node, re-derive it from a second hash (`from = (from + 1 + (h2 % (cap - 1))) % cap`) | keys homed on 3 of 16 → max failover share ≤ 1.3× ideal |
| K11 | Add 5 tests: NQ wrap with the last node busy; ConsistentHash `setWeights` changing only the last weight; Pool nested *settle* publish; a `REPICK_LIMIT` preference (load-aware re-pick beats scan); unkeyed `_scanCursor` rotation | each of the 6 surviving mutants fails |
| Info | Fix the `LitePickErrorCode` doc (RangeError vs TypeError). Export runtime code constants (`export const CODES = Object.freeze({...})`) and a `LitePickError` type with `code: LitePickErrorCode`. Type `STAT_COUNT: 3`. `setWeights` no-op short-circuit. Document that a throwing channel subscriber surfaces as `uncaughtException` | types test |

---

## Unit 4 — CI hardening, release hygiene and docs (P1/P2)

- **`ci.yml`:**
  - `timeout-minutes` on every job (test 20, gates 40, capstone 30, types 10, deploy 10).
  - A workflow-level `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`. The deploy job uses `cancel-in-progress: false`.
  - Pin actions by SHA, with Dependabot (`package-ecosystem: github-actions`, weekly).
  - Bump to Node-24-based action majors.
  - Add `typescript5: npm:typescript@5.9.3` as a devDependency, and point `types-compat` at `node_modules/typescript5/bin/tsc`.
  - Add the 1.1.0 APIs to `test/types/consumer/index.ts`.
- **Weekly workflow:** `verify` (including witness), plus a Stryker run on `Pick.js`/`Pool.js` with the score uploaded. Optionally fail when the score drops below the last recorded value minus 2 points.
- **`bench:gc`:** make the pause limit relative (`p99 ≤ baseline × 2 + 2 ms`), or report-only.
- **Release:**
  - `git tag v1.1.0 2a08567`.
  - Publish from a `release` workflow on tag push, with `npm publish --provenance` (needs `id-token: write` on that job only).
  - Have the workflow verify that `package.json` version, `VERSION`, `llms.txt` and the tag all agree.
  - Move the CHANGELOG `[Unreleased]` notes on top of HEAD, or bump to 1.1.1 when the next code change lands.
- **C4:** add one line to ROADMAP/CHANGELOG: "1.1.0 B1 (`setWeights`, L2, L3) landed as commit 5f408f1, whose message is mislabelled."
- **Docs:**
  - Fix the D2 carry-overs listed in FINDINGS §D1.
  - Update the `Pick.js:1764` WeightedRandom fallback comment.
  - Fix the README anchor (`#consistenthash----sticky--…`), and add a link checker (the reviewer's 60-link script) to CI.
  - Export `./package.json`.
  - Consider trimming the shipped CHANGELOG (the last two minor versions plus a link to the full file); it's 91 kB of the 136 kB tarball.

---

## Definition of done (this audit)

1. CI green on `main` for 5 consecutive pushes. No `pages build and deployment` runs. The published site's file list equals `site.mjs`'s output.
2. `npm run soak` passes 10/10 on a clean tree under `stress-ng --cpu 4`, and the nightly is green 3 nights running with a seeded `soak-baseline`.
3. `soak:teeth` is green, and every hotAlloc control asserts a FAIL at ≥ 1 B/op. The 40 B/op mutant fails.
4. G12 (lost probe), G8 under engine B, and the extended G11 exist, each with a must-fail control. The capstone smoke passes at its calibrated rate on a loaded 4-vCPU box.
5. The published pages load no third-party script origin, and CSP is enforced.
6. All K* tests are added, and the 6 surviving kernel/Pool mutants are killed.
