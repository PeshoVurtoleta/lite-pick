# Research: calibrating the soak's P2C oracle (Phase 3, S7)

**Status:** DECIDED 2026-10-04 -- all recommendations accepted (option C, calibration target 100k clean cycles per live count.) Not implemented yet.
**Question:** the soak checks P2C (pick two distinct eligible nodes at random, send to the less loaded)
by dropping 32 x live requests into empty nodes, 8 independent trials per cycle, and failing a trial if
`max - mean > 4 x log2(ln live) + 4`. The audit (S7) found that bound 3-4x too loose: a P2C that ignores
the load comparison on HALF its picks is never caught. The fix plan proposes `ceil(log2(ln live)) + 3`
and "FAIL if >= 2 of 8 trials exceed it". Where do these formulas come from, and does the proposed rule
catch the half-broken kernel?

**Short answer:** the formula's SHAPE comes from well-known theory, but the theory gives no usable
constant, so the threshold has to be calibrated by simulation (that is what the "+3" is). Measured: the
proposed rule catches an 80%-broken P2C every cycle but the 50%-broken one in only 0.04-21% of cycles.
A different statistic -- the AVERAGE gap over the 8 trials -- catches the 50%-broken one in 66-100% of
cycles with no false alarm in 6,000 clean cycles. Recommendation: switch to the averaged statistic,
calibrated on a long clean run, and keep a hard per-trial cap for gross breakage.

---

## 1. Concepts, in plain words
- **Balls into bins:** throw m balls into n bins. The **gap** is the fullest bin minus the average. For a
  load balancer: requests = balls, nodes = bins, gap = how much worse the busiest node is than average.
- **One random choice** (pure random routing): the gap grows with the number of requests -- about
  sqrt(m log n / n) -- it never settles.
- **Two choices** (P2C): look at two random bins, use the emptier. The gap collapses to about
  log2(ln n) + a constant, and -- the remarkable part -- stops depending on how many balls you throw.
  "log2(ln n)" is tiny: 1.06 at n = 8, 2.47 at n = 256.
- **w.h.p.** ("with high probability"): a theorem that holds with probability approaching 1 as n grows,
  usually with an unspecified constant. Good for understanding; not directly a test threshold.
- **(1+beta)-choice process:** each ball uses two choices with probability beta, one random choice
  otherwise. A P2C that ignores its comparison half the time is exactly beta = 0.5.

