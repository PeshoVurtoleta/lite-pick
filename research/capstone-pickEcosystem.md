# Research: the capstone -- `pickEcosystem/`, a served, FUNCTIONING load-balancing system

**Status:** DECIDED 2026-10-05 -- all recommendations accepted (C1-C9). P0 (the worker layer) IMPLEMENTED
2026-10-05 as lite-worker-pool 1.1.0 `createWorkerSet` (LiteWorkerPool research/worker-set.md). Next: P1, the headless kernel.
**North-star (ROADMAP section 5, your words 2026-09-23):** "to see the whole system built, and not only built --
but functioning, anyone can see the served system; both operational through a browser and terminal" -- the
proof that an A+, zero-GC module is still worth building.
**Your stack sketch (2026-09-23):** lite-di-container (composition root + boot validation) -> lite-di-health
(writes the eligibility view) -> lite-statechart (circuit state -> eligibility bits) -> lite-pick (reads
eligibility + inflight/weights, returns an index) -> lite-query adapter (request lifecycle) -> lite-o1 /
lite-logn -> "your transport / worker pool": lite-worker-pool, lite-worker.

**Question:** what exactly do we build so that anyone can open one URL (or run one command in a terminal) and
watch a REAL load-balanced system work -- real workers doing real jobs, health and circuit breakers deciding who
is up, lite-pick choosing, a supervisor healing what breaks -- made only from the suite's bricks, zero-GC on its
hot paths, and gated like the libraries are?

**Short answer:** the backends are REAL WORKERS (Web Workers in the browser, `worker_threads` in the terminal),
each doing real CPU work at its own speed. A traffic generator sends requests through lite-pick's `/pool`; the
di-* kernel runs the fleet (one DI scope per worker, health + breaker + supervisor per worker); Pool Scope -- which
already exists in both surfaces -- renders the live system instead of its simulation. It needs ONE thing the
suite does not have yet: a worker layer that can run a job on a CHOSEN worker and restart ONE worker
(lite-worker-pool today only does batch `map()` and poisons the whole pool on one failure). That is decision C3.

---

## 1. The pattern we copy: lite-di-container's `diEcosystem/` (read from the repo)

| | diEcosystem (lite-di-container) | pickEcosystem (proposed) |
|---|---|---|
| Hub | static `diEcosystem/index.html`, no scripts but a scroll effect; sections: the proof per package, the lifecycle, links to sub-apps | `pickEcosystem/index.html`: ten strategies, the shipped evidence (balance anchor, GC blast radius, 0% vs 98% disruption, fingerprints), links to the live system |
| Sub-apps | `market-map/` (live order book), `audio-rooms/` -- each `index.html` + `kernel.js` exporting `bootKernel(io)` with injected I/O | `pickEcosystem/live/`: `index.html` + `kernel.js` (`bootKernel({ spawn, clock, raf, ... })`) + `tui.mjs` |
| Packages in the browser | import map of exact-version esm.sh URLs (`?deps=@zakkster/lite-signal@1.5.0` so one lite-signal instance); no bundler | the same |
| Data source on Pages | live Binance websocket, falls back to an in-page simulation after ~4 s down ("never a blank canvas") | real Web Workers in the page; the Pool Scope simulation stays as the deterministic fallback |
| Terminal | none | yes -- the same kernel over `worker_threads` + the Pool Scope TUI (your requirement) |
| Tests | headless `node:test` boots the real kernel with fakes (rAF shim, scripted socket); alloc gates; leak/churn torture; "break" canaries that MUST fail; a test that every import-map URL matches package.json | the same, plus the kernel over REAL worker threads |
| Deploy | one `ci.yml`; `deploy` needs every gate, uploads the repo root with `upload-pages-artifact@v3` + `deploy-pages@v4` | the same, gated on lite-pick's own gates too |
| di-* used | container, event-bus, strategies, cron, ticker, supervisor, health, graph, signal (not orchestrator, not lock) | all of those + orchestrator (graceful shutdown you can watch) |

