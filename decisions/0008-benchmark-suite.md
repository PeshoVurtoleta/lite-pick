# 0008 -- The benchmark suite (M6): parity framing, real-competitors baseline, drift-check teeth, ConsistentHash SKIP

- Status: ratified
- Package: @zakkster/lite-pick 0.6.0 (M6)
- Builds on: ADR 0001 (0 B/op boundary), ADR 0005 (P2C draw + the ln ln n anchor), the RESEARCH
  section 3 dimensions and section 4 vs-AWS positioning.
- Date: 2026-09-23

## Context

M6 ships the ecosystem MVP the roadmap always reserved for a dedicated session: the ten-dimension
benchmark suite that turns lite-pick's two claims (the 0 B/op contract + the balance anchor) into
published, reproducible EVIDENCE. It is deliberately NOT a strategy session -- `Pick.js` and
`Pool.js` stay byte-identical to 0.5.0 apart from the `VERSION` stamp, and the kernel gates
(torture / PerfGate / witness / balance / fuzz) stay green and unperturbed. There is NO s0
strategy-accounting row (that table governs `Pick.js` strategies); M6 touches only `benchmark/`,
the docs, `package.json`, and the three version sites. Four forks were settled.

## Fork 1 -- The headline framing: parity on speed, superiority on the contract + balance + tail (ratified)

- The hazard (RESEARCH section 3): an "N times faster" headline. A trivial `i++ % n` round-robin,
  or `wrr`, MATCHES OR BEATS any honest two-draw strategy (P2C, SED) on raw ops/sec -- so a
  speed-superiority claim shows lite-pick LOSING rows and a sharp reviewer discounts the whole suite.
- Ratified: **throughput is claimed at PARITY; the wins are the contract (0 B/op / 0 major GC),
  balance quality, tail latency (GC blast-radius p99.9 / max pause), and never-a-dead-pick.** Every
  headline and the README prose enforce it. The two headline charts are (1) the balance anchor vs the
  P2C ceiling + random foil, and (2) the GC blast-radius: SERVICE-LEVEL tail under a sustained mixed
  workload, an allocating competitor vs lite-pick -- the number an AWS-paying evaluator actually
  feels (a major GC pause freezes every in-flight request), and the one none of the alternatives
  publish or can pass.

## Fork 2 -- The competitive baseline: REAL pinned npm competitors AND our own in-repo foils (ratified)

- Options: (a) foils only (fast, but "you graded your own homework"); (b) real npm packages only
  (credible, but old/CJS/flaky); (c) both.
- Ratified: **(c) both, kept SHARP not padded.** The three relevant incumbents -- `load-balancers`
  (P2C), `loadbalance` (RR/WRR), `wrr` (weighted-random) -- are pinned to EXACT versions in
  devDependencies (`1.3.52` / `1.0.0` / `1.0.0`) and locked via `npm install`, plus the foils we
  write (naive RR, random single-draw, weight-expansion WRR, collect-candidates-sort). All three
  incumbents are CommonJS; the `benchmark/*.mjs` files load them via `createRequire` and time them
  into `results.json`. A package that refuses to load is NOT silently dropped -- it becomes a labeled
  `unavailable` row (with the failure string), a disclosed gap. `peerDependencies` stays EMPTY --
  these are dev-only and NOT in the published tarball (`files[]` is an explicit whitelist).
