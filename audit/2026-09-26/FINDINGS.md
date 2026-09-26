# lite-pick — Full Audit Findings

**Scope:** the whole repository at commit `8c1ecc7`, version `1.0.0`. That covers:

- the core kernel (`Pick.js`)
- the `/pool` request layer (`Pool.js`)
- the type declarations (`Pick.d.ts`, `Pool.d.ts`)
- the documentation (README, GUIDE, RECIPES, llms.txt, CHANGELOG, ADRs, ROADMAP)
- packaging (`package.json`, `npm pack`)
- the test, benchmark and verification tooling
- the demos (`demo/fanout.mjs`, `demo/pool-scope/**`)

**Method:** I read the code line by line. Every behavioural claim below was reproduced with a script against the real modules. I also ran every `npm` script, some of them several times. Repro snippets are inline.

**Environment:** Node v22.22.2, Linux, 4 cores.

---

## Executive summary

The pick paths are carefully engineered. They really are allocation-free, the fail-closed sentinel is used consistently, and the unit suite (138 tests) passes. The most serious problems sit around the kernel rather than in the selection loops themselves:

1. **PeakEWMA + Pool is a black hole.** Failures and hangs are never fed back into the latency estimate. A fast-failing or hung endpoint therefore becomes the *most* attractive one, and failure rates double (§H1).
2. **Direct eligibility writes are documented as supported, but they corrupt balancer state.** The cached `_live` count and SmoothWRR's weight total go stale. Result: pools that are up but refuse to pick, weight ratios destroyed, and 100% of traffic sent to one node (§H2).
3. **SmoothWRR can return a weight-0 node** after `setWeight(i, 0)`, which is the natural way to drain a node (§H3).
4. **BoundedLoad loses key affinity at low load.** The cap is below 1 whenever total in-flight is smaller than `live / (1+eps)` (§H4).
5. **`npm run verify` fails.** The last step (`test:perf`) fails on every run, because V8's memory reducer fires during a 16 s scenario (§H5).
6. **The "0 B/op" torture checks can't detect allocation that is freed again.** They only measure *retained* bytes (§H6).
7. **The demo web server** listens on all interfaces, serves the whole repo including `.git/`, and has a prefix-match traversal bug (§M-D1, §M-D2).

| Severity | Count |
|---|---|
| High | 6 |
| Medium | 17 |
| Low | 26 |
| Info | a handful |

---

## Results of running the scripts

| Script | Result | Notes |
|---|---|---|
| `npm test` | ✅ PASS | 138/138, 1.7 s |
| `npm run test:types` | ✅ PASS | tsc 7.0.2 (also passes under 5.6) |
| `npm run torture` | ✅ PASS | ~19 s — but see §H6 on what it can detect |
| `npm run witness` | ✅ PASS | **131 s** (linear strategies at n=4096 × 2M ops) |
| `npm run balance` | ✅ PASS | 3.8 s |
| `npm run fuzz` | ✅ PASS | ~1 s — but see §H3 and §M-T2 |
| `npm run test:perf` | ❌ **FAIL** | #17 `WeightedRandom heavy-outage fallback scan`: `oldgen: 2 > 0`, failed on every run tried (6 by the tests reviewer, plus mine). #1 detector validation and the must-fail checks #26/#27 fail on some runs |
| `npm run verify` | ❌ **FAIL** | because `test:perf` fails |
| `npm run bench:verify` | ✅ PASS | but see §M-T1 on what it actually verifies |
| `npm run bench` / `bench:fairness` / `bench:disruption` | ✅ PASS | |
| `npm run bench:gc` | ⚠️ failed 1 of 4 runs | `maxPause 4.6 ms > 2 ms` absolute limit, machine-dependent |
| `npm run soak` (short) | ✅ PASS | `SOAK_CYCLES` / `SOAK_PICKS` give a bounded smoke mode |
| `npm run demo`, `npm run scope:frames` | ✅ PASS | the full scripted matrix (8 scenarios × 10 strategies) also ran clean |
| CI | ❌ none | There is no `.github/workflows` or any other CI config. Nothing runs `verify` automatically. |

---

## HIGH