## 2. What the sources say
- **Azar, Broder, Karlin, Upfal, "Balanced Allocations" (SIAM J. Comput. 1999):** n balls, n bins: one
  choice gives max load (1+o(1)) ln n / ln ln n; d >= 2 choices give ln ln n / ln d + Theta(1). The same
  holds in an "infinite process" where a random ball leaves and a new one arrives each step -- the
  closest classic model to in-flight counts with completions.
  [PDF](https://homes.cs.washington.edu/~karlin/papers/AzarBKU99.pdf)
- **Berenbrink, Czumaj, Steger, Voecking (STOC 2000 / SICOMP 2006), "the heavily loaded case":** for any
  number of balls m, max load = m/n + ln ln n / ln d + O(1) w.h.p. -- the gap does not grow with m.
  [NJIT record](https://digitalcommons.njit.edu/fac_pubs/18541)
- **No published numeric constant** for that O(1) was found; Talwar and Wieder's simpler proof states
  "log log n + gamma(c)" with gamma unspecified. [arXiv 1310.5367](https://ar5iv.labs.arxiv.org/html/1310.5367)
  So "+3" is a calibration choice, not a theorem.
- **Peres, Talwar, Wieder, "The (1+beta)-choice process" (SODA 2010):** gap Theta(log n / beta),
  independent of m. [PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2010/01/YPeres.pdf)
  The half-broken P2C therefore has a gap that grows like log n, not log log n -- a different growth
  order, but at n <= 256 the two differ by only a few units, so the test margin is thin.
- **Supermarket model (Mitzenmacher; Vvedenskaya-Dobrushin-Karpelevich):** with arrivals and
  completions, the fraction of queues with >= k jobs falls doubly exponentially, lambda^(2^k - 1);
  Luczak and McDiarmid show the max queue concentrates on ln ln n / ln d + O(1).
  [Mitzenmacher](https://www.eecs.harvard.edu/~michaelm/abstracts/tpds2001.html),
  [Luczak-McDiarmid](https://arxiv.org/abs/math/0605639)
- **In practice:** Envoy's `least_request` samples `choice_count` (default 2) hosts and takes the one
  with the fewest active requests, citing Mitzenmacher; Finagle/Linkerd use P2C least-loaded.
  [Envoy](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers)
- **Turning a w.h.p. bound into a test:** if one trial exceeds the bound with probability p, then
  P(>= 2 of 8 exceed) ~ 28 p^2. The theorems do not give p at small n -- estimate it by simulation.

## 3. Our measurements (real `P2cBalancer`, the oracle's exact shape: 32 x n balls, empty start)
Gap = max - mean per trial (3,000 trials per size; mutants from a reference P2C that matches the
kernel's healthy distribution):

| n | current bound | proposed | healthy p50 / p99 / max | 50%-ignore p50 / p99 / max | 80%-ignore p50 / max |
|---|---|---|---|---|---|
| 8 | 8.2 | 5 | 1 / 2 / 2 | 2 / 5 / 7 | 4 / 15 |
| 16 | 9.9 | 5 | 1 / 2 / 3 | 3 / 6 / 8 | 6 / 17 |
| 32 | 11.2 | 5 | 1 / 2 / 3 | 3 / 7 / 9 | 7 / 19 |
| 64 | 12.2 | 6 | 2 / 2 / 3 | 4 / 7 / 10 | 9 / 21 |
| 128 | 13.1 | 6 | 2 / 2 / 3 | 5 / 8 / 12 | 10 / 22 |
| 256 | 13.9 | 6 | 2 / 3 / 3 | 5 / 8 / 10 | 11 / 21 |

Chance that one CYCLE (8 trials) fails, under each rule:

| n | proposed, >= 2 of 8 over the bound: 50%-ignore / 80%-ignore | AVERAGE of the 8 gaps > healthy max + 0.5: 50%-ignore / 80%-ignore |
|---|---|---|
| 8 | 0.0004 / 0.74 | 0.66 / 1.00 |
| 16 | 0.006 / 0.99 | 0.97 / 1.00 |
| 32 | 0.04 / 1.00 | 1.00 / 1.00 |
| 64 | 0.02 / 1.00 | 1.00 / 1.00 |
| 128 | 0.07 / 1.00 | 1.00 / 1.00 |
| 256 | 0.21 / 1.00 | 1.00 / 1.00 |

- Healthy: the largest gap ever seen was 3, at every size, over 18,000 trials (the audit saw the same).
  Neither rule had a false alarm. The averaged rule's thresholds (1.88 at n = 8 up to 2.75 at n = 256)
  came from 1,000 clean cycles per size, so its false-alarm rate is only shown to be below ~1 in 1,000
  per cycle -- a longer calibration run is needed before adopting it (minutes of CPU, not hours).
- Why averaging works: a single trial's gap is a noisy integer; the 50%-broken kernel shifts the whole
  distribution up by 1-3 units, which one trial rarely shows past a threshold but the mean of eight
  shows almost every time.
- Note: the oracle starts every trial from EMPTY nodes and has no completions, so the "gap creeps up
  with run length" effect the research agent saw in long simulations with completions does not apply
  to this oracle's shape.

## 4. Options
| | rule | catches | risk |
|---|---|---|---|
| A | proposed: per-trial `ceil(log2(ln n)) + 3`, FAIL if >= 2 of 8 | 80%-broken, random | 50%-broken mostly missed at n <= 128 |
| B | AVERAGE gap of the 8 trials > calibrated threshold per n | 50%-broken (66-100%/cycle), 80%, random | threshold must be calibrated (long clean run) and re-checked if the oracle shape changes |
| C | B, plus A's per-trial cap as a gross backstop | both | slightly more code |

## 5. Recommendation
**C.** Calibrate the averaged threshold per live count from a long clean run of the real kernel (target:
no false alarm in >= 100k clean cycles per size, stored as a small table in `oracles.mjs` with how it was
made), keep the proposed per-trial cap as a backstop, and add the 50%- and 80%-ignore mutants as teeth
controls (the fix plan already asks for them). The literature justifies the SHAPE (log log n healthy vs
log n broken); the numbers come from our own measurement, said so in the code.

## 6. Decisions needed
1. Adopt option C (averaged statistic + per-trial backstop)?
2. Calibration target: no false alarm in 100k clean cycles per live count -- enough, or more?
