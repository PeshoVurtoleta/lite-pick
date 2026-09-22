# 0001 -- Selection-kernel boundary: pure reader, shared eligibility, sibling-owned state

- Status: ratified
- Package: @zakkster/lite-pick 0.0.x (pre-M0)
- Composes with: @zakkster/lite-di-health (eligibility source), @zakkster/lite-statechart
  (per-endpoint circuit breaker), @zakkster/lite-o1 (RandomSet/AliasTable/RingLog substrate),
  @zakkster/lite-logn (exact least-conn heap / Fenwick weighted), @zakkster/lite-fastbit32
  (optional small-pool bitset), @zakkster/lite-worker + lite-worker-pool (in-process consumer).
  Needs NONE of them as a runtime dependency: every seam is duck-typed over a shared TypedArray.
- Date: 2026-09-22

## Context

lite-pick is a load-balancing SELECTION KERNEL: one hot function, `pick() -> index`, that
chooses which of N endpoints handles the next request. The suite already owns every
surrounding concern -- liveness (lite-di-health), state machines (lite-statechart), the O(1)
substrate (lite-o1), supervision/orchestration (lite-di-*), and an in-process worker pool. So
the load-bearing question is not "which algorithm" but "what does the kernel OWN, and what does
it merely READ?". Get that wrong and the zero-GC contract becomes unprovable (hidden state
allocates) or the kernel bloats into a proxy.

Five forks were settled with the user before any code (the user's 2026-09-22 research addendum
is folded in as authoritative). The unifying principle: **lite-pick owns NO mutable state it can
avoid owning.** It reads pre-allocated views that siblings or the caller write, and returns an
integer. Ownership of health, circuit state, and counters lives OUTSIDE the kernel.

## The five ratified forks

### Fork 1 -- Design center of gravity: IN-PROCESS first (ratified)

- Options: (a) remote HTTP client-side balancing as the primary design target, or (b) in-process
  targets (workers, DI services) first, with remote HTTP a first-class SECONDARY consumer via a
  thin adapter.
- Ratified: **(b) in-process first.** The suite lives in the DI/worker/ECS world; health probes,
  statecharts, and schedulers are native there, so an in-process selector stays purely about
  eligibility + selection with almost no hidden state. Remote HTTP needs observed latency, failure
  rates, circuit state, and sticky keys -- all of which push toward ownership and allocation risk if
  baked into the kernel. Remote is served by an optional thin adapter (drafted `lite-pick-http`)
  that OWNS the observation loop and merely writes the same shared views.
- Consequence of the wrong choice: designing for remote-first drags request lifecycle, retries, and
  latency accounting INTO the kernel, breaking the strict 0 B/op contract and the pure-selector
  identity. In-process-first keeps the contract strict; remote stays excellent via a companion.

### Fork 2 -- Eligibility ownership: a SHARED Uint8Array the kernel only READS (ratified)

- Options: (a) `pick()` pulls health via a callback each tick / every N picks, or (b) a
  pre-allocated `Uint8Array eligibility` that WRITERS (lite-di-health probes, circuit breakers,
  admin) mutate at their own cadence and `pick()` only READS (zero-copy).
- Ratified: **(b) shared read-only eligibility view.** `eligibility[i] === 0` -> ineligible;
  non-zero -> eligible. Writers own the mutation rules (mark unhealthy, hysteresis, decay). `pick()`
  never calls out, never triggers a side effect, never risks re-entrancy. A parallel `scores` /
  `inflight` view rides the same ownership model for latency/least-conn strategies (SoA, matching
  the suite style). Lean on lite-di-health probes as the primary writer for in-process targets.
- Consequence of the wrong choice: a pull-callback risks per-tick allocation, unpredictable latency
  if a probe is slow, and tight coupling of the selector to the health source. A shared view is the
  cleanest zero-GC, zero-copy contract and the hardest to accidentally break.

### Fork 3 -- Circuit breaker: CONSUMED, never built in (ratified)

- Options: (a) a batteries-included failure-counting breaker inside the kernel, or (b) the kernel
  stays a pure selector and the breaker lives OUTSIDE (lite-statechart, or a thin external breaker)
  and writes the eligibility view.
- Ratified: **(b) consume, do not own.** lite-statechart is small, tree-shakeable, and already
  models Closed/Open/HalfOpen as a zero-GC integer transition table; a breaker per endpoint is
  cheap. lite-pick NEVER knows WHY an endpoint is ineligible -- only that its bit is 0. If a
  convenience layer is ever wanted it ships as `lite-pick-breaker` (or a documented 10-line
  lite-statechart pattern) behind its own entry point, never in the core.
