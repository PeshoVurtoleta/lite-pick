# Pool Scope -- a live TUI that visualizes a load-balancing DECISION

Pool Scope is an `htop`/`btop`-for-load-balancing: a terminal oscilloscope that watches a
`@zakkster/lite-pick` balancer make its choices and **names the failure** when the policy misbehaves.
It is a **decision monitor, not a resource monitor** -- it does not show CPU/RAM, it shows *where each
pick goes, whether the policy is fair, and which of five pathologies is happening right now.*

This is the FIRST render target (TUI) for post-1.0 #5. It is a **repo-only demo** (not in the npm
tarball) and a **pure CONSUMER**: it reads the balancer's `dump()`-style getters off a throttled
~12 Hz tick and NEVER perturbs the kernel's 0 B/op `pick()` hot path. `Pick.js` / `Pool.js` are
unchanged. The **kernel** stays zero-dependency (`peerDependencies` is `{}`, imports only `Pick.js`);
Pool Scope itself is the "lego thesis" increment -- it PREFERS witnessed, paper-backed sibling kernels
for its latency / detector / hot-key math but **degrades gracefully to inlined math** when a sibling is
absent (see "Sibling-backed layer" below). The siblings are **devDependencies only** (repo-only, never
in the tarball), so they are never a hard dep on anyone who installs `@zakkster/lite-pick`.

## Run it

Interactive (a real TTY, live keys, ~12 Hz repaint):

```
npm run scope
# or: node demo/pool-scope/tui.mjs
```

Scripted / deterministic (renders N frames, then exits 0 -- how it is verified / CI-able):

```
npm run scope:frames
# or: node demo/pool-scope/tui.mjs --frames 40 --scenario flapstorm --strategy p2c --seed 42
```

Flags: `--frames N`, `--scenario <name>`, `--strategy <name>`, `--seed S`.
Scenarios: `healthy`, `killworker`, `overload`, `flapstorm`, `pingpong`, `unfair`, `hotkeys`.
`hotkeys` skews the KEYED workload zipfian -- run it with `consistenthash` or `boundedload` to see the
HOT KEYS panel and the hotspot (see "HOT KEYS panel" below).
Strategies (the ten): `roundrobin`, `smoothwrr`, `p2c`, `leastconn`, `sed`, `nq`, `peakewma`,
`consistenthash`, `boundedload`, `weightedrandom` (default `p2c`).

## Controls (interactive)

| key       | action                                               |
|-----------|------------------------------------------------------|
| `1`..`9`,`0` | switch to strategy 1..10                          |
| `n`       | cycle to the next strategy (with a ghost-trail morph) |
| `k`       | kill a worker (mark it down; press again for more)   |
| `o`       | overload-spike a worker (a hotspot)                  |
| `f`       | flap-storm a worker (rapid eligibility toggling)     |
| `p`       | force two workers into anti-phase (ping-pong)        |
| `u`       | skew the weights (unfair -- needs a weight-aware strategy) |
| `r`       | reset all injectors                                  |
| `q` / Ctrl-C | quit (restores the cursor + terminal)             |

## The five pathologies (independent detectors)

The detectors are **honest**: the scenarios create *conditions*; each detector lights on its own by
reading the snapshot's rolling series -- it never asks which injector is active.

| glyph | pathology   | signature                                            | driven from                        |
|-------|-------------|------------------------------------------------------|------------------------------------|
| `∿`   | oscillation | a heat-strip row STROBING hot/cold                   | eligibility flap-count over a window |
| `⇄`   | ping-pong   | two rows in hard ANTI-PHASE (checkerboard)           | strong negative load correlation   |
| `∅`   | starvation  | a DARK row -- a live worker sustained at ~0 share    | live + busy pool + ~0 rolling share |
| `⚖`   | unfair      | the Gini gauge bows red                               | Gini over the live decision-share  |
| `▲`   | overload    | a pinned-HOT row over saturation                     | inflight sustained over saturation |

The corner tally flips from green **SYSTEM NOMINAL** to a pulsing red **PATHOLOGY DETECTED / N faults**
with the active badges the instant any detector fires. Thresholds are constants at the top of
`detectors.mjs` (tune by eye).

## Layout

- **FINGERPRINT** -- the hero bar-comb: one bar per worker (eighth-block sub-cell height), value-driven
  green->amber->red gradient fill, a drawn mean line + `±1σ` band, a faint weight/capacity ghost bar
  behind each bar (actual-vs-weight fairness -- the novel bit), and a ghost-trail of the previous
  strategy's tops that fades over a morph when you switch strategy.
- **HEAT** -- the worker x time matrix (load = colour) via block glyphs: the temporal-pathology view
  where oscillation / ping-pong / starvation / overload all live.
- **FAIRNESS** -- a Gini gauge + a green/amber/red pressure strip (the Activity-Monitor idiom).
- **ALARM** -- the tally + active pathology badges.
- **data B/op** -- the DATA path (driver tick + snapshot build + detector evaluate, EXCLUDING the
  render string-building) measured over a gc-settled batch at startup on throwaway instances. It reads
  **0 B/op** because that path is zero-allocation (pre-allocated typed rings, SMI-range simulated clock,
  masked head, in-place percentile sort on a reused scratch). Run under `--expose-gc` (the `npm run
  scope` scripts do) for the exact 0; without it the batch shows a few B of unsettled young-gen
  (measurement noise, not per-op allocation). The kernel `pick()` 0 B/op is proven by `test/torture.mjs`.

