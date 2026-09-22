/**
 * @zakkster/lite-pick -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between Pick.d.ts and the runtime fails
 * `npm run test:types`. Not executed; only type-checked. Each strategy (M1+) appends
 * a smoke of its new export here (accounting site 7).
 */

import { VERSION, PICK_NONE, Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer } from '../../Pick.js';

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
