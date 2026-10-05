/**
 * Allocation-RATE probe (not a test file): boots the kernel over virtual workers, warms 3 s, then runs
 * `steps` 1 ms steps between two markers. Run it under
 *   node --trace-gc --min-semi-space-size=1 --max-semi-space-size=1 test/rate-probe.mjs <A|B> <steps> [configJSON]
 * and count the Scavenge lines between MARK-A and MARK-B: bytes/request <= scavenges x 1 MB / requests.
 * (lite-gc-profiler's stabilized measureOps reports the RETAINED delta, which cannot see transient garbage;
 * this is the PerfGate method -- see research/capstone-P1-spec.md, F1 correction.)
 *
 * Optional `--rate N` overrides the scene's arrival rate (A1b drives engine A at 5x capacity to prove the
 * admission path is still zero-alloc under overload). An unknown flag fails closed (exit 2, did-you-mean).
 */
import { bootVirtual, flush } from './harness.mjs';
import { ENGINE_B } from '../kernel.js';

const argv = process.argv.slice(2);
const positional = [];
let rateOverride = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rate') { rateOverride = Number(argv[++i]); continue; }
    if (a.length > 1 && a[0] === '-') {
        process.stderr.write('rate-probe: unknown flag ' + a + ' (known flags: --rate)\n');
        process.exit(2);
    }
    positional.push(a);
}

const mode = positional[0] || 'A';
const STEPS = Number(positional[1] || 30000);
const baseConfig = positional[2] ? JSON.parse(positional[2]) : undefined;
const config = rateOverride !== null ? { ...(baseConfig || {}), rate: rateOverride } : baseConfig;

const { kernel: k, hub, run } = await bootVirtual(config);
if (mode === 'B') k.setEngine(ENGINE_B);
await run(3000);
let t = Math.floor(hub.now());
const ok0 = k.stats.c[1];
const arr0 = k.stats.c[0];
console.log('MARK-A');
if (mode === 'A') {
    for (let s = 0; s < STEPS; s++) { t++; hub.advance(t); k.tick(t); }
} else {
    for (let s = 0; s < STEPS; s++) { t++; hub.advance(t); k.tick(t); if ((s & 15) === 0) await flush(); }
}
console.log('MARK-B');
await flush();
console.log('REQ ' + (k.stats.c[1] - ok0));
console.log('ARR ' + (k.stats.c[0] - arr0));
