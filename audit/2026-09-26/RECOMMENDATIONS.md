# lite-pick — Recommendations for an A+ Module

This complements [FINDINGS.md](./FINDINGS.md). FINDINGS lists **defects**; this document lists **improvements** that would take lite-pick from "well-engineered" to "reference-grade". It covers three areas: the soak harness, telemetry and observability, and the code, API, testing and release process.

Items are tagged:

- **[P0]** needed for an A+ claim
- **[P1]** strongly recommended
- **[P2]** polish

Where a claim is based on a probe, the evidence is inline.

---

## 0. The bar: what "A+" means for this module

A reviewer would grade a selection kernel A+ when all of the following hold:

1. **Correct under every documented usage.** No foot-guns hidden behind an "UB" note, and no strategy that can pick a weight-0 node or a node that is down.
2. **Selection quality is proven, not just safety.** Balance, stickiness and latency steering are *measured continuously*, not only in unit tests.
3. **Every gate has teeth, and every gate is green.** Each check has a must-fail control. `verify` passes on any reasonable machine. CI runs it on every push and a long soak runs nightly.
4. **Observable in production at zero cost when off.** Operators can see why a pick went where it did, without paying for that on the hot path.
5. **The published surface is minimal and exact.** The types match the runtime, the docs match the code, and there is no process chatter in shipped files.

Today, points 1, 3, 4 and 5 fall short (see FINDINGS), and point 2 only partly holds. The recommendations below are ordered to close those gaps.

---

## 1. Soak harness (`benchmark/Soak.mjs`)

The soak is thoughtfully built: typed JSONL, teeth knobs (`SOAK_MUSTFAIL`), SIGINT-safe summaries, reuse of the invariant checkers, and a bounded in-memory series. The issues below are in **what it can detect** and **how trustworthy its numbers are**.

### 1.1 [P0] Fail closed on bad configuration
**Probe:** `SOAK_CYCLES=abc`, `SOAK_CYCLES=-5` and `SOAK_PICKS=xyz` each print `0 picks … -> PASS` and **exit 0**. `SOAK_CYCLES=2.5` silently runs 3 cycles.

```js
function intEnv(name, def, { min, allowZero = false }) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min && !(allowZero && v === 0)) {
    process.stderr.write(`soak: FAIL -- ${name}='${raw}' must be an integer >= ${min}\n`);
    process.exit(2);
  }
  return v;
}
const CYCLES = intEnv('SOAK_CYCLES', 2, { min: 2, allowZero: true });
const PICKS_PER_CYCLE = intEnv('SOAK_PICKS', 60000, { min: CHECKPOINTS * 100 });
```

Also add a final guard: `if (totalPicks === 0) → FAIL`. A soak that did nothing must never pass.

### 1.2 [P0] The drift gates need a real time axis; today they compare lanes and JIT warm-up
Two problems with how the gates are computed:

- **The memory gates compare lanes, not time.** They split the post-warmup *cycle-rollup series* into early and late quarters. The run is cycle-major and has 10 lanes, so in the default 2-cycle run the "early quarter" is `RoundRobin, SmoothWRR` and the "late quarter" is `BoundedLoad, WeightedRandom`. The gate compares **different strategies' heaps**, not drift. Probe: per-lane heap means in cycle 1 were `6.6 … 7.7 MB`.
- **The throughput gate measures JIT warm-up.** It compares the first and second half of the checkpoints *within the only gated cycle*. The default run reported late/early ratios of **1.32–1.71**, which is warm-up, not steady state.

**Fix:**
- Gate **per lane** across **cycles**. For lane L, compare the median of the first N post-warmup cycles against the last N. Require `cycles ≥ 2·N + WARMUP` for a gate to be *active*, and report `insufficientData` explicitly otherwise. That already exists but is never reached under the current windowing.
- Make the default bounded run long enough for the gates to be active. Alternatively, have `npm run soak` print "smoke only: drift gates inactive (need ≥ K cycles)" so nobody mistakes it for a soak.
- Add **`SOAK_DURATION`** (for example `8h` or `30m`) as the primary knob for burn-ins. Cycle counts are the wrong unit for an endurance test.

