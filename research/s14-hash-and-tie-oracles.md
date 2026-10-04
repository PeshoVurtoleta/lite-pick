# Research: oracles for the hashing, least-load and weighted lanes (Phase 3, S14)

**Status:** DECIDED 2026-10-04 -- all four recommendations accepted. IMPLEMENTED 2026-10-04 (table size M = 4099, decided by measurement): see section 7 and the decisions/0014 S14 amendment.
**Question:** the audit's fix plan (2026-09-29, section 3.4) proposes new soak oracles that do not
re-implement the kernel's own walk: (a) a BoundedLoad **cap property**, (b) a ConsistentHash
**disruption property** -- "removing 1 of N backends moves <= 1/N + 2% of keys", (c) a WeightedRandom
chi-square **power** check with a 10%-perturbed-weight mutant, and (d) LeastConn/SED/NQ oracles that
accept any pick in the **argmin set** (ties). Where do these properties come from, and do the numbers
hold for our kernel?

**Short answer:** (a) and (d) are well-founded -- adopt. (b) is wrong as written: our kernel already does
BETTER than 1/N + 2% for the case that matters (a node going down moves zero other keys -- measured), and
the bound would FAIL on the case it does not cover (a Maglev table rebuild with the soak's small table).
Replace it with two sharp properties. (c) needs sizing: a 10% perturbation is detectable with ~20-30k
draws over 8-16 nodes but needs ~2M at 256 -- size the mutant, do not assume.

---

## 1. Concepts, in plain words

- **Consistent hashing:** map keys to backends so that adding or removing one backend moves only a small
  share of keys (the rest keep their "home" -- their caches stay warm).
- **Monotonicity / minimal disruption** (Karger et al.): when a backend is removed, ONLY the keys that
  lived on it move; nothing else is reshuffled. On average that is 1/N of the keys.
- **Maglev** (Google): fills a lookup table of M slots (M prime) by letting each backend claim slots in
  its own pseudo-random order, taking turns. Great balance -- every backend gets floor(M/N) or
  ceil(M/N) slots -- but when the table is REBUILT without a backend, some other keys move too.
- **Bounded load** (Mirrokni, Thorup, Zadimoghaddam): every backend has a capacity of about (1+eps) x the
  average load; a key walks forward past full backends to the first one under capacity.
- **Chi-square goodness-of-fit:** compares observed pick counts with the expected ones. Its **power** is
  the chance it detects a given wrong distribution. Power drops as the number of categories grows,
  because a small error in one category is diluted across all of them.
- **argmin set:** all nodes tied for the lowest score. "Pick is in the argmin set" accepts any tie-break;
  "pick is the lowest index" bakes one tie-break rule into the test.

## 2. What the sources say
- **Karger et al. 1997**, "Consistent Hashing and Random Trees": defines balance, monotonicity, spread
  and load; the "about 1/N of keys move" figure is an EXPECTATION that follows from balance plus
  monotonicity, not a hard per-event bound.
  [STOC PDF](https://cs.brown.edu/courses/csci2950-u/f09/papers/chash97stoc.pdf)
- **Eisenbud et al., NSDI 2016, "Maglev"** (sec. 3.4, 5.3): population by offset/skip permutations, M
  prime; each backend gets floor(M/N) or ceil(M/N) entries; they choose M > 100 x N "to ensure at most a
  1% difference". Disruption is explicitly NOT minimal -- their own 7-slot example moves an entry that
  did not belong to the removed backend -- and it shrinks as M grows ("perfect balance ... at the cost
  of slightly reduced resilience"). [paper](https://www.usenix.org/system/files/conference/nsdi16/nsdi16-paper-eisenbud.pdf)
  Envoy's docs: Maglev "is not as stable as ring hash ... approximately double the keys will move";
  Envoy's default table is 65537. [Envoy LB docs](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers)
- **Mirrokni, Thorup, Zadimoghaddam, SODA 2018**, "Consistent Hashing with Bounded Loads": capacity
  ceil((1+eps) m/n), walk to the first non-full bin; expected moves per update O(1/eps^2), independent
  of system size. Deployed in Google Cloud Pub/Sub and (by Vimeo) in HAProxy as `hash-balance-factor`.
  [arXiv 1608.01350](https://arxiv.org/abs/1608.01350),
  [Google blog](https://research.google/blog/consistent-hashing-with-bounded-loads/). Note: Envoy's
  `hash_balance_factor` probes with random jumps, not a strict forward walk -- "first under-cap in walk
  order" is our design, not a universal one.
- **Chi-square power:** effect size w = sqrt(sum (p1 - p0)^2 / p0), noncentrality n x w^2, df = k - 1;
  Cohen calls w = 0.1 "small". [Real Statistics](https://real-statistics.com/chi-square-and-f-distributions/power-chi-square-tests/),
  rule of thumb: expected count >= 5 per cell. [Wikipedia](https://en.wikipedia.org/wiki/Pearson%27s_chi-squared_test)
- **Ties in production least-connections:** NGINX `least_conn` tries tied servers "in turn using a
  weighted round-robin" [nginx](https://nginx.org/en/docs/http/ngx_http_upstream_module.html); HAProxy
  `leastconn` round-robins within equal-load groups. Nobody promises "lowest index".

## 3. Our measurements (real kernel, `ConsistentHashBalancer`, 20,000 keys, 40 trials each)
Fraction of keys that change backend when one random backend of N is removed:

| table M | N | 1/N | marked DOWN (`setEligible`) | weight 0 + `rebuild()` | ...of which were NOT on the removed node |
|---|---|---|---|---|---|
| 257 | 8 | .125 | .125 | .169 | down: **0**, rebuild: .044 |
| 257 | 32 | .031 | .031 | .107 | down: **0**, rebuild: .075 |
| 257 | 128 | .0078 | .0078 | .036 | down: **0**, rebuild: .029 |
| 257 | 256 | .0039 | .0039 | .020 | down: **0**, rebuild: .016 |
| 65537 | 8 | .125 | .125 | .127 | down: **0**, rebuild: .002 |
| 65537 | 32 | .031 | .032 | .035 | down: **0**, rebuild: .004 |
| 65537 | 128 | .0078 | .0078 | .0135 | down: **0**, rebuild: .006 |
| 65537 | 256 | .0039 | .0039 | .011 | down: **0**, rebuild: .007 |

- **A backend going DOWN moves exactly the keys that were on it -- zero others, in every trial, at both
  table sizes.** Our kernel walks past an ineligible slot instead of rebuilding, which gives Karger's
  minimal disruption on failure for free. That is a sharper property than "<= 1/N + 2%".
- **A REBUILD without the backend** (weight 0) is real Maglev disruption: +0.2 to +0.7 points at the
  library default M = 65537, but +1.6 to +7.5 points at the soak's M = 257. The proposed bound
  `1/N + 2%` would FAIL a correct kernel at M = 257 for N = 8..128 (the research agent's independent
  simulation agrees: 74-100% of trials fail there).
- **Balance at N = 256, M = 257** (the soak's kernel lane): keys per backend ranged 52..171 around a
  mean of 78 -- 255 backends hold 1 slot, one holds 2. That is the floor/ceil rule at M ~ N, a
  property of the soak's TEST configuration, not of the library default (M = 65537, Maglev's own
  "M > 100 x N" advice covers N <= 655).

**WeightedRandom chi-square power** (agent's exact noncentral-chi-square calculation, alpha 0.01, one
weight of k multiplied by 1.1):

| k | draws for 80% power | power at 100k draws |
|---|---|---|
| 8 | 18.6k | ~1.0 |
| 16 | 44k | 0.999 |
| 64 | 286k | 0.16 |
| 256 | 2.06M | 0.016 |

## 4. Options and recommendation
1. **(a) BoundedLoad cap property -- adopt.** It follows directly from the MTZ definition: when an
   eligible backend under the cap is reachable within the probe window, the chosen backend's in-flight
   count (before this request) is below the cap. The note must state the probe window and whether the
   cap counts the incoming request (ours does: the H4 fix). It is independent of the kernel's walk,
   which is the point (the audit: a design error shared by kernel and oracle passes both).
2. **(b) Disruption -- replace the proposed bound with two sharp properties:**
   - *Down-marking is minimal:* after `setEligible(r, false)`, every key whose home was not `r` keeps
     its home (exactly 0 moved). Our existing stickiness oracle already checks a version of this; make
     it the stated property.
   - *Rebuild disruption is bounded by a reference, not by 1/N:* after a weight-0 rebuild, the moved
     fraction is compared with a reference Maglev simulation of the same (M, N) (mean + margin), or the
     soak's keyed lanes move to a table size with M >= 100 x N where the excess is < 1 point. Do NOT
     assert `1/N + 2%`.
   - Do not add a 1/N disruption test to BoundedLoad: its movement guarantee is O(1/eps^2) and depends
     on load.
3. **(c) WeightedRandom power -- size it.** Adopt the 10% mutant, but run it where the chi-square has
   power: k <= 16 eligible nodes, or >= ~300k draws; at k = 256 use per-category binomial tests (about
   640k draws for 80% power) or a larger perturbation. Measure the mutant's detection rate as a teeth
   control, like everything else.
4. **(d) argmin set -- adopt.** Assert `pick in argmin set` for LeastConn/SED/NQ, so the planned 1.1
   rotating tie-break does not break the oracle; if tie-spreading becomes part of the contract, add a
   separate fairness check across the tied indices.

**What we would not copy:** a ring-hash or rendezvous reference as THE oracle for a Maglev kernel (they
have different disruption by design), and a 1/N bound treated as a hard per-event limit (it is an
expectation).

## 5. Decisions needed
1. Adopt (a) cap property and (d) argmin set as proposed?
2. Disruption: replace `1/N + 2%` with "down-marking moves 0 other keys" + "rebuild moves no more than a
   reference Maglev simulation of the same (M, N)"? And should the soak's keyed lanes keep M = 257
   (fast, but 2:1 slot skew at N = 256) or move to a larger prime table?
3. WeightedRandom: size the 10% mutant to k <= 16 or use per-category tests at large k?

## 7. What the implementation measured (2026-10-04)
- **Table size.** For the soak's 256 backends weighted 1..8: M 257 gives 63 backends no slot and collapses
  the weights into two classes (0.5 and 1.5 slots on average); M 4099 gives every backend slots in proportion
  to its weight (rebuild 65 us); M 25601 follows Maglev's own M >= 100 N but its rebuilds forced 17 major GCs
  in a soak of the keyed lanes. Chosen: 4099. Lesson: a test table that is too small does not just make the
  test less precise -- it silently changes WHAT is tested (here: weights).
- **Rebuild disruption at 4099** (20,000 events, eligibility 50-100%): other keys moved p50 2.2%, p99 4.0%,
  max 5.0% -- about twice the M >= 100 N figure (1.1% median at 25601), as Eisenbud et al. predict. Bound 8%.
  Down-marking moved 0 other keys and restoring the weight brought back 100% of keys, in every event.
- **Weighted random.** 4M draws per cycle make a 10% error on one weight-1 node of ~180 a ~6-7 sigma event:
  caught in 83% of cycles (100% for a weight-8 node); clean cycles never exceeded |z| 4.58 against a limit of 6.
- **Mutants that only the new checks catch:** modulo-N hashing (MH1), a reshuffling rebuild (MH2), and a
  pick-level weighted bias (M7b) -- the last two exit 0 on the previous oracles.