### H1. PeakEWMA + Pool: fast-failing or hung endpoints become black holes
**Files:** `Pick.js:685-689, 711-715, 754-770`, `Pool.js:141-151`

Two design choices combine here.

**Choice 1: the cold-start baseline is 1.0 ns.** An unsampled node has `ewma = 1.0` with the `_stamp = -1` sentinel. Sampled nodes carry real RTTs in nanoseconds (for example `1e6`). So in a mixed pool, an unsampled node's cost `(inflight+1) × 1` beats a sampled node's `1 × 1e6` until it has about **a million** requests in flight.

**Choice 2: `Pool` only calls `recordRtt` after a successful `fn`.** A node that throws never gets a sample. A node that hangs never settles.

**Consequences:**

- **A fast-failing node that was never sampled keeps the baseline forever.** It wins every P2C draw it takes part in. Repro: 4 nodes, node 0 always throws, the others take 1 ms, and `Pool.run` uses `{ clock }`. Node 0 received **988 of 2000 requests**, and the failure rate was **49.4%**. Uniform routing would have given 25%.
- **A node that was healthy and then starts failing** has its estimate decay toward 0 (`exp(-dt/tau)`), because no further samples arrive. It then *also* becomes preferred: the tests reviewer measured `ewmaAt ≈ 4e-5` versus `9.9e5` for healthy nodes, and a ~50% share of traffic.
- **A hung node that was never sampled** attracts traffic without limit. Repro: 4891 of 10 000 picks went to it, leaving 4891 requests stuck in flight, and it was still being chosen.

Finagle, which the code cites, guards against this with a penalty for nodes that have pending requests and no latency data, and by feeding failures back.

**Fix:**
- In Pool, call `recordRtt(i, penaltyNs /* or elapsed × k */, done)` in the `catch` branch.
- Seed unsampled nodes from the pool's median sampled EWMA, or from a caller-supplied `initialRttNs`, not from `1.0`.
- Apply a penalty when `inflight > 0` and the node is unsampled or its estimate has decayed toward 0.
- Add Pool tests for fail-fast and hung endpoints; none exist today.

### H2. Eligibility written directly, or shared between balancers, corrupts internal state, and the docs endorse it
**Files:**
- `Pick.js:139-140, 159-163, 186-196, 246, 425, 757, 986, 1108, 1287`
- `RECIPES.md:64-79`
- plus about 15 doc locations (listed below)

`BalancerBase` caches `_live` at construction and updates it only in `setEligible()`. SmoothWRR also caches `_totalEligibleWeight`. Every `pick()` relies on these:

- the fail-closed short-circuit `_live === 0`
- the P2C / PeakEWMA shortcut `_live === 1`
- SmoothWRR's `cur[best] -= total`

**RECIPES §3 option (a)** says `eligible[2] = 0; // zero-copy, pick sees it live` is supported, with only a soft "prefer setEligible when you rely on `live`". The file header says "writers mutate `eligible` at their own cadence; pick() only reads it". RECIPES also reuses one `eligible` array across several balancers.

What goes wrong, all reproduced:

| Scenario | Result |
|---|---|
| Pool constructed all-down, then `el[2] = 1` written directly | `live = 0` and `pick() === -1` **forever**, with a healthy node available. `Pool.run` throws `LITE_PICK_NONE`. |
| SmoothWRR weights `[5,1,100]`, then `el[2] = 0` written directly | 60 000 picks give **31132 / 28868** (expected about 50 000 / 10 000). The accumulators drift without bound, reaching `-3e6` and still growing. |
| SmoothWRR weights `[5,1,0-eligible→100]`, then `el[2] = 1` written directly | **1060 / 1060** picks go to node 2 |
| Running the RECIPES snippet exactly as written, (a) then (b) | `live` becomes 4, then **5 on a capacity of 4** |
| Two balancers share one array; `a.setEligible()` ×3 | `b.live` stays 4 while 1 node is up. A later `b.setEligible(0, true)` does nothing (the byte is already 1), so `b` never recovers. |

