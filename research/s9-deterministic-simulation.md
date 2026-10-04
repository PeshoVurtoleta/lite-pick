# Research: a deterministic simulated scheduler for the soak's pool lanes (Phase 3, S9)

**Status:** DECIDED 2026-10-04 -- all recommendations accepted (S9 + S10 implementation burst next.) Not implemented yet.
**Question:** the audit (S9) found the pool lanes do not use the discrete-event model the ADR claims:
every run in a batch "completes" at the same virtual time plus the batch's summed service, completion
ORDER is just Node's promise order, the clock is in microseconds while Pool and PeakEWMA expect
nanoseconds, nothing ever hangs, and PeakEWMA sees meaningless RTTs (p50 142,711 us for a 1,000 us mean
service; 1,064 of 2,822 samples were the 1e9 failure penalty). The fix plan borrows the
FoundationDB/TigerBeetle pattern -- deterministic simulation testing (DST) -- and adds a model
self-check "rtt p50 ~ mean service x slowdown within +/-20%". What is DST, what does it need, can it
work in Node, and is the self-check right?

**Short answer:** DST is the right tool and fits this code unusually well: Pool reads no real clock, no
real timers and no `Math.random` (its only clock is the injected `opts.clock`). Two changes to the fix
plan: (1) after resolving each event, drain the WHOLE promise queue (one `setImmediate` hop), not "one
microtask" -- an extra `await` inside Pool would otherwise shift what has settled; (2) the self-check
must use MEANS, not the median -- the median response time under processor sharing is NOT
`mean service x slowdown` (measured: 1.14 vs 2.00), and our per-dispatch slowdown is not textbook
processor sharing anyway. Use Little's law (in-flight = arrival rate x mean RTT) as the bookkeeping
check, which holds for any queue.

---

## 1. Concepts, in plain words
- **Discrete-event simulation (DES):** instead of waiting real time, keep a list of future events
  ("run 17 completes at t = 3.2 ms"), always process the EARLIEST next, and jump the clock straight to
  it. A day of traffic can take seconds.
- **Deterministic simulation testing (DST):** run the REAL code inside such a simulation, with every
  source of nondeterminism -- clock, randomness, I/O, scheduling -- replaced by a seeded, controlled
  version. Same seed, same run, bit for bit: any failure replays exactly.
- **Microtask / promise job:** when a promise resolves, the code waiting on it runs in a "microtask".
  Node runs ALL queued microtasks before moving to the next timer or I/O callback.
- **Processor sharing (PS):** a server splits its capacity equally among all jobs present, so each of
  k jobs progresses at 1/k speed. **Slowdown** = response time / service time.
- **Little's law:** average number in the system = arrival rate x average time in the system. It holds
  for any stable queue, whatever the scheduling -- a classic bookkeeping check.