### 1.3 [P0] Measure heap after the retention GC, not by sampling mid-cycle
`heapUsedMB` is sampled with `process.memoryUsage()` at checkpoints *during* the chaos loop, so it includes floating garbage from the cold checkpoint work (`JSON.stringify`, record objects, `memoryUsage` itself). The harness **already forces a GC** at every lane boundary for the retention proof. Sample the heap **right after that GC**. That value is the true leak signal and is far less noisy, so the multiplicative slack can be tightened. `GATE_HEAP_SLACK_MB = 8` on a ~7 MB heap currently allows a 2× leak.

### 1.4 [P0] Keep cold work out of the throughput segments
`segMs0 = tNow` is taken *before* the checkpoint work runs: `massOf` (called **twice**, once for `rec.live` and once inside `checkLane`), `checkLane`, `process.memoryUsage()`, `gc.summary()`, and a **synchronous `appendFileSync`**. All of that is billed to the *next* segment's ops/sec. The result is that throughput depends on `SOAK_LOG`, on disk speed and on invariant cost.

**Fix:** set `segMs0 = performance.now()` *after* the checkpoint block, and compute `mass` once. Better still, time the pick loop only, with a monotonic accumulator: `hot += performance.now() - tHotStart` around each run of picks between checkpoints.

### 1.5 [P0] Add quality invariants to the soak, not only safety invariants
Today the soak asserts that `live` and the aggregates are exact, that no pick lands on a down node, that it fails closed exactly when it should, and that values are finite. Nothing checks that **selection is still good** after millions of chaotic operations. That kind of slow drift (for example the SmoothWRR accumulator drift in FINDINGS §H2) is exactly what a soak exists to catch.

Add a per-lane *quality window*: a rolling histogram of picks over the last W picks between chaos events. Assert these per lane:

| Lane | Quality invariant (over a quiet window) |
|---|---|
| RoundRobin | max − min picks per eligible node ≤ 1 |
| SmoothWRR | \|share_i − w_i/Σw\| ≤ 1/W·cap (deterministic bound); never a weight-0 node |
| WeightedRandom | χ² goodness-of-fit vs w_i/Σw_eligible below the critical value at p=0.001 |
| P2C | max − mean inflight ≤ ln ln n / ln 2 + c |
| LeastConn / SED / NQ | inflight/weight spread ≤ 1/w_min |
| ConsistentHash | the same key maps to the same backend while its home is up (stickiness = 100%) |
| BoundedLoad | the chosen backend's inflight ≤ ceil((1+ε)·(total+1)/live) whenever any under-cap backend is in the window; stickiness ≥ X% at low load |
| PeakEWMA | a node given 10× higher RTT gets ≤ Y% of picks after τ |

These invariants would have caught FINDINGS §H3 (weight-0 picks) and §H4 (BoundedLoad stickiness).

### 1.6 [P0] Widen the chaos menu to the regimes where bugs actually live
The current chaos menu is: whole pool down or up, single-node flaps, weights retuned within `1..8`, and idle troughs. It is missing:

- **Weight 0 and all-zero weights.** `wv = 1 + rng.nextBelow(8)` never produces 0, so the drain path is never exercised. This is why FINDINGS §H3 went unnoticed.
- **Sparse eligibility (≥ 95% down)**, which is what actually drives the P2C/WeightedRandom fallback scans and ConsistentHash probe exhaustion. Random flaps hover around 50% eligible.
- **Tiny pools:** `cap ∈ {1, 2, 3}` (the `_live === 1` shortcut, and the P2C redraw loop). A single CAP=256 misses them entirely.
- **Clock pathologies for PeakEWMA:** regressions, large jumps, `now` far from zero (real `hrtime`-scale values like `1e15`), and bursts of `recordRtt` without picks.
- **Endpoint pathologies:** fail-fast and hung nodes (no settle), which is the PeakEWMA black hole in FINDINGS §H1.
- **Membership churn:** `rebuild()` storms on ConsistentHash/BoundedLoad and WeightedRandom, to catch per-rebuild allocation (FINDINGS L14) and rebuild-time regressions.

### 1.7 [P0] Soak the `/pool` layer
`Pool.run` is the only async code, the only per-call allocation, and the most complex lifecycle: dispatch, settle, failover, abort, `note` and `recordRtt`. It is **never soaked**.

Add Pool lanes (at least P2C, PeakEWMA and BoundedLoad) driven by a small **discrete-event simulator**: per-node service-time distributions, a failure probability, hung nodes and random aborts, with a bounded number of concurrent `run()` calls.

