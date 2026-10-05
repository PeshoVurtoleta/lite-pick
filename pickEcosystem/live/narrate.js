/**
 * pickEcosystem/live -- the words both surfaces use for the live system (the terminal UI and the browser page
 * say the same thing about the same event): a worker's state, and one sentence per decision-stream event.
 * DOM-free and ANSI-free -- a renderer maps the TONE to its own colour. Cold (render rate).
 */

import { EV_BREAKER, EV_ELIGIBLE, EV_RESTART, EV_ESCALATE, EV_REROUTE } from './kernel.js';
import { B_OPEN, B_HALF } from './fleet.js';

export const TONE_OK = 0;
export const TONE_WARN = 1;
export const TONE_BAD = 2;
export const TONE_INFO = 3;

/** A worker's state as the fleet panel shows it, most severe first in the checks. */
export const WS_UP = 0;
export const WS_OUT = 1;          // up, but out of rotation (not READY yet, hung, or draining)
export const WS_HALF = 2;         // breaker half-open: one probe allowed
export const WS_BREAKER = 3;      // breaker open
export const WS_STARTING = 4;     // spawned, waiting for READY
export const WS_DOWN = 5;         // dead; the supervisor is restarting it
export const WS_ESCALATED = 6;    // restart budget spent: kept down until reset
export const WS_TAG = ['up', 'out', 'half', 'BRK', 'start', 'down', 'ESCAL'];
export const WS_LONG = ['up', 'out of rotation', 'breaker half-open', 'breaker open', 'starting', 'down', 'escalated'];
export const WS_TONE = [TONE_OK, TONE_WARN, TONE_WARN, TONE_WARN, TONE_WARN, TONE_BAD, TONE_BAD];

const SET_STARTING = 0;           // lite-worker-pool WORKER_STATE
const SET_DOWN = 2;

/** Worker i's state (WS_*) on a booted kernel. */
export function workerState(k, i) {
    const fl = k.fleet;
    const st = k.set.state(i);
    if (fl.escalated[i]) return WS_ESCALATED;
    if (st === SET_DOWN) return WS_DOWN;
    if (st === SET_STARTING) return WS_STARTING;
    if (fl.bState[i] === B_OPEN) return WS_BREAKER;
    if (fl.bState[i] === B_HALF) return WS_HALF;
    if (!k.balancers.shared.up[i]) return WS_OUT;
    return WS_UP;
}

const BREAKER_NAME = ['CLOSED', 'OPEN', 'HALF-OPEN'];

/** One decision-stream event (a lane's type + packed payload) as a sentence. */
export function eventText(type, p) {
    switch (type) {
        case EV_REROUTE: return 'w' + (p >> 8) + ' -> w' + (p & 255) + '  failover';
        case EV_BREAKER: return 'w' + (p >> 2) + ' breaker ' + BREAKER_NAME[p & 3];
        case EV_ELIGIBLE: return 'w' + (p >> 1) + ((p & 1) ? ' back in rotation' : ' out of rotation');
        case EV_RESTART: return 'w' + p + ' restarted by its supervisor';
        case EV_ESCALATE: return 'w' + p + ' ESCALATED (restart budget spent; kept out until reset)';
        default: return '?';
    }
}

export function eventTone(type, p) {
    switch (type) {
        case EV_REROUTE: return TONE_INFO;
        case EV_BREAKER: return (p & 3) === 1 ? TONE_WARN : TONE_OK;
        case EV_ELIGIBLE: return (p & 1) ? TONE_OK : TONE_WARN;
        case EV_RESTART: return TONE_OK;
        case EV_ESCALATE: return TONE_BAD;
        default: return TONE_WARN;
    }
}
