/**
 * pickEcosystem/live -- the REAL-THREAD smoke run (P1 spec gates): the kernel over node:worker_threads on the
 * real clock for ~20 s, every fault once, then the orchestrator shutdown. Prints "ok" and exits 0, or names
 * the failed check and exits 1. Run by `npm run smoke` (and lite-pick's CI).
 *
 * Timeline (s), faults under P2C first: 2 kill w2 | 4 flaky w1 | 6 hang w4 | 9 crash w5 | 11 heal w1 |
 *   12 crash loop w6 | 15 reset w6 | 16 slow w3 + switch to PeakEWMA | 18 switch to BoundedLoad | 20 shutdown.
 * (Order matters: under PeakEWMA a failing worker is avoided by its failure penalty before its breaker can trip
 * and before a crash loop gets the jobs that make it crash -- the strategy doing its job, seen in an earlier run.)
 * Checks: exit code 0; every arrival accounted for (ok + failed + shed + drained === arrived); no failed
 * request; nothing in flight at exit; kill / hang / crash each restarted their worker; w1's breaker opened;
 * w6 escalated and came back after reset.
 */

import * as lp from '@zakkster/lite-pick';
import * as poolMod from '@zakkster/lite-pick/pool';
import * as wp from '@zakkster/lite-worker-pool';
import { bootKernel } from '../kernel.js';
import { nodeSetSpawn } from '../nodeworker.js';

const RATE = Number(process.env.SMOKE_RATE || 800);
const k = await bootKernel({ lp, poolMod, wp, spawn: nodeSetSpawn, now: () => performance.now(), timers: 'real', config: { rate: RATE } });
const t0 = performance.now();
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - performance.now())));
const log = (s) => process.stderr.write(s + '\n');
const checks = [];
const check = (ok, what) => { checks.push([ok, what]); log((ok ? '  ok   ' : '  FAIL ') + what); };

await at(2); k.fault(2, 'kill');
await at(4); k.fault(1, 'flaky');
await at(6); k.fault(4, 'hang');
await at(9); k.fault(5, 'crash');
await at(11); k.heal(1);
const breakerOpened = k.events[2] > 0;
await at(12); k.fault(6, 'crashloop');
await at(15);
const escalated6 = k.fleet.escalated[6] === 1;
await k.reset(6);
await at(16); k.fault(3, 'slow'); k.setStrategy('peakewma');
await at(18); k.setStrategy('boundedload');
await at(20);
const up6 = k.balancers.shared.up[6] === 1 && k.fleet.escalated[6] === 0;
const code = await k.shutdown({ deadlineMs: 10000 });
const s = k.stats.snapshot();

log('smoke: ' + s.arrived + ' arrivals at ' + RATE + ' req/s over real threads; ok ' + s.ok + ', failed ' + s.failed +
    ', failover ' + s.failover + ', restarts [' + Array.from(k.fleet.restarts).join(',') + ']');
check(code === 0, 'orchestrator exit code 0 (got ' + code + ')');
check(s.ok + s.failed + s.shed + s.drained === s.arrived, 'every arrival accounted for');
check(s.failed === 0, 'no failed request (failover covered kill, hang, crash, flaky)');
check(k.engine.pending() === 0, 'nothing in flight at exit');
check(k.fleet.restarts[2] >= 1, 'kill -> worker 2 restarted');
check(k.fleet.restarts[4] >= 1, 'hang -> worker 4 restarted');
check(k.fleet.restarts[5] >= 1, 'crash -> worker 5 restarted');
check(breakerOpened, 'flaky -> a breaker opened');
check(escalated6, 'crash loop -> worker 6 escalated');
check(up6, 'reset -> worker 6 back');

const bad = checks.filter((c) => !c[0]);
if (bad.length) { process.exitCode = 1; process.stderr.write('', () => process.exit(1)); }
else process.stdout.write('ok\n', () => process.exit(0));