- The baseline is RENDERED, not just stored: each incumbent runs through the SAME `timeLoop` harness
  on the SAME n=1024 pool as the lite-pick strategy of the SAME complexity class, shown side by side
  in the README `<!-- bench:competitors -->` fence (timing numbers, +/-15% band). Framing: ops/ms
  side by side, never "faster"/"Nx"/"beats" -- and parity is claimed ONLY on EQUAL-work rows, with a
  slower row OWNED, not glossed. CRUCIAL corollary (also Fork 1): a family is paired ONLY when a
  same-complexity lite-pick strategy exists. `load-balancers` (O(1) P2C) pairs with `P2cBalancer` --
  parity (within the band). `loadbalance` (O(1) RR) pairs with `RoundRobinBalancer`, but there
  lite-pick is ~22% slower (outside the +/-15% band): `loadbalance` is a bare `i++ % n` with NO
  liveness, while `RoundRobinBalancer` forward-scans the eligibility bitmap to skip down nodes
  (never a dead pick). That eligibility scan is the constant-factor cost of a guarantee none of the
  incumbents offer, so the row is disclosed as slower-for-the-liveness-contract, not spun as parity.
  But `wrr`
  is O(1) weighted-RANDOM, and lite-pick's O(1) weighted-random (`WeightedRandom`, alias table) lands
  at M10; our shipped `SmoothWRRBalancer` is O(cap) *smooth* weighted round-robin (a different,
  stronger guarantee, a different complexity class). Racing those two would manufacture a bogus
  ~100x "losing" row -- exactly the discredit-the-suite trap Fork 1 forbids. So the weighted-random
  row is a disclosed PENDING SKIP (M10), mirroring the ConsistentHash SKIP; `wrr` stays visible, and
  SmoothWRR's own O(cap) throughput is measured by the witness + throughput matrix instead.

## Fork 3 -- Reproducibility with teeth: the drift check, and its exact-vs-timing split (ratified)

- The hazard: marketing-only numbers that rot. RESEARCH section 3 demands a `bench:verify` that
  FAILS CI if a README number drifts from a fresh run.
- Ratified: **README numbers live inside `<!-- bench:ID -->` fences that `Report.mjs` is the sole
  writer of, and `bench:verify` re-checks every one.** The split (also ratified): ALGORITHMIC numbers
  (balance peak-gap, disruption remap %, GC major counts, byte deltas) are EXACT -- `bench:verify`
  recomputes them FRESH from the seeded code and compares byte-for-byte, so a hand-edit OR a code
  regression fails. TIMING numbers (GC pauses, ops/ms) get a +/-15% tolerance band and are compared
  to the stored `results.json` reference rather than a fresh (noisy) run -- teeth against a hand-edit
  without a flaky gate. `results.json` stamps Node / V8 / CPU model / cores / arch / OS and EVERY
  PRNG seed beside the numbers, so any third party reproduces the run.

## Fork 4 -- ConsistentHash disruption: ship the naive-modulo foil NOW, SKIP the real one (ratified)

- The trap (RESEARCH dimension 7): naive-modulo hashing reshuffles almost every key on a scale event
  (measured: ~98.4% remap at n=64), blowing every downstream cache -- the direct foil for the
  cache-affinity selling point. But the real `ConsistentHash` (Maglev table) does not land until M8.
- Ratified: **ship the naive-modulo foil measured NOW + an explicit SKIP row for `ConsistentHash`,
  disclosed as "lands at M8".** NO stub `ConsistentHash` class in `Pick.js` (a stub would be a
  fail-open dead pick waiting to happen, and would pollute the kernel gates). When M8 lands,
  ConsistentHash joins as a measured row and the SKIP is removed.

## Consequences

- `benchmark/` gains `GcBlastRadius.mjs`, `Fairness.mjs`, `Disruption.mjs`, `Report.mjs`, `Soak.mjs`,
  and `results.json`; `Matrix.mjs` is extended (a `dims` flag per subject + the shared seeded
  `buildWorkload` matrix + `SEEDS`), not rewritten. No `benchmark/` file is imported by anything under
  `test/`; the reverse is allowed -- `Soak.mjs` imports `test/invariants.mjs:checkBase` (the M4
  checker, reused) so the endurance soak proves state-synchronisation at every checkpoint.
- `package.json` gains `bench:gc` / `bench:fairness` / `bench:disruption` / `bench:verify` / `soak`
  scripts and the three pinned competitor devDeps; `bench:report` (previously broken -- it pointed at
  an absent `Report.mjs`) now works. `files[]`, `exports`, `peerDependencies`, and the tsc-visible
  API surface are UNCHANGED.
- `Soak.mjs` is the post-1.0 #8 scaffold: ONE P2C lane now (per-strategy lanes are future work),
  emitting a JSONL time-series, the harness the overnight `caffeinate -i` burn-in plugs into.
- M6 is an EVIDENCE session, not a strategy append: it adds NO s0 strategy-accounting row, NO new
  `Pick.js` class. The kernel stays a single 0 B/op file; the suite proves it.
