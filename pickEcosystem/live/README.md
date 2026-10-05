# pickEcosystem / live -- the headless capstone kernel (P1)

The lite-pick capstone (`research/capstone-pickEcosystem.md`) is a served, FUNCTIONING load-balancing system.
This directory is its kernel, headless: real workers doing real CPU work, a supervised fleet with health
checks and circuit breakers, open-loop traffic, live strategy switching and a graceful shutdown -- built
only from the suite's bricks. P2 (below) is the terminal UI; P3 the browser page; P4 serves it.

It has its own `package.json` (exact versions of the published bricks) and is never part of the lite-pick
npm package.

```bash
npm ci
npm run tui                                                      # Pool Scope on the LIVE system (real threads)
npm start -- --seconds 20 --fault 3:kill:2 --fault 6:slow:3     # real worker_threads, 1 line per second
npm test                                                         # the P1 gates (virtual workers, deterministic)
npm run smoke                                                    # ~20 s over real threads, every fault once
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
  in-flight request settles, exit 0). The real-thread smoke run: ~16,000 requests, 0 failed.
- **Real threads:** 8 workers up in ~25 ms; ~1500 req/s at p50 ~1.95 ms on the reference machine.

## Gates

`test/kernel.test.mjs` (G1-G10, each with a control that must fail), `test/alloc.test.mjs` (allocation rate by
scavenge count; retention of 1000 supervised respawns and 200 scope rebuilds), `test/driver.test.mjs` (Pool
Scope's real snapshot over the live system), `test/tui.test.mjs` (the live TUI scripted: fleet, decisions,
shutdown; two runs byte-identical), `test/smoke.mjs` (real threads). G10 runs the gates against the
repo's working-tree `Pick.js`, so a lite-pick change cannot silently break the capstone.
