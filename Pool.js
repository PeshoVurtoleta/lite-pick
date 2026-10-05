/**
 * @zakkster/lite-pick/pool -- the ergonomic request wrapper (M5).
 *
 *     import { Pool, liteQueryFetcher } from '@zakkster/lite-pick/pool';
 *
 * The kernel (Pick.js) is a PURE, 0 B/op selector: pick() -> index. Real callers also need
 * the counter ergonomics ADR 0001 always promised -- increment in-flight on DISPATCH,
 * decrement on SETTLE, and on a failure re-pick a DIFFERENT endpoint. That layer is async
 * (it wraps the request lifecycle), so it lives OUTSIDE the single-file 0 B/op kernel, in
 * this separate subpath file (the lite-query precedent: /stream, /await are subpath entries).
 *
 * BOUNDARY (decisions/0007): Pool owns SPATIAL failover -- try up to `tries` DISTINCT endpoints,
 * once each, on a thrown error. It does NOT own TEMPORAL retry (backoff, staleness) -- that
 * belongs to the caller / a query cache (lite-query's `retry`). The two never double-own: Pool
 * moves ACROSS the pool once; the caller retries the whole operation over TIME.
 *
 * ZERO-GC boundary: the kernel `pick()` is 0 B/op. Pool.run is a normal async function and is NOT. A run
 * that SETTLES ON ATTEMPT 0 (any `tries` value) costs ~900 B/run (Node 22 v22.23.3, Pool's own share
 * above the bare-await driver floor, by scavenge count; `npm run bench:pool`), gated <= 912 B/run; each
 * extra failover attempt adds ~375 B/run and is gated too (test/perf/PoolCost.test.mjs). A latency-aware
 * balancer (PeakEWMA) driven by an epoch-ns `clock` costs ~32 B/run more per attempt (Node 22; the clock
 * reading boxes, read twice per successful attempt) and is gated on its own `clocked` row. (Abort before
 * dispatch is NOT cheaper than a successful run -- it is ungated and above L3.) Your fn's closure,
 * promise and I/O come on top -- a submit-shaped fn adds ~310 B/run (ladder L10-L3); the capstone's full
 * request wiring measured ~2.9 KB/request end to end on 1.1.0, before this change. For 0 B/request, use
 * the hand-wired pickFrom + settle recipe. It is NOT held to the kernel's 0 B/op bar.
 * (F1: a run that never fails over keeps attempt 0 in scalars and allocates no per-run bookkeeping array.)
 *
 * Duck-typed, zero HARD deps, zero peers: `liteQueryFetcher` returns a value shaped like
 * lite-query's `fetcher` (`({ key, signal }) => Promise`) WITHOUT importing lite-query, so
 * `peerDependencies` stays empty and the same helper serves any fetcher-shaped consumer.
 */

import { VERSION, PICK_NONE } from './Pick.js';

/** Re-exported so a /pool-only importer can read the version without importing the core. */
export { VERSION };

/** diagnostics_channel name (1.1.0, D7): published once per DISPATCH -- an endpoint was chosen, its in-flight
 *  count raised, and `fn` is about to be called. Message: `{ pool, endpoint, attempt, key, now }`. */
export const POOL_CHANNEL_DISPATCH = 'lite-pick:pool:dispatch';
/** diagnostics_channel name (1.1.0, D7): published once per attempt when `fn` SETTLES (resolves or throws), before
 *  any rtt feedback or failover. Message: `{ pool, endpoint, attempt, ok, error, aborted }`. */
export const POOL_CHANNEL_SETTLE = 'lite-pick:pool:settle';

/**
 * The two channels, or null where `node:diagnostics_channel` is not reachable without an import (browsers,
 * Node < 20.16 / 22.3 -- no `process.getBuiltinModule`). Loaded synchronously and optionally, so Pool stays
 * browser-safe and has no top-level await (which would break `require()` of this module). Observability must
 * never break a Pool: any failure here means no channels.
 * @returns {{ dispatch: object, settle: object } | null}
 */