Assert:
- `inflight` returns to all zeros at quiescence
- `BoundedLoad.totalInflight === Σ inflight` at every checkpoint
- no unhandled rejections
- heap stays flat across millions of `run()` calls

### 1.8 [P1] A realistic load model
Today, load feedback is `inflight[p]++` followed by a coin-flip decrement *of the same node*. That is a random walk with no service time, so load-aware strategies are never tested against queueing, which is what they're for.

A tiny event queue fixes this: a binary heap of `(completeAt, node)` pre-allocated to a maximum concurrency, with per-node exponential or lognormal service times. It makes `inflight` behave like a real system and gives PeakEWMA real RTTs to learn from. It is also what the quality invariants in §1.5 need.

### 1.9 [P1] Per-pick latency distribution
For a hot-path kernel, **tail latency of `pick()`** matters more than mean throughput. The sparse fallback scans are O(cap), and the ConsistentHash probe is up to 64 steps.

Sample every k-th pick with `process.hrtime.bigint()` deltas, or time batches of 64 and divide. Feed the samples into the `@zakkster/lite-sketch` DDSketch the project already has as a devDependency. Emit p50/p99/p999/max per lane per cycle, and gate `p999_late ≤ 1.5 × p999_early`.

### 1.10 [P1] GC pause telemetry is polluted by the harness's own forced GCs
`gcMaxPauseMs` comes from a `GcProfiler` that starts before the run and stays running through the forced `globalThis.gc()` calls at every lane boundary. The cumulative "worst pause to date" therefore most likely reflects the *forced* full GCs, not the workload.

Either stop and restart (or snapshot) the profiler around the forced GCs, or record `workloadMaxPauseMs` computed only from in-cycle deltas. The same separation already exists for `gcMajorInCycle`; apply it to pauses.

### 1.11 [P1] Seeds collide between lanes
`chaosSeed` mixes in `lane.name.length`, so **P2C/SED (3), SmoothWRR/LeastConn (9) and ConsistentHash/WeightedRandom (14)** get identical chaos streams in every cycle. Use the lane *index*, or a hash of the name, and record the chosen seeds in the header (as is already done for cycle 0).

### 1.12 [P1] Output and provenance
- **Configurable output:** add `SOAK_OUT=path`, defaulting to a run-specific file such as `soak-<iso>-<sha7>.jsonl` under an ignored directory. Today every run truncates the same `benchmark/soak.jsonl` inside the repo.
- **Header fields:** add `schemaVersion`, `pkgVersion` (VERSION), `gitSha`, `gitDirty`, the `execArgv` flags (for example `--expose-gc`, `--max-semi-space-size`), the V8 version, and the total and free memory. Without these, runs can't be compared.
- **Standard metrics:** add `eventLoopUtilization` and `monitorEventLoopDelay` percentiles. They're cheap, standard, and they matter once Pool lanes exist.
- **Crash evidence:** write a final `{type:"fatal"}` record from `uncaughtException` and `unhandledRejection` handlers, so a crash leaves evidence in the stream.

### 1.13 [P1] An analysis tool for the JSONL
The stream is designed for analysis, but nothing in the repo reads it back. Add `npm run soak:report [file] [--baseline other.jsonl]` that:

- renders per-lane heap, RSS, throughput, p99 and quality-metric charts. `@zakkster/lite-charts` is already a devDependency, and `Report.mjs` already writes HTML.
- prints the gate margins, and diffs them against a baseline run, which is the real regression check between releases.

### 1.14 [P2] Header comment drift
The file header still describes `late-window mean RSS <= earlyBaseline * GATE_RSS_MULT + GATE_RSS_ADD_MB`, which is the pre-recalibration gate. The constant is now `GATE_RSS_SLACK_MB`, heapUsed is the primary gate, and RSS is a p95 runaway guard. Update the header so the documented gates are the implemented ones.

### 1.15 [P1] Run it somewhere
Add a scheduled CI workflow (nightly) that runs `SOAK_DURATION=45m` on Linux, uploads the JSONL and HTML report as artifacts, and fails on a gate breach. Run the overnight 8 h burn-in before each release, and link its summary from the CHANGELOG entry.

---

## 2. Telemetry and observability (the library itself)

