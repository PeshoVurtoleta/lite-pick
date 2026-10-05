# pickEcosystem / live -- the capstone system: kernel (P1), terminal UI (P2), browser page (P3), site (P4)

The lite-pick capstone (`research/capstone-pickEcosystem.md`) is a served, FUNCTIONING load-balancing system.
This directory is its kernel, headless: real workers doing real CPU work, a supervised fleet with health
checks and circuit breakers, open-loop traffic, live strategy switching and a graceful shutdown -- built
only from the suite's bricks. P2 (below) is the terminal UI, P3 the browser page, P4 the hub and the Pages site:
**https://peshovurtoleta.github.io/lite-pick/pickEcosystem/**.

It has its own `package.json` (exact versions of the published bricks) and is never part of the lite-pick
npm package.

```bash
npm ci
npm run tui                                                      # Pool Scope on the LIVE system (real threads)
npm start -- --seconds 20 --fault 3:kill:2 --fault 6:slow:3     # real worker_threads, 1 line per second
npm test                                                         # the P1 gates (virtual workers, deterministic)
npm run smoke                                                    # ~20 s over real threads, every fault once
npm run web                                                      # the browser page on http://127.0.0.1:8137/
npm run browser-smoke                                            # the built site in headless Chrome, every check
npm run graph                                                    # regenerate the hub's composition graph
npm run site -- ../../_site                                      # build the Pages site (what CI deploys)
```

`run.mjs` flags: `--strategy <name>` (one of the ten), `--rate <req/s>`, `--engine A|B`, `--seconds N`,
`--fault <sec>:<kind>:<worker>` with kind `kill`, `slow`, `flaky`, `hang`, `crash`, `crashloop`, `heal`,
`reset`. Ctrl-C runs the orchestrator: drain, settle every in-flight request, retire, exit code.

## The terminal UI (P2)

`tui.mjs` is Pool Scope -- the same renderer (`demo/pool-scope/tui-render.mjs`), snapshot and five pathology
detectors as the simulated demo -- fed by the running kernel through `driver.js`, plus the live system's own
panel: every worker's state (`up`, `out`, `BRK` breaker open, `half`, `down`, `ESCAL`) with its restart count, the
DECISIONS stream (breaker flips, rotation changes, supervisor restarts, escalations -- a lane of its own so a
restart never scrolls away) and the newest failover REROUTES ("w1 -> w6").

Keys: `1`-`9`,`0` strategy, `n` next, `e` engine A/B, `w` select a worker, then `k` kill, `s` slow x10,
`f` flaky (50% fail-fast), `h` hang, `c` crash, `l` crash loop, `x` heal, `r` reset (after an escalation),
`+`/`-` arrival rate, `q` shutdown through the orchestrator (drain, settle every request, retire, exit code).
`node tui.mjs --frames N --script 2:kill:2,3:slow:3` renders deterministic frames over virtual workers (script
times are seconds since boot); `--real` uses real threads.

## The browser page (P3)

`index.html` + `page.js` run the SAME `bootKernel` in the visitor's tab: eight real Web Workers (lite-worker-pool's
default transport, Blob URLs via lite-worker), `performance.now`, real timers. Pool Scope's browser renderer
(`demo/pool-scope/web/render.mjs`, shared with the simulated page) paints it through `driver.js`; the page adds the
fleet, DECISIONS and REROUTES panels (the terminal's words, `narrate.js`) and the terminal's keys and rate steps
(`surface.js`), plus buttons for each. Click a worker (or press `w`) to choose where a fault lands; `q` / the
shutdown button runs the orchestrator and reports its exit code; "boot a fresh system" starts again.

- **Every module is pinned.** The import map names each brick at the exact version `package.json` pins;
  `test/web.test.mjs` W1 keeps the two equal both ways, and requires `?external=` wherever one brick imports
  another at runtime (lite-worker-pool -> lite-worker, lite-statechart / lite-charts -> lite-signal), so each
  loads once.
- **The device is measured.** Before booting, the page times the job's own loop on this machine (warm-up, then
  the best of four windows): "~1 ms of CPU per job" holds on a phone too. Fewer cores, less traffic
  (2000 / 1500 / 1000 req/s for 8+ / 6+ / fewer).
- **A hidden tab pauses its traffic.** Browsers throttle a background tab's timers to once a second or slower,
  which would offer a whole second at once; the page offers nothing while hidden and resyncs on return.
- **A crash is loud in a browser too.** A Web Worker that calls `close()` dies silently (no event: it would look
  hung for a second); `job.js` fails the job and raises an uncaught error, so the set takes the worker down at once.
