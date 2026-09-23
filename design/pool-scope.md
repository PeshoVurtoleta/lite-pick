# Pool Scope -- the live pathology visualizer (design brief for post-1.0 #5)

Status: RESEARCHED + feel-prototype built. NOT scheduled (post-1.0, after 1.0.0).
Owner doc for ROADMAP.md post-1.0 #5 ("an htop for the endpoint pool"). This is a
DESIGN/RESEARCH brief, not an ADR: it records what to build and why, to be ratified
into ADRs when #5 is greenlit. Repo-only (not in package.json `files[]`).

Sourced from a 3-thread web research pass (2026-09-23) + the user's design direction
(btop admiration, the pathology list, the two ASCII mockups, lite-signal demo as the
house style). Prototype: a self-contained hand-rolled-canvas artifact ("Pool Scope"),
built 2026-09-23 to feel the hero mechanic before committing the real build.

---

## 1. Thesis -- the empty niche

btop / htop / Grafana visualize RESOURCES: "how is my machine doing?" Pool Scope
visualizes a DECISION: "where is each pick going, and can I SEE the policy working?"
It is a DECISION monitor, not a resource monitor. Its job is to make load-balancing
PATHOLOGIES instantly legible -- the five the user named:

1. oscillation
2. ping-pong balancing
3. starvation (a LIVE worker gets no traffic)
4. unfair distribution (load not proportional to weight/capacity)
5. overloaded workers (hotspotting)

One-line pitch: "the only live view where you can watch a load-balancing policy
misbehave -- and it names the failure for you."

Do NOT compete with btop on its turf. Borrow its AESTHETIC (density, sub-cell bars,
color discipline), reject its SUBJECT (machine resources).

## 2. The gap is real (confirmed by primary sources)

- Every production LB tool is a per-endpoint saturation TABLE or averaged time-series
  (a resource/health view), none visualizes the decision or fairness-vs-weight or
  oscillation over time:
  - Envoy `/clusters` -- plain text dump of per-host counters; the docs CONCEDE stats
    "do not provide enough information" and recommend the ejection event log.
    https://www.envoyproxy.io/docs/envoy/latest/operations/admin.html
  - HAProxy stats -- color-coded HTML table, snapshot only, no history/heatmap.
    https://www.haproxy.com/blog/exploring-the-haproxy-stats-page
  - NGINX Plus -- live saturation tables + gauges; no decision/fairness/oscillation.
    https://docs.nginx.com/nginx/admin-guide/monitoring/live-activity-monitoring/
  - Grafana LB dashboards -- per-backend lines + latency heatmaps, but 300s+ windows
    SMEAR OUT short-lived oscillation/ping-pong and never encode load/weight.