Today the kernel exposes `live`, `capacity`, `totalInflight` (BoundedLoad), `tableSize` (ConsistentHash) and a private `_builds` counter (WeightedRandom). Pool exposes nothing. For an in-process load balancer, operators will want to answer questions like "why is node 3 getting 60%?", "how often are we failing closed?" and "is the probe window being exhausted?".

### 2.1 [P0] Zero-cost counters in a caller-supplied typed array
This keeps the house style: views owned by the caller, 0 B/op, no callbacks on the hot path.

```js
// Opt-in: pass a Float64Array(STATS_LEN) (or omit -> a shared static dummy, so the hot path stays
// branch-free: `st[PICKS]++` on a 1-element-per-slot scratch that nobody reads).
export const STAT = Object.freeze({
  PICKS: 0, NONE: 1, FALLBACK_SCANS: 2, REJECTIONS: 3, PROBE_STEPS: 4,
  CAP_OVERFLOWS: 5, CAP_FALLBACKS: 6, REDRAW_COLLISIONS: 7, REBUILDS: 8, ELIGIBILITY_FLIPS: 9,
});
const lb = new P2cBalancer(n, eligible, inflight, seed, { stats: new Float64Array(STAT_LEN) });
```

- Per-pick cost is 1–3 increments of a typed-array slot, a few ns at most. PerfGate stays 0 B/op.
- Per-endpoint pick counts are an optional second `Uint32Array(cap)` (`pickCounts`). With it, operators can compute realized share against configured weight, the single most useful load-balancer metric.
- Document the counter semantics, and ship a cold helper `readStats(lb)` that returns a plain object for exporters.

### 2.2 [P0] Pool lifecycle hooks via `node:diagnostics_channel` (with a fallback)
`diagnostics_channel` is built for this: **zero cost when nobody subscribes** (`channel.hasSubscribers`), native to Node, and consumed by OpenTelemetry, APMs and custom exporters.

```js
// Pool.js (lazy, environment-safe)
let dc = null; try { dc = await import('node:diagnostics_channel'); } catch {}
const chDispatch = dc?.channel('lite-pick:pool:dispatch');   // { endpoint, attempt, key }
const chSettle   = dc?.channel('lite-pick:pool:settle');     // { endpoint, attempt, ok, elapsedNs, error }
const chNone     = dc?.channel('lite-pick:pool:none');       // { attempt }
// in run(): if (chSettle?.hasSubscribers) chSettle.publish({...})
```

Alternatively, offer a plain `hooks` option (`{ onDispatch, onSettle, onFailover, onNone }`) for browsers, where `node:` imports aren't available. Pool is already documented as not being a 0 B/op path, so this is in budget. Document the recommended OpenTelemetry attribute names (`lb.endpoint`, `lb.strategy`, `lb.attempt`, `lb.outcome`).

### 2.3 [P1] `describe()`: a cold, allocation-OK introspection snapshot
One method per strategy that returns a plain JSON-safe object:

- **All strategies:** `strategy`, `capacity`, `live`, `version`.
- **SmoothWRR:** `totalEligibleWeight` and the min/max `current` (a desync detector).
- **ConsistentHash/BoundedLoad:** slot share per backend (`slots[i] / M`), which shows how weights actually landed in the Maglev table; plus `eps`, `totalInflight` and the current `cap`.
- **PeakEWMA:** per-node `ewmaAt(now)`, stamp age, and which nodes are unsampled (it would have made the §H1 black hole obvious).
- **WeightedRandom:** `builds`, and the effective probability per node.

This is invaluable for support tickets and for the demos (which currently reach into `_private` fields).

### 2.4 [P1] Consistent, machine-readable errors
Only `LITE_PICK_NONE` has a `.code`. Give every thrown error a stable code, for example:

- `LITE_PICK_RANGE`
- `LITE_PICK_TYPE`
- `LITE_PICK_CAPACITY`
- `LITE_PICK_TABLE_SIZE`
- `LITE_PICK_WEIGHT`

Export them as constants, and keep the `[lite-pick]` message prefix. Exporters and tests can then match on codes rather than message text.

### 2.5 [P2] Health-to-eligibility audit trail
If the eligibility writer moves behind an API (see §3.1), that API can keep a tiny ring of the last K `(i, up, epoch)` transitions in a pre-allocated `Uint32Array`. That gives operators a free flap history ("node 7 flipped 40 times in the last minute") with no hot-path cost.

