# 0002 -- Anti-flapping: hysteresis, dwell, and backoff on every routing change

- Status: ratified
- Package: @zakkster/lite-pick 0.0.x (pre-M0)
- Composes with: @zakkster/lite-statechart (per-endpoint breaker HalfOpen dwell), the
  bounded-load `(1 + eps)` cap (M9), the AZ-aware escalation wrapper (post-1.0 #3).
- Prior art: Linux CFS load balancing (imbalance thresholds, migration cost, nr_balance_failed
  backoff, wake-affinity); Linux sched domains (local-first hierarchy); IBM z/OS WLM (smoothed,
  goal-driven weight changes rather than instantaneous ones).
- Date: 2026-09-22

## Context

The 2026-09-22 Linux/IBM research sweep surfaced a class of bug that ADR 0001 (ownership) does
not address: **flapping.** A balancer that reacts to a single noisy sample -- one slow response,
one transient failure, one momentary load spike -- oscillates: it evicts an endpoint, traffic
shifts, the endpoint recovers, traffic floods back, it overloads again. The oscillation is worse
than the imbalance it tried to fix; it also thrashes caches (a sticky key that ping-pongs between
nodes loses locality on both).

Linux CFS is the canonical counter-example. Despite running on every scheduler tick, it is
deliberately ANTI-GREEDY: it will not migrate a task unless the imbalance clears a threshold
(`imbalance_pct`), the move is worth more than its cache/migration cost (`avg_idle` vs
`avg_scan_cost`), and repeated failed attempts back off (`nr_balance_failed`); wake-affinity even
biases a task back toward its previous CPU. It accepts some imbalance rather than pay constant
migration. IBM z/OS WLM likewise adjusts routing weights on a SMOOTHED interval, not per request.

lite-pick's hot `pick()` stays greedy and stateless -- P2C picks the better of two RIGHT NOW, and
that is correct, because a single pick is cheap and self-correcting. The flapping risk lives in the
WARM/COLD ring, in the STATE that pick() reads: the eligibility bit, the bounded-load cap, the AZ
choice. Those transitions -- not the pick -- must have hysteresis.

## The ratified rule

**Every routing-state transition applies hysteresis; no transition fires on a single sample.**
Concretely, three mechanisms, each owned by the layer that writes the shared view (never by
`pick()` itself, per ADR 0001):

### 1. Dwell before re-admitting a recovered endpoint (the breaker seam)

- An endpoint marked ineligible does NOT flip back to eligible on the first success. It goes through
  a HalfOpen probe/dwell period (owned by the lite-statechart breaker): a bounded number of trial
  requests must succeed, over a minimum dwell time, before the eligibility bit is set.
- Ratified: **consume lite-statechart's HalfOpen dwell** (ADR 0001 Fork 3 -- the breaker is not in
  the kernel). lite-pick never sees the dwell; it only sees the bit flip once, after the dwell holds.
- Consequence of the wrong choice: instant re-admit thundering-herds the just-recovered node (every
  waiting request pounces the moment its bit flips) and re-trips it -- the classic recovery
  oscillation. The dwell + a graduated ramp (probe floor -> full) prevents it.

### 2. Threshold + margin before a bounded-load redirect

- Bounded-load (M9) only skips an endpoint once its occupancy exceeds `(1 + eps) x mean`, and only
  redirects while it STAYS over -- the `eps` band IS the hysteresis. A node hovering at the mean is
  never redirected; it must be clearly over.
- Ratified: **the `(1 + eps)` cap is the anti-flap margin**, tuned so normal jitter stays inside it.
- Consequence of the wrong choice: redirecting at exactly the mean flaps every node around the
  average continuously.

### 3. Drift threshold + one-sided ramp for AZ escalation

- AZ-aware (post-1.0 #3) suppresses local traffic only when local rtt drifts past a threshold above
  all-zone (Zalando: >35%), and restores it GRADUALLY (a probe floor ramping up), not in one step.
  Escalation is local-first up the sched-domains-style hierarchy, one level at a time.
- Ratified: **threshold to escalate, gradual ramp to de-escalate** (asymmetric, like CFS wake-affinity
  biasing toward the previous CPU).

### Signal smoothing underpins all three

- The latency/occupancy signals the thresholds read are already EWMA/windowed (PeakEWMA, bounded-load),
  which is itself hysteresis in the signal domain -- a single sample cannot move a smoothed average far.
  Backoff (a CFS `nr_balance_failed` analog) applies where a transition keeps failing: widen the dwell.

## The gate

A dedicated dwell/hysteresis test (ROADMAP section 3) asserts, per strategy that reads mutable
routing state: **a single injected noisy sample (one failure, one spike) does NOT change the pick
outcome**, and a sustained change DOES (after the dwell/threshold). This is the falsifiable
anti-flap assertion, the counterpart to the balance-quality gate.

## Scope / non-goals

- This ADR governs STATE TRANSITIONS in the warm/cold ring, not `pick()`. `pick()` stays greedy,
  stateless, and zero-GC -- it reads whatever the (now hysteretic) views say.
- lite-pick does not IMPLEMENT the breaker or the EWMA; it consumes them (ADR 0001). This ADR fixes
  the CONTRACT (dwell/threshold/ramp) those writers must honor, and the gate that proves it.
- Exact constants (dwell ms, HalfOpen probe count, `eps`, AZ drift %) are per-deployment tunables with
  documented defaults, settled at each strategy's session -- not hard-coded here.
