/**
 * @zakkster/lite-pick -- consistent-hash disruption (M6 dimension 7, a trust gate; measured at M8).
 *
 *     node benchmark/Disruption.mjs
 *
 * THE consistent-hash quality metric and the cache-affinity selling point (RESEARCH dim 7):
 * on a scale event (add / remove a node), what FRACTION of keys keep their node? A good
 * consistent-hash reshuffles ~1/n of keys; the classic trap -- NAIVE MODULO hashing
 * (`key % n`) -- reshuffles almost EVERYTHING, blowing every downstream cache.
 *
 * M8 ships the real `ConsistentHashBalancer` (Maglev table), so this file now measures the
 * HONEST pair:
 *   - the naive-modulo FOIL (the trap, quantified), and
 *   - the real Maglev table (removing a backend = mark it down; adding = bring one up), which
 *     remaps only ~1/n of keys.
 * The M6 explicit SKIP row is REPLACED by this measured row.
 *
 * Keys are a fixed seeded set, and the Maglev build is deterministic (seeded), so BOTH remap
 * fractions are EXACT and drift-checked by bench:verify.
 */

import { Prng, ConsistentHashBalancer } from '../Pick.js';
import { SEEDS } from './Matrix.mjs';

const KEYS = 100000;
const CH_M = 65537; // the default Maglev table size (prime): smooth, ~1/n disruption

/** Fraction of keys whose node changes when the pool goes from `n` to `m` under `key % size`. */
function naiveModuloRemap(keys, n, m) {
    let moved = 0;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] % n !== keys[i] % m) moved++;
    }
    return moved / keys.length;
}

/**
 * Fraction of keys whose Maglev backend changes on a scale event, modeled via ELIGIBILITY (the
 * runtime path -- the table is untouched, so only the affected backend's keys move):
 *   - 'remove': an n-backend table, all up; take one down -> its ~1/n keys reroute.
 *   - 'add':    an (n+1)-backend table with the extra backend initially DOWN (so it routes over n);
 *               bring it up -> ~1/(n+1) keys move onto it.
 */
function maglevRemap(keys, n, kind) {
    if (kind === 'remove') {
        const el = new Uint8Array(n).fill(1);
        const ch = new ConsistentHashBalancer(n, el, null, CH_M, SEEDS.disruption);
        const before = new Int32Array(keys.length);
        for (let i = 0; i < keys.length; i++) before[i] = ch.pick(keys[i]);
        ch.setEligible(n - 1, false); // remove one backend (no rebuild)
        let moved = 0;
        for (let i = 0; i < keys.length; i++) if (ch.pick(keys[i]) !== before[i]) moved++;
        return moved / keys.length;
    }
    // add: an (n+1)-backend table with backend n initially down, then brought up.
    const el = new Uint8Array(n + 1).fill(1);
    el[n] = 0;
    const ch = new ConsistentHashBalancer(n + 1, el, null, CH_M, SEEDS.disruption);
    const before = new Int32Array(keys.length);
    for (let i = 0; i < keys.length; i++) before[i] = ch.pick(keys[i]);
    ch.setEligible(n, true); // add the new backend
    let moved = 0;
    for (let i = 0; i < keys.length; i++) if (ch.pick(keys[i]) !== before[i]) moved++;
    return moved / keys.length;
}

/** Measure the naive-modulo trap AND the real Maglev table on add + remove events. */
export function measureDisruption() {
    const rng = new Prng(SEEDS.disruption);
    const keys = new Uint32Array(KEYS);
    for (let i = 0; i < KEYS; i++) keys[i] = rng.next(); // seeded key hashes

    const n = 64;
    const events = [
        { event: 'remove-node (64->63)', kind: 'remove', from: n, to: n - 1 },
        { event: 'add-node (64->65)', kind: 'add', from: n, to: n + 1 },
    ];
    const naiveModulo = events.map((e) => ({
        event: e.event,
        remapPct: naiveModuloRemap(keys, e.from, e.to) * 100,
        idealPct: (1 / Math.max(e.from, e.to)) * 100, // a good consistent hash's target
    }));
    const consistentHash = events.map((e) => ({
        event: e.event,
        remapPct: maglevRemap(keys, n, e.kind) * 100,
    }));

    return { keys: KEYS, seed: SEEDS.disruption, naiveModulo, consistentHash };
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const r = measureDisruption();
    process.stdout.write('lite-pick disruption (M6 dimension 7, Maglev measured at M8) -- ' + r.keys +
        ' keys, seed 0x' + r.seed.toString(16) + '\n');
    for (let i = 0; i < r.naiveModulo.length; i++) {
        const m = r.naiveModulo[i], c = r.consistentHash[i];
        process.stdout.write('  ' + m.event.padEnd(22) +
            '  naive-modulo ' + m.remapPct.toFixed(1) + '%' +
            '  ConsistentHash (Maglev) ' + c.remapPct.toFixed(2) + '%' +
            '  (ideal ~' + m.idealPct.toFixed(1) + '%)\n');
    }

    // The trap is real iff naive modulo reshuffles the overwhelming majority (>50%) AND the
    // Maglev table stays near the ideal (<= 2x the 1/n target).
    const trapShown = r.naiveModulo.every((m) => m.remapPct > 50);
    const maglevMinimal = r.consistentHash.every((c, i) => c.remapPct <= 2 * r.naiveModulo[i].idealPct);
    process.stdout.write('  naive-modulo trap quantified (>50% remap) -> ' + (trapShown ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  Maglev minimal disruption (<= 2x ideal) -> ' + (maglevMinimal ? 'PASS' : 'FAIL') + '\n');
    if (!trapShown || !maglevMinimal) { process.stderr.write('bench:disruption: FAIL\n'); process.exit(1); }
    process.stdout.write('bench:disruption: PASS\n');
}