function _channels() {
    try {
        if (typeof process !== 'object' || process === null || typeof process.getBuiltinModule !== 'function') return null;
        const dc = process.getBuiltinModule('node:diagnostics_channel');
        if (!dc || typeof dc.channel !== 'function') return null;
        return { dispatch: dc.channel(POOL_CHANNEL_DISPATCH), settle: dc.channel(POOL_CHANNEL_SETTLE) };
    } catch {
        return null;
    }
}
const _ch = _channels();
const _chDispatch = _ch !== null ? _ch.dispatch : null;
const _chSettle = _ch !== null ? _ch.settle : null;

/*
 * ONE reused message object per channel (measured, research 7.2: a fresh object per publish cost 315-458
 * scavenges / 10M; a reused one 0). Subscribers run synchronously inside publish() and must COPY what they
 * need. The references are cleared after every publish, so a message never keeps a Pool or an error alive.
 * A publish NESTED inside a subscriber (a subscriber that starts a run) gets a fresh object, so the outer
 * publish's remaining subscribers still read their own event.
 *
 * The endpoint and attempt number are passed to the publisher as scalars (on a dispatching iteration the
 * attempt index IS held.length - 1 when the failover array exists), so run() itself only adds a guarded
 * call per event. With NOBODY subscribed the hasSubscribers guard is one property read and no message is
 * built; the dispatch/settle cost is gated by test/perf/PoolCost.test.mjs (lane L9 == L3).
 */
const _dMsg = { pool: null, endpoint: -1, attempt: 0, key: undefined, now: undefined };
const _sMsg = { pool: null, endpoint: -1, attempt: 0, ok: false, error: undefined, aborted: false };
let _dDepth = 0, _sDepth = 0;

/** Publish a dispatch event (only called when the channel has subscribers). */
function _pubDispatch(pool, endpoint, attempt, key, now) {
    const m = _dDepth === 0 ? _dMsg : { pool: null, endpoint: -1, attempt: 0, key: undefined, now: undefined };
    m.pool = pool; m.endpoint = endpoint; m.attempt = attempt; m.key = key; m.now = now;
    _dDepth++;
    try {
        _chDispatch.publish(m);
    } finally {
        _dDepth--;
        m.pool = null; m.key = undefined; m.now = undefined;
    }
}

/** Publish a settle event (only called when the channel has subscribers). */
function _pubSettle(pool, endpoint, attempt, ok, error, aborted) {
    const m = _sDepth === 0 ? _sMsg : { pool: null, endpoint: -1, attempt: 0, ok: false, error: undefined, aborted: false };
    m.pool = pool; m.endpoint = endpoint; m.attempt = attempt;
    m.ok = ok; m.error = error; m.aborted = aborted;
    _sDepth++;
    try {
        _chSettle.publish(m);
    } finally {
        _sDepth--;
        m.pool = null; m.error = undefined;
    }
}
/** fn resolved. */
function _pubSettleOk(pool, endpoint, attempt) { _pubSettle(pool, endpoint, attempt, true, undefined, false); }
/** fn threw (the endpoint's failure). */
function _pubSettleErr(pool, endpoint, attempt, error) { _pubSettle(pool, endpoint, attempt, false, error, false); }
/** fn threw after the caller's signal aborted (a cancel, not the endpoint's fault). */
function _pubSettleAbort(pool, endpoint, attempt, error) { _pubSettle(pool, endpoint, attempt, false, error, true); }

/**
 * Distinct-endpoint re-pick bound (M2): after a failed attempt Pool re-picks up to this many times
 * while the strategy keeps returning an already-tried endpoint, before falling back to a linear scan
 * for an eligible UNTRIED endpoint. Small: `tries` is small, and a keyed/deterministic strategy that
 * always returns the same backend hits the scan after this bound rather than spinning.
 */
const REPICK_LIMIT = 8;

