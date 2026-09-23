/**
 * @zakkster/lite-pick -- endurance soak (post-1.0 #8 scaffold, opportunistic at M6).
 *
 *     node --expose-gc benchmark/Soak.mjs                 # bounded acceptance run
 *     SOAK_CYCLES=0 caffeinate -i node --expose-gc benchmark/Soak.mjs   # overnight burn-in
 *
 * This is the UNBOUNDED cousin of test/torture.mjs: a continuous mixed-chaos workload over a
 * realistic pool (heavy P2C pick streams + eligibility flap storms + whole-pool-down troughs
 * + in-flight load feedback), snapshotting RSS / GC / ops-sec and RUNNING the M4 invariant
 * checker (test/invariants.mjs:checkBase, REUSED) at every checkpoint to catch slow drift no
 * bounded gate can -- RSS creep, GC-pause degradation, a one-in-a-billion aggregate desync.
 *
 * THIS IS THE HARNESS the overnight `caffeinate -i` burn-in plugs into: set SOAK_CYCLES=0 to
 * run forever (Ctrl-C to stop); the default bounded run is the CI/acceptance lane. Per ROADMAP
 * post-1.0 #8 it grows a lane per strategy; M6 ships ONE P2C lane (per-strategy lanes future).
 *
 * The two proofs asserted every cycle:
 *   - tracker.size() returns to 0 after each cycle (no balancer outlived its scope), and
 *   - checkBase is green at every checkpoint (live exact, never a down pick, fail-closed IFF
 *     pickable mass is 0). Emits a JSONL time-series to benchmark/soak.jsonl.
 *
 * Requires --expose-gc (retention gc + GcProfiler pause sampling).
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { P2cBalancer, Prng, PICK_NONE } from '../Pick.js';
import { checkBase, recomputeLive } from '../test/invariants.mjs';

const JSONL = fileURLToPath(new URL('./soak.jsonl', import.meta.url));
const CAP = 256;
const CYCLES = Number(process.env.SOAK_CYCLES ?? 8);       // 0 = run forever (overnight)
const PICKS_PER_CYCLE = Number(process.env.SOAK_PICKS ?? 200000);
const CHECKPOINTS = 5;
const CHECK_EVERY = Math.max(1, (PICKS_PER_CYCLE / CHECKPOINTS) | 0);

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write('soak: FAIL -- run with --expose-gc: node --expose-gc benchmark/Soak.mjs\n');
        process.exit(1);
    }
    const { GcProfiler } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-pick-soak',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    const noop = () => {};
    const gc = new GcProfiler().start();
    writeFileSync(JSONL, ''); // fresh time-series

    let invariantFailures = 0;
    let sizeFailures = 0;
    let totalPicks = 0;
    const t0 = performance.now();

    // One cycle of chaos, in its own frame so the balancer is torn down before we gc.
    function runCycle(cycle) {
        const eligible = new Uint8Array(CAP).fill(1);
        const inflight = new Uint32Array(CAP);
        const p2c = new P2cBalancer(CAP, eligible, inflight, 0x51A17ED ^ cycle);
        tracker.track(p2c, noop, 'p2c-soak', { audit: true });
        const rng = new Prng(0xC0FFEE ^ cycle);

        let lastPick = PICK_NONE;
        let allDown = false;
        for (let step = 1; step <= PICKS_PER_CYCLE; step++) {
            // --- chaos: flap storms + whole-pool-down troughs + load feedback ----------
            const roll = rng.nextBelow(1000);
            if (roll < 5) {
                // whole-pool-down trough: fail closed, then recover next chaos tick.
                for (let i = 0; i < CAP; i++) p2c.setEligible(i, false);
                allDown = true;
            } else if (allDown && roll < 15) {
                for (let i = 0; i < CAP; i++) p2c.setEligible(i, true);
                allDown = false;
            } else if (roll < 60) {
                const i = rng.nextBelow(CAP);
                p2c.setEligible(i, (rng.nextBelow(2) === 0)); // single-node flap
                if (allDown) allDown = false;
            }

            lastPick = p2c.pick();
            if (lastPick !== PICK_NONE) {
                inflight[lastPick]++;
                if (rng.nextBelow(2) === 0 && inflight[lastPick] > 0) inflight[lastPick]--; // settle
            }
            totalPicks++;

            // --- checkpoint: invariants + JSONL snapshot -------------------------------
            if (step % CHECK_EVERY === 0) {
                const mass = recomputeLive(eligible, CAP); // P2C pickable mass = live count
                const reason = checkBase(p2c, eligible, CAP, lastPick, mass);
                const gs = gc.summary();
                const mem = process.memoryUsage();
                const rec = {
                    cycle,
                    checkpoint: (step / CHECK_EVERY) | 0,
                    tMs: +(performance.now() - t0).toFixed(1),
                    picks: totalPicks,
                    live: mass,
                    rssMB: +(mem.rss / 1048576).toFixed(1),
                    heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
                    gcMajor: gs.gc.major,
                    gcMinor: gs.gc.minor,
                    gcMaxPauseMs: +gs.gc.maxMs.toFixed(3),
                    trackerSize: tracker.size(),
                    invariant: reason === null ? 'ok' : reason,
                };
                appendFileSync(JSONL, JSON.stringify(rec) + '\n');
                if (reason !== null) {
                    invariantFailures++;
                    process.stderr.write('  soak invariant FAIL cycle ' + cycle +
                        ' step ' + step + ': ' + reason + '\n');
                }
            }
        }
    }

    let cycle = 0;
    const forever = CYCLES === 0;
    while (forever || cycle < CYCLES) {
        runCycle(cycle);

        // retention proof: the cycle's balancer must be collectable -- size() -> 0.
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 0));
        let live = tracker.size();
        for (let i = 0; i < 8 && live > 0; i++) {
            globalThis.gc();
            await new Promise((r) => setTimeout(r, 0));
            live = tracker.size();
        }
        if (live !== 0) {
            sizeFailures++;
            process.stderr.write('  soak retention FAIL cycle ' + cycle +
                ': tracker.size()=' + live + ' (expected 0)\n');
        }
        const findings = tracker.audit();
        process.stdout.write('soak cycle ' + cycle + ': picks=' + totalPicks +
            ' tracker.size()=' + live +
            ' invariants=' + (invariantFailures === 0 ? 'green' : invariantFailures + ' FAIL') +
            ' findings=' + findings.length + '\n');
        cycle++;
    }
    gc.stop();

    const ok = invariantFailures === 0 && sizeFailures === 0 && warns.length === 0;
    process.stdout.write('soak: ran ' + cycle + ' cycles, ' + totalPicks + ' picks, ' +
        'invariants ' + (invariantFailures === 0 ? 'green at all checkpoints' : invariantFailures + ' FAIL') +
        ', tracker.size()==0 ' + (sizeFailures === 0 ? 'after every cycle' : sizeFailures + ' FAIL') +
        ', time-series -> benchmark/soak.jsonl -> ' + (ok ? 'PASS' : 'FAIL') + '\n');
    if (!ok) { process.stderr.write('soak: FAIL\n'); process.exit(1); }
}

main().catch((e) => {
    process.stderr.write('soak: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