## 2. What the sources say
- **FoundationDB** (SIGMOD 2021 paper, sec. 4): the real database code runs inside a single-threaded
  deterministic simulation; network, disk, time and randomness sit behind interfaces with a thin shim to
  the real system calls in production. The clock jumps to the next event. "BUGGIFY" sites inject legal
  but unusual behaviour (each site enabled with p = 0.25 per run, then firing with p = 0.25); each run
  randomizes its configuration ("swarm testing") and coverage macros confirm rare states are reached.
  They built the simulator before the database and estimate about a trillion CPU-hours of simulation.
  **Their own stated limit:** "Simulation is not able to reliably detect performance issues, such as an
  imperfect load balancing algorithm."
  [paper](https://www.foundationdb.org/files/fdb-paper.pdf),
  [testing docs](https://apple.github.io/foundationdb/testing.html),
  [Buggify.h](https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h)
- **TigerBeetle VOPR:** runs whole clusters of real code in one process with a stubbed clock, network
  and disk; injects packet loss, partitions and storage corruption; ~1000x time compression; any run
  replays from seed + commit. [VOPR docs](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md),
  [safety](https://docs.tigerbeetle.com/concepts/safety/)
- **Others:** Antithesis makes unmodified software deterministic with a hypervisor
  ([blog](https://antithesis.com/blog/deterministic_hypervisor/)); Jepsen tests real clusters and finds
  bugs it cannot replay ([Jepsen](https://jepsen.io/analyses)); Rust's madsim/turmoil seed a whole async
  runtime; S2's write-up lists the hidden nondeterminism they had to remove and recommends running the
  same seed twice and byte-comparing the trace ([S2](https://s2.dev/blog/dst)).
- **What JavaScript lets you control:** timers, `Date`, `performance` and `queueMicrotask` can be faked
  ([@sinonjs/fake-timers](https://github.com/sinonjs/fake-timers)); `Math.random` has no seed API.
  **What it does not:** native promise jobs run strictly FIFO in the order they were queued -- fixed,
  but not yours to reorder ([ECMA-262](https://tc39.es/ecma262/#sec-hostenqueuepromisejob)); each
  `await` costs at least one microtask hop ([V8](https://v8.dev/blog/fast-async)); real `setTimeout`
  vs `setImmediate` order in the main module is non-deterministic
  ([Node docs](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)).
- **Processor sharing** (M/G/1-PS): the MEAN response time is E[S] / (1 - rho) whatever the service
  distribution ("insensitivity"), and every job size sees the same mean slowdown 1/(1 - rho) -- but
  the response-time DISTRIBUTION, median included, is not insensitive.
  [Zukerman, sec. 13.2](https://arxiv.org/pdf/1307.2968),
  [Wierman and Harchol-Balter](https://www.cs.cmu.edu/~harchol/Papers/unfairness.pdf). The research
  agent's simulation (400k jobs, mean service 1): at rho = 0.5 the mean was 2.00 for every distribution,
  but the median was 1.14 (exponential), 1.60 (deterministic), 0.40 (hyperexponential).
- **Little's law** (J. D. C. Little, Operations Research, 1961): L = lambda x W for any stable system,
  independent of arrival process, service distribution and scheduling order. A textbook result -- it was
  not re-fetched for this note.

## 3. Our code, measured against the DST requirements
| requirement | status |
|---|---|
| one virtual clock | Pool and PeakEWMA read only the injected `opts.clock` -- good. Units are mixed today (us clock, ns config): fix to ns. |
| one seeded randomness | the harness uses `Prng` everywhere -- good; nothing calls `Math.random`. |
| no real time in logic | Pool has no real timers. The pool lane's only real timer is the batch DEADLINE (a watchdog for a run that never settles). Under DST that becomes deterministic: event queue empty while runs are still pending = a lost run, detected without waiting. |
| deterministic scheduling | today: microtask order. Under DST: the event queue decides, and the queue has no sequence number, so equal completion times are ordered by heap position (deterministic, but not first-in-first-out -- add a sequence tie-break). |
| a hung run that really hangs | today "hung" is "fail all" with another code. Under DST: park the run with no completion event, release it (ETIMEDOUT) at phase end. |

## 4. Design points the research changes
1. **Drain, do not count microtasks.** The plan's "await one microtask so Pool's continuation runs" is
   fragile: Pool's settle path may take several hops (`await fn(...)`, then the feedback), and any
   future extra `await` would change what has settled before the next event. After resolving an event,
   yield ONE macrotask (`await new Promise((r) => setImmediate(r))`): Node drains every microtask first,
   so each event's consequences are complete before the next one. Cost: one event-loop turn per event.
2. **Self-check with means and Little's law, not the median.** Replace "p50 ~ mean service x slowdown
   within +/-20%" with (a) Little's law per pool lane -- mean in-flight = completions per unit sim time x
   mean RTT, which checks the simulator's own bookkeeping for any scheduling; and (b) if a PS formula is
   asserted at all, compare MEAN RTT with mean service x 1/(1 - rho). Note our per-dispatch slowdown
   `1 + inflight / perNodeConc` is a service-time inflation fixed at dispatch, not true processor sharing
   (which re-divides capacity whenever a job arrives or leaves), so even the mean formula is only
   approximate for it; Little's law holds regardless.
3. **Same seed twice, compare the trace.** Add a determinism check: run one pool cycle twice with one
   seed and byte-compare a trace (event times, pick indices, outcomes). This is the standard DST
   self-test and catches hidden nondeterminism early.
4. **Keep performance claims statistical.** As FoundationDB says, a simulator does not prove
   load-balancing quality; it makes RTTs and completion order realistic and reproducible. The soak's
   quality judgements stay with the oracles (S7/S14 notes).

**What we would not copy:** BUGGIFY-style fault injection inside Pool.js (shipped code stays untouched --
faults stay in the harness and the teeth mutants), and a fake-timers library (Pool needs none; the
simulated clock is already injectable).

## 5. Recommendation
Implement S9 as the fix plan describes, with the four changes above: ns units throughout, a
sequence-number tie-break in the event queue, a setImmediate drain per event, Little's-law and
mean-based self-checks instead of the median, a seed-twice trace comparison, and lost-run detection by
"queue empty, runs pending". Do S10 (dispatch to a down node = assertion A8) in the same area, since it
touches the same `fn`.

## 6. Decisions needed
1. Adopt the four changes (drain per event, Little's law + mean self-check, seed-twice trace check,
   deterministic lost-run detection)?
2. Per-dispatch slowdown (simple, approximate) or true processor sharing per node (exact, re-schedules
   every in-flight completion on each arrival/departure -- more code)? Recommendation: keep the simple
   model, check it with Little's law, and say "approximate PS" in the docs.