**Fix:**
- Remove option (a). State that `setEligible()` is the *only* supported writer, and that each balancer needs its own array.
- Alternatively, drop the cache: compute liveness during the scan, or add a `recount()` API and document it.
- Reword every doc location that says the eligibility view is written externally:
  - `README.md:22, 35-36, 55, 367-368, 435, 437`
  - `GUIDE.md:9`
  - `RECIPES.md:8, 64-66, 336-337, 371-372`
  - `llms.txt:12-13, 104-105, 123-124`
  - `Pick.d.ts:35-37`
  - `Pick.js:13-16, 140, 149-150`
  - `CHANGELOG.md:511`
  - `decisions/0001:48-52`, `decisions/0002:36`

### H3. SmoothWRR returns a weight-0 node after `setWeight(i, 0)`, and after some eligibility flaps
**File:** `Pick.js:324-332, 338-352`

`setWeight` changes the weight but does not reset `_current[i]`. `pick()` also considers weight-0 nodes. A node drained to 0 while it still holds positive credit, or a pool whose accumulator sum went negative because a node left with credit, can therefore have a weight-0 node hold the maximum accumulator.

```js
const s = new SmoothWRRBalancer(4, new Uint8Array(4).fill(1), new Uint32Array([5,4,3,2]));
s.pick();            // -> 0
s.setWeight(1, 0);   // drain node 1
// next 30 picks: 2,3,0,2,0,**1**,0,3,2,0,...   <- weight-0 node 1 returned
```

A randomized search also found weight-0 picks triggered purely by eligibility toggles. The tests reviewer added a single "never pick weight-0" check to a scratch copy of the SmoothWRR fuzz spec, and it failed immediately on every seed in the corpus. SED and NQ have this check; SmoothWRR (`test/fuzz.mjs:60-72`) does not.

**Fix:** skip `wt[i] === 0` in the pick loop (`if (el[i] && wt[i])`), and reset `_current[i] = 0` in `setWeight`. Add the fuzz check and a unit test.

### H4. BoundedLoad destroys key affinity at low load
**File:** `Pick.js:1113, 1118, 1128`

`cap = (1+eps) × _total / live`, with no ceiling, and the test is `inf[i] < cap`. Whenever `_total < live / (1+eps)`, the cap is below 1, so *any* backend with a single request in flight counts as over cap.

Repro:
- 10 backends, eps 0.25. With one request in flight on the home backend, the second request for the **same key** goes to a different backend (cap = 0.125).
- 5 concurrent requests for one key spread across **5 different backends**.

Low concurrency is exactly where cache affinity matters most. The paper (Mirrokni–Thorup–Zadimoghaddam) and HAProxy's `hash-balance-factor` use `ceil((1+eps) × (m+1) / n)`, counting the incoming request, so the cap is always at least 1. All the tests run at high occupancy (100 in flight, or a mean of 10).

**Fix:** use `cap = Math.ceil((1 + eps) * (total + 1) / live)` with `inf[i] < cap`, or an equivalent `<=` form. Add a low-load stickiness test.

### H5. `npm run verify` fails: PerfGate #17 trips on V8's memory reducer
**File:** `test/perf/PerfGate.test.mjs:404-431, 678-683`

The WeightedRandom heavy-outage scenario does 1.8M picks, each scanning 16 384 slots, which takes about 16.7 s.

- V8's memory reducer starts after about 8 s of low allocation and runs 2 GCs, which is exactly the reported `oldgen 2`.
- `--trace-memory-reducer` confirms it: GC #1 fires at ≈8.1 s and GC #2 at ≈8.7 s.
- With `--no-memory-reducer`, the scenario passes.

This is a false positive, but it means the project's own release gate is red.

**Fix:** shrink the scenario (a smaller CAP or N) so each phase finishes well under 8 s, or add `--no-memory-reducer` to the `test:perf` script. Separately, make the must-fail checks robust (see §M-T3).

### H6. torture's "0 B/op" checks cannot detect allocation that is freed again
**File:** `test/torture.mjs:151-322` (also the B/op figure at `benchmark/GcBlastRadius.mjs:158,176`)

`measureAllocs` counts only bytes that are **still alive after a forced GC**, and takes the minimum across batches. torture rounds that figure and treats `null` ("could not measure") as 0.

The tests reviewer demonstrated the gap: a `pick()` wrapper that allocates an object per call, and one that allocates a string per call, both report **"0 B/op PASS"**. torture has no must-fail control, so nothing shows it can ever fail.