- Every beautiful ANIMATION shows one algorithm's steady state, names no pathology,
  models no health/weight:
  - samwho.dev/load-balancing -- the closest prior art; queue stacks, request dots,
    age-as-color-drift, power-as-grey-shade. Steal liberally. https://samwho.dev/load-balancing/
  - sorting visualizers / balls-into-bins -- distinct-residue-per-algorithm is our
    whole thesis (Bostock, https://bost.ocks.org/mike/algorithms/); the tallest bar IS
    the imbalance. But static/steady-state and unlabeled.
  - CFS scheduler visualizers -- Gantt lanes per task; one ships a "starvation" preset.
    The single best idiom for starvation/ping-pong/oscillation over time, absent from
    every LB tool. https://github.com/talaamm/CPU-Scheduler-Visualizer
- Consistent-hash evenness + disruption-on-scale (Maglev) is NEVER drawn anywhere --
  prior-art-free territory for M8. https://research.google.com/pubs/archive/44824.pdf

Conclusion: nobody fuses the decision stream + the five pathologies into one live
"watch a policy misbehave" view. That white space is the niche.

## 3. Core design principles

- INVERT btop's color budget. btop is always colorful, so an alarm cannot stand out.
  Pool Scope stays calm monochrome-GREEN at baseline and reserves amber/magenta/red
  PLUS MOTION exclusively for pathologies -- so ~90% of the time the screen is quiet
  and a fault is the ONLY thing warm or moving. Anomaly becomes pre-attentive. This is
  the key aesthetic move and the opposite of a system monitor.
- REDUNDANT anomaly encoding: never signal a fault by hue alone -- always color PLUS
  motion PLUS a glyph badge PLUS a stripe (also colorblind-safe).
- The STARVATION-is-DARK / OVERLOAD-is-BRIGHT polarity is the organizing axis: the two
  failure extremes frame the healthy middle.
- The panel reads `dump()` on a throttled ~10 Hz rAF tick -- it NEVER perturbs the
  0 B/op `pick()` hot path (lite-law: no per-pick telemetry). Show an `alloc delta 0 B`
  badge to prove the hot path stays zero-alloc live.
- Show the app at rest (it auto-runs healthy on load) and give reduced-motion users a
  calm variant (state still legible, pulsing/glow suppressed).

## 4. Layout -- three stacked idioms, each individually pre-attentive

1. HERO: the settling BAR-COMB (strategy fingerprint). One bar per worker; flip the
   strategy and it TWEENS into the characteristic shape. Overlays: a drawn mean line
   plus a +/-1 sigma band (so "tight band" is literal distance-to-mean), and a GHOST-
   TRAIL of the previous strategy's tops that fades over the morph (Bostock's residue
   idea -- the CHANGE is the spectacle). Behind each bar, a WEIGHT/CAPACITY GHOST BAR so
   load-over-weight fairness is visible -- GENUINELY NOVEL, nobody overlays actual-vs-weight.
   Fingerprints: random = jittery lopsided piles (max load ~ ln n / ln ln n); RoundRobin
   = flat comb; SmoothWRR = smooth staircase; P2C = tight band near the mean (the
   ln ln n / ln 2 ceiling, live); LeastConn = dead-level; SED = weighted staircase; NQ =
   idle-first left-to-right fill.