---

## 3. Code and API

### 3.1 [P0] Make eligibility ownership impossible to get wrong
Root cause of FINDINGS §H2: a *shared, externally written* bitmap combined with *cached* aggregates (`_live`, `_totalEligibleWeight`) that only the balancer's own `setEligible` maintains. Pick one coherent model:

- **Option A (recommended): a small `Eligibility` object** as the shared unit.
  ```js
  export class Eligibility {
    constructor(cap) { this.bits = new Uint8Array(cap); this.live = 0; this.epoch = 0; }
    set(i, up) { /* validate integer i; flip; live += ±1; epoch++ */ }
  }
  const el = new Eligibility(8);
  const a = new P2cBalancer(8, el, inflight), b = new RoundRobinBalancer(8, el);  // truly shareable
  ```
  - Balancers read `el.live` directly, so there is no per-balancer cache to desync.
  - SmoothWRR keeps its total keyed on `el.epoch` and recomputes cold on mismatch, an O(cap) cost only after a flip.
  - `Uint8Array` input stays accepted for backward compatibility, wrapped as an `Eligibility` with a documented "don't write directly" rule.
- **Option B: no cached aggregates.** Compute `live` during the scan (RoundRobin, LeastConn, SED and NQ already scan), and treat `_live` only as a hint that is re-validated on the rare fallback path. This costs a little on the O(1) strategies.

Either way, delete RECIPES §3(a), and have the docs say "one writer API".

### 3.2 [P0] One validation helper, applied everywhere
```js
function idx(i, cap) {
  if ((i >>> 0) !== i || i >= cap) throw rangeErr('index out of range: ' + i);  // rejects NaN, 1.5, -1, '2'
  return i;
}
function u32View(name, a, cap) { if (!(a instanceof Uint32Array) || a.length < cap) throw rangeErr(`${name} must be…`); return a; }
```
- The first helper fixes FINDINGS M1 in one place.
- The second collapses about 12 copies of the same constructor check.
- `isEligible` should use the same integer test (and return `false` rather than throw).

### 3.3 [P0] Fix the algorithm details before calling 1.x "reference"
These are covered in FINDINGS; they're listed here as design changes:

- **SmoothWRR:** skip `w === 0` in the pick loop and reset credit in `setWeight`. Consider renormalizing the remaining accumulators on an eligibility transition, which keeps the invariant `Σ current = 0`.
- **BoundedLoad:** use `cap = ceil((1+ε)·(total+1)/live)`, which is the paper's and HAProxy's definition.
- **PeakEWMA:**
  - Add a penalty for unsampled nodes and for pending requests, as Finagle does.
  - Clamp `dt ≥ 0`.
  - Blend with the undecayed history.
  - Rename "half-life" to "time constant", or change the math to match the name.
  - Consider `initialRttNs` as a constructor option.
- **LeastConn/SED/NQ:** start the scan from a rotating cursor so ties are spread (0 B/op, still deterministic).
- **Sparse fallback scans:** the current scan returns the first eligible node after a random offset, which biases toward nodes that follow runs of down nodes. Replace it with a uniform choice: count the eligible nodes, draw k, then walk to the k-th. It stays O(cap), is still rare, and is still 0 B/op.
- **ConsistentHash probe exhaustion:** add a cold O(M) sweep after the 64-slot window. It is rare, and it removes the "healthy nodes exist but PICK_NONE" failure mode.

### 3.4 [P1] Pool contract hardening
- **Truly distinct failover.** Track the endpoints tried in a small fixed-size array (`tries` is small) and re-pick while the result repeats, with a bound, then fall back to a scan. Alternatively, offer `strategy.pickExcluding(mask)`.
- **Keyed balancers must receive a key.** Mark them (`static KEYED = true`), throw `LITE_PICK_KEY_REQUIRED` when `key` is missing, and stop passing `key` into PeakEWMA's `now`.
- **Abort before dispatch.** Call `signal?.throwIfAborted()` before *every* attempt. Today an already-aborted signal still dispatches the first attempt.
- **Feedback is never a failure.** Wrap `recordRtt` and `note`, so an error in feedback can't turn a success into a retry (FINDINGS M4).
- **Failure feedback.** Add `opts.failurePenaltyNs`, or a `classify(err)` hook, so a latency-aware balancer learns from errors.
- **Timeouts and hedging (roadmap).** A per-attempt `timeoutMs` built on `AbortSignal.any([signal, AbortSignal.timeout(ms)])`, and later a hedged second request after the p95 latency. These are what production users reach for next.
- **Types.** Make `Pool<B extends Balancer>` generic, so `pool.balancer` keeps its concrete type, and add overloads that *require* `key` for keyed balancers.