The kernel really is allocation-free: PerfGate's scavenge counting supports that. But torture's labels overstate what torture itself proves.

**Fix:** relabel these as *retention* checks, treat `null` as a failure, and add a must-fail control. Rely on PerfGate's scavenge counting for the allocation claim.

---

## MEDIUM — core library and Pool

### M1. Non-integer or NaN indices corrupt `_live` and pass validation
**Files:** `Pick.js:176-178, 186-196, 732, 962, 1090, 1265`

The range checks `i < 0 || i >= cap` pass for `NaN` and for fractions like `1.5`. Typed-array access at those indices reads `undefined` and ignores writes. As a result:

- `setEligible(1.5, false)` / `setEligible(NaN, false)` **decrement `_live` without flipping any bit**. Four such calls on a healthy 4-node pool give `live = 0` and `pick() === -1`.
- `setEligible(0.5, true)` on an all-down pool gives `live = 1` while `pick()` still returns -1.
- `isEligible(1.5)` returns **true** (`undefined !== 0`).
- `note(NaN, 1)` changes BoundedLoad's `_total`.
- `recordRtt(1.5, …)` and `setWeight(NaN | 1.5, …)` silently do nothing.

**Fix:** validate every index with `Number.isInteger(i)` (or `(i >>> 0) === i`), and make `isEligible` return false for non-integers.

### M2. Pool's "distinct-endpoint failover" is not distinct
**Files:** `Pool.js:12-15, 68-71`, `Pool.d.ts`, `README.md:408`

Pool just re-picks with the failed node's in-flight count raised. Whether the next pick lands elsewhere depends on the strategy:

| Balancer | Attempts with `tries: 3`, always throwing |
|---|---|
| ConsistentHash (keyed, or unkeyed) | `[3, 3, 3]`: the **same backend every time** |
| WeightedRandom, 2 nodes with weights 100:1, `tries: 2` | the same endpoint in **197 of 200** runs |
| WeightedRandom, 4 nodes, `tries: 3` | a repeat in 649 of 1000 runs |
| LeastConn, `inflight = [0, 5]`, `tries: 2` | `[0, 0]` |

The demo's "re-picked a different replica" counter shows `3>3>3` sequences as well.

**Fix:** track the endpoints already tried in `run()` and re-pick while the choice is in that set (bounded), falling back to a scan. Or reword the contract as "re-picks with the failed endpoint's load raised (usually a different one)", and document which strategies can't guarantee a different endpoint.

### M3. Pool with a keyed balancer: a missing `key` silently routes everything to one backend, and `key` and `clock` are conflated
**Files:** `Pool.js:112-113, 129`, `Pool.d.ts:14, 34-38`, `Pick.d.ts:189, 226, 272`

- `run(fn)` against ConsistentHash or BoundedLoad without `opts.key` calls `pick(undefined)`, so the key becomes 0. Repro: 100 requests all went to **backend 7 of 8**.
- With `clock` but no `key`, the clock reading is used as the *hash key*.
- With both `key` and `clock` against PeakEWMA, `pick(key)` passes the key as `now`.
- The types declare `pick(keyHash?: number)` / `pick(now?: number)` as optional, and `Balancer.pick(arg?: number)` merges the two meanings.
- `Pool.d.ts` says `key` is "ignored by non-keyed strategies"; it isn't ignored by PeakEWMA. It also ties the `note` hook to `key`, but `note` is driven whenever the balancer has a `note` method.

**Fix:**
- Make the parameters required in the `.d.ts` files.
- Give keyed balancers a marker, such as `static keyed = true` or `pick.length`, and have Pool throw when `key` is missing.
- Keep `key` and `clock` as separate channels.

### M4. A `recordRtt` exception after a *successful* call turns the success into a failover retry
**File:** `Pool.js:141-151`

`recordRtt` is inside the inner `try`, so if it throws, the `catch` treats the attempt as failed and Pool re-dispatches. For example, a clock that returns `NaN` or `Infinity` makes `recordRtt` throw a RangeError. Repro: `fn` ran **twice** for a single successful request. That duplicates side effects for non-idempotent work.

**Fix:** capture `out`, run the rtt feedback outside the attempt's `try` (or wrap it and swallow errors), then `return out`.

