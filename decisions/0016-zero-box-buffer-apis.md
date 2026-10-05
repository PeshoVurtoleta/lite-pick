# 0016 -- Zero-box buffer APIs: `pickFrom`, `recordRttFrom`, and a PRNG that never boxes

- Status: Accepted
- Package: @zakkster/lite-pick 1.1.0
- Builds on: ADR 0001 (selection-kernel boundary), ADR 0009 (PeakEWMA), ADR 0010 (ConsistentHash),
  ADR 0011 (BoundedLoad).
- Research: `research/1.1.0-buffer-apis.md` (decisions E1-E6, accepted 2026-10-05).
- Date: 2026-10-05

## Context

`pick(now)`, `recordRtt(i, sampleNs, now)` and `pick(keyHash)` take numbers that are, in real use, outside V8's
small-integer range (a ~1.7e18 ns clock, a 32-bit hash >= 2^31) or fractional (an rtt). V8 boxes such a number
into a ~16 B HeapNumber whenever the call is not inlined, so the "0 B/op" claim held only for small-integer
arguments (the 1.0.1 KNOWN LIMITATION). Whether a given call is inlined changes from run to run: the perf gate's
report-only CH / BL lanes read 0 on one run and 24 scavenges on the next.

## Decision

- **E1 / E2 -- names and layout, the suite's `xxxFrom(buf, i)` convention** (lite-sketch `addFrom`,
  lite-adaptive `addFrom` / `advanceFrom`, lite-logn `searchFrom`): `pickFrom(buf, i)` on PeakEWMA (clock in a
  Float64Array) and ConsistentHash / BoundedLoad (key in any typed array, normalized by `>>> 0`), and
  `recordRttFrom(endpoint, buf, j)` reading `[sampleNs, now]` at `buf[j], buf[j + 1]` (recordRtt's order).
- **E3 -- `pickFrom` keeps `pick`'s never-throw contract.** Any value, any index: past the end reads undefined,
  which behaves like `pick(NaN)`. No per-pick type check; a null / undefined buffer is a programming error the
  engine reports. (The suite's other `From` methods validate, but none is a never-throw hot path.)
- **E4 -- `recordRttFrom` validates like `recordRtt`** (warm path) plus `LITE_PICK_ARRAY` for anything but a
  Float64Array with both slots, before any write.
- **One body, no duplication.** PeakEWMA's pick body is `_pickAt(buf, at)` and its feedback body
  `_recordAt(i, buf, j)`: both read every double from a typed array. `pick(now)` / `recordRtt` write their
  arguments into a balancer-owned `Float64Array(2)` and call the same body. ConsistentHash / BoundedLoad reduce
  the key to its table slot first (`(key >>> 0) % M`, always a small integer), and `_pickSlot(slot)` is the
  shared body (BoundedLoad overrides it with the cap-aware walk).
- **E5 -- the PRNG never boxes.** `Prng.next()` returns a uint32, >= 2^31 half the time; when V8 did not inline
  it, every draw boxed (P2C: one box per pick on average). `nextBelow` now runs the xorshift step itself, and
  WeightedRandom's uniform draws run it inline. The streams are bit-identical (golden fingerprints from 076157e
  in test/BufferApis.test.js), so no seeded result anywhere changes.
- **E6 -- scope.** Pool keeps calling `pick(now)` (its `now` lives across an `await` and is stored tagged
  anyway; Pool was never 0 B/op). No BigInt clock. The plain methods keep their signatures.

## Consequences

- Measured (darwin arm64, Node 22 and 26, 1 MB pinned young generation): every `From` path 0 B/op with V8
  inlining on AND off; HEAD's plain paths 16-32 B/op with inlining off. `pickFrom` costs what `pick` costs;
  `recordRttFrom` ~1 ns more than `recordRtt` (9.6 vs 8.6 ns).
- PerfGate gains five GATED lanes at realistic magnitudes (PeakEWMA `pickFrom` with a 1.7e15 clock,
  `recordRttFrom` with fractional samples, CH / BL `pickFrom` with keys >= 2^31, and the 1.0.x isolation
  pattern), and a second run of the whole gate with `--max-inlined-bytecode-size=0`
  (`npm run test:perf:noinline`, in `verify` and CI). On the pre-B6 kernel that run fails 12 lanes.
- The 1.0.1 "recordRtt in isolation" FINDINGS is closed with an established root cause (a Maglev merge of a
  tagged argument with a double in the 1.0.x blend, removed by B3; research section 6).
