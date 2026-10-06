/**
 * @zakkster/lite-pick -- STREAM-PARITY golden suite.
 *
 *     node --test test/StreamParity.test.js
 *
 * A refactor that claims to be behaviour-preserving must PROVE it bit for bit. `test/stream-program.mjs`
 * runs a fixed, seeded program over every exported strategy and folds the observable output -- the
 * pick() stream, PeakEWMA's `_ewma`/`_samp` Float64 state across four clock regimes, the ConsistentHash
 * and BoundedLoad lookup tables -- into one FNV-1a-32 digest per program. This suite pins each digest to
 * a GOLDEN literal cut from the released kernel.
 *
 * What moves a digest (the bugs this guards): a desynced WeightedRandom eligible-weight cache (`_ew`),
 * a stale alias table, a non-bit-exact PeakEWMA decay rewrite, a changed Maglev table. What does NOT:
 * an invariant-preserving refactor (that is the point -- K2/K4/K5 keep every stream byte-identical).
 *
 * Revert-check (the must-fail control, run out of band, not in CI): running `fingerprints` against a
 * copy whose WeightedRandom `setEligible` drops its `_ew` maintenance moves `weightedrandom.sparse` --
 * the fallback reads a wrong eligible-weight sum. A golden that cannot be falsified is not a gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprints } from './stream-program.mjs';
import * as mod from '../Pick.js';

/**
 * The golden digests, cut from the released kernel (and re-cut by `npm run parity:update` discipline
 * whenever an INTENTIONAL stream change ships, documented in the CHANGELOG). Never widened: a single
 * mismatch fails the suite and names the program.
 */
const GOLDEN = Object.freeze({
    roundrobin: 'f5c1c567',
    smoothwrr: '033cd4b0',
    p2c: '6ee6dad0',
    leastconn: 'f2930428',
    sed: 'cb23572e',
    nq: 'ab8c3e6c',
    'peakewma.backToBack': 'b05e5f34',
    'peakewma.interleaved': '652ef5a4',
    'peakewma.batchOneNow': '09c8a96a',
    'peakewma.backwardsClock': '874fa798',
    'peakewma.fracClock': '6ab86b68',
    consistenthash: '1b535acd',
    boundedload: '7826bbf7',
    weightedrandom: '838885b8',
    'weightedrandom.sparse': '6fcffcb4',
});

test('StreamParity: every program digest matches its golden (bit-exact)', () => {
    const fp = fingerprints(mod);
    for (const program of Object.keys(GOLDEN)) {
        assert.equal(fp[program], GOLDEN[program],
            'stream digest for "' + program + '" drifted: ' + fp[program] + ' != golden ' + GOLDEN[program]);
    }
});

test('StreamParity: the golden set and the program set are the same (no program silently dropped)', () => {
    const programs = Object.keys(fingerprints(mod)).sort();
    const golden = Object.keys(GOLDEN).sort();
    assert.deepEqual(programs, golden, 'stream-program.mjs and GOLDEN disagree on the program roster');
});