## Sibling-backed layer (optional peers -- the lego thesis)

Pool Scope's latency / detector / hot-key math is backed by witnessed, paper-backed sibling kernels when
they are installed, and falls back to the PS1 inlined math when they are not. The inlined path is the
SEAM the peers slot into -- a swap, not a rewrite -- so the demo runs identically either way, just less
sharply. This is the "inline first, adopt the peer when it earns its place" pattern, made visible.

| layer            | sibling (preferred)                              | inline fallback                        |
|------------------|--------------------------------------------------|----------------------------------------|
| latency header   | **lite-sketch `DDSketch`** -- `add(rtt)` 0 B/op on settle; `quantile()` on the render tick gives p50/p95/p99 within a **HARD +-1% relative-error** bound. Global + per-worker sketches (per-worker tail via `latWorkerQuantile`), rolled for recency. | a fixed 512-sample ring, pre-alloc-sorted for the percentiles |
| oscillation      | **lite-adaptive `ADWIN`** (one per worker) -- consumes the eligibility stream; a flapping worker's windowed **variance** rises (0.25 vs 0 stable), and ADWIN's adaptive window (drift-cut on the eligible->flapping regime change) keeps the variance recency-scoped, clearing fast on recovery | eligibility flap-count over the window |
| decayed share    | **lite-adaptive `ForwardDecay`** (one per worker) -- `add(now)` 0 B/op on each pick; `rate(now)` is a RECENCY-weighted pick rate feeding the fingerprint + heat + Gini (recent picks weigh more) | a decayed rolling pick counter |
| hot keys         | **lite-adaptive `HeavyKeeper`** -- `add(key)` 0 B/op; `topKInto(buf)` 0-alloc identifies the decayed top-k ("hot RIGHT NOW", native decay tracks the CURRENT hot set, far lower error than Space-Saving on a Zipfian/drifting stream) | a decayed per-key frequency array, partial-selected |

HeavyKeeper is preferred over lite-sketch's cumulative `SpaceSaving` because a live monitor wants the
CURRENT hot set (decay), not an all-time tally.

**Optional import + graceful fallback.** `siblings.mjs` loads both peers with a dynamic, fail-open
`import()` (try/catch): a missing package degrades that layer to `null` and every consumer takes the
inline path. Force the fallback to prove it:

```
POOL_SCOPE_NO_SKETCH=1    node --expose-gc demo/pool-scope/tui.mjs   # latency -> inline sort
POOL_SCOPE_NO_ADAPTIVE=1  node --expose-gc demo/pool-scope/tui.mjs   # detectors/share/hot-keys -> inline
```

**Backing indicator.** The header prints which backing is live so the wiring is visible at a glance:

```
backing  detectors lite-adaptive · latency lite-sketch · hot-keys lite-adaptive
```

Each label turns amber and reads `inline (fallback)` when its sibling is absent. The `data 0 B/op` badge
still reads **0 for all ten strategies** -- every sibling call on the DATA path is a 0 B/op entry point
(`DDSketch.add`, `ADWIN.add`, `ForwardDecay.add`, `HeavyKeeper.add`); the cold reads (`quantile` /
`rate` / `topKInto` into a pre-alloc buffer) happen on the render tick.

## HOT KEYS panel (the keyed strategies)

`consistenthash` (#8) and `boundedload` (#9) route by an INTEGER key over a bounded keyspace. Under the
`hotkeys` scenario the key stream is **zipfian**, so a few keys dominate -- exactly the skewed, bounded
key set a consistent-hash pool exists for. The HOT KEYS panel (shown ONLY when a keyed strategy is
active) lists the top ~5 keys by recent share and the worker each maps to:

```
node --expose-gc demo/pool-scope/tui.mjs --frames 20 --scenario hotkeys --strategy consistenthash
node --expose-gc demo/pool-scope/tui.mjs --frames 20 --scenario hotkeys --strategy boundedload
```

The payoff: **ConsistentHash** piles the hot key onto one backend (a hotspot -- the panel's top key at
~10% share, the heat-strip row solid, `UNFAIR` + `OVERLOAD` firing), while **BoundedLoad** caps the hot
backend and overflows to neighbours (fairer -- lower Gini, `SYSTEM NOMINAL`). That contrast IS the M8/M9
story, drawn live. Under the default (`healthy`) keyed workload the keys are uniform, coverage is even,
and both stay nominal.

## The files (renderer-agnostic scene model)

- `snapshot.mjs` -- the `LitePickSnapshot`: an SoA ring buffer (parallel typed arrays, power-of-2 size,
  masked head, zero-alloc append) + the Gini/percentile math. The one source both this TUI and a later
  browser target render from.
- `detectors.mjs` -- the five detectors + the alarm tally, thresholds as constants (ADWIN-backed
  oscillation with the flap-count fallback).
- `driver.mjs` -- the simulated traffic engine over the REAL ten balancers (deterministic in-repo PRNG),
  owning the caller arrays + the fault injectors + the keyed (uniform/zipfian) workload and the
  DDSketch / ForwardDecay / HeavyKeeper sibling instances (with inline fallbacks).
- `siblings.mjs` -- the OPTIONAL PEER layer: dynamic fail-open `import()` of lite-sketch + lite-adaptive,
  the backing indicators, and the `POOL_SCOPE_NO_*` fallback overrides.
- `tui.mjs` -- the renderer + the dual-mode main loop + the HOT KEYS panel + the backing indicator.

Reads state only; never calls `pick()`; kernel unchanged; `peerDependencies` `{}`.
