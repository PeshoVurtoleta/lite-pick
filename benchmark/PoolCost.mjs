/**
 * @zakkster/lite-pick -- Pool.run cost LADDER benchmark (`npm run bench:pool`).
 *
 *   node benchmark/PoolCost.mjs            # runs each lane in its own pinned child process
 *
 * Prints the full ladder (L0..PLANT, B/run by scavenge count under a 1 MiB young gen), then the three
 * derived numbers the docs quote:
 *   - Pool's own share   = L3 - L1   (its promise + frame + one await, above the driver floor)
 *   - excess over wrapper = L3 - L2  (Pool.run above a hand-written minimal async wrapper)
 *   - caller add          = L10 - L3 (a submit-shaped fn's own promise + a per-run opts object)
 *
 * Each lane is a child of test/perf/pool-cost-lanes.mjs run with --expose-gc and the semi-space pinned
 * to 1 MiB (min AND max). Run it on Node 26 and Node 22 to get both rows. SANITY: L0 must be 0, and
 * L3-L1 must land in [600, 2000] B/run -- outside that the attribution is wrong; the bench STOPS and
 * no doc/ceiling change is warranted.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANES = resolve(HERE, '../test/perf/pool-cost-lanes.mjs');
const N = process.env.POOL_COST_N ? parseInt(process.env.POOL_COST_N, 10) : 200000;
const FLAGS = ['--expose-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];

const LANE_IDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L6S', 'L7', 'L8a', 'L8b', 'L9', 'L10',
    'CTRL_OBJ', 'CTRL_OBJ6', 'PL_BOX', 'PL_BOX6', 'PL_BOX8b', 'PLANT', 'PROMOTE'];
const DESC = {
    L0: 'bare pick() + inflight ++/-- (sync floor)',
    L1: 'await RESOLVED (driver floor)',
    L2: 'minimal hand-written async wrapper',
    L3: 'Pool.run(SYNC_FN) P2C tries 1',
    L4: 'Pool.run(ASYNC_FN)',
    L5: 'Pool.run(() => RESOLVED)',
    L6: 'tries 2, attempt 0 throws (ACTUAL failover)',
    L6S: 'tries 2, attempt 0 SUCCEEDS (common path)',
    L7: 'abort before dispatch',
    L8a: 'PeakEWMA, small-int clock (== L3)',
    L8b: 'PeakEWMA, 1.7e15 epoch-ns clock (clocked row)',
    PL_BOX8b: 'L8b + one escaped boxed double (clocked teeth)',
    L9: 'L3 + both channels subscribed (== L3)',
    L10: 'submit-shaped fn + per-run { signal }',
    CTRL_OBJ: 'L3 + one escaped {a:i} (attempt0 teeth)',
    CTRL_OBJ6: 'L6 + one escaped {a:i} (failover teeth)',
    PL_BOX: 'L3 + one escaped boxed double (attempt0 teeth)',
    PL_BOX6: 'L6 + one escaped boxed double (failover teeth)',
    PLANT: 'L3 + one escaped [] + push (teeth)',
    PROMOTE: 'L3 + retained {a,b} (old-gen teeth)',
};

function runLane(id) {
    const r = spawnSync(process.execPath, [...FLAGS, LANES, id, String(N)], { encoding: 'utf8' });
    if (r.status !== 0) {
        process.stderr.write('lane ' + id + ' failed:\n' + (r.stderr || '') + '\n');
        process.exit(1);
    }
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

const node = process.versions.node;
process.stdout.write('Pool.run cost ladder -- Node ' + node + ', N=' + N +
    ', young gen pinned to 1 MiB (min=max=1), B/run by scavenge count\n');
process.stdout.write('  lane   B/run      sN    s8N   oldN  old8N  what\n');

const by = {};
for (const id of LANE_IDS) {
    const d = runLane(id);
    by[id] = d;
    const b = d.bytesPerRun.toFixed(1).padStart(8);
    process.stdout.write('  ' + id.padEnd(6) + b + '  ' +
        String(d.sN).padStart(5) + '  ' + String(d.s8N).padStart(5) + '  ' +
        String(d.oldN).padStart(4) + '  ' + String(d.old8N).padStart(5) + '  ' + DESC[id] + '\n');
}

const attempt0 = by.L3.bytesPerRun - by.L1.bytesPerRun;
const failover = by.L6.bytesPerRun - by.L1.bytesPerRun;
const perExtraAttempt = by.L6.bytesPerRun - by.L3.bytesPerRun;
const excess = by.L3.bytesPerRun - by.L2.bytesPerRun;
const callerAdd = by.L10.bytesPerRun - by.L3.bytesPerRun;

process.stdout.write('\n');
process.stdout.write("  attempt-0 share     L3 - L1  = " + attempt0.toFixed(1) + ' B/run (CEIL = this + 8)\n');
process.stdout.write('  failover share      L6 - L1  = ' + failover.toFixed(1) + ' B/run (CEIL = this + 8)\n');
process.stdout.write('  clocked share       L8b - L1 = ' + (by.L8b.bytesPerRun - by.L1.bytesPerRun).toFixed(1) + ' B/run (CEIL = this + 8)\n');
process.stdout.write('  per extra attempt   L6 - L3  = ' + perExtraAttempt.toFixed(1) + ' B/run\n');
process.stdout.write('  clock per attempt   L8b - L8a = ' + (by.L8b.bytesPerRun - by.L8a.bytesPerRun).toFixed(1) + ' B/run (epoch-ns clock boxes)\n');
process.stdout.write('  excess over wrapper L3 - L2  = ' + excess.toFixed(1) + ' B/run\n');
process.stdout.write('  caller add          L10 - L3 = ' + callerAdd.toFixed(1) + ' B/run\n');
process.stdout.write('  abort (UNGATED)     L7 - L1  = ' + (by.L7.bytesPerRun - by.L1.bytesPerRun).toFixed(1) + ' B/run (above a successful run -- not cheap)\n');
process.stdout.write('  teeth attempt0      CTRL_OBJ - L1 = ' + (by.CTRL_OBJ.bytesPerRun - by.L1.bytesPerRun).toFixed(1) +
    ' , PLANT - L1 = ' + (by.PLANT.bytesPerRun - by.L1.bytesPerRun).toFixed(1) + ' B/run (must exceed attempt0 CEIL)\n');
process.stdout.write('  teeth failover      CTRL_OBJ6 - L1 = ' + (by.CTRL_OBJ6.bytesPerRun - by.L1.bytesPerRun).toFixed(1) +
    ' , PL_BOX6 - L1 = ' + (by.PL_BOX6.bytesPerRun - by.L1.bytesPerRun).toFixed(1) + ' B/run (must exceed failover CEIL)\n');
process.stdout.write('  teeth clocked       PL_BOX8b - L1 = ' + (by.PL_BOX8b.bytesPerRun - by.L1.bytesPerRun).toFixed(1) +
    ' B/run (must exceed clocked CEIL)\n');
process.stdout.write('  old-gen teeth       PROMOTE old N:' + by.PROMOTE.oldN + ' 8N:' + by.PROMOTE.old8N +
    ' (must be > 0)\n');

let bad = false;
if (by.L0.bytesPerRun !== 0) {
    process.stderr.write('\nSTOP: L0 must be 0 B/run (got ' + by.L0.bytesPerRun + ') -- the floor allocates, the harness is wrong.\n');
    bad = true;
}
if (!(attempt0 >= 600 && attempt0 <= 2000)) {
    process.stderr.write("\nSTOP: Pool's own attempt-0 share L3-L1 = " + attempt0.toFixed(1) +
        ' B/run is outside [600, 2000] -- the attribution is wrong; do NOT change docs or ceilings.\n');
    bad = true;
}
process.exit(bad ? 1 : 0);
