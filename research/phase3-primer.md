# Primer: the ideas behind Phase 3, worked by hand -- and how Linux and IBM do the same

**Status:** learning companion to the three Phase 3 notes (2026-10-04): `s9-deterministic-simulation.md`,
`s7-p2c-oracle-bound.md`, `s14-hash-and-tie-oracles.md`. Those notes say WHAT we decided; this one shows
HOW the ideas work, with small examples produced by our own kernel, and how two long-lived engineering
cultures -- the Linux kernel and IBM -- solved the same problems. Nothing here changes the decisions.

Principle (agreed 2026-10-04): lite-pick keeps its own design; it borrows only techniques that are
proven elsewhere, and cites them, so the borrowing shows the library is built on solid ground.

---

## 1. A Maglev table you can hold in your head (ConsistentHash)

A Maglev table is an array of M slots (M prime). Each slot names a backend. A key is hashed to a slot,
and the slot's backend serves it. Building the table: each backend gets its own pseudo-random ORDER of
slots -- start at `offset`, step by `skip` (both from hashing the backend's name; `skip` is never 0 and,
because M is prime, the steps visit every slot exactly once). Backends then take turns: each claims the
next slot in its own order that is still empty, until the table is full. Taking turns is why every
backend ends up with floor(M/N) or ceil(M/N) slots -- near-perfect balance.

**Our kernel, M = 7 slots, N = 3 backends A B C** (real output of `ConsistentHashBalancer`):

```
table, slot 0..6               : B A A C C A B      A=3 slots, B=2, C=2  (7/3 -> 2 or 3: floor/ceil)
REBUILT without B (weight 0)   : C A C C A A A      slots 2 and 4 changed, and they were NOT B's
```

That second line is Maglev's documented trade-off: a rebuild gives perfect balance again, but it can
move keys that never belonged to the removed backend (here two slots out of five that were not B's).
The bigger M is compared with N, the smaller that collateral movement -- which is why the library
default is M = 65537 and why the S14 note measured 1.6-7.5 points of extra movement at the soak's
small M = 257 but only 0.2-0.7 points at 65537.

**Marking B DOWN instead** (`setEligible`), ten keys:

```
homes before B goes down : C A A A B B B B C C
homes after  B is down   : C A A A A A A A C C       only B's four keys moved; every other key stayed
```

Down-marking does not rebuild: the pick walks forward past the ineligible slot. That gives exactly the
"minimal disruption" property of Karger's consistent hashing -- the sharp oracle S14 adopts.

**How Linux does it.** The kernel's own load balancer, IPVS, ships a Maglev scheduler (`mh`, added in
Linux 4.18, `net/netfilter/ipvs/ip_vs_mh.c`). Its table size is always prime, chosen from 251 ... 131071,
default 4093 (`CONFIG_IP_VS_MH_TAB_INDEX = 12`). Two details mirror our design:
- A server set to weight 0 (drained) or flagged overloaded KEEPS its slots -- the table is built from
  `last_weight`, the last non-zero weight -- so draining causes no reshuffle.