- **The worker table's p95** is time on the worker (its queue + the job), per worker, over the last second.

## The site (P4)

The hub (`pickEcosystem/index.html`) introduces the system and links the live page and the simulated Pool Scope.
Its composition graph is not drawn by hand: `graph.mjs` boots the kernel and exports the root container and one
worker scope with lite-di-graph (`graph.json`, `graph.svg`); `test/site.test.mjs` S2 regenerates both and fails if
the committed picture is stale. `site.mjs` builds the Pages site from exactly what the three pages reach -- every
relative link, every module in their import graphs -- so it never carries node_modules, tests or research, and the
site root redirects to the hub. The browser smoke run drives that built site; the CI `deploy` job publishes it from
`main` only after every other job is green (Settings -> Pages -> Source must be "GitHub Actions").

## What each brick does here

| Brick | Job |
|---|---|
| lite-di-container | composition root; one child scope per worker (`fleet.js`) |
| lite-worker-pool `createWorkerSet` | the workers: targeted jobs, per-worker isolation, respawn, control values |
| lite-pick | the ten strategies (`balancers.js`); engine A's `pickFrom` + feedback; engine B's `/pool` |
| lite-di-strategies | the live strategy switch |
| lite-di-supervisor | restarts a dead / hung worker (5 per 30 s, then escalated: kept out until reset) |
| lite-di-health | per-worker readiness: READY handshake, no hung job (500 ms), supervisor healthy |
| lite-statechart | per-worker breaker: Open after 5 consecutive failures, HalfOpen after 2 s, one probe |
| lite-di-event-bus | every dispatch / failover / breaker flip / restart as a numeric event (0 B/emit), flight recorder |
| lite-di-cron | traffic 100 Hz, fleet 20 Hz, stats 1 Hz, on the injected clock |
| lite-di-orchestrator | shutdown: drain -> stop supervising -> quiesce -> retire scopes -> exit code |
| lite-sketch | latency percentiles (DDSketch) |

## Measured (virtual workers unless noted)

- **Engine A (default) allocates nothing per request**: 0 scavenges over 1.9M requests on Node 26 (2 one-off on
  Node 22), whole steady state included -- traffic, picks, replies, feedback, the fleet tick, event emits.
  Engine B (`/pool` + `submit`, a Promise per request) ~2.9 KB/request. Over real threads Node's MessagePort
  adds ~1.1-1.4 KB/job (measured in lite-worker-pool 1.1.0) -- the transport's, not this code's.
- **One 10x-slow worker, 2000 req/s, p99:** PeakEWMA 10.1 ms, LeastConn 30.3 ms, P2C 40.0 ms, RoundRobin 340 ms.
- **Faults, no failed request:** kill (failover + restart), 50% fail-fast (breaker opens, HalfOpen probe closes
  it), hang (out at 500 ms, respawned at ~1 s), crash loop (escalated after 5 restarts), shutdown (every
  in-flight request settles, exit 0). The real-thread smoke run: ~16,000 requests, 0 failed. One fault at a
  time: with `tries: 2`, two overlapping faults can lose a request (a failover that lands on a second failing
  worker), so the smoke timeline never overlaps them.
- **Real threads:** 8 workers up in ~25 ms; ~1500 req/s at p50 ~1.95 ms on the reference machine.

## Gates

`test/kernel.test.mjs` (G1-G10, each with a control that must fail), `test/alloc.test.mjs` (allocation rate by
scavenge count; retention of 1000 supervised respawns and 200 scope rebuilds), `test/driver.test.mjs` (Pool
Scope's real snapshot over the live system), `test/tui.test.mjs` (the live TUI scripted: fleet, decisions,
shutdown; two runs byte-identical), `test/web.test.mjs` (W1-W6: import-map drift both ways, the browser's module
graph, the DOM contract, the browser crash path, the device scene, the static server's allowlist),
`test/site.test.mjs` (S1-S3: the site is exactly what the pages reach, the hub graph is the running kernel's, the
hub's versions are package.json's), `test/smoke.mjs` (real threads), `test/browser-smoke.mjs` (the BUILT site in
headless Chrome over the DevTools protocol, zero dependencies: the hub and its links; the live page booted, kill /
crash / flaky through its own keys, engine B, a strategy switch, graceful shutdown with exit code 0, no failed
request; the simulated page; no console error). G10 runs the
gates against the repo's working-tree `Pick.js`, so a lite-pick change cannot silently break the capstone.
