/**
 * pickEcosystem/live -- the guided TOUR (capstone P5, "the scenario script"): about 80 seconds that walk a visitor
 * through what the system does, one fault or strategy at a time, with a caption saying what to watch. The browser
 * page (button / key t) and the terminal UI (key t, or `--tour` scripted) play the same script through the same
 * kernel calls the keys use.
 *
 * Each step: `at` (seconds from the start), `act` (null, [verb, ...args] -- fault / heal / reset / strategy -- or a list
 * of those),
 * `say` (the caption), and `expect` -- the DECISIONS line the step must produce within `within` seconds, so
 * test/tour.test.mjs can hold the script to its captions (a tour that says "restarted" and shows nothing fails).
 * DOM-free and ANSI-free.
 */

import { eventText } from './narrate.js';
import { STREAM_CAP } from './kernel.js';

export const TOUR = Object.freeze([
    { at: 0, act: ['strategy', 'p2c'], say: 'Eight workers, strategy P2C: each request is a ~1 ms job on the less busy of two random workers.' },
    { at: 7, act: ['fault', 2, 'kill'], say: 'w2 is killed. Its in-flight requests fail over to other workers; its supervisor restarts it.',
        expect: 'w2 restarted by its supervisor', within: 3 },
    { at: 14, act: ['fault', 3, 'slow'], say: 'w3 now runs 10x slower. P2C counts requests in flight, not how long they take: w3 still gets work, and its p95 climbs.' },
    { at: 22, act: ['strategy', 'peakewma'], say: 'PeakEWMA measures latency: it learns w3 is slow and steers around it (watch the fingerprint).' },
    { at: 30, act: ['heal', 3], say: 'w3 is healed. PeakEWMA notices and sends it traffic again.' },
    // Back to P2C first: under PeakEWMA a failing worker's penalty steers traffic away before five failures in a
    // row can open its breaker (the strategy doing its job -- but then the breaker has nothing to show).
    { at: 34, act: [['strategy', 'p2c'], ['fault', 1, 'flaky']],
        say: 'Back to P2C. w1 now fails half its jobs: five failures in a row open its circuit breaker; failover hides it.',
        expect: 'w1 breaker OPEN', within: 4 },
    { at: 42, act: ['heal', 1], say: 'w1 is healed. After the cool-down one probe goes through, and the breaker closes.',
        expect: 'w1 breaker CLOSED', within: 5 },
    { at: 48, act: ['strategy', 'consistenthash'], say: 'ConsistentHash keeps every key on its own worker -- so the worker holding the hottest keys takes far more than its share.' },
    { at: 56, act: ['strategy', 'boundedload'], say: 'BoundedLoad keeps keys sticky too, but caps each worker near the mean and spills the overflow.' },
    { at: 63, act: ['fault', 6, 'crashloop'], say: 'w6 now crashes on every job. Five restarts in thirty seconds and its supervisor gives up.',
        expect: 'w6 ESCALATED', within: 6 },
    { at: 71, act: ['reset', 6], say: 'reset: a fresh scope and supervisor bring w6 back into rotation.',
        expect: 'w6 back in rotation', within: 4 },
    { at: 76, act: ['strategy', 'p2c'], say: 'That is the tour. Break something yourself -- or press q to watch a graceful shutdown.' },
    { at: 84, act: null, say: null },
]);

/** Apply one step's action -- or list of actions -- to a booted kernel (a reset returns its promise). */
export function act(kernel, a) {
    if (a === null) return undefined;
    if (Array.isArray(a[0])) { let r; for (const one of a) r = act(kernel, one); return r; }
    const verb = a[0];
    if (verb === 'strategy') return kernel.setStrategy(a[1]);
    if (verb === 'fault') return kernel.fault(a[1], a[2]);
    if (verb === 'heal') return kernel.heal(a[1]);
    if (verb === 'reset') return kernel.reset(a[1]);
    throw new RangeError('unknown tour verb ' + verb);
}

/** True iff the structural lane holds `text` among events at or after time `since` (kernel clock, ms). */
export function laneHas(lane, text, since) {
    const m = lane.count < STREAM_CAP ? lane.count : STREAM_CAP;
    for (let j = 0; j < m; j++) {
        const idx = (lane.head - 1 - j + STREAM_CAP) % STREAM_CAP;
        if (lane.time[idx] < since) continue;
        if (eventText(lane.type[idx], lane.payload[idx]).indexOf(text) >= 0) return true;
    }
    return false;
}

/** Plays the tour against a kernel; call tick(now) from the render loop (any rate). */
export class TourPlayer {
    constructor(kernel, script) {
        this.k = kernel;
        this.script = script || TOUR;
        this.t0 = -1;
        this.next = 0;
        this.step = -1;
    }
    get active() { return this.t0 >= 0; }
    get caption() { return this.step >= 0 && this.step < this.script.length ? this.script[this.step].say : null; }
    /** "3/12" while active. */
    get progress() { return (this.step + 1) + '/' + (this.script.length - 1); }
    start(now) { this.t0 = now; this.next = 0; this.step = -1; this.tick(now); }
    stop() { this.t0 = -1; this.step = -1; }
    /** Run every step that is due; returns the current caption (null once the tour has ended). */
    tick(now) {
        if (this.t0 < 0) return null;
        const script = this.script;
        while (this.next < script.length && now - this.t0 >= script[this.next].at * 1000) {
            const s = script[this.next];
            this.step = this.next++;
            const r = act(this.k, s.act);
            if (r && typeof r.then === 'function') r.catch(() => {});
            if (s.say === null) { this.stop(); return null; }
        }
        return this.caption;
    }
}