/**
 * Cold failover fallback (M2): the first ELIGIBLE endpoint NOT already tried this run, scanning the
 * capacity from a rotating start (`from`) so failover does not always favour low indices. Uses the
 * balancer's own `isEligible` (duck-typed; if absent, no scan is possible -> PICK_NONE). Returns
 * PICK_NONE when every eligible endpoint has already been tried -- the caller then stops failing over
 * rather than re-dispatching to an endpoint that already failed this run.
 * @param {{ capacity: number, isEligible?(i: number): boolean }} b
 * @param {number[]} tried  endpoints already dispatched this run
 * @param {number} from  rotating scan start
 * @returns {number}
 */
function _scanUntried(b, tried, from) {
    if (typeof b.isEligible !== 'function') return PICK_NONE;
    const cap = b.capacity;
    for (let s = 0; s < cap; s++) {
        let idx = from + s;
        if (idx >= cap) idx -= cap;
        if (b.isEligible(idx) && tried.indexOf(idx) < 0) return idx;
    }
    return PICK_NONE;
}

/**
 * A coded error (1.1.0): every error Pool throws or rejects with carries a stable `.code` (messages may
 * change in any release; codes are semver API -- the same `LITE_PICK_*` family as the kernel's). Cold.
 * @param {ErrorConstructor} Ctor
 * @param {string} code
 * @param {string} msg
 * @returns {Error}
 */
function _err(Ctor, code, msg) {
    const e = new Ctor(msg);
    e.code = code;
    return e;
}

/**
 * The coded error for a non-finite clock reading (N7: every Pool error carries a `.code`). Cold path.
 * @param {unknown} v  the reading clock() returned
 * @returns {Error}
 */
function _clockInvalid(v) {
    const e = new Error('[lite-pick] clock() must return a finite number, got ' + String(v));
    e.code = 'LITE_PICK_CLOCK_INVALID';
    return e;
}

/**
 * Attach a feedback error to fn's error WITHOUT replacing it (identity is preserved): when `err` is
 * an extensible object, define a NON-enumerable `liteFeedbackError` property carrying `fe`. Never
 * throws (a frozen/sealed or primitive `err` is left untouched) -- the caller still gets fn's error.
 * @param {unknown} err  the value fn threw (returned unchanged)
 * @param {unknown} fe   the feedback error to attach
 */
function _attachFeedback(err, fe) {
    if (err !== null && (typeof err === 'object' || typeof err === 'function')) {
        try {
            Object.defineProperty(err, 'liteFeedbackError', {
                value: fe, enumerable: false, configurable: true, writable: true,
            });
        } catch { /* frozen/sealed: leave fn's error untouched -- identity preserved */ }
    }
}

/**
 * Pool -- wraps a balancer + the caller-owned in-flight view with the dispatch/settle counter
 * ergonomics and distinct-endpoint failover. The balancer is duck-typed (anything with
 * `pick() -> number`, `capacity`, and `live`), so a Pool can drive any lite-pick strategy or a
 * compatible custom one.
 */