### M5. LeastConn and NQ send 100% of light traffic to the lowest index
**File:** `Pick.js:486-491, 599-608`

Ties always go to the lowest index. With sequential traffic (concurrency 1) through Pool, the split was **LeastConn [1000, 0, 0, 0]** and **NQ [1000, 0, 0, 0]**. This is documented, but it is an operational trap: it concentrates cache and connection warm-up on node 0 and leaves the others cold. nginx `least_conn` and HAProxy `leastconn` break ties round-robin.

**Fix:** start the scan from a rotating cursor, as RoundRobin does. That stays 0 B/op and remains deterministic.

---

## MEDIUM — documentation and types

### M-Doc1. BoundedLoad docs say to mutate in-flight "only through `note()`", but `note()` never writes `inflight`
**Files:**
- `README.md:228`
- `llms.txt:64-66, 239-241`
- `Pick.d.ts:239-241, 251-252`
- `Pick.js:1031-1033, 1043-1045`
- `decisions/0011:46-47`
- `CHANGELOG.md:83-84`

`note()` updates `_total` only. Following the text literally (calling `note` and never touching `inflight`) leaves `inflight` at all zeros, so every pick is under cap and hotspot protection is silently lost. The README's own example contradicts the text: it does `inflight[i]++` *and* calls `note`.

**Fix:** say "update `inflight[i]` **and** call `note(i, ±1)` in lockstep (or use `/pool`)".

### M-Doc2. The README shows the wrong `VERSION`
**File:** `README.md:387` shows `VERSION; // -> '0.9.0'`. The runtime value is `'1.0.0'`.

---

## MEDIUM — tests and benchmarks

### M-T1. `bench:verify` verifies much less than the README claims
**Files:** `benchmark/Report.mjs:347-406`, `README.md:275`

The README says `bench:verify` fails if a README number drifts from a *fresh run* (timing within ±15%). In fact:

- **Timing and GC headline numbers** are compared against the stored `results.json`, which the same script wrote. Nothing is re-timed, so the check only catches hand-edits to the README.
- **Only the seeded P2C balance table and the disruption table** are recomputed fresh.
- **`measureFairness()` runs, but its result is never checked.**
- **Numbers outside the fenced blocks are not checked at all.** For example, the README's "~107x" was measured as 76x here.

`results.json` came from Node v26.8.2 on an Apple M4 Pro. The code nevertheless calls it "machine-independent".

**Fix:** correct the README claim, and either re-measure these numbers in verify or label them "stored".

### M-T2. Every `benchmark/*.mjs` silently does nothing when the path contains a space, or on Windows
**Files:** `Report.mjs:410`, `Matrix.mjs:271`, `GcBlastRadius.mjs:220`, `Fairness.mjs:178`, `Disruption.mjs:91`

The entry check `import.meta.url === 'file://' + process.argv[1]` fails because `import.meta.url` percent-encodes the path (a space becomes `%20`). In a copy under a path with a space, `bench:verify` accepted a tampered README and **exited 0**.

**Fix:** `import.meta.url === pathToFileURL(process.argv[1]).href`.

### M-T3. PerfGate must-fail controls are flaky, and the `grows` counter can never fire
**File:** `test/perf/PerfGate.test.mjs:585-619`, `:37-39`

- `const arr = [pick()]; sink += arr[0]` never escapes, so once V8 optimises the loop it can remove the allocation. The observed counts were `scavenges N: 2-3, 8N: 0`, and the ConsistentHash and BoundedLoad must-fail checks failed in 3 of 5 runs.
- A typed array's `buffer.byteLength` can't change, so the `grows` check can never trigger.

**Fix:** write each control allocation into a 64-slot ring so it escapes, and compare buffer *identity* instead of `byteLength`.

### M-T4. The fuzzer's "single node down" block exercises a broken state
**File:** `test/fuzz.mjs:300-301`

It writes `el[0] = 0` directly and *then* calls `b.setEligible(0, false)` on 9 balancers that share `el`. Every `setEligible` call does nothing, so every balancer keeps `live = 1`. The resulting PICK_NONEs come from fallback branches that the code comments call "unreachable".

**Fix:** remove the direct write, give each balancer its own array, and assert `checkBase` afterwards.

