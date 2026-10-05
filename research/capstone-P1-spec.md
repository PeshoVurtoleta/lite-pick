# Spec: capstone P1 -- the headless kernel (`pickEcosystem/live/`)

**Status:** DECIDED 2026-10-05 -- all recommendations accepted (F1-F8) -- and IMPLEMENTED 2026-10-05 in
`pickEcosystem/live/` (README there). Two measured changes: the F1 numbers (see the correction below), and gate
G3 is about TAIL LATENCY, not share (a slow worker's share drops under every load-aware strategy; its p99 does not). Plan: `capstone-pickEcosystem.md` section 9.
**Goal:** the whole system running HEADLESS -- real workers, health, breakers, supervision, traffic, faults,
shutdown -- booted by `bootKernel(io)`, proven by tests, runnable in a terminal with 1 Hz stats. P2/P3 add only
renderers (Pool Scope reads it through its existing driver interface).

## One measurement that changes the plan (F1)

The plan said requests go through lite-pick's `/pool`. Measured per request, as an allocation RATE (scavenges
at a pinned 1 MB young generation -- the PerfGate method; `test/rate-probe.mjs`), over the whole steady state
of the virtual-worker system (traffic, picks, replies, feedback, the fleet tick, event emits):

| request path | Node 26.8 | Node 22.23 |
|---|---|---|
| A: `lb.pickFrom(clk, 0)` + `set.post(i, job, tag)` + `onSettle` -> `inflight--`, `recordRttFrom` | **0 scavenges over 1.9M requests** | 2 scavenges, flat from 481k to 1.9M requests (one-off warm-up) |
| B: `pool.run((i, signal) => set.submit(i, job, { signal }))` | **~2.9 KB/request** (168 scavenges / 60k) | -- |

The only other per-request allocation on the main thread is Node's MessagePort (~1.1-1.4 KB/job, measured in
lite-worker-pool 1.1.0, disclosed). So B would roughly triple the per-request garbage of a system whose whole
point is "zero-GC is still possible", while A adds nothing to the transport's share.

**Correction (2026-10-05, during P1).** This section first quoted A at "1.09 / 2.69 B" and B at "1361 / 1280 B".
Those came from lite-gc-profiler's `measureOps` with `stabilize` on, which reports the RETAINED live-set delta, not
the allocation rate: it could not see transient garbage, so it under-stated both (B's figure only showed because
its Promises could not settle inside a synchronous loop). The conclusion stands and is stronger; the numbers above
are the allocation rate. Getting A to zero also took two fixes the rate method exposed: traffic keys kept in
[0, 2^30) (a uint32 >= 2^31 boxed crossing `_key()` -> `request()`), and the Poisson / Zipf uniforms computed
in place rather than returned from a helper (a fractional double boxes across a call V8 does not inline).
(Side finding for lite-pick: `/pool`'s docs describe its cost as "O(1) counter ops + one small per-run array";
B's ~2.9 KB includes `submit`'s Promise; how it splits between /pool and submit is to be measured and the docs corrected
in a separate lite-pick item, not here.)

## Decisions

1. **F1 Request engine.** Default = **A, a zero-allocation engine**: a preallocated request table (Float64Array /
   Int32Array slots), `pickFrom` (zero-box clock / key), `set.post` + `onSettle`, the balancer's feedback
   (`inflight`, `recordRttFrom`, `note` for BoundedLoad), and ONE failover to a distinct eligible worker (the
   `/pool` rule, `tries: 2`) -- all in typed arrays. The UI shows "bytes per request" live. **B (`/pool` +
   `submit`) is a switchable second engine**, so visitors can see the ergonomic API and its measured cost side by
   side. Recommended: A default, B toggle. (A deviation from plan section 9, which said `/pool` only.)
2. **F2 lite-pick is injected.** `bootKernel(io)` takes the lite-pick and lite-worker-pool module namespaces in
   `io`. The served page and `run.mjs` pass the PINNED published versions (lite-pick 1.1.0, lite-worker-pool
   1.1.0); one test suite passes the repo's working tree (`../../Pick.js`), so a kernel change cannot silently
   break the capstone. Recommended.
