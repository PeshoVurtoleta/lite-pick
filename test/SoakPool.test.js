/**
 * @zakkster/lite-pick -- the soak's pool lanes are a DETERMINISTIC simulation (audit 2026-09-29 S9/S10).
 *
 *     node --test test/SoakPool.test.js
 *
 * The standard deterministic-simulation self-test (research/s9-deterministic-simulation.md): run the same
 * seed twice and compare the trace -- any hidden nondeterminism (a real clock, real timers, Math.random,
 * promise order deciding completion order) shows as a different hash. Also proves every pool lane is clean
 * on the shipped Pool.js (A1-A5, A8 down-dispatch, A9 Little's-law identity) and that a different seed
 * really changes the run. Zero-dep (a stub tracker; no lite-leak) so it runs in the no-install Node 18 job.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPoolCycle, POOL_LANES } from '../benchmark/soak/pool-lane.mjs';
import { KEYS, KEY_MASK, CAP, M_CH } from '../benchmark/soak/lanes.mjs';

const STUB_TRACKER = { track() {} };
const DEPS = { keys: KEYS, keyMask: KEY_MASK };
const run = (lane, seed) => runPoolCycle(lane, CAP, M_CH, seed, {}, null, DEPS, STUB_TRACKER);

for (const lane of POOL_LANES) {
    test(lane + ': same seed -> same trace; other seed -> different trace', async () => {
        const a = await run(lane, 0xC0FFEE), b = await run(lane, 0xC0FFEE), c = await run(lane, 0xBEEF);
        assert.equal(a.traceHash, b.traceHash);
        assert.equal(a.events, b.events);
        assert.equal(a.simUs, b.simUs);
        assert.notEqual(a.traceHash, c.traceHash);
    });

    test(lane + ': clean Pool passes every assertion; RTTs are simulated, in ns', async () => {
        const r = await run(lane, 0x1234567);
        assert.equal(r.lostRun, false);
        assert.equal(r.launched, 2048);
        assert.equal(r.resolved + r.rejected, r.launched);
        for (const k of ['assert1_inflightConsistent', 'assert2_quiescenceZero', 'assert3_accounted', 'assert4_codesOk',
            'assert5_outcomeOk', 'assert8_noDownDispatch', 'assert9_little']) assert.equal(r[k], true, k);
        assert.equal(r.downDispatch, 0);
        // A9 is an identity, not an approximation.
        assert.ok(Math.abs(r.inflightArea - r.attemptArea) <= 1e-9 * Math.max(1, r.attemptArea));
        // Mean service 1 ms with processor-sharing slowdown: RTTs are milliseconds in ns, never the old
        // summed-batch values (p50 ~142 ms) -- a coarse guard, the soak records the exact figures.
        assert.ok(r.rttP50Ns > 2e5 && r.rttP50Ns < 5e6, 'rtt p50 ' + r.rttP50Ns);
        assert.ok(r.svcMeanNs >= 1e6, 'mean service >= 1 ms (slowdown >= 1): ' + r.svcMeanNs);
    });
}