### M-T5. Test gaps for the core bugs above
No test covers:

- non-integer or NaN indices (M1)
- SmoothWRR `setWeight(i, 0)` (H3)
- BoundedLoad at low load (H4)
- Pool + PeakEWMA with failing or hung endpoints (H1)
- Pool failover distinctness beyond LeastConn/PeakEWMA on n=2 (M2)
- `Pool.run(fn, null)` (L1)
- direct or shared eligibility writes (H2)
- BoundedLoad under-cap preference and ConsistentHash stickiness (no strategy-specific fuzz checks)

---

## MEDIUM — demos

### M-D1. The demo web server listens on 0.0.0.0 and serves the whole repo, including `.git/` and `node_modules`
**File:** `demo/pool-scope/web/serve.mjs:21, 29, 70`

`server.listen(PORT)` has no host argument. Over a non-loopback address, `/.git/config`, `/package.json` and `/node_modules/...` all returned 200. Every HTTP method is served, and there is no Host-header check, so a DNS-rebinding attack is possible.

**Fix:** `listen(PORT, '127.0.0.1')`; allow only the paths the page needs (`/demo/pool-scope/`, `/Pick.js`, `/Pool.js`); reject methods other than GET and HEAD; check the Host header.

### M-D2. The path-traversal guard is a prefix match without a separator
**File:** `serve.mjs:59` — `if (!abs.startsWith(ROOT))`

`/../lite-pick-secret/x` resolves to `/home/user/lite-pick-secret/x`, which still starts with the ROOT string `/home/user/lite-pick`. Verified with `curl --path-as-is` and with `%2e%2e`: a sibling directory's file was served. `readFile` also follows symlinks out of ROOT.

**Fix:** `const rel = path.relative(ROOT, abs); if (rel.startsWith('..') || path.isAbsolute(rel)) → 403`, and optionally `realpath` the result.

### M-D3. The pool-scope driver desyncs BoundedLoad's `_total`
**File:** `demo/pool-scope/driver.mjs:482-483, 540-543`

The pin and ceiling clamps write `inflight[i]` directly, and settle calls `note(w, -1)` even when the counter was already 0.

In the *overload* scenario the sum of `inflight` was 99 while `totalInflight` was 73, so the displayed and routed cap was 7.60 instead of 10.31. The *pingpong* scenario diverged by up to 12.

**Fix:** apply clamps as deltas, calling `note(i, target - inflight[i])`, and call `note(-1)` only when a decrement actually happened.

### M-D4. The TUI reset sets concurrency to 108, not the default 72
**File:** `demo/pool-scope/tui.mjs:542`

The default is 72 (`driver.mjs:33`). At 108, a healthy pool shows false OVERLOAD alarms, for example 81 frames on SmoothWRR. The web reset uses 72, so the TUI and the web page disagree.

**Fix:** use `DEFAULT_CONC`, or replace the driver the way the web version does.

---

## LOW

### Core library and Pool