### 3.5 [P1] Keep the cold paths as disciplined as the hot path
- **ConsistentHash `_build` allocates on every rebuild:** `offset`, `skip`, `quota`, `next`, `filledCount` and `taken`, about 64 KB at the default M. Pre-allocate that scratch in the constructor, as `WeightedRandomBalancer` already does. The docs then become true ("no allocation on any path").
- **Bound the table size:** cap M (for example `M ≤ 2^24`), and use additive stepping (`c += skip; if (c >= M) c -= M`) instead of the multiply-then-modulo that loses precision above ~9.5e7.
- **Minimal disruption on weight change:** today `setWeight` does a full O(M·N) rebuild. For large pools, a *proportional* re-fill that only touches slots of the changed backend would keep more keys in place. At minimum, measure disruption for a weight change in `bench:disruption`; today it only measures removals.

### 3.6 [P1] Trim process chatter from the shipped source
- **Source comments:** `Pick.js` is 1308 lines, and roughly 60% of that is comments full of milestone and session history ("M7", "this session APPENDS…", "Fork 0", ADR cross-references in every paragraph).
- **Tarball size:** the published package is 75 kB packed, dominated by README, CHANGELOG and llms.txt.
- **Recommendation:**
  - Keep JSDoc to contract, complexity and ownership in 3–8 lines per symbol, and move design history into `decisions/`.
  - Consider not shipping CHANGELOG.md and llms.txt in the tarball; link to them instead.
  - Remove internal-process language from README and llms.txt.

### 3.7 [P2] Micro-API polish
- **Literal types:** `VERSION: '1.0.0'`, `PICK_NONE: -1`, `CH_DEFAULT_M: 65537`.
- **Strategy name:** a `static STRATEGY = 'p2c'` on each class, useful for telemetry labels.
- **Required arguments:** make `pick(now)` and `pick(keyHash)` required in the `.d.ts` (FINDINGS M3).
- **Seed API:** `Prng` could expose `seed` read-only, and `reseed(s)`.
- **Tracing hash:** `ConsistentHashBalancer.lookup(keyHash)` returns the *home* backend without the eligibility probe. It's useful for debugging and tests.
- **Iteration protocol:** implement `Symbol.for('nodejs.util.inspect.custom')` to print `describe()` in the REPL.

---

## 4. Testing and verification

### 4.1 [P0] Get `verify` green and meaningful
- **PerfGate #17:** shrink the WeightedRandom heavy-outage scenario, or pass `--no-memory-reducer` (FINDINGS H5).
- **Must-fail controls that can't be optimized away:** write each control allocation into a 64-slot ring so it escapes, and compare buffers by identity for `grows`.
- **Honest torture labels:** label torture as a *retention* check, and give it a must-fail control (FINDINGS H6).
- **Fix `bench:verify`:** either re-measure what the README says it re-measures, or say "stored" (FINDINGS M-T1). Prefer **relative** gates, lite-pick versus a competitor on the same machine in the same run, over absolute ops/s from someone's laptop.
- **Fix every benchmark entry point** with `pathToFileURL` (FINDINGS M-T2).

### 4.2 [P0] CI
There is no CI today. A minimal A+ setup:

| Job | Trigger | Content |
|---|---|---|
| test | push / PR | Node 20, 22 and 24 × ubuntu, macos and windows: `npm test`, `test:types`, `fuzz`, `balance` |
| gates | push / PR (ubuntu) | `torture`, `test:perf` (pinned flags), `bench:verify`, `npm pack --dry-run` size budget |
| types-compat | push / PR | consumer fixture compiled with TS 5.x under `node16`, `bundler` and `node10` resolution, and with `lib: ES2022` only (catches FINDINGS L15/L16) |
| soak | nightly | `SOAK_DURATION=45m`, upload JSONL + report |
| release | tag | `npm publish --provenance`, verifying VERSION = package.json = llms.txt = tag |

