/**
 * @zakkster/lite-pick -- consistent-hash disruption (M6 dimension 7, a trust gate).
 *
 *     node benchmark/Disruption.mjs
 *
 * THE consistent-hash quality metric and the cache-affinity selling point (RESEARCH dim 7):
 * on a scale event (add / remove a node), what FRACTION of keys keep their node? A good
 * consistent-hash reshuffles ~1/n of keys; the classic trap -- NAIVE MODULO hashing
 * (`key % n`) -- reshuffles almost EVERYTHING, blowing every downstream cache.
 *
 * At M6 the real ConsistentHash (Maglev table) has not shipped -- it lands at M8 (ROADMAP).
 * So this file ships the HONEST pair the plan ratified:
 *   - the naive-modulo FOIL measured now (the trap, quantified), and
 *   - an explicit SKIP row for ConsistentHash, disclosed as "lands at M8", NOT a stub.
 * When M8 lands, ConsistentHash joins as a measured row and the SKIP is removed.
 *
 * Keys are a fixed seeded set, so the remap fraction is EXACT and drift-checked.
 */

import { Prng } from '../Pick.js';
import { SEEDS } from './Matrix.mjs';

const KEYS = 100000;

/** Fraction of keys whose node changes when the pool goes from `n` to `m` under `key % size`. */
function naiveModuloRemap(keys, n, m) {
    let moved = 0;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] % n !== keys[i] % m) moved++;
    }
    return moved / keys.length;
}

/** Measure the naive-modulo trap on add + remove events; returns structured result. */
export function measureDisruption() {
    const rng = new Prng(SEEDS.disruption);
    const keys = new Uint32Array(KEYS);
    for (let i = 0; i < KEYS; i++) keys[i] = rng.next(); // seeded key hashes

    const n = 64;
    const events = [
        { event: 'remove-node (64->63)', from: n, to: n - 1 },
        { event: 'add-node (64->65)', from: n, to: n + 1 },
    ];
    const naiveModulo = events.map((e) => ({
        event: e.event,
        remapPct: naiveModuloRemap(keys, e.from, e.to) * 100,
        idealPct: (1 / Math.max(e.from, e.to)) * 100, // a good consistent hash's target
    }));

    return {
        keys: KEYS,
        seed: SEEDS.disruption,
        naiveModulo,
        consistentHash: { status: 'SKIP', reason: 'ConsistentHash (Maglev) lands at M8' },
    };
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const r = measureDisruption();
    process.stdout.write('lite-pick disruption (M6 dimension 7) -- ' + r.keys +
        ' keys, seed 0x' + r.seed.toString(16) + '\n');
    for (let i = 0; i < r.naiveModulo.length; i++) {
        const m = r.naiveModulo[i];
        process.stdout.write('  naive-modulo  ' + m.event.padEnd(22) +
            '  remaps ' + m.remapPct.toFixed(1) + '% of keys' +
            '  (a good consistent hash: ~' + m.idealPct.toFixed(1) + '%)\n');
    }
    process.stdout.write('  ConsistentHash  ' + r.consistentHash.status +
        ' -- ' + r.consistentHash.reason + '\n');

    // The trap is real iff naive modulo reshuffles the overwhelming majority (>50%).
    const trapShown = r.naiveModulo.every((m) => m.remapPct > 50);
    process.stdout.write('  naive-modulo trap quantified (>50% remap on a scale event) -> ' +
        (trapShown ? 'PASS' : 'FAIL') + '\n');
    if (!trapShown) { process.stderr.write('bench:disruption: FAIL\n'); process.exit(1); }
    process.stdout.write('bench:disruption: PASS\n');
}
