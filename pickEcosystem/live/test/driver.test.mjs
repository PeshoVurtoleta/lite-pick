/**
 * pickEcosystem/live -- the LiveDriver feeds Pool Scope's REAL snapshot (demo/pool-scope/snapshot.mjs) from the
 * running system: P2/P3 then only add renderers.
 *
 *   D1 after 2 s of the default scene a frame shows 8 live workers, throughput ~ the arrival rate, a finite
 *      p50, shares summing to 1.
 *   D2 a 10x-slow worker under PeakEWMA shows a share well under the fair 1/8.
 *   D3 per-worker time ON the worker (its queue + the job; the web renderer's worker table): a 10x-slow worker's
 *      p95 reads several times a normal worker's; NaN while a worker has served nothing in the last full second
 *      (never a fake 0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LitePickSnapshot } from '../../../demo/pool-scope/snapshot.mjs';
import { LiveDriver } from '../driver.js';
import { bootVirtual } from './harness.mjs';

async function frames(k, run, count, ms) {
    const d = new LiveDriver(k);
    const snap = new LitePickSnapshot(k.cfg.workers);
    for (let f = 0; f < count; f++) {
        await run(ms);
        d.beginFrame(ms / 1000);
        snap.build(d);
    }
    return snap;
}

test('D1 a live frame: 8 workers, throughput ~ arrivals, finite latency, shares sum to 1', async () => {
    const { kernel: k, run } = await bootVirtual();
    await run(1500);
    const snap = await frames(k, run, 12, 84);
    assert.equal(snap.live, 8);
    assert.ok(snap.curThroughput > 1600 && snap.curThroughput < 2400, 'throughput ' + snap.curThroughput);
    assert.ok(snap.p50 > 0 && snap.p50 < 10, 'p50 ' + snap.p50);
    let s = 0;
    for (let i = 0; i < 8; i++) s += snap.wShare[i];
    assert.ok(Math.abs(s - 1) < 1e-9, 'share sum ' + s);
});

test('D2 PeakEWMA starves a 10x-slow worker of share, visibly', async () => {
    const { kernel: k, run } = await bootVirtual({ strategy: 'peakewma' });
    await run(1000);
    k.fault(3, 'slow');
    await run(2000);
    const snap = await frames(k, run, 12, 84);
    assert.ok(snap.wShare[3] < 0.125 / 2, 'slow worker share ' + snap.wShare[3]);
    assert.ok(snap.wEwma[3] > snap.wEwma[0], 'its EWMA cost is the highest');
});

test('D3 per-worker time on the worker: the slow worker reads several times higher, an idle one reads NaN', async () => {
    const { kernel: k, run } = await bootVirtual({ strategy: 'roundrobin' });
    const d = new LiveDriver(k);
    assert.ok(Number.isNaN(d.latWorkerQuantile(0, 0.95)), 'no full second yet: NaN');
    k.fault(3, 'slow');
    await run(2500);
    const slow = d.latWorkerQuantile(3, 0.95), fast = d.latWorkerQuantile(0, 0.95);
    // 1 ms jobs arriving in 10 ms traffic bursts: a job can wait behind two or three others on its worker.
    assert.ok(fast >= 1 && fast < 6, 'w0 p95 ' + fast + ' ms');
    assert.ok(slow > 4 * fast, 'w3 p95 ' + slow + ' ms vs w0 ' + fast);
});