- Consequence of the wrong choice: an in-kernel breaker grows without bound (half-open probes,
  success thresholds, jitter, per-endpoint metrics) and stops being "lite"; the pure-selector
  boundary is far easier to defend. This is one of the two hardest forks to reverse later, so it is
  pinned now.

### Fork 4 -- Load counters: CALLER-OWNED typed arrays, prefer pure read (ratified)

- Options: (a) kernel-owned counters with `onDispatch`/`onSettle` lifecycle hooks, or (b)
  caller-owned `Uint32Array inflight` / `Float64Array ewma` that the caller (or a thin adapter)
  increments on dispatch and updates on settle; `pick()` only READS them.
- Ratified: **(b) caller-owned, pure read.** Maximum composability (the same counter array can feed
  metrics, rate limiters, or multiple selectors), and the kernel's accounting can never diverge from
  the caller's view. Optional allocation-free hooks or a thin `TrackedPool` wrapper (owns the arrays,
  exposes `dispatch()`/`settle()`) may ship OUTSIDE the hot core for DX, documented as a companion,
  not the identity.
- Consequence of the wrong choice: kernel-owned counters force the selector to know the request
  lifecycle and become a source of hidden work/divergence. Caller-owned arrays match Fork 2's
  ownership model exactly -- one consistent SoA story.

### Fork 5 -- Small-pool fast path: ONE Uint8Array path first; lite-fastbit32 an OPTIONAL peer later (ratified)

- Options: (a) special-case N <= 32 with a lite-fastbit32 single-word eligibility set from day one,
  or (b) one general `Uint8Array` (or Uint32 bitset) path first, adding a fastbit32 specialization
  later ONLY if measurement shows a clear win AND the public API is unchanged.
- Ratified: **(b) one path first, fastbit32 an optional peer build-path later.** A single code path
  is easier to prove 0 B/op and audit; most pools are small and a bit-scan over a Uint32 is already
  very fast. The fastbit32 path, if it lands, is an INTERNAL optimization (auto-selected or an opt-in
  constructor flag) with an identical `pick()`, and must not constrain future algorithms (large
  consistent-hash virtual-node rings). lite-fastbit32 becomes an OPTIONAL peer dependency, never a
  hard one.
- Consequence of the wrong choice: two public identities / two behaviours (different iteration or
  random order) is a testing and audit burden for a marginal win. This is the MOST reversible fork,
  so it is deliberately deferred.

## The resulting identity (the through-line)

lite-pick is a pure, zero-GC selection kernel. It READS pre-allocated views (eligibility, weights,
loads, scores) and returns an index (or a fail-closed sentinel). It never owns health, never owns
circuit state, never owns counters, never allocates on the steady-state pick path. All mutable state
lives with the caller or a sibling package. Remote HTTP and worker-pool use cases are served by thin,
optional adapters that feed the same shared views. Batteries (breakers, tracking helpers, fetch/axios
adapters) live in companion packages or examples so the core stays small and the 0 B/op claim stays
falsifiable and strict.

## Consumer / test target: lite-worker + lite-worker-pool

lite-worker-pool is the first in-process consumer and a torture-test target. HONEST NOTE recorded so
it is not oversold: lite-worker-pool's `map(items)` already load-balances by WORK-STEALING (each
worker pulls the next unassigned index when it frees up), so for the plain stateless `map` case the
queue is self-balancing and lite-pick adds nothing. lite-pick earns its slot where work-stealing
does NOT apply: STICKY / keyed dispatch (route item -> a specific worker by consistent hash so per-
worker caches stay warm), PUSH / fire-and-forget dispatch (no result await, so no pull queue), and
routing across HETEROGENEOUS workers or multiple pools by live load. Those are the scenarios the
worker-pool integration test exercises.

## What this ADR does NOT decide (deferred to later ADRs / sessions)

- Consistent-hash ring vs Maglev table (M8) and the integer-key-only hashing rule.
- Whether `pick()` returns -1 or throws on an all-ineligible pool (lean: -1 default, configurable).
- The exact rtt-window substrate (lite-o1 RingLog vs lite-ring-buffer) -- M7.
- The `lite-pick-http` remote adapter's observation loop -- its own session/ADR.
