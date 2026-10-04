/**
 * @zakkster/lite-pick soak -- calibrate the S14 oracle thresholds on the real kernel (audit 2026-09-29 S14;
 * research/s14-hash-and-tie-oracles.md, decided 2026-10-04).
 *
 *     node benchmark/soak/_calibrate-s14.mjs [--ch 20000] [--wr 2000] [--power 300] [--seed 0x514]
 *          [--out benchmark/soak/s14-calibration.json]
 *
 * Every number goes through the SAME evaluateOracle() the soak calls, at the soak's shape (cap 256, the
 * soak's 4096 keys, M = M_CH), reading the oracle's own raw statistic (_oracleStat):
 *   - ConsistentHash (--ch events): weights 1 + (i & 7) (the freeze restore), a fresh eligibility density
 *     in [0.5, 1] per event. Records the rebuild's moved share of OTHER keys and every oracle/property
 *     violation (down-marking and restore must read exactly 0 on a correct kernel).
 *   - WeightedRandom (--wr clean cycles): random weights 1..8 and density in [0.5, 1] per cycle (the freeze's
 *     settle-dense shape). Records the per-category max |z|.
 *   - WeightedRandom power (--power cycles per mutant): the kernel is fed weights x10 with the perturbed
 *     node(s) x11 -- an exact +10% -- while the oracle judges the true weights: every 16th node (the M7b
 *     teeth), and one weight-1 node / one weight-8 node.
 * Tooling, not a test; deterministic for a given seed.
 */

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ConsistentHashBalancer, WeightedRandomBalancer, Prng } from '../../Pick.js';
import { evaluateOracle, _oracleStat, CH_REBUILD_MOVED_MAX, WR_Z_CRIT, WR_DRAWS } from './oracles.mjs';
import { KEYS, KEY_COUNT, M_CH } from './lanes.mjs';

const CAP = 256;
const a = process.argv.slice(2), o = { ch: 20000, wr: 2000, power: 300, seed: 0x514, out: null };
for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '');
    if (!(k in o)) { process.stderr.write('unknown option --' + k + '\n'); process.exit(2); }
    o[k] = k === 'out' ? a[i + 1] : Number(a[i + 1]);
}
const rng = new Prng(o.seed >>> 0);
const t0 = Date.now();
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

function density(b) {   // a fresh eligibility pattern via setEligible, density uniform in [0.5, 1]
    const d = 512 + rng.nextBelow(513);   // /1024
    for (let i = 0; i < CAP; i++) b.setEligible(i, rng.nextBelow(1024) < d);
}

// ---- ConsistentHash rebuild disruption ------------------------------------------------------------------
const chEl = new Uint8Array(CAP), chW = new Uint32Array(CAP);
for (let i = 0; i < CAP; i++) chW[i] = 1 + (i & 7);
const ch = new ConsistentHashBalancer(CAP, chEl.fill(1), chW, M_CH, 0x9e3779b9);
const moved = [];
let chOracleViol = 0, chPropViol = 0, chSkipped = 0;
for (let e = 0; e < o.ch; e++) {
    density(ch);
    const r = evaluateOracle('ConsistentHash', ch, chEl, null, chW, KEYS, KEY_COUNT, CAP, rng);
    chOracleViol += r.viol;
    if (_oracleStat[0] < 0) { chSkipped++; continue; }
    moved.push(_oracleStat[0]);
    chPropViol += r.propViol;
}
moved.sort((x, y) => x - y);
const chOut = { events: o.ch, skipped: chSkipped, m: M_CH, oracleViol: chOracleViol, propViolAtCurrentBound: chPropViol,
    currentBound: CH_REBUILD_MOVED_MAX, movedShare: { p50: q(moved, 0.5), p99: q(moved, 0.99), p999: q(moved, 0.999), max: moved[moved.length - 1] } };
process.stderr.write('CH ' + JSON.stringify(chOut) + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)\n');

// ---- WeightedRandom: clean max |z| and mutant power -------------------------------------------------------
const wrEl = new Uint8Array(CAP), wrW = new Uint32Array(CAP), kW = new Uint32Array(CAP);
const wr = new WeightedRandomBalancer(CAP, wrEl.fill(1), kW.fill(1), 0x2545F491);
function wrCycle(perturb) {   // perturb: 0 clean, 1 every 16th node, 2 one weight-1 node, 3 one weight-8 node
    density(wr);
    for (let i = 0; i < CAP; i++) { wrW[i] = 1 + rng.nextBelow(8); kW[i] = wrW[i] * 10; }
    let target = -1;
    if (perturb === 1) { for (let i = 0; i < CAP; i += 16) kW[i] = wrW[i] * 11; }
    else if (perturb >= 2) {
        const want = perturb === 2 ? 1 : 8;
        for (let s = rng.nextBelow(CAP), k = 0; k < CAP; k++) { const i = (s + k) % CAP; if (wrEl[i]) { target = i; break; } }
        wrW[target] = want; kW[target] = want * 11;
    }
    wr.rebuild();
    const r = evaluateOracle('WeightedRandom', wr, wrEl, null, wrW, KEYS, KEY_COUNT, CAP, rng);
    return r;
}
const zs = [];
let wrViol = 0, wrSkipped = 0;
for (let c = 0; c < o.wr; c++) {
    const r = wrCycle(0);
    if (r.insufficient) { wrSkipped++; continue; }
    wrViol += r.viol;
    zs.push(_oracleStat[1]);
}
zs.sort((x, y) => x - y);
const wrOut = { cycles: o.wr, skipped: wrSkipped, draws: WR_DRAWS, zCrit: WR_Z_CRIT, violations: wrViol,
    maxAbsZ: { p50: q(zs, 0.5), p99: q(zs, 0.99), max: zs[zs.length - 1] } };
process.stderr.write('WR clean ' + JSON.stringify(wrOut) + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)\n');
const power = {};
for (const [name, mode] of [['every16th', 1], ['oneWeight1', 2], ['oneWeight8', 3]]) {
    let caught = 0, ran = 0;
    for (let c = 0; c < o.power; c++) { const r = wrCycle(mode); if (r.insufficient) continue; ran++; if (r.viol > 0) caught++; }
    power[name] = { cycles: ran, caught, share: +(caught / ran).toFixed(4) };
    process.stderr.write('WR +10% ' + name + ' ' + JSON.stringify(power[name]) + '\n');
}
let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const out = { meta: { tool: 'benchmark/soak/_calibrate-s14.mjs', node: process.version, gitSha: sha, seed: o.seed,
    seconds: Math.round((Date.now() - t0) / 1000), date: new Date().toISOString() }, consistentHash: chOut, weightedRandom: wrOut, wrPower: power };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
if (o.out) writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n');
