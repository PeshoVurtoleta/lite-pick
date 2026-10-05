/**
 * Allocation-RATE probe (not a test file): boots the kernel over virtual workers, warms 3 s, then runs
 * `steps` 1 ms steps between two markers. Run it under
 *   node --trace-gc --min-semi-space-size=1 --max-semi-space-size=1 test/rate-probe.mjs <A|B> <steps> [configJSON]
 * and count the Scavenge lines between MARK-A and MARK-B: bytes/request <= scavenges x 1 MB / requests.
 * (lite-gc-profiler's stabilized measureOps reports the RETAINED delta, which cannot see transient garbage;
 * this is the PerfGate method -- see research/capstone-P1-spec.md, F1 correction.)
 */
import { bootVirtual, flush } from './harness.mjs';
import { ENGINE_B } from '../kernel.js';

const mode = process.argv[2] || 'A';
const STEPS = Number(process.argv[3] || 30000);
const { kernel: k, hub, run } = await bootVirtual(process.argv[4] ? JSON.parse(process.argv[4]) : undefined);
if (mode === 'B') k.setEngine(ENGINE_B);
await run(3000);
let t = Math.floor(hub.now());
const ok0 = k.stats.c[1];
console.log('MARK-A');
if (mode === 'A') {
    for (let s = 0; s < STEPS; s++) { t++; hub.advance(t); k.tick(t); }
} else {
    for (let s = 0; s < STEPS; s++) { t++; hub.advance(t); k.tick(t); if ((s & 15) === 0) await flush(); }
}
console.log('MARK-B');
await flush();
console.log('REQ ' + (k.stats.c[1] - ok0));
