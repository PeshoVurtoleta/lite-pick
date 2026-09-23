/**
 * @zakkster/lite-pick -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak       -- RETENTION: does a balancer instance outlive its
 *                                  owner? tracker.size() -> 0 after churn is the proof.
 *                                  A balancer owns no external kernel (no timer, listener,
 *                                  or the shared eligibility view, which the CALLER owns),
 *                                  so being collected is the desired outcome.
 *   - @zakkster/lite-gc-profiler -- BUDGET: does the hot path allocate? 0 B/op on the
 *                                  substrate hot ops (Prng.next / nextBelow, isEligible)
 *                                  is the M0 gate. Strategy pick() paths join at M1+.
 *
 * M4: the profiled hot paths are the SUBSTRATE (PRNG draw + eligibility read) that every
 * strategy rides, AND RoundRobin.pick(), SmoothWRR.pick(), P2C.pick(), LeastConn.pick(),
 * SED.pick(), and NQ.pick(). Each later strategy appends its own reused-instance hot phase
 * here (ROADMAP section 3).
 *
 * ENTRY CONTRACT (mirrors lite-o1): --expose-gc is mandatory; the two devDeps are
 * imported AFTER the guard so a fresh clone that skipped `npm install` fails with a
 * remedy, not a stack trace.
 */

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try {
            await import(pkg);
        } catch {
            process.stderr.write(
                'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
            process.exit(2);
        }
    }

    const { measureAllocs } = await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const {
        Prng, BalancerBase, RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer,
        LeastConnBalancer, SedBalancer, NqBalancer,
    } = await import('../Pick.js');

    const CAP = 1 << 12;    // pool capacity 4096
    const CYCLES = 4096;    // retention churn

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-pick',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });

    // ---- phase 1: retention torture ---------------------------------------
    // A BalancerBase owns only its capacity + a reference to a CALLER-owned Uint8Array
    // (never copied, never retained beyond the caller). The cleanup closes over NOTHING,
    // so the tracker can finalize each instance. After churn + gc, tracker.size() must
    // be 0 -- no balancer outlived its scope. The churn lives in its own function so its
    // frame is fully torn down before we gc (conservative stack scanning otherwise pins
    // the last instance).
    const noop = () => {};
    function fillTracker() {
        const el = new Uint8Array(CAP).fill(1);
        const weights = new Uint32Array(CAP).fill(3);
        const inflight = new Uint32Array(CAP);
        for (let c = 0; c < CYCLES; c++) {
            const b = new BalancerBase(CAP, el);
            b.setEligible(c & (CAP - 1), (c & 1) === 0);
            b.isEligible(c & (CAP - 1));
            tracker.track(b, noop, 'balancerbase', { audit: true });
            const rr = new RoundRobinBalancer(CAP, el);
            rr.pick();
            tracker.track(rr, noop, 'roundrobin', { audit: true });
            const wrr = new SmoothWRRBalancer(CAP, el, weights);
            wrr.pick();
            tracker.track(wrr, noop, 'smoothwrr', { audit: true });
            const p2c = new P2cBalancer(CAP, el, inflight, c);
            p2c.pick();
            tracker.track(p2c, noop, 'p2c', { audit: true });
            const lc = new LeastConnBalancer(CAP, el, inflight);
            lc.pick();
            tracker.track(lc, noop, 'leastconn', { audit: true });
            const sed = new SedBalancer(CAP, el, inflight, weights);
            sed.pick();
            tracker.track(sed, noop, 'sed', { audit: true });
            const nq = new NqBalancer(CAP, el, inflight, weights);
            nq.pick();
            tracker.track(nq, noop, 'nq', { audit: true });
        }
        return tracker.size();
    }
    fillTracker();

    globalThis.gc();
    await new Promise((r) => setTimeout(r, 0));
    globalThis.gc();
    let live = tracker.size();
    for (let i = 0; i < 8 && live > 0; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 0));
        live = tracker.size();
    }
    const findings = tracker.audit();

    // ---- phase 2: per-call allocation on the substrate hot path (0 B/op) ---
    // One reused Prng + one reused BalancerBase. Steady state: one PRNG draw + one
    // bounded eligibility read. No object, closure, string, or array is created.
    const el = new Uint8Array(CAP);
    for (let i = 0; i < CAP; i += 2) el[i] = 1;          // half eligible
    const base = new BalancerBase(CAP, el);
    const rng = new Prng(0x1234abcd);
    let sink = 0;
    const step = () => {
        const i = rng.nextBelow(CAP);
        if (base.isEligible(i)) sink = (sink + i) | 0;
    };
    const allocRes = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = allocRes.bytesPerCall === null ? 0 : allocRes.bytesPerCall;
    const allocBytes = Math.max(0, Math.round(bpc));
    const allocOk = allocBytes === 0;

    // ---- phase 3: RoundRobin.pick() per-call allocation (0 B/op) -----------
    // One reused RoundRobinBalancer over a half-eligible pool: every pick() is a
    // compare-wrap loop + one cursor write, no object/closure/array created.
    const rr = new RoundRobinBalancer(CAP, el);
    let rrSink = 0;
    const rrStep = () => { rrSink = (rrSink + rr.pick()) | 0; };
    const rrAllocRes = measureAllocs(rrStep, { iterations: 100000, batches: 8 });
    const rrBpc = rrAllocRes.bytesPerCall === null ? 0 : rrAllocRes.bytesPerCall;
    const rrAllocBytes = Math.max(0, Math.round(rrBpc));
    const rrAllocOk = rrAllocBytes === 0;

    // ---- phase 4: SmoothWRR.pick() per-call allocation (0 B/op) ------------
    // One reused SmoothWRRBalancer: pick() is an O(cap) scan mutating the owned Float64
    // accumulators in place + one subtract; no object/closure/array created.
    const weights = new Uint32Array(CAP).fill(3);
    const wrr = new SmoothWRRBalancer(CAP, el, weights);
    let wrrSink = 0;
    const wrrStep = () => { wrrSink = (wrrSink + wrr.pick()) | 0; };
    const wrrAllocRes = measureAllocs(wrrStep, { iterations: 100000, batches: 8 });
    const wrrBpc = wrrAllocRes.bytesPerCall === null ? 0 : wrrAllocRes.bytesPerCall;
    const wrrAllocBytes = Math.max(0, Math.round(wrrBpc));
    const wrrAllocOk = wrrAllocBytes === 0;

    // ---- phase 5: P2C.pick() per-call allocation (0 B/op) ------------------
    // One reused P2cBalancer over a half-eligible pool + a caller-owned inflight array:
    // pick() is a few PRNG steps + array reads (rejection draws) + one compare -- no
    // object/closure/array created.
    const inflight = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
    const p2c = new P2cBalancer(CAP, el, inflight, 0xABCDEF);
    let p2cSink = 0;
    const p2cStep = () => { p2cSink = (p2cSink + p2c.pick()) | 0; };
    const p2cAllocRes = measureAllocs(p2cStep, { iterations: 100000, batches: 8 });
    const p2cBpc = p2cAllocRes.bytesPerCall === null ? 0 : p2cAllocRes.bytesPerCall;
    const p2cAllocBytes = Math.max(0, Math.round(p2cBpc));
    const p2cAllocOk = p2cAllocBytes === 0;

    // ---- phase 6: LeastConn.pick() per-call allocation (0 B/op) ------------
    // One reused LeastConnBalancer: pick() is an O(cap) integer-compare scan + one index
    // write over the caller-owned inflight view; no object/closure/array created.
    const lc = new LeastConnBalancer(CAP, el, inflight);
    let lcSink = 0;
    const lcStep = () => { lcSink = (lcSink + lc.pick()) | 0; };
    const lcAllocRes = measureAllocs(lcStep, { iterations: 100000, batches: 8 });
    const lcBpc = lcAllocRes.bytesPerCall === null ? 0 : lcAllocRes.bytesPerCall;
    const lcAllocBytes = Math.max(0, Math.round(lcBpc));
    const lcAllocOk = lcAllocBytes === 0;

    // ---- phase 7: SED.pick() per-call allocation (0 B/op) ------------------
    // One reused SedBalancer: pick() is an O(cap) scan + one Float64 division per eligible
    // node over caller-owned inflight + weights; no object/closure/array created.
    const sed = new SedBalancer(CAP, el, inflight, weights);
    let sedSink = 0;
    const sedStep = () => { sedSink = (sedSink + sed.pick()) | 0; };
    const sedAllocRes = measureAllocs(sedStep, { iterations: 100000, batches: 8 });
    const sedBpc = sedAllocRes.bytesPerCall === null ? 0 : sedAllocRes.bytesPerCall;
    const sedAllocBytes = Math.max(0, Math.round(sedBpc));
    const sedAllocOk = sedAllocBytes === 0;

    // ---- phase 8: NQ.pick() per-call allocation (0 B/op) -------------------
    // One reused NqBalancer over a BUSY pool (inflight all >= 1) so every pick() takes the
    // full SED-fallback scan -- the worst case, still no object/closure/array created.
    const busy = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) busy[i] = 1 + (i & 15);
    const nq = new NqBalancer(CAP, el, busy, weights);
    let nqSink = 0;
    const nqStep = () => { nqSink = (nqSink + nq.pick()) | 0; };
    const nqAllocRes = measureAllocs(nqStep, { iterations: 100000, batches: 8 });
    const nqBpc = nqAllocRes.bytesPerCall === null ? 0 : nqAllocRes.bytesPerCall;
    const nqAllocBytes = Math.max(0, Math.round(nqBpc));
    const nqAllocOk = nqAllocBytes === 0;

    // ---- verdict ----------------------------------------------------------
    const retentionOk = live === 0 && findings.length === 0 && warns.length === 0;
    void sink; void rrSink; void wrrSink; void p2cSink; void lcSink; void sedSink; void nqSink;

    process.stdout.write('lite-pick torture (M4: substrate + RoundRobin + SmoothWRR + P2C + LeastConn + SED + NQ)\n');
    process.stdout.write('  retention: tracker.size()=' + live +
        ' findings=' + findings.length + ' warns=' + warns.length +
        ' -> ' + (retentionOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  substrate hot-path allocs: ' + allocBytes + ' B/op -> ' +
        (allocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  RoundRobin.pick() allocs: ' + rrAllocBytes + ' B/op -> ' +
        (rrAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  SmoothWRR.pick() allocs: ' + wrrAllocBytes + ' B/op -> ' +
        (wrrAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  P2C.pick() allocs: ' + p2cAllocBytes + ' B/op -> ' +
        (p2cAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  LeastConn.pick() allocs: ' + lcAllocBytes + ' B/op -> ' +
        (lcAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  SED.pick() allocs: ' + sedAllocBytes + ' B/op -> ' +
        (sedAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  NQ.pick() allocs: ' + nqAllocBytes + ' B/op -> ' +
        (nqAllocOk ? 'PASS' : 'FAIL') + '\n');

    if (!retentionOk || !allocOk || !rrAllocOk || !wrrAllocOk || !p2cAllocOk ||
        !lcAllocOk || !sedAllocOk || !nqAllocOk) {
        process.stderr.write('torture: FAIL\n');
        process.exit(1);
    }
    process.stdout.write('torture: PASS\n');
}

main().catch((e) => {
    process.stderr.write('torture: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