export class Pool {
    /**
     * @param {{ pick(): number, capacity: number, live: number }} balancer  a lite-pick
     *   strategy (RoundRobin / SmoothWRR / P2C / LeastConn / SED / NQ) or a duck-compatible one.
     * @param {Uint32Array} inflight  the SAME caller-owned in-flight view the balancer reads
     *   (length >= balancer.capacity). Pool is the increment/decrement authority around run().
     */
    constructor(balancer, inflight) {
        if (!balancer || typeof balancer.pick !== 'function' ||
            typeof balancer.capacity !== 'number' || typeof balancer.live !== 'number') {
            throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] Pool needs a balancer with pick(), capacity, and live');
        }
        if (!(inflight instanceof Uint32Array) || inflight.length < balancer.capacity) {
            throw _err(RangeError, 'LITE_PICK_ARRAY', '[lite-pick] inflight must be a Uint32Array of length >= balancer.capacity');
        }
        this._b = balancer;
        this._inflight = inflight;
        this._scanCursor = 0;   // rotating failover-scan start for UNKEYED runs (spreads across runs)
    }

    /** The wrapped balancer. */
    get balancer() {
        return this._b;
    }

    /** The shared in-flight view Pool increments on dispatch and decrements on settle. */
    get inflight() {
        return this._inflight;
    }

    /**
     * Run `fn` against a chosen endpoint, incrementing its in-flight on dispatch and decrementing on
     * settle. On a thrown error, keep the failed endpoint's count ELEVATED and fail over to a
     * genuinely DISTINCT endpoint -- up to `tries` attempts, then throw the last error. Every count
     * this run raised (and every applied `note(+1)`) is released before returning or throwing
     * (net-zero on every path: success, throw, abort, feedback error).
     *
     * DISTINCT FAILOVER (M2): the endpoints already tried this run are tracked; after a failure Pool
     * re-picks while the strategy repeats a tried endpoint (bounded by REPICK_LIMIT), then falls back
     * to a scan for an eligible UNTRIED endpoint (`balancer.isEligible`). The scan start is derived
     * from the KEY for a keyed run (deterministic per key -> a key's failover target is stable and
     * cache-friendly, but spread ACROSS keys so one failing backend does not funnel every key onto a
     * single neighbour) and from a rotating per-Pool cursor for an unkeyed run. If no untried eligible
     * endpoint exists it stops failing over -- never re-dispatching to an endpoint that already failed
     * this run.
     *
     * CHANNELS (M3), read off the strategy's static markers so Pool stays duck-typed:
     *   - A KEYED balancer (`constructor.KEYED === true`: ConsistentHash / BoundedLoad) REQUIRES a
     *     numeric `opts.key`; Pool drives `pick(key)`. Missing/non-numeric key -> a clear error. A
     *     clock reading is NEVER passed to a keyed pick.
     *   - A LATENCY balancer (`constructor.LATENCY === true`: PeakEWMA) REQUIRES an `opts.clock`;
     *     Pool reads `clock()` (validated finite BEFORE dispatch) and drives `pick(now)`.
     *   - Otherwise (an UNMARKED balancer) Pool keeps the 1.0.0 semantics: a supplied `opts.key`
     *     drives `pick(key)` verbatim (N2 -- a wrapper or custom keyed strategy without the marker
     *     still routes by key; mark it `static KEYED = true` to get key validation); else, when a
     *     `clock` is supplied, its reading drives `pick(now)` (a non-latency built-in ignores the
     *     argument; a duck-typed latency balancer that omitted the marker still gets `now`). A LATENCY
     *     balancer never receives the key.
     *
     * FEEDBACK IS LOUD, never silent, and never re-runs fn (M4): the occupancy hook `note(i, +1/-1)`
     * mirrors dispatch/settle, and the latency hook `recordRtt` is fed on settle when a clock is in use.
     *   - On SUCCESS the settle feedback (read `clock()`, then `recordRtt(i, done - now, done)`; a
     *     BACKWARDS finite reading `done < now` records NO sample -- neither a rejection nor a fake 0 ns
     *     rtt; `done === now` is a real 0 reading and is recorded) runs OUTSIDE the attempt's try/catch, so it can never re-dispatch fn. If it fails (clock
     *     throws or returns non-finite, or `recordRtt` throws) `run` REJECTS with a `LITE_PICK_FEEDBACK`
     *     -coded error whose `.cause` is the feedback error and whose `.result` is fn's resolved value
     *     (the caller loses nothing). fn ran exactly once.
     *   - On FAILURE the penalty feedback `recordRtt(i, max(elapsed, failurePenaltyNs), done)` (H1)
     *     -- skipped when the signal is aborted (N1: a caller cancel is not the endpoint's fault) --
     *     runs in its OWN try/catch so fn's error object is preserved by identity as the thrown value.
     *     If the penalty feedback fails (throwing/non-finite clock, throwing `recordRtt`) Pool stops
     *     failing over (a broken clock would throw on the next attempt anyway), attaches the feedback
     *     error to fn's error as a NON-enumerable `liteFeedbackError`, and throws fn's error unchanged.
     *   - H1 recovery: a penalized node's estimate decays back to competitive after roughly
     *     `tauNs * ln(failurePenaltyNs / healthyRttNs)`, so it is periodically RE-PROBED at that
     *     cadence (recovery works) while its steady-state share stays low.
     *
     * @template T
     * @param {(endpoint: number, signal?: { readonly aborted: boolean }) => (Promise<T>|T)} fn
     * @param {{ signal?: { readonly aborted: boolean, reason?: unknown, throwIfAborted?(): void },
     *   tries?: number, clock?: () => number, key?: number, failurePenaltyNs?: number } | null} [opts]
     *   `tries` (default 1 = no failover) is the max distinct-endpoint attempts; `signal` is passed to
     *   `fn` and, when already aborted, dispatches NOTHING (the abort always propagates); `clock`
     *   (REQUIRED for a latency balancer) is a caller-owned nanosecond source driving `pick(now)` +
     *   `recordRtt`; `key` (REQUIRED for a keyed balancer, forwarded verbatim to an unmarked one) is a
     *   caller-supplied INTEGER routing key;
     *   `failurePenaltyNs` (default 1e9) is the minimum rtt penalty a thrown attempt feeds a
     *   latency-aware balancer.
     * @returns {Promise<T>}
     */
    async run(fn, opts) {
        if (typeof fn !== 'function') throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] Pool.run needs a function');
        const o = opts != null ? opts : undefined;      // L1: run(fn, null) / run(fn) are valid
        const rawTries = o && o.tries != null ? (o.tries | 0) : 1;
        const tries = rawTries > 0 ? rawTries : 1;
        const signal = o ? o.signal : undefined;
        const b = this._b, inflight = this._inflight;

        // M3: separate, REQUIRED channels, read off the strategy's static markers (duck-typed --
        // Pool imports nothing new). Validate BEFORE any dispatch (fail closed).
        const ctor = b.constructor;
        const keyed = !!(ctor && ctor.KEYED === true);
        const latency = !!(ctor && ctor.LATENCY === true);

        let key;
        if (keyed) {
            const k = o ? o.key : undefined;
            if (typeof k !== 'number' || !Number.isFinite(k)) {
                const e = new Error('[lite-pick] a keyed balancer (ConsistentHash/BoundedLoad) requires a numeric opts.key');
                e.code = 'LITE_PICK_KEY_REQUIRED';
                throw e;
            }
            key = k;
        } else if (!latency && o && o.key !== undefined) {
            // N2: an UNMARKED balancer (a wrapper, decorator or custom keyed strategy without
            // `static KEYED = true`) gets the supplied key verbatim, as 1.0.0 did. Dropping it would
            // silently route every key to one backend. Mark the class KEYED to get key validation.
            key = o.key;
        }
        const useKey = key !== undefined;

        let clock;
        if (latency) {
            const c = o ? o.clock : undefined;
            if (typeof c !== 'function') {
                const e = new Error('[lite-pick] a latency-aware balancer (PeakEWMA) requires an opts.clock function');
                e.code = 'LITE_PICK_CLOCK_REQUIRED';
                throw e;
            }
            clock = c;
        } else {
            clock = o && typeof o.clock === 'function' ? o.clock : undefined;
        }

        // H1: a thrown attempt feeds a latency penalty so a fast-failing endpoint stops being the
        // cheapest pick. Default 1 s; validated finite > 0 (fail closed -- never silently ignored).
        let failurePenaltyNs = 1e9;
        if (o && o.failurePenaltyNs !== undefined) {
            const fp = o.failurePenaltyNs;
            if (typeof fp !== 'number' || !Number.isFinite(fp) || fp <= 0) {
                throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] failurePenaltyNs must be a finite number > 0');
            }
            failurePenaltyNs = fp;
        }

        // Opt-in feedback (duck-typed, independent): latency (recordRtt, only with a clock) and
        // occupancy (note). Inert when the balancer does not duck-type the method. `useNow` is true
        // when the clock reading is passed to pick() (any clocked run that does not route by key).
        const rtt = clock !== undefined && typeof b.recordRtt === 'function';
        const notes = typeof b.note === 'function';
        const useNow = clock !== undefined && !useKey;

        // F1: a run that SETTLES on attempt 0 (the common path, any `tries` value) stays in SCALARS --
        // `d0` whether attempt 0 dispatched, `e0` its endpoint (ANY value the balancer returned, never
        // used as a truthiness flag -- a duck-typed balancer may return undefined / NaN / a negative /
        // a non-number, which an `e0 >= 0` test would mis-handle), and
        // `n0` whether its note(+1) landed. The `held` / `noteApplied` arrays (endpoints TRIED this run,
        // kept elevated; per-held whether note(+1) landed so finally never unpairs) are built LAZILY at
        // the top of the first attempt>0 iteration, so a run that never fails over allocates neither.
        // held[0] is always e0; held[1..] are the failover endpoints.
        let d0 = false;          // did attempt 0 dispatch? (separate from e0 so e0 is never a flag)
        let e0;                  // attempt-0 endpoint (whatever the balancer returned)
        let n0 = false;          // attempt-0 note(+1) landed
        let held = null;         // lazily [e0, ...failover] once a second attempt begins
        let noteApplied = null;  // lazily [n0, ...] in lockstep with held
        let lastErr;
        try {
            for (let attempt = 0; attempt < tries; attempt++) {
                // Item 5: abort before EVERY attempt -- an already-aborted signal dispatches NOTHING and
                // ALWAYS throws (throwIfAborted is optional on the structural signal: call it when it is
                // a function, then always throw the reason, else a coded abort error).
                if (signal && signal.aborted) {
                    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
                    if (signal.reason !== undefined) throw signal.reason;
                    const e = new Error('[lite-pick] run aborted before dispatch');
                    e.code = 'LITE_PICK_ABORTED';
                    throw e;
                }

                // Validate the clock reading BEFORE dispatch so a broken clock fails closed early.
                let now;
                if (clock !== undefined) {
                    now = clock();
                    if (!Number.isFinite(now)) {
                        throw _clockInvalid(now);
                    }
                }

                // Choose an endpoint: the key goes to a keyed pick (marked, or an unmarked balancer
                // given opts.key -- N2); a clock reading (now) never reaches a key-routed pick but
                // does drive pick(now) for any other clocked run (M3 + nit 7).
                let i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());
                if (attempt > 0) {
                    // F1: materialise the failover arrays from attempt 0's scalars, once, here.
                    // Build with push (not a [e0] literal): the literal would size the backing store to
                    // 1 and reallocate on the first failover push, costing MORE than the pre-F1 [] + push.
                    if (held === null) { held = []; held.push(e0); noteApplied = []; noteApplied.push(n0); }
                    // M2: genuinely DISTINCT failover. Re-pick while the result repeats a tried
                    // endpoint (bounded), then a scan for an eligible UNTRIED endpoint from a start that
                    // is key-derived (keyed: stable per key, spread across keys) or cursor-rotated.
                    for (let g = 0; i !== PICK_NONE && held.indexOf(i) >= 0 && g < REPICK_LIMIT; g++) {
                        i = useKey ? b.pick(key) : (useNow ? b.pick(now) : b.pick());
                    }
                    if (i === PICK_NONE || held.indexOf(i) >= 0) {
                        const cap = b.capacity;
                        const from = typeof key === 'number'
                            ? (Math.imul(key >>> 0, 0x9e3779b1) >>> 0) % cap
                            : (this._scanCursor = (this._scanCursor + 1) & 0x3fffffff) % cap;   // stays an SMI
                        i = _scanUntried(b, held, from);
                    }
                }
                if (i === PICK_NONE) {
                    if (attempt === 0) {
                        const e = new Error('[lite-pick] no eligible endpoint');
                        e.code = 'LITE_PICK_NONE';
                        throw e;
                    }
                    break;   // no distinct untried endpoint left: surface the last error
                }

                inflight[i] = (inflight[i] + 1) >>> 0;
                if (held === null) { d0 = true; e0 = i; } else { held.push(i); noteApplied.push(false); }
                if (notes) {
                    // A throwing note(+1) propagates (loud); the landed flag stays false so the finally
                    // never sends an UNPAIRED note(-1) for this dispatch (nit 8). inflight is released.
                    b.note(i, 1);
                    if (held === null) { n0 = true; } else { noteApplied[noteApplied.length - 1] = true; }
                }
                // D7 (1.1.0): guarded -- with nobody subscribed this is one property read, no message is built.
                if (_chDispatch !== null && _chDispatch.hasSubscribers) _pubDispatch(this, i, attempt, key, now);

                let out;
                let ok = false;
                try {
                    out = await fn(i, signal);
                    ok = true;
                } catch (err) {
                    lastErr = err;
                    // N1: a caller abort is not the endpoint's fault. Check it BEFORE the penalty, so a
                    // cancel never feeds the 1 s penalty into the EWMA (peak rule) or the pool mean.
                    if (signal && signal.aborted) {
                        if (_chSettle !== null && _chSettle.hasSubscribers) _pubSettleAbort(this, i, attempt, err);
                        throw err;                              // abort: stop failover, propagate
                    }
                    if (_chSettle !== null && _chSettle.hasSubscribers) _pubSettleErr(this, i, attempt, err);
                    if (rtt) {
                        // H1 penalty feedback in its OWN try/catch: fn's error identity is preserved.
                        // Boolean flag, not a null sentinel: a hook that throws `null` is still a failure.
                        let feFailed = false, feErr;
                        try {
                            const done = clock();
                            if (!Number.isFinite(done)) {
                                throw _clockInvalid(done);
                            }
                            let elapsed = done - now;
                            if (!(elapsed >= 0)) elapsed = 0;   // clamp (NaN-safe): backwards finite clock
                            const pen = elapsed > failurePenaltyNs ? elapsed : failurePenaltyNs;
                            b.recordRtt(i, pen, done);
                        } catch (fe) {
                            feFailed = true;
                            feErr = fe;
                        }
                        if (feFailed) {
                            // Broken clock/feedback: stop failing over (the pre-dispatch check would
                            // throw next attempt anyway) and throw fn's error, unchanged, with the
                            // feedback error attached non-enumerably (never replaced).
                            _attachFeedback(err, feErr);
                            throw err;
                        }
                    }
                    continue;                                   // keep inflight[i] elevated, re-pick distinct
                }
                if (ok) {
                    if (_chSettle !== null && _chSettle.hasSubscribers) _pubSettleOk(this, i, attempt);
                    if (rtt) {
                        // Settle feedback runs OUTSIDE the attempt's try/catch (never re-runs fn). If it
                        // fails, REJECT loudly with LITE_PICK_FEEDBACK carrying .cause and .result.
                        try {
                            const done = clock();
                            if (!Number.isFinite(done)) {
                                throw _clockInvalid(done);
                            }
                            // A backwards clock reading records NO sample: a fabricated 0 ns rtt would
                            // make the node look instant (cost 0 while idle) and drag down the pool mean.
                            // done === now is a real 0 reading from a coarse clock and IS recorded.
                            if (done >= now) b.recordRtt(i, done - now, done);
                        } catch (fe) {
                            const e = new Error('[lite-pick] settle-time feedback failed after a successful call');
                            e.code = 'LITE_PICK_FEEDBACK';
                            e.cause = fe;
                            e.result = out;
                            throw e;
                        }
                    }
                    return out;
                }
            }
            throw lastErr;
        } finally {
            // F1: release attempt 0's endpoint (held[0] == e0) FIRST, then the failover endpoints
            // held[1..] -- byte-for-byte the same order and the same net-zero as the pre-F1 held[0..]
            // loop. Settle note(-1) ONLY for a dispatch whose note(+1) landed (nit 8), and swallow a
            // cleanup-time throw so it never masks the error being thrown (identity preserved).
            if (d0) {
                inflight[e0] = inflight[e0] > 0 ? inflight[e0] - 1 : 0;
                if (notes && n0) {
                    try { b.note(e0, -1); } catch { /* best-effort net-zero cleanup */ }
                }
            }
            if (held !== null) {
                for (let k = 1; k < held.length; k++) {
                    const j = held[k];
                    inflight[j] = inflight[j] > 0 ? inflight[j] - 1 : 0;
                    if (notes && noteApplied[k]) {
                        try { b.note(j, -1); } catch { /* best-effort net-zero cleanup */ }
                    }
                }
            }
        }
    }
}

