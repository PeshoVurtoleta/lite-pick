# Pool Scope -- a live TUI that visualizes a load-balancing DECISION

Pool Scope is an `htop`/`btop`-for-load-balancing: a terminal oscilloscope that watches a
`@zakkster/lite-pick` balancer make its choices and **names the failure** when the policy misbehaves.
It is a **decision monitor, not a resource monitor** -- it does not show CPU/RAM, it shows *where each
pick goes, whether the policy is fair, and which of five pathologies is happening right now.*

This is the FIRST render target (TUI) for post-1.0 #5. It is a **repo-only demo** (not in the npm
tarball) and a **pure CONSUMER**: it reads the balancer's `dump()`-style getters off a throttled
~12 Hz tick and NEVER perturbs the kernel's 0 B/op `pick()` hot path. `Pick.js` / `Pool.js` are
unchanged. Zero dependencies -- it imports only from lite-pick's own `Pick.js`.

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
Scenarios: `healthy`, `killworker`, `overload`, `flapstorm`, `pingpong`, `unfair`.
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

## The files (renderer-agnostic scene model)

- `snapshot.mjs` -- the `LitePickSnapshot`: an SoA ring buffer (parallel typed arrays, power-of-2 size,
  masked head, zero-alloc append) + the Gini/percentile math. The one source both this TUI and a later
  browser target render from.
- `detectors.mjs` -- the five detectors + the alarm tally, thresholds as constants.
- `driver.mjs` -- the simulated traffic engine over the REAL ten balancers (deterministic in-repo PRNG),
  owning the caller arrays + the fault injectors.
- `tui.mjs` -- the renderer + the dual-mode main loop.

Reads state only; never calls `pick()`; kernel unchanged.
