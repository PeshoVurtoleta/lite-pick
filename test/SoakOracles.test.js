/**
 * @zakkster/lite-pick -- the soak's S14 oracles judge what they claim, on the real kernel (audit 2026-09-29 S14;
 * research/s14-hash-and-tie-oracles.md).
 *
 *     node --test test/SoakOracles.test.js
 *
 * 1. LeastConn/NQ accept ANY member of the argmin set (tie order is unspecified) and still reject a non-argmin.
 * 2. ConsistentHash: the clean kernel passes stickiness and the stated properties; MODULO-N hashing (slot
 *    depends on the live count) and a rebuild that reshuffles (permutation depends on the weights) are caught
 *    by the properties ALONE.
 * 3. BoundedLoad: the clean kernel passes the reference walk and the cap properties.
 * 4. WeightedRandom: the clean kernel passes the per-category pass; a pick-level +10% bias on every 16th node
 *    (the alias table untouched) is caught.
 * 5. Drift guard: the thresholds in oracles.mjs match the committed evidence (benchmark/soak/s14-calibration.json).
 * Zero-dep (Node 18 no-install job); seeded, deterministic, ~1 s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    Prng, LeastConnBalancer, NqBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
} from '../Pick.js';
import { evaluateOracle, CH_REBUILD_MOVED_MAX, WR_Z_CRIT, WR_DRAWS } from '../benchmark/soak/oracles.mjs';
import { KEYS, KEY_COUNT, M_CH } from '../benchmark/soak/lanes.mjs';

const CAP = 256;
const CAL = JSON.parse(readFileSync(new URL('../benchmark/soak/s14-calibration.json', import.meta.url), 'utf8'));

function randomEligibility(b, rng) { for (let i = 0; i < CAP; i++) b.setEligible(i, rng.nextBelow(4) !== 0); }

test('argmin oracle: any tied member passes; a non-argmin fails', () => {
    const el = new Uint8Array(64).fill(1), inf = new Uint32Array(64), wt = new Uint32Array(64).fill(1);
    class TieHigh extends LeastConnBalancer {   // a legal tie-break: the HIGHEST index among the least loaded
        pick() { let best = -1; for (let i = 0; i < 64; i++) if (el[i] && (best < 0 || inf[i] <= inf[best])) best = i; return best; }
    }
    class Worst extends LeastConnBalancer {
        pick() { let best = -1; for (let i = 0; i < 64; i++) if (el[i] && (best < 0 || inf[i] > inf[best])) best = i; return best; }
    }
    assert.equal(evaluateOracle('LeastConn', new TieHigh(64, el, inf), el, inf, wt, null, 0, 64, new Prng(1)).viol, 0);
    inf.fill(0);
    assert.ok(evaluateOracle('LeastConn', new Worst(64, el, inf), el, inf, wt, null, 0, 64, new Prng(1)).viol > 0);
    inf.fill(0);
    class LastIdle extends NqBalancer {          // NQ: ANY idle positive-weight node is in the set
        pick() { for (let i = 63; i >= 0; i--) if (el[i] && wt[i] > 0 && inf[i] === 0) return i; return super.pick(); }
    }
    assert.equal(evaluateOracle('NQ', new LastIdle(64, el, inf, wt), el, inf, wt, null, 0, 64, new Prng(2)).viol, 0);
});

function chPool(Cls) {
    const el = new Uint8Array(CAP).fill(1), wt = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) wt[i] = 1 + (i & 7);
    return { b: new Cls(CAP, el, wt, M_CH, 0x9e3779b9), el, wt };
}
function chRun(Cls, events, seed) {
    const { b, el, wt } = chPool(Cls), rng = new Prng(seed);
    let viol = 0, propViol = 0, propChecks = 0;
    for (let e = 0; e < events; e++) {
        randomEligibility(b, rng);
        const r = evaluateOracle('ConsistentHash', b, el, null, wt, KEYS, KEY_COUNT, CAP, rng);
        viol += r.viol; propViol += r.propViol; propChecks += r.propChecks;
    }
    return { viol, propViol, propChecks };
}

test('ConsistentHash: clean passes; modulo-N hashing and a reshuffling rebuild are caught by the properties alone', () => {
    const clean = chRun(ConsistentHashBalancer, 20, 0xC1);
    assert.equal(clean.viol, 0);
    assert.equal(clean.propViol, 0);
    assert.ok(clean.propChecks > 0);
    class ModuloN extends ConsistentHashBalancer {   // the slot depends on the live count
        pick(k) { return super.pick(((k >>> 0) + this._live) >>> 0); }
    }
    const m = chRun(ModuloN, 5, 0xC2);
    assert.equal(m.viol, 0, 'the stickiness re-walk does not see modulo-N hashing');
    assert.ok(m.propViol > 0, 'down-marking minimality must');
    class Reshuffle extends ConsistentHashBalancer { // the permutation depends on the weights
        _build() { let t = 0; for (let i = 0; i < CAP; i++) t += this._weights[i]; this._seed = (0x9e3779b9 + t) >>> 0; super._build(); }
    }
    const r = chRun(Reshuffle, 5, 0xC3);
    assert.equal(r.viol, 0, 'the stickiness re-walk does not see a reshuffling rebuild');
    assert.ok(r.propViol > 0, 'the rebuild bound must');
});

test('BoundedLoad: the clean kernel passes the reference walk and the cap properties', () => {
    const el = new Uint8Array(CAP).fill(1), wt = new Uint32Array(CAP), inf = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) wt[i] = 1 + (i & 7);
    const b = new BoundedLoadBalancer(CAP, el, inf, 0.25, wt, M_CH, 0x9e3779b9);
    const rng = new Prng(0xB1);
    randomEligibility(b, rng);
    const r = evaluateOracle('BoundedLoad', b, el, inf, wt, KEYS, KEY_COUNT, CAP, rng);
    assert.equal(r.viol, 0);
    assert.equal(r.propViol, 0);
    assert.equal(r.propChecks, KEY_COUNT);
});

test('WeightedRandom: clean passes the per-category pass; a pick-level +10% bias is caught', () => {
    const el = new Uint8Array(CAP).fill(1), wt = new Uint32Array(CAP);
    const rng = new Prng(0xA1);
    for (let i = 0; i < CAP; i++) wt[i] = 1 + rng.nextBelow(8);
    const b = new WeightedRandomBalancer(CAP, el, wt, 0x2545F491);
    randomEligibility(b, rng);
    const clean = evaluateOracle('WeightedRandom', b, el, null, wt, null, 0, CAP, rng);
    assert.equal(clean.insufficient, false);
    assert.equal(clean.viol, 0);
    class Biased extends WeightedRandomBalancer {    // every 16th node +10%: the others are redrawn 1 time in 11
        pick() { for (;;) { const p = super.pick(); if (p < 0 || (p & 15) === 0 || this._rng.nextBelow(11) !== 0) return p; } }
    }
    const bb = new Biased(CAP, el, wt, 0x2545F491);
    assert.ok(evaluateOracle('WeightedRandom', bb, el, null, wt, null, 0, CAP, rng).viol > 0);
});

test('S14 thresholds == the committed calibration evidence', () => {
    const ch = CAL.consistentHash, wr = CAL.weightedRandom;
    assert.equal(ch.m, M_CH);
    assert.ok(ch.events >= 20000);
    assert.equal(ch.oracleViol, 0);
    assert.equal(ch.propViolAtCurrentBound, 0);
    assert.equal(ch.currentBound, CH_REBUILD_MOVED_MAX);
    assert.ok(ch.movedShare.max < CH_REBUILD_MOVED_MAX);
    assert.equal(wr.draws, WR_DRAWS);
    assert.equal(wr.zCrit, WR_Z_CRIT);
    assert.ok(wr.cycles >= 2000);
    assert.equal(wr.violations, 0);
    assert.ok(wr.maxAbsZ.max < WR_Z_CRIT);
    assert.ok(CAL.wrPower.every16th.share >= 0.99, 'the M7b-shaped +10% must be caught nearly every cycle');
});