### 4.3 [P1] Coverage and mutation testing
- **Coverage:** add `c8` with a 100% line and 100% branch target on `Pick.js` and `Pool.js`. The "unreachable" defensive branches should either be proven unreachable (and removed) or covered.
- **Mutation testing:** run **Stryker** (or a small hand-rolled mutant set) against `Pick.js`. FINDINGS H3 shows the current tests don't pin down weight-0 behaviour for SmoothWRR, and mutation testing finds exactly that class of gap. Track the mutation score as a quality metric in the README.

### 4.4 [P1] Property-based tests with a model
The fuzzer checks invariants. Add a **reference-model oracle** as well: a tiny, obviously correct but slow implementation of each strategy, operating on plain arrays and recomputing everything on every call. Drive it in lockstep with the real balancer under random operation sequences, including weight 0, non-integer indices (which must throw), sparse eligibility, and `cap ∈ {1, 2, 3}`.

- **Deterministic strategies** (RoundRobin, SmoothWRR, LeastConn, SED, NQ, ConsistentHash, BoundedLoad): assert identical picks.
- **Randomized strategies** (P2C, PeakEWMA, WeightedRandom): assert the same *candidate set* given the same PRNG draws.

### 4.5 [P1] Statistical tests with explicit power
For WeightedRandom and P2C, replace fixed tolerances with χ² or KS tests at a stated significance. Also include a known-bad control, for example a WeightedRandom with one weight perturbed by 5%, which **must** be rejected. That proves the test has power.

### 4.6 [P2] Faster `witness`
`witness` takes 131 s, mostly on O(cap) strategies at n=4096 × 2M operations. Scale the operation count by 1/n for linear strategies (the complexity *slope* is what's being tested), and add RoundRobin's sparse-eligibility worst case, which is currently never measured.

---

## 5. Packaging, release and supply chain

- **Engines [P1]:** move to `>=20`. Node 18 is EOL, and the dev tooling already requires 20.
- **Exports [P1]:** add `"./package.json": "./package.json"` to `exports`, and add `typesVersions` for `/pool` so node10-resolution consumers work.
- **Provenance [P1]:** publish with `--provenance` from CI. Add `SECURITY.md` (with a reporting address) and a `CONTRIBUTING.md` that states the gate discipline (for example, never widening a bound to make a gate pass).
- **Size budget [P2]:** add a size budget check in CI covering tarball size and the byte size of `Pick.js` with comments stripped. The kernel's value proposition is "tiny and fast", so measure it.
- **Supply-chain CI [P2]:** run `npm audit signatures` in CI. Pin devDependencies exactly: the benchmark competitors already are, but the `@zakkster/*` tooling uses caret ranges, and a tooling update can move a perf gate.

---

## 6. Demos

Covered in FINDINGS (M-D1…M-D4, L23–L26). In short:

- Bind the demo web server to loopback, restrict it to an allowlist of paths, and fix the traversal check.
- Vendor or SRI-pin the CDN modules.
- Drive BoundedLoad in the demos through deltas passed to `note()`.
- Make the TUI reset use `DEFAULT_CONC`.
- Restore the terminal on SIGTERM/SIGHUP, and use the alternate screen.

Once `describe()` exists (§2.3), switch the demos to use it instead of `_private` fields. The demos then double as integration tests of the public observability surface.

---

## Suggested roadmap

| Step | Contents | Outcome |
|---|---|---|
| **1.0.1** (bug-fix) | FINDINGS H1–H4, M1–M4; §3.2 validation; RECIPES §3(a) removed; `verify` green; CI (test + gates) | correct under every documented usage |
| **1.1** (observability) | §2.1 counters, §2.2 diagnostics_channel/hooks, §2.3 `describe()`, §2.4 error codes; Pool hardening §3.4 | operable in production |
| **1.2** (proof) | soak §1.1–§1.7 + nightly CI; model-oracle tests §4.4; coverage + mutation §4.3; relative bench gates | quality proven continuously |
| **2.0** (if needed) | §3.1 `Eligibility` object as the shared unit (breaking); required `pick()` args in types | foot-gun-free API |

Doing 1.0.1 → 1.2 would, in my assessment, put lite-pick firmly in A+ territory. It would be a kernel whose correctness, selection quality and zero-GC claims are each backed by a gate that is green, has teeth, and runs automatically.
