/**
 * @zakkster/lite-pick -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Pick.d.ts and the runtime fails
 * `npm run test:types`. Not executed; only type-checked. Each strategy (M1+) appends
 * a smoke of its new export here (accounting site 7).
 */

import { VERSION, PICK_NONE, Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, CH_DEFAULT_M, CH_PROBE_LIMIT } from '../../Pick.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// PICK_NONE is the -1 literal.
const none: -1 = PICK_NONE;
void none;

// Prng: seed optional; next / nextBelow return numbers; reset returns void.
const p1: Prng = new Prng();
const p2: Prng = new Prng(12345);
void p2;
const r: number = p1.next();
const b: number = p1.nextBelow(8);
void r; void b;
p1.reset();

// BalancerBase: capacity + shared Uint8Array eligibility view.
const base: BalancerBase = new BalancerBase(4, new Uint8Array(4));
const cap: number = base.capacity;
const live: number = base.live;
const ok: boolean = base.isEligible(0);
void cap; void live; void ok;
base.setEligible(1, true);
const picked: number = base.pick();
void picked;

// @ts-expect-error -- capacity is readonly.
base.capacity = 5;

// @ts-expect-error -- live is readonly.
base.live = 0;

// @ts-expect-error -- eligible must be a Uint8Array, not a number[].
new BalancerBase(4, [1, 1, 1, 1]);

// @ts-expect-error -- setEligible needs a boolean, not a number.
base.setEligible(0, 1);

// RoundRobinBalancer: a BalancerBase subclass; pick() returns a number.
const rr: RoundRobinBalancer = new RoundRobinBalancer(4, new Uint8Array(4));
const rrBase: BalancerBase = rr; // is-a BalancerBase
void rrBase;
const rrCap: number = rr.capacity;
const rrLive: number = rr.live;
const rrPick: number = rr.pick();
void rrCap; void rrLive; void rrPick;
rr.setEligible(0, true);

// @ts-expect-error -- eligible must be a Uint8Array.
new RoundRobinBalancer(4, [1, 1, 1, 1]);

// SmoothWRRBalancer: adds a weights arg + setWeight; a BalancerBase subclass.
const wrr: SmoothWRRBalancer = new SmoothWRRBalancer(4, new Uint8Array(4), new Uint32Array(4));
const wrrBase: BalancerBase = wrr;
void wrrBase;
const wrrPick: number = wrr.pick();
void wrrPick;
wrr.setWeight(0, 5);
wrr.setEligible(1, true);

// @ts-expect-error -- weights must be a Uint32Array, not a number[].
new SmoothWRRBalancer(4, new Uint8Array(4), [1, 1, 1, 1]);

// @ts-expect-error -- weights arg is required.
new SmoothWRRBalancer(4, new Uint8Array(4));

// P2cBalancer: adds an inflight arg + optional seed; a BalancerBase subclass.
const p2c: P2cBalancer = new P2cBalancer(4, new Uint8Array(4), new Uint32Array(4));
const p2cSeeded: P2cBalancer = new P2cBalancer(4, new Uint8Array(4), new Uint32Array(4), 123);
void p2cSeeded;
const p2cBase: BalancerBase = p2c;
void p2cBase;
const p2cPick: number = p2c.pick();
void p2cPick;

// @ts-expect-error -- inflight must be a Uint32Array, not a number[].
new P2cBalancer(4, new Uint8Array(4), [0, 0, 0, 0]);

// @ts-expect-error -- inflight arg is required.
new P2cBalancer(4, new Uint8Array(4));

// LeastConnBalancer: capacity + eligibility + a caller-owned inflight view; a BalancerBase subclass.
const lc: LeastConnBalancer = new LeastConnBalancer(4, new Uint8Array(4), new Uint32Array(4));
const lcBase: BalancerBase = lc;
void lcBase;
const lcPick: number = lc.pick();
void lcPick;

// @ts-expect-error -- inflight must be a Uint32Array, not a number[].
new LeastConnBalancer(4, new Uint8Array(4), [0, 0, 0, 0]);

// @ts-expect-error -- inflight arg is required.
new LeastConnBalancer(4, new Uint8Array(4));

// SedBalancer: adds a weights arg after inflight; a BalancerBase subclass.
const sed: SedBalancer = new SedBalancer(4, new Uint8Array(4), new Uint32Array(4), new Uint32Array(4));
const sedBase: BalancerBase = sed;
void sedBase;
const sedPick: number = sed.pick();
void sedPick;

// @ts-expect-error -- weights must be a Uint32Array, not a number[].
new SedBalancer(4, new Uint8Array(4), new Uint32Array(4), [1, 1, 1, 1]);

// @ts-expect-error -- weights arg is required.
new SedBalancer(4, new Uint8Array(4), new Uint32Array(4));

// NqBalancer: same signature as SED; a BalancerBase subclass.
const nq: NqBalancer = new NqBalancer(4, new Uint8Array(4), new Uint32Array(4), new Uint32Array(4));
const nqBase: BalancerBase = nq;
void nqBase;
const nqPick: number = nq.pick();
void nqPick;

// @ts-expect-error -- weights arg is required.
new NqBalancer(4, new Uint8Array(4), new Uint32Array(4));

// PeakEwmaBalancer: capacity + eligibility + inflight + tauNs + optional seed; a BalancerBase subclass.
const pe: PeakEwmaBalancer = new PeakEwmaBalancer(4, new Uint8Array(4), new Uint32Array(4), 1e6);
const peSeeded: PeakEwmaBalancer = new PeakEwmaBalancer(4, new Uint8Array(4), new Uint32Array(4), 1e6, 123);
void peSeeded;
const peBase: BalancerBase = pe;
void peBase;
const pePick: number = pe.pick(1000);
void pePick;
const peEwma: number = pe.ewmaAt(0, 1000);
void peEwma;
pe.recordRtt(0, 5000, 1000);

// @ts-expect-error -- inflight must be a Uint32Array, not a number[].
new PeakEwmaBalancer(4, new Uint8Array(4), [0, 0, 0, 0], 1e6);

// @ts-expect-error -- tauNs (a number) is required.
new PeakEwmaBalancer(4, new Uint8Array(4), new Uint32Array(4));

// @ts-expect-error -- recordRtt needs three numbers.
pe.recordRtt(0, 5000);

// ConsistentHashBalancer: capacity + eligibility + optional weights + optional m + optional seed.
const chM: number = CH_DEFAULT_M;
const chP: number = CH_PROBE_LIMIT;
void chM; void chP;
const ch: ConsistentHashBalancer = new ConsistentHashBalancer(4, new Uint8Array(4));
const chW: ConsistentHashBalancer = new ConsistentHashBalancer(4, new Uint8Array(4), new Uint32Array(4));
const chFull: ConsistentHashBalancer = new ConsistentHashBalancer(4, new Uint8Array(4), new Uint32Array(4), 257, 123);
void chW; void chFull;
const chBase: BalancerBase = ch; // is-a BalancerBase
void chBase;
const chSize: number = ch.tableSize;
void chSize;
const chPick: number = ch.pick(0xdeadbeef);
void chPick;
ch.setWeight(0, 5);
ch.rebuild();
ch.setEligible(1, false);

// @ts-expect-error -- weights must be a Uint32Array, not a number[].
new ConsistentHashBalancer(4, new Uint8Array(4), [1, 1, 1, 1]);

// @ts-expect-error -- tableSize is readonly.
ch.tableSize = 5;
