/**
 * pickEcosystem/live -- what the two surfaces share (the terminal UI and the browser page answer to the same
 * keys, step the rate the same way, inject faults the same way), and the browser page's device scene. DOM-free,
 * so the tests run all of it in Node.
 *
 * The terminal scene assumes the reference machine: UNITS_PER_MS busy-loop units are ~1 ms there. A visitor's
 * browser may be a phone, so the page MEASURES the job's own loop on this device before booting (~80 ms, once)
 * -- "~1 ms of real CPU per job" then holds on every machine -- and offers less traffic to a device with fewer
 * cores. The measurement itself (`calibrateUnitsPerMs`) lives in calibrate.js and is re-exported here so the
 * page and the tests keep their single `./surface.js` import.
 */

// Re-exported so page.js / the web tests keep importing it from ./surface.js (the measurement is in calibrate.js).
export { calibrateUnitsPerMs } from './calibrate.js';

/** The scene's offered rate for a device with `cores` hardware threads (8 workers always). */
export function browserScene(cores) {
    const c = cores > 0 ? cores : 4;
    return { rate: c >= 8 ? 2000 : c >= 6 ? 1500 : 1000 };
}

/** The fault a key injects on the selected worker, or undefined. */
export const FAULT_KEYS = Object.freeze({ k: 'kill', s: 'slow', f: 'flaky', h: 'hang', c: 'crash', l: 'crashloop', x: 'heal', r: 'reset' });

/** The rate keys (+ / -). */
export function rateUp(r) { return Math.round(r * 1.25); }
export function rateDown(r) { return Math.max(100, Math.round(r / 1.25)); }

/** Apply a fault kind (FAULT_KEYS value) to worker w; `reset` returns its promise. */
export function applyFault(kernel, kind, w) {
    if (kind === 'reset') return kernel.reset(w);
    if (kind === 'heal') return kernel.heal(w);
    return kernel.fault(w, kind);
}

/** The note the surfaces show when the orchestrator's shutdown resolves with exit code `code`. */
export function shutdownNote(code) {
    if (code === 0) return 'every worker retired cleanly.';
    if (code === 2) return 'deadline hit: workers terminated, in-flight requests failed.';
    return 'shutdown ended with code ' + code + ': workers terminated.';
}