2. BENEATH: the HEAT-STRIP matrix (worker x time, load = color) -- the Brendan-Gregg /
   CFS-Gantt idiom (https://www.brendangregg.com/HeatMaps/utilization.html). ONE view
   carries four pathologies: oscillation = a strobing row; ping-pong = two rows in hard
   ANTI-PHASE (a checkerboard); starvation = a DARK dead row; overload = a pinned-HOT row.
   This is the temporal-pathology killer -- oscillation and ping-pong live entirely in
   the time dimension and cannot be seen in a static bar.
3. FAIRNESS SCALAR: a Lorenz curve + Gini gauge -- the best fairness-at-a-glance
   primitive (bow off the 45-degree line = unfair; Gini -> 0 = LeastConn's ideal). Ties
   straight to test/balance.mjs. https://www.datacamp.com/tutorial/lorenz-curve

Optional/secondary: a Vizceral-style particle fan-out (requests as particles source ->
worker; a dead edge = starvation, a fat edge = overload). More visceral, but the bar-
comb reads variance more precisely. https://github.com/Netflix/vizceral

The two user mockups map onto this: (1) per-worker load bars over a TIME axis + an
aggregate header (queue depths, rebalances, peak/avg latency) = the heat-strip + stats
rail; (2) the scrolling "A -> B" rebalance/decision feed = an event stream panel (the
"why" a resource monitor has no equivalent for).

## 5. Per-pathology encoding (each a DISTINCT signature so the TYPE is readable)

| Pathology     | Signature (must look distinct)                                              | Glyph              | Drive from                    |
|---------------|----------------------------------------------------------------------------|--------------------|-------------------------------|
| Oscillation   | heat-strip row STROBING hot/cold + growing-amplitude sine on the scope,     | U+223F tilde-wave  | autocorrelation / flap-count  |
|               | amber->red by amplitude                                                     |                    |                               |
| Ping-pong     | two rows in HARD ANTI-PHASE (checkerboard) + a flipping arc; discrete       | U+21C4 arrows      | negative correlation of the   |
|               | two-state, distinct from oscillation's smooth wave                          |                    | two hottest rows              |
| Starvation    | the DARK signature -- a drained, desaturated ghost row / dead flow edge;    | U+2205 empty-set   | live worker with ~0 share     |
|               | absence against lit neighbours; amber blink on the label                   |                    | while the pool is busy        |
| Unfair dist.  | Lorenz BOW off the diagonal + a tilted weight-ghosted bar set (diverging    | U+2696 scales      | Gini > threshold              |
|               | ramp)                                                                       |                    |                               |
| Overload      | the BRIGHT signature -- bar OVERSHOOTS its ceiling, saturated red + hard    | U+25B2 triangle    | worker load > saturation      |
|               | glow + fast pulse; inverse-video capacity label                            |                    |                               |

Shared alarm layer: a corner tally that flips green "SYSTEM NOMINAL" -> pulsing red
"PATHOLOGY DETECTED / N faults" the instant any detector fires (peripheral-vision
signal), with the active badges listed. Detectors are INDEPENDENT of the fault
injectors -- scenarios create conditions, detectors light on their own (honest).

Prior-art framing: flapping is detected via autocorrelation and shown as event markers
overlaid on a timeline (Broadcom Avi, Azure autoscale docs); a locked ping-pong limit
cycle draws a closed Lissajous loop / regular recurrence-plot diagonals (optional depth
panel, not the glance).

## 6. House style -- inherit from the lite-signal demo (do not reinvent)

The lite-signal "oscilloscope" demo (demo/index.html in LiteSignal) is the sibling
design system. Reuse:
- Dark palette: bg ramp #07090d / #0d1117 / #131922 / #1a2230; text #d8d6d2, dim
  #8b8d94, faint #555960; accents green #5fe39f, cyan #7dd3fc, amber #f5b942, magenta
  #e879a8, red #f87171; glow shadows for alarm. Semantic use: green = healthy, amber =
  oscillation/warn, red = overload/critical, magenta = ping-pong, cyan = decisions.
- Type: JetBrains Mono (data/display) + Space Mono (eyebrows/labels).
- Layout: canvas STAGE + side PANEL + corner OVERLAYS; scene tabs. Two scenes map 1:1:
  "vs Naive" -> our "vs random" fingerprint morph; "Pool Inspector" -> our pool view.
- The `alloc delta 0 B` metric badge (proves zero-GC live).

Render techniques (from the TUI-aesthetic thread):
- VALUE-DRIVEN GRADIENT FILLS (btop): color-lerp each bar/cell along its magnitude axis
  (green -> amber -> red) so hue IS the reading, not just height.
- BRAILLE-DOT TEXTURE (drawille, U+2800 base, 2x4 dots/cell) on the scope trace so it
  reads as a terminal instrument, not smooth SVG.
- EIGHTH-BLOCK SPARKLINES (U+2581..U+2588) per worker in the side panel.
- MIXED DENSITY tiers (notcurses): dense dots for signal, solid blocks for meter fills.
- TWO-LAYER redraw: static chrome canvas + moving trace canvas, glow via shadowBlur.
- CRT PHOSPHOR-DECAY sweep rather than a scrolling ribbon, so pathologies read as
  PERSISTENT SHAPES (a standing wave = oscillation) -- shape-over-time is more
  diagnostic than btop's magnitude-over-time.

macOS Activity Monitor reference (user, 2026-09-23) -- a resource monitor like btop, so
steal the INTERACTION + LAYOUT craft, reject the subject. Transferables (some btop lacks):
- TABBED VIEWS (CPU / Memory / Energy / ...) -> our scene tabs (fingerprint / heat / latency
  / fairness), aligning with the lite-signal scene-tab layout.
- SORTABLE dense live TABLE with a % column + inline mini-bar per row, sorted by load -> the
  per-worker rows (sort by share / load / latency / EWMA-cost); dense + scannable.
- CLICK-A-ROW -> DETAIL INSPECTOR (Activity Monitor double-click -> sample) -> click a worker
  for its detail: latency percentiles, recent picks, EWMA cost, eligibility history.
- The MEMORY-PRESSURE graph (a colored green/yellow/red pressure strip that answers "is the
  system healthy" pre-attentively) -> a FAIRNESS-PRESSURE gauge (green = balanced, red =
  starving/monopolised), reinforcing the calm-baseline color budget.
- The bottom SUMMARY STRIP (history sparkline + aggregate footer stats) -> our aggregate
  header/footer with the fairness / throughput / latency mini-charts.
NOTE: keep the DARK oscilloscope identity (lite-signal house style); Activity Monitor is
light + native-precise -- borrow its restraint and precision, not its light theme.

Sources: btop README (three symbol modes: braille U+2800-28FF, geometric U+25A0-25FF,
block U+2500-259F; 3-stop gradient meters) https://github.com/aristocratos/btop ;
drawille https://github.com/asciimoo/drawille ; unicode sparklines
https://rosettacode.org/wiki/Sparkline_in_unicode ; RAG/threshold + side-stripe alarm
design https://www.mastt.com/blogs/project-rag-status-dashboard .

## 7. The lego thesis -- compose suite bricks, no new low-level code

The REAL demo (not the prototype) rides existing siblings, all OPTIONAL PEERS:
- @zakkster/lite-charts (v1.24.0, stable): the charting engine. heatmap kernel ->
  heat-strip; bar / horizontal-bar -> fingerprint comb; line/area -> scope trace +
  sparklines + Lorenz curve; data-pinned annotations -> pathology / event markers.
  Reactive, zero-GC on lite-scene, 60fps at 100k points via min/max decimation.
- @zakkster/lite-signal (+ lite-signal-decorators / lite-di-signal): drives data,
  theme, and control state reactively; the panel updates on signal change.
- @zakkster/lite-sketch (DDSketch, v0.3.0): the peak/avg/p99 latency header -- 0 B/op
  add, hard per-query relative-error bound. See ROADMAP M7 + RESEARCH tail-latency.
- Also named in ROADMAP #5: lite-hud, lite-canvas-graph, lite-fps-meter.

None is a hard dep. The viz reads the balancer's `dump()` snapshot; the kernel imports
nothing from the viz.

## 8. The prototype (feel-check, throwaway)

"Pool Scope" -- a self-contained HTML artifact (hand-rolled canvas, simulated pool, NO
deps, NOT wired to real lite-pick). Built 2026-09-23 to evaluate "eye-catchy + unique
in the niche" before committing the real build. It implements: the fingerprint bar-comb
with mean/sigma + ghost morph; the heat-strip; fault injectors (kill worker, overload
spike, flap storm, force ping-pong); independent detectors driving the alarm tally +
badges; the calm-baseline color budget; a Gini/latency stats rail; the `alloc delta 0 B`
badge. It is a MOCKUP -- the production demo replaces the hand-rolled canvas with the
lite-charts bricks above.

## 9. Telemetry model -- the devtools snapshot layer (keepers from external review, 2026-09-23)

BOUNDARY FIRST (do not let it creep back): lite-pick is a STATELESS SELECTION KERNEL,
not a scheduler. It owns no tasks, no queues, no migrations. So this telemetry layer has
NO rebalance/migration metrics (sourceWorker->targetWorker, movedTasks, migrationsIn/Out)
and NO queueDepth/queueAge -- those presume a pending-task buffer + task movement lite-pick
never has (a "rebalance" counter would be a misnomer: each pick() is independent). If task
migration or queue-age ever get a home it is lite-worker-pool (post-1.0 #1), not lite-pick.
Per-worker completedTasks/failedTasks/activeTasks are NOT kernel state (ADR 0001) -- surfaced
by the /pool adapter if at all.

Shape (aligned with lite-law + the zero-GC philosophy):
- SoA RING-BUFFER snapshots, NOT event objects. Parallel typed arrays, power-of-2 size,
  masked head -- exactly the lite-law hot-path ring:
    const SIZE=4096; // power of 2
    const ts=new Float64Array(SIZE), fairness=new Float32Array(SIZE), gini=new Float32Array(SIZE),
          throughput=new Float32Array(SIZE), latP50=new Float32Array(SIZE),
          latP95=new Float32Array(SIZE), latP99=new Float32Array(SIZE);
    let head=0; // append: head=(head+1)&(SIZE-1)  -- zero alloc, ECS-friendly, chart-ready
  Lives in the OBSERVABILITY/DEVTOOLS layer (#5 viz + #7 lite-di-signal adapter), NOT in
  Pick.js. The kernel exposes a minimal dump(); the ring accumulates snapshots on the
  ~10 Hz tick, off the 0 B/op hot path.
- FAIRNESS first-class: Gini PRIMARY (catches uneven spread max-min misses: 90/90/90/90/90
  -> 0, 10/10/10/10/90 -> 0.51), plus min/max ratio + stdDev as cheap secondary readouts.
  Drives the Lorenz curve + Gini gauge (section 4).
- LATENCY percentiles, NEVER averages: p50/p75/p90/p95/p99/max from lite-sketch DDSketch,
  produced by the /pool layer (Pool.run records rtt on settle), not the kernel.
- Snapshot cadence 100/250/500 ms by workload (the ~10 Hz default tick).

NEW chart for section 4's set:
- THROUGHPUT-vs-LATENCY scatter ("the killer graph"): x = service latency, y = picks/sec.
  Healthy = throughput rises while latency stays flat; a bad algorithm = latency explodes
  as throughput climbs. Makes the M6 thesis ("parity on speed, superiority on the tail") a
  single visual -- beside the fingerprint + heat-strip + Lorenz trio.

Four headline KPIs (corrected -- queueAge.p95 DROPPED as a category error, replaced with a
lite-pick-native signal): fairness.score, fairness.gini, latency.p99, and eligibility-churn /
(/pool) failover-rate. If those stay stable while throughput climbs, the selector is behaving.

lite-pick-devtools framing: a LitePickSnapshot { system, workers[], fairness, latency } model
is essentially #5 (viz) + #7 (lite-di-signal observability adapter) combined -- a
`lite-pick-devtools` surface. Recorded on ROADMAP #7.

## 10. Open questions to settle when #5 is greenlit

- Real `dump()` shape: what per-worker fields the viz reads (inflight, share, eligible,
  weight, cap) and the exact ~10 Hz snapshot API on the balancer (must stay off the hot
  path).
- Which detectors ship (autocorrelation for oscillation? correlation for ping-pong?
  Gini for unfairness?) and their thresholds -- and whether pathology labelling is part
  of the shipped viz or demo-only.
- Bar-comb vs particle-fan-out as the hero (prototype uses bar-comb; fan-out is more
  visceral but reads variance worse).
- Doubles as the live face of the endurance soak (post-1.0 #8): leave it on
  `caffeinate -i`, the panel is the overnight dashboard. Confirm the soak's JSONL feeds
  the same panel.
- TWO RENDER TARGETS (user, 2026-09-23): (a) the browser-canvas panel this brief describes,
  and (b) a TERMINAL-ONLY TUI -- a genuine htop/btop-for-load-balancing. SAME data (dump()
  snapshot), SAME pathology detectors, SAME calm-baseline color budget; only the renderer
  differs. TUI render path (already researched, section 6): braille dots (U+2800, 2x4/cell)
  for the fingerprint + scope traces, block/eighth glyphs (U+2580-259F, U+2581-2588) for
  the heat-strip + bars, sextant/octant density tiers (notcurses) for richness, 256/true-
  color ANSI on the same green->amber->red ramp; render on a throttled tick, no per-pick
  telemetry. Open: shared "scene model" so browser + TUI render from one snapshot source;
  which ships first (the TUI is the purer thesis + the easier zero-dep artifact; the browser
  one is the richer pitch). Decide when #5 is greenlit.

---

Related: ROADMAP.md post-1.0 #5 (the entry) + #8 (endurance soak). Memory:
lite-pick.md (live-viz positioning + research summary).