| # | File | Issue | Fix |
|---|---|---|---|
| L1 | `Pool.js:112` | `Pool.run(fn, null)` throws a raw `TypeError: Cannot read properties of null (reading 'key')`. The other opts reads are null-safe. | `opts != null && opts.key !== undefined` |
| L2 | `Pick.js:397, 407-415, 1297-1305` | The sparse-eligibility fallback scan is **biased**, despite the P2C comment "unbiased first-eligible-after-a-random-offset". With only nodes 0 and 1 eligible out of 100 at equal weight, P2C `_draw` and WeightedRandom give **63.5% / 36.5%**, because 27% of draws reach the fallback. | Fix the comment. Optionally scan from a random start and pick uniformly among the eligible nodes, or use the documented `RandomSet` seam. |
| L3 | `Pick.js:993-999` | ConsistentHash / BoundedLoad fail closed after 64 *slots*, not 64 backends. With 60 of 64 backends down (4 healthy), **0.81%** of keys got PICK_NONE. This is documented, but it is an availability loss during mass outages. | A cold full-table scan fallback when the probe window is exhausted, or a probe limit that scales with `M/live`. |
| L4 | `Pick.js:740-742` | The PeakEWMA blend differs from the cited Finagle formula. The code decays the estimate first, then blends with `(1-w)` from the same `dt`, so the history is weighted `w²`: `ewma·w² + s·(1-w)`. Finagle uses `cost·w + s·(1-w)` and compares the sample to the undecayed cost. | Use `e_old·w + s·(1-w)`, or document the difference. |
| L5 | `Pick.js:647, 664`, `Pick.d.ts:180`, `README.md:151,165` | `tau` is called the EWMA **half-life**. With `exp(-dt/tau)` it is the time constant; the half-life is `tau·ln 2`. | Fix the wording. |
| L6 | `Pick.js:714, 740` | A negative `dt` (a non-monotonic clock) is not clamped: `exp(+x)` inflates the estimate. Finagle uses `max(t - stamp, 0)`. | Clamp `dt` at 0. |
| L7 | `Pick.js:936` | ConsistentHash `M` has no upper bound. Above M ≈ 9.49e7, `offset + (j%M)·skip` exceeds 2^53, the permutation loses precision and may stop being a bijection, so `_build`'s `while (taken[c])` could spin. `Uint32Array(M)` is also 4·M bytes. | Cap M (for example ≤ 2^24 + a prime), or use `Math.imul`-free modular stepping (`c = c + skip; if (c >= M) c -= M`). |
| L8 | `Pick.js:122-126` | The `nextBelow` comment says "multiply-shift … Math.imul-free mul"; it is float division. The bias is negligible, but the comment is inaccurate. | Fix the comment. |

### Documentation and types