Lessons it records that apply here: pin every import-map entry (a floating version breaks on the next
publish); load optional heavy modules with dynamic `import()` so the kernel boots under Node; the default must
never be a blank page.

## 2. What exists already

- **lite-pick 1.1.0**: ten strategies, `/pool` (dispatch/settle, failover, latency + occupancy feedback),
  zero-box `pickFrom` / `recordRttFrom`, stats slab, `describe()`, error codes.
- **Pool Scope** (`demo/pool-scope/`, both surfaces): `driver.mjs` is a closed-loop SIMULATION over the real
  balancers; `snapshot.mjs` reads it through `snapshot.build(driver)`; `detectors.mjs` names five pathologies;
  `tui.mjs` (terminal) and `web/` (browser, lite-charts) render it. Data path measured 0 B/op.
- **The soak** (ADR 0014): time-axis drift gates, the "heartbeat" ROADMAP section 5 wants.

So the renderers, detectors and evidence exist. The capstone's real change: **replace the simulated driver
with a real system that presents the same interface to `snapshot.build()`.**

## 3. The system

```
traffic generator (cron / ticker lane)          open-loop arrivals at a target rate; keys for keyed strategies
      |
lite-pick /pool  run(fn, { key | clock, tries })  dispatch/settle, failover, recordRtt / note feedback
      |  pick()  <- balancer (strategy chosen live via lite-di-strategies)
      |              reads: eligible[] (written ONLY via setEligible), inflight[], weights[]
      v
worker i  (one DI child scope per worker)
   - the worker: Web Worker / worker_thread doing real CPU work, own speed (heterogeneous)
   - Health: sources = ready handshake, heartbeat age, supervisor  -> readyz() === 0 ?
   - breaker: lite-statechart Closed -> Open -> HalfOpen on job failures
   - Supervisor: one-for-one restart of a killed/crashed worker; escalate after the budget (stays down)
   eligibility(i) = health ready AND breaker not Open        -> balancer.setEligible(i, ...)  (cold, on change)
      |
event bus: every dispatch / settle / failover / restart / breaker flip  -> the decision stream ("A -> D")
           + flight recorder: "replay the last N seconds"
      |
Pool Scope: snapshot.build(system) at ~12 Hz -> detectors -> browser canvas / terminal TUI
```

Every brick has one job -- the "lego proof" made literal:

| Brick | Job in the system |
|---|---|
| lite-di-container | composition root; one child scope per worker; boot-time validation; reverse-order teardown |
| lite-worker (+ the worker layer, C3) | runs the jobs; transfer-only messaging |
| lite-di-health | per-worker readiness (handshake, heartbeat age, supervisor) -- the eligibility WRITER's input |
| lite-statechart | per-worker circuit breaker; Open clears eligibility; HalfOpen lets one probe through |
| lite-di-supervisor | restarts a dead worker; escalates a crash loop (the worker stays down -- fail closed) |
| lite-pick + `/pool` | selection, failover, latency/occupancy feedback |
| lite-di-strategies | the live strategy switch (ten balancers behind one router) |
| lite-di-event-bus | the decision stream at 0 B/emit; flight-recorder replay |
| lite-di-cron | traffic schedule, scripted fault scenarios, 1 Hz roll-ups |
| lite-di-ticker + lite-raf | the browser render lane |
| lite-di-signal / lite-signal | UI state |
| lite-di-orchestrator | graceful shutdown you can watch: drain (readyz fails, generator stops), in-flight finish, workers retire, exit code |
| lite-di-graph | the hub shows the system's real composition graph, exported from the running container |
| lite-sketch / lite-adaptive / lite-charts | percentiles, detectors, charts (already in Pool Scope) |
| lite-query (optional) | a cached read path in front of the pool: only misses reach a worker |