/**
 * liteQueryFetcher -- adapt a Pool into a fetcher for a query cache (lite-query's `fetcher`, or
 * any `({ key, signal }) => Promise` consumer). Duck-typed: imports NOTHING from lite-query.
 *
 *     const fetcher = liteQueryFetcher(pool, ({ endpoint, key, signal }) =>
 *         fetch(urls[endpoint] + '/' + key[0], { signal }).then(r => r.json()), { tries: 2 });
 *     query(qc, { key: ['users'], fetcher });
 *
 * The query cache owns TEMPORAL retry/backoff/staleness; the Pool owns SPATIAL failover across
 * the pool (`tries`). Wiring both is deliberate layering, never double-ownership (ADR 0007).
 *
 * `ctx.key` is the QUERY-CACHE key (arbitrary), passed through to `perEndpoint`; it is NOT the
 * integer ROUTING key a keyed balancer needs, so this generic adapter does not drive `pick(key)` --
 * a keyed balancer wired through it fails closed (supply routing keys via `pool.run` directly). A
 * `clock` (for a latency balancer) is forwarded when supplied in `opts`.
 *
 * @template T
 * @param {Pool} pool
 * @param {(ctx: { endpoint: number, key: any, signal?: { readonly aborted: boolean } }) => (Promise<T>|T)} perEndpoint
 * @param {{ tries?: number, clock?: () => number, failurePenaltyNs?: number }} [opts]  spatial failover
 *   attempts (default 1), an optional nanosecond clock, and the failure penalty -- all forwarded to
 *   `pool.run` (the clock/penalty feed a latency-aware balancer).
 * @returns {(ctx: { key: any, signal?: { readonly aborted: boolean } }) => Promise<T>}
 */
