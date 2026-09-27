/**
 * @zakkster/lite-pick/pool -- the fan-out demo (M5, the integration moat).
 *
 *     node demo/fanout.mjs
 *
 * The landing story end-to-end: a service fans requests out to a pool of downstream replicas
 * through lite-pick's least-connections selection + the Pool ergonomics. Some replicas are
 * flaky and one goes fully DOWN mid-run; the demo shows (1) load spread by exact least-conn in
 * a real dispatch/settle loop, (2) failover re-picking a DIFFERENT replica when one errors, and
 * (3) the eligibility bitmap taking a dead node out with zero dead picks. No network, no deps --
 * a mock transport so it runs anywhere; swap `callReplica` for a real fetch and it is identical.
 *
 * This is NOT the kernel's 0 B/op path (that is torture/PerfGate) -- it is the async request
 * layer. It demonstrates the wiring a caller (or the lite-query fetcher) actually writes.
 */

import { LeastConnBalancer, PICK_NONE } from '../Pick.js';
import { Pool, liteQueryFetcher } from '../Pool.js';

const N = 6;                                   // six downstream replicas
const replicas = Array.from({ length: N }, (_, i) => 'replica-' + i);

// Per-replica behaviour: a base latency and a failure rate. replica-3 is flaky; replica-5 dies.
const latency = [8, 12, 20, 15, 10, 25];
const failRate = [0.0, 0.0, 0.0, 0.35, 0.0, 0.0]; // replica-3 fails ~35% of calls

let s = 0x1234abcd >>> 0;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The mock transport: resolves after the replica's latency, or rejects if it "fails".
async function callReplica(i, signal) {
    await sleep(latency[i] * (0.5 + rnd()));
    if (signal && signal.aborted) throw new Error('aborted');
    if (rnd() < failRate[i]) throw new Error(replicas[i] + ' 503');
    return { from: replicas[i], ok: true };
}

// The substrate: a shared eligibility bitmap (a health source writes it) + caller-owned inflight.
const eligible = new Uint8Array(N).fill(1);
const inflight = new Uint32Array(N);
const balancer = new LeastConnBalancer(N, eligible, inflight);
const pool = new Pool(balancer, inflight);

// Bookkeeping for the report.
const served = new Uint32Array(N);
const failovers = { count: 0 };
let deadPicks = 0, none = 0, exhausted = 0;

// A lite-query-shaped fetcher: this IS the request path (not just a typeof check). Each request
// passes its own `seen` list through the query-cache `key` channel (arbitrary, forwarded to
// perEndpoint verbatim -- LeastConn is not keyed, so this is not a routing key); perEndpoint records
// the endpoint the pool dispatched to, so we can observe distinct failover targets and dead picks.
const fetcher = liteQueryFetcher(pool, ({ endpoint, key, signal }) => {
    key.seen.push(endpoint);
    if (!eligible[endpoint]) deadPicks++;                // the invariant: pick() never returns a down index
    return callReplica(endpoint, signal);
}, { tries: 3 });

// Count DISTINCT endpoints in a request's dispatch trail: a failover only "re-picked a different
// replica" when the trail holds more than one distinct index (a 3>3>3 repeat is NOT a failover).
function distinctCount(trail) {
    let d = 0;
    for (let a = 0; a < trail.length; a++) {
        let dup = false;
        for (let b = 0; b < a; b++) if (trail[b] === trail[a]) { dup = true; break; }
        if (!dup) d++;
    }
    return d;
}

async function oneRequest() {
    const seen = [];
    try {
        const res = await fetcher({ key: { seen } });
        served[replicas.indexOf(res.from)]++;
        if (distinctCount(seen) > 1) failovers.count++;  // tried a genuinely DIFFERENT replica
    } catch (e) {
        if (e && e.code === 'LITE_PICK_NONE') none++;    // no eligible endpoint remained
        else exhausted++;                                // exhausted all tries -> reported, never dropped
    }
}

async function main() {
    process.stdout.write('lite-pick fan-out demo -- least-connections + Pool failover\n');
    process.stdout.write('  ' + N + ' replicas, replica-3 flaky (~35% 503), replica-5 fails at t=250ms\n\n');

    // Kill replica-5 partway through (a health probe / breaker would flip this bit).
    setTimeout(() => { balancer.setEligible(5, false); process.stdout.write('  [health] replica-5 marked DOWN\n'); }, 250);

    // Bounded concurrency: CONC workers each pull the next request id until the run is drained.
    const REQUESTS = 4000, CONC = 64;
    let next = 0;
    async function worker() { while (next < REQUESTS) { next++; await oneRequest(); } }
    await Promise.all(Array.from({ length: CONC }, worker));

    // Verify the sanity invariant: every in-flight counter drained back to zero.
    let leaked = 0; for (let i = 0; i < N; i++) leaked += inflight[i];

    process.stdout.write('\n  distribution (requests served per replica):\n');
    let total = 0; for (let i = 0; i < N; i++) total += served[i];
    for (let i = 0; i < N; i++) {
        const pct = total ? (served[i] / total * 100) : 0;
        const bar = '#'.repeat(Math.round(pct / 2));
        process.stdout.write('    ' + replicas[i].padEnd(10) +
            (eligible[i] ? ' up  ' : ' DOWN') + ' ' +
            String(served[i]).padStart(5) + '  ' + bar + ' ' + pct.toFixed(1) + '%\n');
    }
    process.stdout.write('\n  failovers (a request that re-picked a DIFFERENT replica): ' + failovers.count + '\n');
    process.stdout.write('  exhausted (used all tries and still failed): ' + exhausted + '\n');
    process.stdout.write('  no-eligible-endpoint (LITE_PICK_NONE): ' + none + '\n');
    process.stdout.write('  dead picks (served by a down replica): ' + deadPicks + '  <- must be 0\n');
    process.stdout.write('  in-flight leaked after drain: ' + leaked + '  <- must be 0\n');
    process.stdout.write('  request path: the lite-query fetcher drop-in (' + (typeof fetcher === 'function') + ')\n');

    if (deadPicks !== 0 || leaked !== 0) { process.stderr.write('\ndemo: FAIL\n'); process.exit(1); }
    process.stdout.write('\ndemo: OK -- least-conn spread the load, failover routed around flaky/down replicas, 0 dead picks, 0 leaked in-flight.\n');
    void PICK_NONE;
}

main().catch((e) => { process.stderr.write('demo: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
