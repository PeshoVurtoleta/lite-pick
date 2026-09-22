# @zakkster/lite-pick

> Zero-GC load-balancing **selection kernel**: one hot `pick()` that returns an endpoint **index** over a fixed pool and allocates **0 B/op** on the steady-state path. A pure selector, never a proxy -- it consumes health and circuit state, it never owns them. **v0.0.1 is the M0 scaffold**: the substrate seams (`VERSION`, `PICK_NONE`, a deterministic `Prng`, and `BalancerBase`'s shared read-only eligibility view) ahead of the strategy roster -- RoundRobin, SmoothWRR, P2C, LeastConn/SED/NQ, PeakEWMA, ConsistentHash, BoundedLoad, WeightedRandom, landing one per session.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-pick.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-pick)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-pick?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-pick)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-pick?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-pick)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-pick?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-pick)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The load balancer the ecosystem was missing

The npm landscape has old algorithm libraries (`load-balancers`, `loadbalance`, `wrr`) and heavy full proxies -- but **no package that ships a provably zero-GC `pick()` path with a measured balance-quality anchor.** Most algorithm libraries use ordinary objects and arrays and quietly allocate under sustained high call rates (millions of picks/sec in worker fan-out, high-QPS internal services, client-side routing). `lite-pick` fills that gap: a small, dependency-free, ESM-first selection **kernel** you drop into an HTTP client, a worker pool, or a custom proxy -- and it proves its two claims instead of asserting them.

- **The `pick()` is the product.** One hot-path primitive: given a pool of endpoints, return the index of the one to use. Every strategy (round-robin, weighted, power-of-two-choices, least-connections, latency-aware, consistent-hash, bounded-load) is a different `pick()` over the same substrate.
- **Two pieces of evidence, both shipped.** A **0 B/op** witness on the pick path (no object, closure, string, or array created per pick), and a measured **balance-quality anchor** -- peak-to-average load within the strategy's theoretical ceiling (for P2C, the Azar-Broder-Karlin-Upfal `ln ln n / ln 2` bound) and strictly better than a random foil.
- **A pure selector, not a proxy.** It **consumes** health and circuit state; it never owns them. Health is a shared read-only bitmap written by [`@zakkster/lite-di-health`](https://www.npmjs.com/package/@zakkster/lite-di-health); circuit state comes from [`@zakkster/lite-statechart`](https://www.npmjs.com/package/@zakkster/lite-statechart); load counters are caller-owned typed arrays. `pick()` only reads.

> **Status: M0 scaffold (v0.0.1).** This release ships the substrate every strategy will ride, and **no strategy yet**. The first strategy, **RoundRobin (M1)**, lands the throughput witness and the balance gate. See [ROADMAP.md](./ROADMAP.md) for the M0 -> M10 path to 1.0.0, and [decisions/](./decisions) for the ratified ownership boundary (ADR 0001) and the anti-flapping rule (ADR 0002).

```bash
npm install @zakkster/lite-pick
```

## The substrate (what M0 ships)

```js
import { BalancerBase, Prng, PICK_NONE, VERSION } from '@zakkster/lite-pick';

// A pool of 4 endpoints. The eligibility view is SHARED and read-only to pick():
// lite-di-health probes / circuit breakers write it; the balancer only reads it.
const eligible = Uint8Array.from([1, 1, 0, 1]); // endpoint 2 is down

const base = new BalancerBase(4, eligible);
base.capacity;        // -> 4
base.live;            // -> 3  (O(1), cold-path maintained)
base.isEligible(2);   // -> false  (out-of-range is false too, never a throw)

// Cold path: a health source marks endpoint 2 back up. live stays exact.
base.setEligible(2, true);
base.live;            // -> 4

// A deterministic PRNG so the balance benchmark is reproducible (no Math.random
// on a gated path). Strategies draw from this on the hot path, zero-alloc.
const rng = new Prng(0x1234abcd);
rng.nextBelow(4);     // -> a uint32 in [0, 4)
rng.reset();          // replays the exact stream

PICK_NONE;            // -> -1  (fail-closed sentinel: no endpoint, never a dead pick)
VERSION;              // -> '0.0.1'
```

`BalancerBase.pick()` is **abstract** at M0 -- it throws, so an unfinished strategy fails loudly rather than returning a dead index. Strategy subclasses (M1+) implement it. Here is the shape the headline **P2C** strategy will take (M3), for orientation:

```js
// SHAPE ONLY -- not shipped until M3. Two random eligible draws, return the lower
// in-flight load. One extra probe over random buys the ln ln n balance ceiling.
class P2cBalancer extends BalancerBase {
  constructor(capacity, eligible, inflight, seed) {
    super(capacity, eligible);
    this._inflight = inflight;  // caller-owned Uint32Array; pick() only reads it
    this._rng = new Prng(seed);
  }
  pick() {
    if (this.live === 0) return PICK_NONE;      // fail closed
    const a = this._draw(), b = this._draw();   // two distinct eligible draws
    return this._inflight[b] < this._inflight[a] ? b : a;
  }
}
```

## Design ownership (ratified before any strategy)

lite-pick owns **no mutable state it can avoid owning** ([ADR 0001](./decisions/0001-selection-kernel-boundary.md)):

| Concern | Owner | lite-pick's role |
| --- | --- | --- |
| Liveness / eligibility | `@zakkster/lite-di-health` writes a shared `Uint8Array` | **reads** it, zero-copy |
| Circuit state | `@zakkster/lite-statechart` (consumed) | never built in; sees only the bit |
| In-flight / rtt counters | caller-owned `Uint32Array` / `Float64Array` | **reads** them; pure `pick()` |
| Whole pool down | -- | fail-closed: returns `PICK_NONE` (-1) |
| Routing flap | the layer that writes the shared view | hysteresis/dwell ([ADR 0002](./decisions/0002-anti-flapping.md)); `pick()` stays greedy |

**In-process first** (workers, DI services, ECS-style systems); remote HTTP is served by a thin optional adapter that owns the observation loop and writes the same shared views. The zero-GC contract stays strict because the kernel never touches the request lifecycle.

## Composes with

The moat is not the algorithms -- it is that lite-pick wires already-proven zero-GC parts of the suite: [`lite-di-health`](https://www.npmjs.com/package/@zakkster/lite-di-health) (liveness), [`lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) (`RandomSet` / `AliasTable` / `RingLog` substrate), [`lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) (exact least-conn heap / Fenwick weights), [`lite-lru`](https://www.npmjs.com/package/@zakkster/lite-lru) (sticky affinity), [`lite-statechart`](https://www.npmjs.com/package/@zakkster/lite-statechart) (breaker), [`lite-query`](https://www.npmjs.com/package/@zakkster/lite-query) (the fetcher adapter), and [`lite-await`](https://www.npmjs.com/package/@zakkster/lite-await) (hedging). **None is a runtime dependency** -- every seam is duck-typed over a shared TypedArray.

## Gates

Every strategy session must pass, no exceptions:

```bash
npm test           # node:test boundary suite
npm run test:types # tsc type-surface check (Pick.d.ts vs runtime)
npm run torture    # lite-leak retention + lite-gc-profiler 0 B/op (needs --expose-gc)
npm run test:perf  # lite-perf-gate HARD zero-alloc gate + a mustFail teeth-check
npm run witness    # pick throughput flatness across a pool-size sweep
npm run balance    # peak-to-average vs the strategy ceiling + random foil (the anchor)
npm run verify     # all of the above
```

The zero-GC proof is two complementary tools kept separate (the suite's torture-harness discipline): a soak tester (`torture.mjs`, [`@zakkster/lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) + [`@zakkster/lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler)) and a node:test-native hard gate (`test/perf/PerfGate.test.mjs`, [`@zakkster/lite-perf-gate`](https://www.npmjs.com/package/@zakkster/lite-perf-gate)), which includes a `mustFail` scenario proving the instrument has teeth.

## License

MIT (c) Zahary Shinikchiev