| # | Location | Issue |
|---|---|---|
| L9 | `README.md:279` vs `285-287` | The prose is stale against the table. It says the weighted-random row is "SKIP … lands at M10" (it has landed), and quotes old numbers (59591/60956, "~22% slower"; the table has 57019/59778, ~12%). The ~2.3× WeightedRandom deficit versus `wrr` is not discussed. |
| L10 | `README.md:390`, `RECIPES.md:305-314, 361-374` | Roster lists omit WeightedRandom and BoundedLoad. The gotchas section doesn't mention the BoundedLoad `note` lockstep. |
| L11 | `README.md:441`, `llms.txt:353-356` | "is an *optional peer* (`peerDependenciesMeta.optional`)", but both fields are `{}`. |
| L12 | `README.md:433`, `llms.txt:106-107`, `decisions/0001:78` | Says the EWMA/RTT arrays are caller-owned; PeakEWMA allocates and owns `_ewma`/`_stamp`. |
| L13 | `RECIPES.md:99` | Claims `[5,1,1,1]` gives `a a b a c a a d`; the actual sequence is `a a b a c a d a`. |
| L14 | `README.md:341-342`, `decisions/0010:54` | "never copied" and "no allocation on any path", but ConsistentHash/BoundedLoad **copy** the weights, and every `setWeight`/`rebuild` allocates 5×`Int32Array(N)` + `Uint8Array(M)` (~64 KB at the default M), leaving cold garbage per rebuild. |
| L15 | `Pool.d.ts:26, 64, 71, 77` | Uses the global `AbortSignal`. A consumer with `lib: ["ES2022"]`, no DOM, no `@types/node` and `skipLibCheck: false` gets TS2304. Declare a minimal `{ readonly aborted: boolean }` type. |
| L16 | `package.json` | The `/pool` types don't resolve under `moduleResolution: node10` (TS2307 in TS 5.x). Add `"typesVersions": { "*": { "pool": ["./Pool.d.ts"] } }`. |
| L17 | `ROADMAP.md:26-32, 88, 186-187` | Stale: shipped milestones still show "planned", "1.0.0 = eight strategies" (it's ten), and M10 "rides lite-o1 AliasTable verbatim" (the build is inline). |
| L18 | `README.md:24, 93`, `llms.txt:152-153, 168`, `Pick.js:365, 460` | Stale "the M5 adapter will…" wording (Pool has shipped), and internal session text in the README ("This session APPENDS one class…"). |
| L19 | `README.md:408, 422` | Tells users to `npm run demo`, but `demo/` isn't in the tarball, so this only works from a clone. It also claims `tries=2` "re-picks a DIFFERENT endpoint" (see M2). |

### Tests, benchmarks and demos

| # | Location | Issue |
|---|---|---|
| L20 | `benchmark/GcBlastRadius.mjs` | The absolute limit `maxPause ≤ 2 ms` is machine-dependent: 4.6 ms in 1 of 4 runs here. |
| L21 | `test/fuzz.mjs:323` | Includes a `Math.random()` seed that is printed only on failure. Replay works, but CI runs are not identical. |
| L22 | `test/witness.mjs` | Takes 131 s. It never measures RoundRobin's sparse-eligibility worst case. |
| L23 | `demo/pool-scope/tui.mjs:509, 548-549` | SIGTERM and SIGHUP leave the cursor hidden. Any arrow key quits (`\x1b` prefix match). There's no alternate screen, so the user's terminal gets wiped. |
| L24 | `demo/fanout.mjs:62-65` | Counts `seen.length > 1` as "a different replica" even for `3>3>3`. Requests that exhaust their tries are silently dropped, so 3998 of 4000 were served with nothing reported. `fetcher` is built but never called. |
| L25 | `demo/pool-scope/web/index.html:29-38`, `main.mjs:27` | A static import of `lite-signal` from esm.sh with no SRI `integrity` entries. If the CDN is down the whole page fails, and a compromised module would run on the localhost origin that can read `/.git/*` (M-D1). |
| L26 | `serve.mjs` | `--port 99999` crashes with a RangeError. EADDRINUSE crashes because there's no `'error'` handler. The `PORT` env var is ignored. The path without a trailing slash returns 404. There's no `nosniff` header. |

---

## INFO

- **Packaging.** `npm pack --dry-run` shows 11 files, 75.5 kB packed and 242.9 kB unpacked. The exports map is correct (`types` first), and `sideEffects: false` is correct. There is no `./package.json` export and no `require` condition; `require(esm)` works on Node 22 but not on Node 18.
- **Engines.** `engines: >=18`, but Node 18 is EOL, and the dev tooling (`@zakkster/lite-leak`, `lite-cleanup`) needs Node 20 or later, so `npm run verify` can't run on 18.
- **Type precision.** `VERSION`, `CH_DEFAULT_M` and `CH_PROBE_LIMIT` could be literal types. `Pool` could be generic over its balancer. The type tests import `../../Pick.js` by relative path, so they never exercise the exports map.
- **Fuzzer.** The ConsistentHash "mass" invariant in `test/invariants.mjs:96` re-implements `pick()`'s probe loop instead of checking it independently.
- **Demo comments.** A few are stale: `OVERLOAD_SAT` says 16 but is 18 (`driver.mjs:45`), `snapshot.mjs:172`, and `detectors.mjs:13`. Switching strategy in the TUI blocks the event loop for about 0.7 s (a synchronous `measureDataPath`).
- **Demo web page.** No XSS sinks with user data were found; all `innerHTML` interpolations are numbers or constants.
- **Confirmed correct:**
  - Vose alias build: a weight-0 column can never survive to the prob-1 drain.
  - Maglev quotas sum to M and the populate step cannot stall for M ≤ ~9e7.
  - The WeightedRandom rejection sampling renormalizes correctly over the eligible mass.
  - The SED/NQ weight-0 exclusion is correct.
  - Pool keeps in-flight counts net-zero on every path tested, including abort and failover.
  - Pick paths do not allocate in the steady state (PerfGate scavenge counts).

---

## Suggested fix order

1. **H1** — record a penalty on failure in Pool, and a sane cold-start baseline or pending penalty in PeakEWMA.
2. **H2 + M-T4** — make `setEligible` the only writer (or drop the `_live` cache), and fix RECIPES and the other docs.
3. **H3** — skip weight-0 nodes in the SmoothWRR pick loop and reset credit in `setWeight`; add the fuzz check.
4. **H4** — use the ceil-based CHBL cap.
5. **H5, M-T2, M-T3** — get `npm run verify` green and trustworthy; add a CI workflow that runs it.
6. **M1, M2, M3, M4** — index validation and the Pool contract (distinct failover, required key, rtt feedback outside the retry).
7. **M-D1, M-D2** — bind the demo server to loopback and fix the traversal check.
8. Documentation sweep (M-Doc1, M-Doc2, L9–L19).