export function liteQueryFetcher(pool, perEndpoint, opts) {
    if (!(pool instanceof Pool)) throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] liteQueryFetcher needs a Pool');
    if (typeof perEndpoint !== 'function') {
        throw _err(TypeError, 'LITE_PICK_ARGUMENT', '[lite-pick] liteQueryFetcher needs a per-endpoint function');
    }
    const tries = opts && opts.tries != null ? opts.tries : 1;
    const clock = opts && typeof opts.clock === 'function' ? opts.clock : undefined;
    const failurePenaltyNs = opts && opts.failurePenaltyNs !== undefined ? opts.failurePenaltyNs : undefined;
    // Validate once at creation (fail closed early), not on every fetch.
    if (failurePenaltyNs !== undefined &&
        (typeof failurePenaltyNs !== 'number' || !Number.isFinite(failurePenaltyNs) || failurePenaltyNs <= 0)) {
        throw _err(RangeError, 'LITE_PICK_OPTION', '[lite-pick] failurePenaltyNs must be a finite number > 0');
    }
    return function fetcher(ctx) {
        const key = ctx ? ctx.key : undefined;
        const signal = ctx ? ctx.signal : undefined;
        return pool.run(
            (endpoint, sig) => perEndpoint({ endpoint, key, signal: sig }),
            { signal, tries, clock, failurePenaltyNs },
        );
    };
}
