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
 *   - @zakkster/lite-gc-profiler -- RETENTION on the hot ops: measureAllocs counts only the
 *                                  bytes STILL ALIVE after a forced GC (the minimum across
 *                                  batches). That is a retention reading, NOT an allocation
 *                                  rate. It CANNOT see a transient box or a per-call object
 *                                  that dies young. So every "B/op" figure below is labelled
 *                                  "retained B/op": a hot op that leaks nothing per call reads
 *                                  0. See the H6 note.
 *
 * WHAT PROVES WHAT (H6): the allocation-free / 0-B/op claim for the hot paths is proven by
 * PerfGate's SCAVENGE counting under pinned semi-space flags (`npm run test:perf`), which sees
 * transient boxes torture cannot. torture proves RETENTION: nothing the hot ops touch survives
 * a GC, and no balancer instance outlives its owner. The MUST_FAIL control below (a pick wrapper
 * that pushes each result object into an array outliving the batch) trips this retention lane
 * every run -- if it ever reads 0 the lane is blind and the gate fails closed. A `null` reading
 * ("could not measure") is an unverified state and is treated as FAIL, never coerced to 0.
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
        LeastConnBalancer, SedBalancer, NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer,
        BoundedLoadBalancer, WeightedRandomBalancer,
    } = await import('../Pick.js');

    const CAP = 1 << 12;    // pool capacity 4096
    const CYCLES = 4096;    // retention churn

    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-pick',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });

    // measureAllocs reports the bytes STILL ALIVE after a forced GC (min across batches): a
    // RETENTION reading, not an allocation rate. `null` == "could not measure" is an unverified
    // state -> fail closed (never coerced to 0). A hot op that retains nothing reads 0.
    const retainedBytes = (res) => {
        if (!res || res.bytesPerCall === null || res.bytesPerCall === undefined) return null;
        return Math.max(0, Math.round(res.bytesPerCall));
    };
    const showBytes = (b) => (b === null ? 'unmeasured(null)' : String(b));

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
            const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, c);
            pe.pick(c);
            pe.recordRtt(c & (CAP - 1), 1000, c);
            tracker.track(pe, noop, 'peakewma', { audit: true });
            const wr = new WeightedRandomBalancer(CAP, el, weights, c);
            wr.pick();
            tracker.track(wr, noop, 'weightedrandom', { audit: true });
        }
        return tracker.size();
    }
    fillTracker();

    // ConsistentHash + BoundedLoad (CHBL, which extends it) own a Maglev table + weights but no
    // external kernel (no timer / listener / shared view retained beyond the caller), so they must
    // finalize like every sibling. Their COLD build is O(M x N), so this churns SMALL instances
    // (capacity 64, M 257) -- enough to prove finalization without a slow build storm. The cleanup
    // closes over NOTHING.
    const CH_CAP = 64, CH_M = 257, CH_CYCLES = 256;
    function fillTrackerCH() {
        const el = new Uint8Array(CH_CAP).fill(1);
        const w = new Uint32Array(CH_CAP).fill(3);
        const inf = new Uint32Array(CH_CAP);
        for (let c = 0; c < CH_CYCLES; c++) {
            const ch = new ConsistentHashBalancer(CH_CAP, el, w, CH_M, c);
            ch.pick(c * 2654435761);
            ch.setEligible(c & (CH_CAP - 1), (c & 1) === 0);
            tracker.track(ch, noop, 'consistenthash', { audit: true });
            const bl = new BoundedLoadBalancer(CH_CAP, el, inf, 0.25, w, CH_M, c);
            bl.note(c & (CH_CAP - 1), 1);
            bl.pick(c * 2654435761);
            tracker.track(bl, noop, 'boundedload', { audit: true });
        }
        return tracker.size();
    }
    fillTrackerCH();

    // WeightedRandom.setWeights(buf.subarray(0, cap)) retention (K5, 1.1.1): setWeights COPIES via
    // `_weights.set(weights.subarray(0, cap))`, so the passed-in view (and its buffer) must NOT be
    // retained -- every argument must finalize even while the balancer that received it STAYS ALIVE.
    //
    // Teeth (reviewer rv2/wrret.mjs): if the balancer were dropped each iteration, a setWeights that
    // retained its argument (`this._kept = w`) would be collected WITH the balancer and the arg would
    // finalize anyway -- the lane would pass a leaking mutant. So the balancer is LONG-LIVED here: one
    // instance takes every setWeights call and is held past the forced-GC drain. With the balancer alive,
    // a retained argument can never finalize. The real WR copies, so every tracked view finalizes and the
    // tracker returns to 0; a LEAKY subclass (`setWeights` keeps the arg) is run through this SAME lane
    // function as the MUST-RETAIN control and MUST trip. Track the ARGUMENT view (NOT the ctor weights the
    // balancer keeps by design); the cleanup closes over NOTHING.
    const WR_CAP = 1 << 10, WR_CYCLES = 50, WR_PER = 1000;
    const wrLaneEl = new Uint8Array(WR_CAP).fill(1);
    function runWRSetWeightsLane(balancer, trk, cycles, per) {
        for (let c = 0; c < cycles; c++) {
            for (let k = 0; k < per; k++) {
                const argBuf = new Uint32Array(WR_CAP);
                for (let i = 0; i < WR_CAP; i++) argBuf[i] = 1 + (i & 7);
                const view = argBuf.subarray(0, WR_CAP);             // the VIEW handed to setWeights
                balancer.setWeights(view);
                balancer.pick();
                trk.track(view, noop, 'wr-setweights-arg', { audit: true });
            }
        }
    }
    // The long-lived receivers are held in this array, which is referenced AFTER the GC drain (its
    // length is printed), so V8 cannot prove them dead early: a retained argument therefore cannot
    // finalize while its balancer lives. The lane runs in its own function so the churn frame (and the
    // transient `view` locals) are torn down before the drain.
    const wrKeepAlive = [];
    const wrLiveBalancer = new WeightedRandomBalancer(
        WR_CAP, wrLaneEl, new Uint32Array(WR_CAP).fill(1), 0x1234abcd);
    wrKeepAlive.push(wrLiveBalancer);
    runWRSetWeightsLane(wrLiveBalancer, tracker, WR_CYCLES, WR_PER);

    // MUST-RETAIN control: the SAME lane function, but the receiver is a LEAKY subclass that pushes every
    // setWeights argument into a field array. Because this long-lived instance retains the views, they can
    // never finalize: this tracker's size() must stay == the arg count after the forced GC. If it drops to
    // 0 the real lane above is blind (it would pass this exact mutant), and the gate fails closed.
    const wrCtrlWarns = [];
    const wrCtrlTracker = createLeakTracker({
        name: 'lite-pick-wr-setweights-ctrl',
        onWarning: (w) => wrCtrlWarns.push(w.kind + ':' + w.reason),
    });
    class LeakyWRBalancer extends WeightedRandomBalancer {
        setWeights(w) { (this._kept || (this._kept = [])).push(w); return super.setWeights(w); }
    }
    const WR_CTRL_ARGS = 64;
    const wrCtrlBalancer = new LeakyWRBalancer(
        WR_CAP, wrLaneEl, new Uint32Array(WR_CAP).fill(1), 0x5eed1e55);
    wrKeepAlive.push(wrCtrlBalancer);
    runWRSetWeightsLane(wrCtrlBalancer, wrCtrlTracker, 1, WR_CTRL_ARGS);

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

    // The MUST-RETAIN control reads its size AFTER the same forced-GC drain: the kept args must survive.
    const wrCtrlLive = wrCtrlTracker.size();
    const wrCtrlTrips = wrCtrlLive >= 1 && wrCtrlWarns.length === 0;

    // ---- phase 2: substrate hot path -- 0 retained B/op --------------------
    // One reused Prng + one reused BalancerBase. Steady state: one PRNG draw + one
    // bounded eligibility read. No object, closure, string, or array is retained.
    const el = new Uint8Array(CAP);
    for (let i = 0; i < CAP; i += 2) el[i] = 1;          // half eligible
    const base = new BalancerBase(CAP, el);
    const rng = new Prng(0x1234abcd);
    let sink = 0;
    const step = () => {
        const i = rng.nextBelow(CAP);
        if (base.isEligible(i)) sink = (sink + i) | 0;
    };
    const allocBytes = retainedBytes(measureAllocs(step, { iterations: 100000, batches: 8 }));
    const allocOk = allocBytes === 0;

    // ---- phase 3: RoundRobin.pick() -- 0 retained B/op ---------------------
    // One reused RoundRobinBalancer over a half-eligible pool: every pick() is a
    // compare-wrap loop + one cursor write, no object/closure/array retained.
    const rr = new RoundRobinBalancer(CAP, el);
    let rrSink = 0;
    const rrStep = () => { rrSink = (rrSink + rr.pick()) | 0; };
    const rrAllocBytes = retainedBytes(measureAllocs(rrStep, { iterations: 100000, batches: 8 }));
    const rrAllocOk = rrAllocBytes === 0;

    // ---- phase 4: SmoothWRR.pick() -- 0 retained B/op ----------------------
    // One reused SmoothWRRBalancer: pick() is an O(cap) scan mutating the owned Float64
    // accumulators in place + one subtract; no object/closure/array retained.
    const weights = new Uint32Array(CAP).fill(3);
    const wrr = new SmoothWRRBalancer(CAP, el, weights);
    let wrrSink = 0;
    const wrrStep = () => { wrrSink = (wrrSink + wrr.pick()) | 0; };
    const wrrAllocBytes = retainedBytes(measureAllocs(wrrStep, { iterations: 100000, batches: 8 }));
    const wrrAllocOk = wrrAllocBytes === 0;

    // ---- phase 5: P2C.pick() -- 0 retained B/op ----------------------------
    // One reused P2cBalancer over a half-eligible pool + a caller-owned inflight array:
    // pick() is a few PRNG steps + array reads (rejection draws) + one compare -- no
    // object/closure/array retained.
    const inflight = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) inflight[i] = i & 15;
    const p2c = new P2cBalancer(CAP, el, inflight, 0xABCDEF);
    let p2cSink = 0;
    const p2cStep = () => { p2cSink = (p2cSink + p2c.pick()) | 0; };
    const p2cAllocBytes = retainedBytes(measureAllocs(p2cStep, { iterations: 100000, batches: 8 }));
    const p2cAllocOk = p2cAllocBytes === 0;

    // ---- phase 6: LeastConn.pick() -- 0 retained B/op ----------------------
    // One reused LeastConnBalancer: pick() is an O(cap) integer-compare scan + one index
    // write over the caller-owned inflight view; no object/closure/array retained.
    const lc = new LeastConnBalancer(CAP, el, inflight);
    let lcSink = 0;
    const lcStep = () => { lcSink = (lcSink + lc.pick()) | 0; };
    const lcAllocBytes = retainedBytes(measureAllocs(lcStep, { iterations: 100000, batches: 8 }));
    const lcAllocOk = lcAllocBytes === 0;

    // ---- phase 7: SED.pick() -- 0 retained B/op ----------------------------
    // One reused SedBalancer: pick() is an O(cap) scan + one Float64 division per eligible
    // node over caller-owned inflight + weights; no object/closure/array retained.
    const sed = new SedBalancer(CAP, el, inflight, weights);
    let sedSink = 0;
    const sedStep = () => { sedSink = (sedSink + sed.pick()) | 0; };
    const sedAllocBytes = retainedBytes(measureAllocs(sedStep, { iterations: 100000, batches: 8 }));
    const sedAllocOk = sedAllocBytes === 0;

    // ---- phase 8: NQ.pick() -- 0 retained B/op -----------------------------
    // One reused NqBalancer over a BUSY pool (inflight all >= 1) so every pick() takes the
    // full SED-fallback scan -- the worst case, still no object/closure/array retained.
    const busy = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) busy[i] = 1 + (i & 15);
    const nq = new NqBalancer(CAP, el, busy, weights);
    let nqSink = 0;
    const nqStep = () => { nqSink = (nqSink + nq.pick()) | 0; };
    const nqAllocBytes = retainedBytes(measureAllocs(nqStep, { iterations: 100000, batches: 8 }));
    const nqAllocOk = nqAllocBytes === 0;

    // ---- phase 9: PeakEWMA.pick(now) -- 0 retained B/op --------------------
    // One reused PeakEwmaBalancer over a half-eligible pool + caller-owned inflight: pick(now)
    // is two rejection draws + two decay-on-read exp() + a compare -- a PURE read (no write),
    // no object/closure/array retained. `now` is a monotonically advancing caller clock.
    const pe = new PeakEwmaBalancer(CAP, el, inflight, 1e6, 0xBADC0DE);
    let peSink = 0, peNow = 0;
    const peStep = () => { peNow += 1000; peSink = (peSink + pe.pick(peNow)) | 0; };
    const peAllocBytes = retainedBytes(measureAllocs(peStep, { iterations: 100000, batches: 8 }));
    const peAllocOk = peAllocBytes === 0;

    // ---- phase 10: PeakEWMA.recordRtt() -- 0 retained B/op -----------------
    // The warm feedback path: one decay + one branch + two Float64 writes over the owned EWMA
    // state; validation is typeof/range guards that only construct an Error on the (untaken)
    // failure branch -- the success path retains nothing.
    let rttNow = 0;
    const rttStep = () => { rttNow += 1000; pe.recordRtt(rttNow & (CAP - 1), rttNow % 500000, rttNow); };
    const rttAllocBytes = retainedBytes(measureAllocs(rttStep, { iterations: 100000, batches: 8 }));
    const rttAllocOk = rttAllocBytes === 0;

    // ---- phase 11: ConsistentHash.pick(keyHash) -- 0 retained B/op ---------
    // The Maglev TABLE is built ONCE here (the COLD, disclosed cost -- M x 4 bytes, ~256KB at the
    // 65537 default; excluded from the hot measurement). Steady-state pick(keyHash) is slot = key %
    // M, a prebuilt-table read, and a bounded probe -- integer ops, no object/closure/array retained.
    const chEl = new Uint8Array(CAP);
    for (let i = 0; i < CAP; i += 2) chEl[i] = 1;             // half eligible (exercise the probe)
    const ch = new ConsistentHashBalancer(CAP, chEl, null, 65537, 0xC0FFEE); // COLD build, not measured
    let chSink = 0, chKey = 0x12345678 >>> 0;
    const chStep = () => { chKey = (Math.imul(chKey, 1664525) + 1013904223) >>> 0; chSink = (chSink + ch.pick(chKey)) | 0; };
    const chAllocBytes = retainedBytes(measureAllocs(chStep, { iterations: 100000, batches: 8 }));
    const chAllocOk = chAllocBytes === 0;

    // ---- phase 12: BoundedLoad.pick(keyHash) -- 0 retained B/op ------------
    // CHBL: the Maglev TABLE is built ONCE here (the COLD, disclosed cost -- excluded from the hot
    // measurement). Steady-state pick(keyHash) is slot = key % M, a table read, and a bounded cap-aware
    // probe -- integer/float locals, no object/closure/array retained. _total is seeded ONCE (cold notes)
    // so the cap branch is exercised on the hot path (over-cap homes overflow along the probe).
    const bl = new BoundedLoadBalancer(CAP, chEl, inflight, 0.25, null, 65537, 0xB0DED10A); // COLD build, not measured
    let blTotal = 0;
    for (let i = 0; i < CAP; i++) blTotal += inflight[i];
    bl.note(0, blTotal);                                 // seed _total to the true inflight sum (cold)
    let blSink = 0, blKey = 0x2468ace0 >>> 0;
    const blStep = () => { blKey = (Math.imul(blKey, 1664525) + 1013904223) >>> 0; blSink = (blSink + bl.pick(blKey)) | 0; };
    const blAllocBytes = retainedBytes(measureAllocs(blStep, { iterations: 100000, batches: 8 }));
    const blAllocOk = blAllocBytes === 0;

    // ---- phase 13: BoundedLoad.note() -- 0 retained B/op -------------------
    // The warm feedback path: one add + one clamp compare over the owned scalar _total; the typeof/
    // range guards only construct an Error on the (untaken) failure branch, so success retains nothing.
    let noteI = 0;
    const noteStep = () => { noteI = (noteI + 1) & (CAP - 1); bl.note(noteI, (noteI & 1) ? -1 : 1); };
    const noteAllocBytes = retainedBytes(measureAllocs(noteStep, { iterations: 100000, batches: 8 }));
    const noteAllocOk = noteAllocBytes === 0;

    // ---- phase 14: WeightedRandom.pick() -- 0 retained B/op ----------------
    // One reused WeightedRandomBalancer over a half-eligible, weighted pool: each pick() is one
    // alias-column draw + one probability compare (rejection-sampled over eligibility) -- integer/
    // float locals only, no object/closure/array retained. The alias table is built ONCE (COLD) in the
    // ctor. The instance is created OUTSIDE the measured loop and stepped inside; nothing closes over it.
    const wrEl = new Uint8Array(CAP);
    for (let i = 0; i < CAP; i += 2) wrEl[i] = 1;             // half eligible (exercise rejection)
    const wrWeights = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) wrWeights[i] = 1 + (i & 15);
    const wrand = new WeightedRandomBalancer(CAP, wrEl, wrWeights, 0x5EED1E55);
    let wrandSink = 0;
    const wrandStep = () => { wrandSink = (wrandSink + wrand.pick()) | 0; };
    const wrandAllocBytes = retainedBytes(measureAllocs(wrandStep, { iterations: 100000, batches: 8 }));
    const wrandAllocOk = wrandAllocBytes === 0;

    // ---- phase 14b: WeightedRandom.pick() HEAVY-OUTAGE fallback -- 0 retained B/op --
    // EXACTLY ONE eligible positive-weight node in the CAP pool (all others down), so the 64-try
    // rejection loop misses ~every time and each pick() runs the rotated linear-scan FALLBACK -- the
    // branch the half-eligible phase 14 never reaches. It must be 0 retained B/op too (integer locals
    // only). The instance is created OUTSIDE the measured loop and stepped inside; nothing closes over it.
    const wrFbEl = new Uint8Array(CAP);
    wrFbEl[1] = 1;                                            // one eligible node -> exhaust rejection, scan
    const wrFbWeights = new Uint32Array(CAP);
    for (let i = 0; i < CAP; i++) wrFbWeights[i] = 1 + (i & 15);
    const wrandFb = new WeightedRandomBalancer(CAP, wrFbEl, wrFbWeights, 0x0FF0DEAD);
    let wrandFbSink = 0;
    const wrandFbStep = () => { wrandFbSink = (wrandFbSink + wrandFb.pick()) | 0; };
    const wrandFbAllocBytes = retainedBytes(measureAllocs(wrandFbStep, { iterations: 100000, batches: 8 }));
    const wrandFbAllocOk = wrandFbAllocBytes === 0;

    // ---- MUST-FAIL control: a deliberately RETAINING pick wrapper ----------
    // Proves the retention lane has teeth. Each call pushes a fresh result object into an array
    // that OUTLIVES every batch, so those objects survive the forced GC and measureAllocs reports
    // retained bytes > 0. This control MUST trip (retained > 0) on every run; if it reads 0 or null
    // the lane is blind and the whole gate fails closed. It is the mirror of every 0-B/op phase above.
    const retainHold = [];
    let mustSink = 0;
    const mustFailStep = () => {
        const idx = rng.nextBelow(CAP);
        retainHold.push({ idx, live: base.isEligible(idx) });   // escapes the batch -> retained
        mustSink = (mustSink + retainHold.length) | 0;
    };
    const mustFailBytes = retainedBytes(measureAllocs(mustFailStep, { iterations: 20000, batches: 8 }));
    const mustFailTrips = mustFailBytes !== null && mustFailBytes > 0;
    void mustSink; void retainHold.length;

    // ---- verdict ----------------------------------------------------------
    const retentionOk = live === 0 && findings.length === 0 && warns.length === 0;
    void sink; void rrSink; void wrrSink; void p2cSink; void lcSink; void sedSink; void nqSink; void peSink; void chSink; void blSink; void wrandSink; void wrandFbSink;

    process.stdout.write('lite-pick torture (M10: substrate + RoundRobin + SmoothWRR + P2C + LeastConn + SED + NQ + PeakEWMA + ConsistentHash + BoundedLoad + WeightedRandom)\n');
    process.stdout.write('  retention: tracker.size()=' + live +
        ' findings=' + findings.length + ' warns=' + warns.length +
        ' -> ' + (retentionOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  WR.setWeights(subarray) arg retention: MUST-RETAIN control size=' + wrCtrlLive +
        ' warns=' + wrCtrlWarns.length + ' -> ' +
        (wrCtrlTrips ? 'TRIPPED (lane has teeth)' : 'BLIND -- gate is broken') + '\n');
    void wrKeepAlive.length;    // keep both lane receivers reachable PAST the drain (teeth)
    process.stdout.write('  (hot-path figures are RETAINED B/op: bytes alive after a forced GC, not an alloc rate;\n' +
        '   the 0-B/op allocation claim is proven by PerfGate scavenge counting -- npm run test:perf)\n');
    process.stdout.write('  substrate hot-path retained: ' + showBytes(allocBytes) + ' B/op -> ' +
        (allocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  RoundRobin.pick() retained: ' + showBytes(rrAllocBytes) + ' B/op -> ' +
        (rrAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  SmoothWRR.pick() retained: ' + showBytes(wrrAllocBytes) + ' B/op -> ' +
        (wrrAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  P2C.pick() retained: ' + showBytes(p2cAllocBytes) + ' B/op -> ' +
        (p2cAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  LeastConn.pick() retained: ' + showBytes(lcAllocBytes) + ' B/op -> ' +
        (lcAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  SED.pick() retained: ' + showBytes(sedAllocBytes) + ' B/op -> ' +
        (sedAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  NQ.pick() retained: ' + showBytes(nqAllocBytes) + ' B/op -> ' +
        (nqAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  PeakEWMA.pick() retained: ' + showBytes(peAllocBytes) + ' B/op -> ' +
        (peAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  PeakEWMA.recordRtt() retained: ' + showBytes(rttAllocBytes) + ' B/op -> ' +
        (rttAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  ConsistentHash.pick(keyHash) retained: ' + showBytes(chAllocBytes) + ' B/op -> ' +
        (chAllocOk ? 'PASS' : 'FAIL') + ' (Maglev table build is the disclosed COLD cost)\n');
    process.stdout.write('  BoundedLoad.pick(keyHash) retained: ' + showBytes(blAllocBytes) + ' B/op -> ' +
        (blAllocOk ? 'PASS' : 'FAIL') + ' (CHBL Maglev table build is the disclosed COLD cost)\n');
    process.stdout.write('  BoundedLoad.note() retained: ' + showBytes(noteAllocBytes) + ' B/op -> ' +
        (noteAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  WeightedRandom.pick() retained: ' + showBytes(wrandAllocBytes) + ' B/op -> ' +
        (wrandAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  WeightedRandom.pick() heavy-outage fallback retained: ' + showBytes(wrandFbAllocBytes) + ' B/op -> ' +
        (wrandFbAllocOk ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('  MUST-FAIL control (retaining pick wrapper) retained: ' + showBytes(mustFailBytes) +
        ' B/op -> ' + (mustFailTrips ? 'TRIPPED (lane has teeth)' : 'BLIND -- gate is broken') + '\n');

    if (!retentionOk || !allocOk || !rrAllocOk || !wrrAllocOk || !p2cAllocOk ||
        !lcAllocOk || !sedAllocOk || !nqAllocOk || !peAllocOk || !rttAllocOk || !chAllocOk ||
        !blAllocOk || !noteAllocOk || !wrandAllocOk || !wrandFbAllocOk || !mustFailTrips || !wrCtrlTrips) {
        process.stderr.write('torture: FAIL\n');
        if (!wrCtrlTrips) {
            process.stderr.write('  WR.setWeights MUST-RETAIN control did not trip (size=' + wrCtrlLive +
                ', warns=' + wrCtrlWarns.length + '): the setWeights-arg retention lane is blind\n');
        }
        if (!mustFailTrips) {
            process.stderr.write('  MUST-FAIL control did not trip (retained=' + showBytes(mustFailBytes) +
                '): the retention lane cannot see retained bytes -- gate is not trustworthy\n');
        }
        process.exit(1);
    }
    process.stdout.write('torture: PASS\n');
}

main().catch((e) => {
    process.stderr.write('torture: FAIL -- ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
});