**What visitors can do (the story).** Each is a button / key, and each shows a brick earning its place:
kill a worker (supervisor restarts it, health re-admits it, nothing is lost -- failover covered the in-flight
request); slow a worker 10x (PeakEWMA steers away, LeastConn keeps feeding it); make one fail fast (breaker
opens, PeakEWMA's failure penalty, half-open probe); crash-loop one (supervisor escalates, it stays down);
hot keys (ConsistentHash melts one worker, BoundedLoad spreads the overflow); drain vs remove (0 keys move vs
~0.5%); overload; switch strategy live (the fingerprint morphs); graceful shutdown (the orchestrator's phases,
step by step); replay the last 10 seconds.

**Measured feasibility (this machine, Node 26.8, 12 cores, `worker_threads`, 32-byte transferred buffer):** one
worker round-trips an empty job in ~9 us (~115k jobs/s); 4 workers ~229k jobs/s, 8 workers ~182k jobs/s (the
main thread is the ceiling, ~200k messages/s); with ~0.1 ms of real work per job, 4 workers do ~35k jobs/s. A
watchable demo runs at hundreds to a few thousand requests/s, two orders of magnitude below the ceiling. One
lesson from the probe itself: a fixed start-up wait was flaky under load -- workers must signal READY (which is
exactly a health source), never be assumed up after a delay.

## 4. The gap: the worker layer (decision C3)

lite-worker-pool 1.0.1 (380 lines) is built for one job: `map(items)` over N workers, each pulling the next
item (work stealing), results in input order. Three of its properties are right for batches and wrong here:

1. **No targeted dispatch.** There is no "run this job on worker i" -- the worker pulls; lite-pick cannot choose.
2. **One job in flight per worker** (one scratch buffer each). Queueing ("Queue A 12") needs k slots or a
   per-worker queue.
3. **One failure poisons the pool.** Correct for a batch (fail the batch closed); wrong for a service, where one
   dead worker must go down ALONE while the others serve and the supervisor restarts it.

ADR 0001 already said lite-pick earns its place next to lite-worker-pool only for keyed / push / heterogeneous
dispatch -- this is that feature. Options:

- **(a) A second, service-shaped mode in lite-worker-pool** (e.g. `createWorkerSet(workerFn, opts)`: per-worker
  `run(i, buf)`, k in-flight slots per worker, per-worker error isolation, `respawn(i)`, per-worker stats);
  `map()` unchanged. Its own research note + release in that repo, before the capstone uses it.
- **(b) Build the capstone's worker layer directly on lite-worker** (one `WorkerHandle` per endpoint). No change
  to lite-worker-pool; the code lives in the demo.
- **(c) (b) first, then lift it into lite-worker-pool as (a)** once the capstone has proven the shape.

Recommendation: **(a)**. The capstone is a proof built from real bricks; a worker layer written inside the
demo would be the one part that is not a brick, and it is exactly the feature ROADMAP post-1.0 #1 promised.
Prior art for the shape (worker-choice strategies, per-key ordering, affinity vs stealing) is in section 7; the affinity contract for keyed jobs is C8.

## 5. Two surfaces, one kernel

- **Browser (GitHub Pages):** everything runs in the page; workers are Web Workers made from Blob URLs (what
  lite-worker's `defineWorker` already does). GitHub Pages cannot set custom response headers, so no COOP/COEP
  and therefore no SharedArrayBuffer: messaging stays transfer-only -- which is what lite-worker-pool already
  does. Served at `https://peshovurtoleta.github.io/lite-pick/pickEcosystem/` (relative links, no `<base>`).
- **Terminal:** `node pickEcosystem/live/tui.mjs` (an npm script) runs the SAME `bootKernel` with a
  `worker_threads` spawn and the Pool Scope TUI. SIGINT goes through the orchestrator (drain -> finish ->
  retire -> exit code), so Ctrl-C itself is a demo.
- `bootKernel(io)` takes `spawn`, `clock`, `raf`/ticker source and the renderer sink -- the market-map pattern,
  which is also what lets the tests boot it headless.

## 6. Gates -- the system is gated like a library

- **Headless `node:test`** boots the real kernel twice: over a synchronous in-process worker (deterministic --
  scenario outcomes asserted exactly: a killed worker is restarted within the supervisor budget, a failing
  worker's breaker opens, no request is lost) and over real `worker_threads`.
- **Zero-GC where we claim it:** selection + feedback + event-bus emit + eligibility evaluation, measured with
  the PerfGate method. Honest disclosure where it does NOT hold: a `postMessage` transfer allocates (each hop
  mints a new ArrayBuffer object -- lite-worker-pool documents it); we measure that per-job cost and print it.
- **Retention:** lite-leak churn -- kill/restart 1000 workers, scope count returns to 0.
- **Soak heartbeat:** the live system runs for hours (the ADR 0014 drift gates on heap and quality).
- **Break canaries:** switches that must make each gate fail (the diEcosystem and soak-teeth discipline).
- **Import-map drift test** (every esm.sh URL matches package.json devDependencies).
- **Deploy** runs only after all of the above and lite-pick's own `verify`.

## 7. Prior art for the worker layer

What production systems do when work goes to a CHOSEN worker rather than being pulled:

| System | What it does | What it tells us |
|---|---|---|
| Akka / Pekko routers | `ConsistentHashingPool` (key from the message or an envelope; 10 virtual nodes per routee); `SmallestMailboxPool` (idle first, then fewest queued); `BalancingPool` = one shared mailbox (work stealing). Consistent hashing ignores load entirely, and BalancingPool cannot be combined with it (no message can target a routee in a shared queue). | Keep pull-based `map()` as our BalancingPool; keyed dispatch needs per-worker queues. Akka has no bounded-load option -- lite-pick's BoundedLoad fills that hole. |
| Orleans placement | Activation-count placement samples 2 silos (power of two choices) and predicts each one's load as its last report PLUS the placements it made since. | P2C pays off when counters lag (across pools); inside one process our counters are exact and current. |
| Piscina 5.3 | One shared FIFO queue; a pluggable `loadBalancer(task, workers)`; the default takes any idle worker first, else the least used under a cap; `maxQueue: 'auto'` = threads squared. No keyed routing built in. | A pluggable chooser is accepted prior art -- lite-pick is that chooser. |
| workerpool 10, threads.js 1.7 | One shared queue, idle workers pull; no choice strategy, no affinity; queues unbounded by default. | Do not copy unbounded queues. |
| poolifier 5.3 (closest npm prior art) | 7 worker-choice strategies: ROUND_ROBIN, LEAST_USED (executing + queued; the default), LEAST_BUSY (run/wait time), LEAST_ELU (event-loop utilization), FAIR_SHARE (predicted end time), WEIGHTED_ROUND_ROBIN, INTERLEAVED_WRR. Opt-in per-worker queues (`size` = pool size squared) with task stealing. Affinity is static per task FUNCTION (`workerNodeKeys`), not per item; reading the source, stealing does not appear to check it (not run). | Our mapping: LeastConn ~ LEAST_USED, NQ ~ idle-first, PeakEWMA ~ LEAST_BUSY / FAIR_SHARE, SmoothWRR / WeightedRandom ~ WRR -- plus what poolifier lacks: per-item keyed routing (ConsistentHash) and keyed routing with a load cap (BoundedLoad). |
| BookKeeper `OrderedExecutor`, Kafka partitioner | Same key -> same thread / partition -> FIFO per key (`key mod N`). Kafka's load-aware partitioning applies only to records WITHOUT a key. | Per-key ORDERING is a second reason for keyed dispatch, besides warm state. |
| Netty event loops | A channel is bound to one loop for life, chosen round robin at registration, blind to load. | Sticky without load awareness -- what not to copy. |
| HAProxy `hash-balance-factor` (Vimeo, 1.25) + `hash-preserve-affinity always / maxconn / maxqueue` | Bounded-load consistent hashing over concurrent requests; newer versions let you choose whether affinity is kept when the target's queue is full. | The affinity contract must be explicit (decision C8). |
| Queueing theory | JSQ is the classic optimum for identical servers but reads every queue; power-of-d gives a doubly-exponential gain from d = 1 to 2 and beats a global minimum under STALE load data (herding); Join-Idle-Queue (Microsoft, 2011) takes idle discovery off the arrival path. | In-process, JSQ (our LeastConn) is affordable; NQ is JIQ's idea; P2C matters for large N or stale counters. |
| Work stealing (Blumofe-Leiserson; Go, Tokio) | Idle workers steal from busy ones. Stealing moves work to whoever is idle, which breaks key -> worker placement; systems combine them by stealing only when idle or treating affinity as a hint (locality-guided stealing). | If the worker layer ever steals, it must never steal strictly keyed items. |

So the service-shaped worker layer (C3 a) should have: a per-worker queue with a CAP (never unbounded), the
chooser injected (any object with `pick()` -- lite-pick's balancers qualify; the worker layer imports nothing
from lite-pick), per-worker failure isolation and `respawn(i)`, and the load it reports = executing + queued.
`map()` stays as it is (the pull / BalancingPool mode); the two modes are never mixed in one queue.

## 8. Decisions needed

1. **C1 Home:** `pickEcosystem/` in the lite-pick repo, served by lite-pick's Pages, never in the npm tarball
   (recommended, as ROADMAP section 5 says) -- or a separate repo?
2. **C2 Backends:** real workers on both surfaces, with the Pool Scope simulation kept as the deterministic
   fallback (recommended) -- or simulated backends only?
3. **C3 Worker layer:** (a) a service-shaped mode in lite-worker-pool first (recommended) / (b) inside the demo
   on lite-worker / (c) (b) then (a)?
4. **C4 Strategy switch:** each balancer owns its eligibility array, so a switch builds the new balancer cold
   and replays eligibility through `setEligible` (recommended) -- or keep ten balancers live and write all ten?
5. **C5 Breaker policy:** lite-statechart per worker, Open after k consecutive failures, HalfOpen after a
   cool-down, one probe (recommended) -- thresholds tuned visibly in the UI?
6. **C6 Traffic:** open-loop arrivals at a target rate (recommended: shows queueing and overload honestly) --
   or closed-loop fixed concurrency (Pool Scope's current model)?
7. **C7 lite-query:** include the cached read path in the first version, or later?
8. **C8 Affinity contract for keyed jobs** (HAProxy's `hash-preserve-affinity` question): STRICT -- a key never
   leaves its worker, so per-key order holds and a full queue rejects / waits -- or BOUNDED -- BoundedLoad may
   spill a key to a neighbour (warm state mostly kept, ordering not guaranteed). Recommended: support both,
   chosen per run, documented; the demo shows the difference (ConsistentHash = strict, BoundedLoad = bounded).
9. **C9 Build order** (each a reviewed burst, like 1.1.0):
   - P0 the worker layer (C3), in its own repo and note;
   - P1 the headless kernel (`bootKernel`) + its tests and gates, runnable in a terminal with plain output;
   - P2 the TUI on the real kernel (Pool Scope's renderer, driver interface shared);
   - P3 the browser page (Pool Scope's web renderer) + the import map + its drift test;
   - P4 the hub page + the Pages deploy job;
   - P5 the soak heartbeat, the scenario script, polish.

## 9. Next session: the P1 plan (draft -- opens with a one-page spec, F-decisions, before code)

**Goal of P1:** the whole system running HEADLESS -- no rendering -- booted by `bootKernel(io)`, proven by tests,
runnable in a terminal with plain periodic stats. P2/P3 then only add renderers.

**Where:** `pickEcosystem/live/` in the lite-pick repo, with ITS OWN `package.json` + lock (the diEcosystem
sub-app pattern): the di-* bricks, lite-statechart, lite-signal, lite-sketch, lite-worker(-pool) and a PINNED
published `@zakkster/lite-pick` are the sub-app's dependencies, so lite-pick's own devDependencies and
`peerDependencies: {}` stay untouched and the demo dogfoods the released package. Never in `files[]`.

**Files:** `kernel.js` (`bootKernel(io)` -- `io = { spawn, now, schedule, rng }`, injectable so tests run on a
virtual clock), `fleet.js` (one DI child scope per worker: Health + breaker + supervisor child),
`traffic.js` (open-loop Poisson arrivals, keys for keyed strategies), `driver.js` (the Pool Scope driver
interface over the live system), `run.mjs` (terminal: boots with `worker_threads`, prints 1 Hz stats, SIGINT ->
orchestrator), `test/` (node:test + torture).

**Wiring (the decisions C1-C9 made concrete):**
- Root container: `set` (createWorkerSet, `slots` 2, `queue` 32), `inflight` (Uint32Array), the balancer
  router (lite-di-strategies over the ten strategies), `pool` (lite-pick `/pool`), the event bus, `now`.
- Per worker i, a child scope: token `worker` = `singletonFactoryAsync(() => set.respawn(i))`; a Supervisor
  (one-for-one, budget e.g. 5 restarts / 30 s, escalate -> stays DOWN); a Health with sources `ready`
  (`set.isReady(i)`), `hung` (`busySince` age < limit) and `watchSupervisor`; a lite-statechart breaker
  Closed -> Open after k consecutive failures -> HalfOpen after a cool-down -> Closed on a probe success.
  A death (`LWP_WORKER_DOWN`) is `reportFault`ed to the supervisor.
- Eligibility writer (a cron job, ~20 Hz): `up(i) = health.readyz() === 0 && breaker allows` -> `setEligible`
  only on change. HalfOpen allows exactly one probe in flight.
- Request path: arrival -> `pool.run((i, signal) => set.submit(i, job, { signal }), { tries: 2, key | clock })`
  -> settle feeds the breaker (failure count) and lite-sketch (latency); every dispatch / settle / failover /
  breaker flip / restart / eligibility change is an event-bus emit (flight recorder on).
- Strategy switch: build the new balancer cold, replay eligibility via `setEligible`, new `/pool` over the SAME
  `inflight` array (in-flight runs of the old pool settle into the same counters).
- Faults (all real, inside the threads via `set.control`): slow x10, fail-fast rate, hang, crash, kill;
  scenarios = timed scripts on lite-di-cron.
- Shutdown: lite-di-orchestrator -- drain (readyz fails, traffic stops admitting), in-flight finish,
  supervisor.shutdown, `set.dispose`, container teardown, exit code.

**P1 gates (headless, the loopback `setLoopbackSpawn` + a virtual clock = deterministic):**
- kill a worker -> no request lost (failover), supervisor restarts it within budget, it becomes eligible again;
- slow worker -> PeakEWMA's share of it falls below a bound, LeastConn's does not (the visible contrast);
- fail-fast worker -> breaker opens, the worker gets no traffic, HalfOpen probe recovers it;
- crash loop -> supervisor escalates, the worker stays DOWN and ineligible (fail closed);
- graceful shutdown -> no new admissions, every in-flight request settles, exit code OK, threads gone;
- strategy switch under load -> the inflight sum is conserved and returns to 0 at quiescence;
- zero-alloc: the selection + feedback + eligibility + event-bus path (PerfGate method), with the
  MessagePort transport cost reported, not gated;
- retention: 1000 worker kill/respawn cycles through the supervisor, scope count back to 0;
- a real `worker_threads` smoke run (30 s, every fault once), and break controls for each gate.

**Open questions for the P1 spec (F-decisions):** breaker k and cool-down; hung-job limit; arrival rate and
worker speeds for the default scene; whether the sub-app pins lite-pick 1.1.0 or follows the repo's
working tree in its tests (recommend: pinned for the served demo, plus one test run against the working
tree so a kernel change cannot silently break the capstone).

## What we would NOT do

- A Node HTTP fleet as the backends: Pages cannot host it, and it would make the browser surface a recording.
- SharedArrayBuffer transport: impossible on Pages (no COOP/COEP headers).
- A bundler: the import-map-of-pinned-URLs pattern already works and keeps "view source" honest.
- A worker layer written only inside the demo, if C3 (a) is accepted.
- Claiming 0 B/op for message passing: we measure and disclose it.
