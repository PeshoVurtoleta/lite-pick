/**
 * @zakkster/lite-pick soak -- durable JSONL stream + fatal handlers (audit RECOMMENDATIONS 1.12).
 *
 * A typed, self-describing stream. Every record carries `type`, a monotonic `seq`, and `tMs` (ms
 * since run start). Types: header | checkpoint | cycle | summary | fatal. SOAK_OUT overrides the
 * path; the default is benchmark/out/soak-<iso>-<sha7>.jsonl under the ignored out/ directory (so a
 * run never truncates a shared file). installFatalHandlers writes a fatal record + a summary with
 * reason:'fatal' on an uncaught exception or unhandled rejection, then exits 1 -- a crash always
 * leaves evidence in the stream.
 *
 * COLD module: writes are synchronous (appendFileSync) so a kill mid-run keeps a complete stream.
 */

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** Compute the default output path under benchmark/out/. */
export function defaultOutPath(sha) {
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const sha7 = sha ? String(sha).slice(0, 7) : 'nogit';
    const url = new URL('../out/soak-' + iso + '-' + sha7 + '.jsonl', import.meta.url);
    return fileURLToPath(url);
}

export function openStream(path, t0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');   // fresh stream
    return { path, t0, seq: 0 };
}

/** Append one typed record. Stamps type, seq, tMs. Returns the stamped record. */
export function writeRecord(stream, type, body) {
    const rec = body || {};
    rec.type = type;
    rec.seq = stream.seq++;
    rec.tMs = +(performance.now() - stream.t0).toFixed(1);
    appendFileSync(stream.path, JSON.stringify(rec) + '\n');
    return rec;
}

/** Write a single fatal record carrying the crash context. Synchronous. */
export function writeFatal(stream, kind, ctx, err) {
    const c = ctx || {};
    return writeRecord(stream, 'fatal', {
        kind,
        lane: c.lane === undefined ? null : c.lane,
        cycle: c.cycle === undefined ? null : c.cycle,
        seeds: c.seeds === undefined ? null : c.seeds,
        message: String(err && err.message ? err.message : err),
        stack: err && err.stack ? String(err.stack) : null,
    });
}

/**
 * Install uncaughtException + unhandledRejection handlers. Writes a fatal record, then a summary
 * (reason:'fatal') via writeSummary, then exits 1 -- a crash always leaves evidence in the stream.
 */
export function installFatalHandlers(stream, getContext, writeSummary) {
    let firing = false;
    const handle = (kind, err) => {
        if (firing) { process.exit(1); }
        firing = true;
        try {
            writeFatal(stream, kind, (getContext && getContext()) || {}, err);
            if (writeSummary) writeSummary('fatal');
        } catch (e) {
            try { process.stderr.write('soak: fatal-handler write failed -- ' + e + '\n'); } catch (e2) { /* ignore */ }
        }
        // S11: an unhandled rejection DURING A POOL LANE IS pool assertion A7 (zero unhandled rejections over
        // the run) -- a structured breach. An unhandled rejection anywhere else (no pool lane in flight) is
        // not a pool assertion at all; it is a CRASH, like an uncaughtException, never mislabelled A7.
        const ctx = (getContext && getContext()) || {};
        const msg = (err && err.stack ? err.stack : String(err)).replace(/\n/g, ' ');
        if (kind === 'unhandledRejection' && ctx.tier === 'pool') process.stderr.write('soak: BREACH pool=A7 lane=' + (ctx.lane || '*') + ' cycle=' + ctx.cycle + ' detail=unhandled rejection: ' + msg + '\n');
        else process.stderr.write('soak: CRASH -- ' + kind + ': ' + (err && err.stack ? err.stack : err) + '\n');
        process.exit(1);
    };
    process.on('uncaughtException', (err) => handle('uncaughtException', err));
    process.on('unhandledRejection', (err) => handle('unhandledRejection', err));
}