3. **F3 Breaker** (lite-statechart, per worker): Closed -> Open after **5 consecutive failures** (Envoy outlier
   detection's `consecutive_5xx` default is 5); Open -> HalfOpen after a **2 s cool-down** (Envoy's base ejection
   is 30 s -- shortened so a visitor sees the cycle); HalfOpen admits **one** probe: success -> Closed, failure ->
   Open. Recommended.
4. **F4 Hung job:** a job older than **500 ms** (the default scene's jobs take ~1-3 ms) makes the worker's
   `hung` health source fail (ineligible at once); still hung after **1 s** -> `reportFault` -> the supervisor
   kills and respawns it. Recommended.
5. **F5 Supervision:** one-for-one, budget **5 restarts per 30 s** per worker; past it the worker is ESCALATED:
   stays DOWN and ineligible until the visitor presses "reset" (a manual respawn) -- fail closed. Recommended.
6. **F6 Default scene:** **8 workers**; each job is ~1 ms of real CPU in the thread, workers 6 and 7 are 2x and 3x
   slower (heterogeneous by default, so strategy differences are visible at once); **open-loop Poisson arrivals at
   2000 req/s** (~40% of capacity); keys Zipf over 10,000 keys for the keyed strategies; default strategy P2C.
   Faults (all inside the threads via `set.control`): slow x10, fail-fast 50%, hang, crash, kill; overload =
   arrivals x3.5. Recommended.
7. **F7 Clocks and ticks:** everything periodic runs on lite-di-cron with an injected `now`: traffic 100 Hz
   (a Poisson count per tick), eligibility writer 20 Hz (`setEligible` only on change), stats 1 Hz. Tests drive
   `cron.tick(now)` on a virtual clock over the loopback -> fully deterministic. Recommended.
8. **F8 Packaging and CI:** `pickEcosystem/live/` has its own `package.json` + lock with EXACT versions of the
   bricks above (diEcosystem sub-app pattern), never in lite-pick's `files[]`; lite-pick's CI gains one job:
   `npm ci && npm test` in that directory (the P1 gates), on Node 22. Recommended.

## Files

`kernel.js` (`bootKernel(io)` -> `{ container, set, engine, fleet, traffic, driver, shutdown }`), `fleet.js`
(per-worker child scope: Supervisor child `worker` = `set.respawn(i)`, Health sources `ready` / `hung` /
supervisor, the breaker, the eligibility writer), `engine.js` (A and B), `traffic.js` (open-loop arrivals + Zipf
keys), `driver.js` (the Pool Scope driver interface: `inflight`, `isEligible`, `shareOf`, `weightOf`, `capOf`,
`ewmaOf`, `latQuantile`, `latRing`, `hasLatSketch`, `frameSettles`, `frameSeconds`, `nowNs`, `tick`, `beginFrame`,
`setStrategy`, faults), `run.mjs` (terminal: `worker_threads`, 1 Hz stats, SIGINT -> lite-di-orchestrator),
`test/`.

## Gates (each with a break control that must fail)

Deterministic (loopback + virtual clock): kill -> no request lost (failover), restarted within budget, eligible
again; slow worker -> PeakEWMA's share of it falls below a bound while LeastConn's does not; fail-fast -> breaker
opens, no traffic, HalfOpen probe recovers; hang -> ineligible at 500 ms, respawned at 1 s; crash loop ->
escalated, DOWN and ineligible; shutdown -> no new admissions, every in-flight request settles, exit code OK;
strategy switch under load -> inflight sum conserved, back to 0 at quiescence. Allocation: engine A's request
path < 8 B/request (PerfGate method), engine B's measured and printed. Retention: 1000 supervised kill/respawn
cycles, scopes back to 0. Real threads: a 30 s smoke run with every fault once.