- At lookup, an unavailable server is skipped; with the `mh-fallback` flag the lookup re-hashes and probes
  for a live server (without it, the connection gets no destination).
  [ip_vs_mh.c](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/ip_vs_mh.c),
  [ipvsadm(8)](https://manpages.debian.org/testing/ipvsadm/ipvsadm.8.en.html)

Our down-marking is the same idea as `mh-fallback`: keep the layout, skip the dead entry. One difference
worth knowing (not a decision): in lite-pick, weight 0 + `rebuild()` REMOVES the backend's slots, while
IPVS treats weight 0 as "drain, keep the slots". That is a candidate topic for 1.1.0, with its own note.

The same table shape appears in network cards: RSS (receive-side scaling) hashes each flow into an
indirection table whose entries name a receive queue -- weighting is "how many entries you own"
([kernel scaling doc](https://docs.kernel.org/networking/scaling.html)). IBM's products, by contrast,
make sessions sticky with tokens (the WebSphere plug-in's cloneID) or timers (Load Balancer
`stickytime`), not with hash tables -- we found no IBM documentation of consistent hashing.

## 2. Why two choices beat one -- and why the test threshold must be measured (P2C)

**Our numbers, same random stream, one choice vs two choices:**

```
8 servers, 80 requests     one choice : loads 16 10 9 11 10 8 8 8     gap (max - mean) over 5 seeds: 6 7 7 8 3
                           two choices: loads  9 10 10 11 10 10 10 10  gap: 1 1 1 1 1
16 servers, 1600 requests  one choice : gap over 5 seeds: 19 22 15 20 18
                           two choices: gap over 5 seeds:  1  1  1  2  2
```

With one random choice, the gap GROWS with traffic (about the square root of the request count). With
two choices it stays at 1-2 no matter how much traffic flows. The theory (Azar et al. 1999; Berenbrink
et al. 2006): the gap is about log2(ln n) + a constant, independent of the number of requests. A P2C
that ignores its comparison part of the time is the "(1+beta)-choice process" (Peres, Talwar, Wieder
2010), whose gap grows like log n instead -- a different growth order, but at our pool sizes only a few
units apart, which is why the oracle's threshold must come from measurement, not from the theorem.

**How Linux does it.**
- IPVS gained a power-of-two scheduler, `twos`, in Linux 5.12 (`ip_vs_twos.c`, citing Mitzenmacher's
  survey). It draws two servers by weight and keeps the one with the lower weighted connection count.
  Its two draws can be the SAME server; lite-pick's P2C always compares two DISTINCT nodes.
  [ip_vs_twos.c](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/ip_vs_twos.c)
- The CPU scheduler's load balancer shows the thresholding discipline. It does NOT rebalance at the first
  sign of imbalance: `imbalance_pct` (110 for hyper-threads, 117 elsewhere) means "treat a domain as
  balanced until the busiest group is 10-17% over", and it escalates only after repeated failed
  attempts (`nr_balance_failed`). In 2020 the default was lowered from 125 to 117 because measurements
  showed 125 tolerated real unfairness (11 threads on 2 x 4 CPUs: a 20% imbalance never corrected).
  [topology.c](https://github.com/torvalds/linux/blob/master/kernel/sched/topology.c),
  [LKML patch](https://lkml.iu.edu/hypermail/linux/kernel/2009.3/05743.html)
  That is exactly the S7 lesson: a tolerance is necessary, it must be calibrated against data, and the
  first guess (our `4 log2(ln n) + 4`, Linux's 125) was too loose.

**How IBM does it.** IBM Research published a closed-form approximation of the mean response time of
join-the-shortest-queue routing (Nelson and Philips, SIGMETRICS 1989; under 0.5% error for K <= 8
queues). [IBM Research](https://research.ibm.com/publications/approximation-to-the-response-time-for-shortest-queue-routing)
In products, IBM's least-load routing is CICSPlex SM `QUEUE` (shortest queue relative to the region's
maximum tasks) and Sysplex Distributor `WEIGHTEDACTIVE` (active connections kept proportional to weights).
[CICSPlex SM](https://www.ibm.com/docs/SSGMCP_6.1.0/fundamentals/wlm/wlm-algorithms.html)

## 3. A deterministic event loop in fifteen lines (S9)

The whole S9 idea, runnable (a sketch, not the harness code):

```js
let clock = 0, seq = 0; const q = [];
// "work" never finishes by itself: it parks its resolver in the event queue at a SIMULATED time
const work = (name, ms) => new Promise((resolve) => q.push({ at: clock + ms, seq: seq++, resolve }));
const run = async (name, ms) => { const t0 = clock; await work(name, ms); log(name, clock - t0); };
const all = Promise.all([run('r1', 30), run('r2', 10), run('r3', 20)]);
while (q.length) {
    q.sort((a, b) => a.at - b.at || a.seq - b.seq);    // earliest event first; seq breaks ties
    const ev = q.shift();
    clock = ev.at;                                      // JUMP the clock -- no real waiting
    ev.resolve();                                       // release exactly that request
    await new Promise((r) => setImmediate(r));          // let ALL resulting promise work finish
}
await all;
// output: r2 done at 10ms (rtt 10) | r3 done at 20ms (rtt 20) | r1 done at 30ms (rtt 30)
```

Three things make it deterministic: one clock that only the loop moves, one seeded random source (here
the fixed service times), and an order decided by the queue -- never by how Node happens to schedule
promises. The `setImmediate` hop matters: Node finishes every pending microtask before it, so each
event's consequences (Pool's retry, its RTT feedback) are complete before the next event starts. The
fix plan's "await one microtask" would break as soon as Pool's settle path took one more hop.

**How Linux does it.** LinSched, a user-space program that hosts the real Linux scheduler code with a
simulated clock and topology (University of North Carolina, later reworked at Google), gave "stable and
repeatable results" for scheduler experiments. [LWN](https://lwn.net/Articles/409680/) For bug finding,
Linux mostly uses randomized stress instead: `rcutorture` (written by Paul McKenney while at IBM, 2005)
hammers RCU and checks an invariant histogram -- but it re-seeds from the clock, so a failure is not
replayable from a seed. Our seeded soak is stricter on that point. [rcutorture docs](https://docs.kernel.org/RCU/torture.html)

**How IBM does it.** IBM Haifa's ConTest (IBM Systems Journal, 2002) inserts sleeps and yields at
synchronization points, chosen at random or by coverage, because "re-running the same test finds almost
nothing unless the interleaving is forced to change"; it pairs the noise with a replay mechanism.
[paper](https://www.academia.edu/24590006/Multithreaded_Java_program_test_generation) That is the same
pairing as FoundationDB's BUGGIFY plus seeds -- and as our chaos phases plus seeds.

**Checking the simulator with a formula.** IBM Research's Mean Value Analysis (Reiser and Lavenberg,
1980) computes mean queue lengths and response times of closed queueing networks from three equations,
one of which is Little's law. [JACM](https://projects.csail.mit.edu/jacm/References/reiserl1980:313.html)
S9 uses Little's law (mean in-flight = arrival rate x mean RTT) as the simulator's bookkeeping check; MVA
and the Nelson-Philips formula are candidates for stronger analytic checks later.

## 4. "Test the test": teeth, in two other cultures
- **IBM / Linux:** in 2014 McKenney added `rcu_busted`, a deliberately broken RCU used only to confirm that
  rcutorture catches it. [LKML](https://lkml.iu.edu/1402.2/00823.html) That is precisely our must-fail
  teeth battery (a kernel mutant must FAIL the soak).
- **Linux fault injection:** `failslab`, `fail_page_alloc`, `fail_function` and others make chosen kernel
  calls fail by probability or interval; `/proc/<pid>/fail-nth` fails exactly the Nth call, so a test can
  walk N upward and visit every failure point deterministically.
  [fault-injection docs](https://docs.kernel.org/fault-injection/fault-injection.html) Our `SOAK_MUSTFAIL`
  modes and the coverage meta-test (every gate has a control) are the same discipline.

## 5. Lessons we did NOT adopt (yet) -- candidates, each would get its own note
- **The black-hole effect.** IBM WLM penalizes servers by their abnormal-termination rate because a failing
  server answers fast and would otherwise attract MORE work. [Redbook SG24-7621](https://www.redbooks.ibm.com/redbooks/pdfs/sg247621.pdf)
  lite-pick met the same trap (audit H1, PeakEWMA) and fixed it in 1.0.1 with the failure penalty --
  an independent confirmation that the fix was the right shape.
- **Damping.** IBM Load Balancer limits how far a weight may move per update ("smoothing index", default
  1.5) and only publishes changes larger than a sensitivity threshold (5%), to stop herd oscillation.
  [LB guide](https://public.dhe.ibm.com/software/webserver/appserv/library/v80/LBguide_ipv4.pdf)
  A possible future soak scenario.
- **Drain versus remove.** IPVS keeps a drained server's slots (above). A candidate 1.1.0 topic.

## 6. Map: lite-pick, Linux, IBM

| lite-pick | Linux | IBM |
|---|---|---|
| RoundRobin | IPVS `rr` | Sysplex Distributor ROUNDROBIN; WebSphere plug-in Round Robin |
| SmoothWRR | IPVS `wrr` is gcd-stepped and bursty; ours is smooth (nginx-style) | plug-in weight countdown with reset |
| LeastConn | IPVS `lc` / `wlc` | WEIGHTEDACTIVE |
| SED | IPVS `sed`: (active + 1) / weight, inactive ignored -- same rule | CICSPlex SM QUEUE (closest) |
| NQ | IPVS `nq`: first idle server, else SED -- same rule | -- |
| P2C | IPVS `twos` (5.12; draws may repeat, ours are distinct) | Nelson-Philips JSQ analysis |
| PeakEWMA | none in IPVS | Load Balancer advisors + smoothing; SERVERWLM with TSR |
| ConsistentHash (Maglev) | IPVS `mh` (4.18, prime M, default 4093); RSS tables | none found (token/timer affinity instead) |
| BoundedLoad | none (OVERLOAD flag + fallback is nearest) | plug-in MaxConnections (analogy only) |
| WeightedRandom | weighted draws inside `twos` | BASEWLM proportional weights |
| soak drift thresholds | `imbalance_pct` hysteresis | Load Balancer sensitivity threshold |
| teeth (must-fail) | `rcu_busted`, fault injection, `fail-nth` | ConTest noise |
| seeded, replayable soak | LinSched (repeatable); rcutorture is not seed-replayable | ConTest replay |

Note where lite-pick matches a proven design exactly (SED, NQ), where it deliberately does better (P2C's
distinct choices, smooth WRR, a seed-replayable soak, a zero-allocation kernel proven by a must-fail
battery), and where an established system still has something to teach us (drain semantics, damping).

## Sources
Linux: [IPVS Kconfig](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/Kconfig),
[ip_vs_sed.c](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/ip_vs_sed.c),
[ip_vs_nq.c](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/ip_vs_nq.c),
[ip_vs_wrr.c](https://github.com/torvalds/linux/blob/master/net/netfilter/ipvs/ip_vs_wrr.c),
[LVS scheduling](http://www.linuxvirtualserver.org/docs/scheduling.html),
[sched-domains](https://docs.kernel.org/scheduler/sched-domains.html),
[fair.c](https://github.com/torvalds/linux/blob/master/kernel/sched/fair.c).
IBM: [Sysplex Distributor](https://www.ibm.com/docs/SSLTBW_3.1.0/com.ibm.zos.v3r1.halz002/sys_distrib.htm),
[WebSphere plug-in](https://www.ibm.com/docs/en/SSAW57_8.5.5/com.ibm.websphere.nd.multiplatform.doc/ae/cwsv_plugins.html),
[Kephart and Chess 2003](https://jmvidal.cse.sc.edu/lib/kephart03a.html).
All examples in sections 1-3 were produced by `Pick.js` on 2026-10-04 (scratch scripts, not committed).
