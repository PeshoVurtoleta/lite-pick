/**
 * @zakkster/lite-pick -- the soak's P2C oracle limit is CALIBRATED, and the code matches the evidence
 * (audit 2026-09-29 S7; research/s7-p2c-oracle-bound.md, option C).
 *
 *     node --test test/SoakP2C.test.js
 *
 * 1. The table in oracles.mjs covers live 8..256, is monotone, and refuses (-1) anything outside it.
 * 2. Drift guard: it equals the breakpoints in benchmark/soak/p2c-calibration.json, and that evidence is a
 *    real >= 100k-clean-cycles-per-live-count run with no backstop or lost-pick event and every clean
 *    maximum strictly under its limit -- so nobody can hand-edit the limit without re-calibrating.
 * 3. On the real kernel at the soak's live range: clean cycles never fail; a P2C ignoring its comparison
 *    half the time fails nearly every cycle. Seeded: deterministic.
 * Zero-dep, so it runs in the no-install Node 18 job.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { P2cBalancer, Prng } from '../Pick.js';
import { P2C_SUM_LIMIT, p2cSumLimit, p2cTrials, _p2c, P2C_TRIALS, P2C_MIN_LIVE } from '../benchmark/soak/oracles.mjs';

const CAP = 256;
const CAL = JSON.parse(readFileSync(new URL('../benchmark/soak/p2c-calibration.json', import.meta.url), 'utf8'));

test('P2C limit table: covers live 8..256, monotone, fails closed outside', () => {
    assert.equal(P2C_SUM_LIMIT[0][0], P2C_MIN_LIVE);
    for (let i = 1; i < P2C_SUM_LIMIT.length; i++) {
        assert.ok(P2C_SUM_LIMIT[i][0] > P2C_SUM_LIMIT[i - 1][0], 'breakpoints strictly increase in live');
        assert.ok(P2C_SUM_LIMIT[i][1] > P2C_SUM_LIMIT[i - 1][1], 'limits increase (a breakpoint is a change)');
    }
    for (let n = P2C_MIN_LIVE; n <= CAP; n++) assert.ok(p2cSumLimit(n) > 0, 'limit at live ' + n);
    for (const n of [-1, 0, 1, 7, CAP + 1, 1e9, NaN]) assert.equal(p2cSumLimit(n), -1, 'outside the table: ' + n);
});

test('P2C limit table == the committed calibration evidence (>= 100k clean cycles per live count)', () => {
    assert.deepEqual(P2C_SUM_LIMIT.map((r) => [r[0], r[1]]), CAL.breakpoints);
    assert.equal(CAL.meta.cap, CAP);
    assert.equal(CAL.meta.trials, P2C_TRIALS);
    assert.equal(CAL.meta.mutant, 0);
    assert.ok(CAL.meta.cycles >= 100000, 'calibrated on ' + CAL.meta.cycles + ' cycles per live count');
    assert.equal(CAL.rows.length, CAP - P2C_MIN_LIVE + 1);
    for (const r of CAL.rows) {
        assert.ok(r.cycles >= 100000);
        assert.equal(r.backstop, 0, 'clean backstop fired at live ' + r.live);
        assert.equal(r.lost, 0, 'clean lost pick at live ' + r.live);
        assert.ok(r.maxSum + CAL.margin <= p2cSumLimit(r.live), 'clean max under the limit at live ' + r.live);
        assert.equal(r.sumHist.reduce((s, h) => s + h[1], 0), r.cycles, 'histogram accounts for every cycle');
    }
});

// The (1+beta)-choice mutant, beta 0.5: same distinct-second-draw loop as the kernel, then keep the first
// draw on half the picks (mirrors _mustfail M8b and _calibrate-p2c.mjs --mutant 50).
function ignoreHalf() {
    const a = this._draw();
    if (a < 0) return -1;
    if (this._live === 1) return a;
    let c = this._draw();
    for (let t = 0; c === a && t < 32; t++) c = this._draw();
    if (c < 0 || c === a) return a;
    if (this._rng.nextBelow(10) < 5) return a;
    return this._inflight[c] < this._inflight[a] ? c : a;
}

function failedCycles(live, cycles, seed, mutant) {
    const el = new Uint8Array(CAP), inf = new Uint32Array(CAP);
    const b = new P2cBalancer(CAP, el, inf, seed);
    if (mutant) b.pick = ignoreHalf;
    const rng = new Prng((seed ^ 0xA5A5A5A5) >>> 0);
    const perm = new Int32Array(CAP);
    const limit = p2cSumLimit(live);
    let failed = 0;
    for (let c = 0; c < cycles; c++) {
        for (let i = 0; i < CAP; i++) { perm[i] = i; b.setEligible(i, false); }
        for (let i = 0; i < live; i++) {
            const j = i + rng.nextBelow(CAP - i);
            const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
            b.setEligible(perm[i], true);
        }
        p2cTrials(b, el, inf, CAP, live);
        if (_p2c[0] > limit || _p2c[1] >= 2 || _p2c[2] > 0) failed++;
    }
    return failed;
}

test('real kernel at the soak live range: clean never fails; ignore-50% fails nearly every cycle', () => {
    for (const live of [165, 200]) {
        assert.equal(failedCycles(live, 60, 0x51C0FFEE, false), 0, 'clean P2C failed at live ' + live);
        const f = failedCycles(live, 30, 0x51C0FFEE, true);
        assert.ok(f >= 27, 'ignore-50% caught in only ' + f + '/30 cycles at live ' + live);
    }
});
