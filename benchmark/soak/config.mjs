/**
 * @zakkster/lite-pick soak -- configuration parsing (audit RECOMMENDATIONS 1.1, 1.2).
 *
 * FAIL CLOSED: an invalid, out-of-range, or unknown SOAK_* value is an ERROR that calls
 * process.exit(2) with a human line on stderr -- never a silent default, and `null` is never
 * treated as `0`. readConfig(env, roster) returns a frozen config object or exits.
 *
 * This is a COLD module: it runs once at startup. No hot-path constraints apply here.
 */

// N = the number of post-warmup cycles each side of the early/late split needs; a gate is
// active only at >= 2*N + WARMUP cycles. N=5, WARMUP=1 -> the floor of 11. N was 3 (floor 7) until S2
// (audit 2026-09-29): one noisy cycle moved a median of three, and an exact one-sided Mann-Whitney test
// cannot reach p < 0.01 with 3 samples per side (its smallest p is 1/20); with 5 it is 1/252.
export const GATE_N = 5;
export const WARMUP_CYCLES = 1;
export const MIN_ACTIVE_CYCLES = 2 * GATE_N + WARMUP_CYCLES; // 11

export const PICKS_MIN = 20000;
export const PICKS_MAX = 1 << 24;   // 16777216
export const DEFAULT_PICKS = 100000;   // the quiet-after phase (>=50%) then holds >= 4 WeightedRandom
                                       // chi-square windows of 8192 picks -- so the oracle actually runs
export const DEFAULT_CYCLES = MIN_ACTIVE_CYCLES;
export const DEFAULT_SEED = 0xC0FFEE >>> 0;

// Smoke overrides: a fast bounded run BELOW the gate floor, so drift gates report SMOKE.
export const SMOKE_CYCLES = 3;
export const SMOKE_PICKS = PICKS_MIN;

// Every SOAK_* key the harness understands. An env key with the SOAK_ prefix that is not
// here is a typo -> exit 2 with a did-you-mean hint (fail closed on unknown option).
const KNOWN_KEYS = [
    'SOAK_CYCLES', 'SOAK_DURATION', 'SOAK_PICKS', 'SOAK_SEED', 'SOAK_LANES',
    'SOAK_SMOKE', 'SOAK_OUT', 'SOAK_MUSTFAIL', 'SOAK_KERNEL', 'SOAK_POOL',
    'SOAK_REQUIRE_PROVENANCE',
];

// Every SOAK_MUSTFAIL mode is WIRED to actually trip a gate (exit 1); an unknown value is an error,
// never a silent no-op. leak->retention, heap->heap-drift, rss->memory-runaway (the resident buffer
// forces a workload major GC -> the gcMajor gate, which fires before the deliberately generous RSS
// runaway threshold), decay->dense hotOps, decaysparse->sparse hotOps (proves the split series has
// teeth on its own), weight0->quality(H3 guard), imbalance->quality(distribution).
export const MUSTFAIL_MODES = Object.freeze(['leak', 'heap', 'slowleak', 'rss', 'decay', 'decaysparse', 'weight0', 'imbalance',
    // pool-lane teeth (T14-15): poolleak->quiescence(A2), poolnote->totalInflight(A1), pooldrop->
    // accounting(A3), poolbadcode->rejection-codes(A4), poolretain->retention(A6), poolunhandled->A7.
    'poolleak', 'poolnote', 'pooldrop', 'poolbadcode', 'poolretain', 'poolunhandled']);

const DURATION_RE = /^[1-9]\d*(s|m|h)$/;
const INT_RE = /^-?\d+$/;

function fail(msg) {
    process.stderr.write('soak: FAIL -- ' + msg + '\n');
    process.exit(2);
}

/** Levenshtein distance (cold, tiny) -> the closest known key for the did-you-mean hint. */
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = d[0];
        d[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = d[j];
            d[j] = Math.min(
                d[j] + 1,
                d[j - 1] + 1,
                prev + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1),
            );
            prev = tmp;
        }
    }
    return d[n];
}

function nearestKey(key) {
    let best = null, bestD = Infinity;
    for (const k of KNOWN_KEYS) {
        const dd = editDistance(key, k);
        if (dd < bestD) { bestD = dd; best = k; }
    }
    return bestD <= 4 ? best : null;
}

/** Strict integer env parse. raw is the string value (already known defined). */
function parseIntEnv(name, raw, min, max, allowZero) {
    if (!INT_RE.test(raw)) {
        fail(name + "='" + raw + "' must be an integer" +
            (allowZero ? ' >= ' + min + ' (or 0)' : ' in [' + min + ', ' + max + ']'));
    }
    const v = Number(raw);
    if (!Number.isInteger(v)) fail(name + "='" + raw + "' is not an integer");
    if (allowZero && v === 0) return 0;
    if (v < min || v > max) {
        fail(name + "='" + raw + "' out of range [" + min + ', ' + max + ']');
    }
    return v;
}

/** Parse SOAK_DURATION into milliseconds. Enforces the `^[1-9]\d*(s|m|h)$` grammar. */
function parseDuration(raw) {
    if (!DURATION_RE.test(raw)) {
        fail("SOAK_DURATION='" + raw + "' must match /^[1-9]\\d*(s|m|h)$/ (for example 30m, 8h, 45s)");
    }
    const unit = raw[raw.length - 1];
    const n = Number(raw.slice(0, -1));
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
    return n * mult;
}

function parseBool(name, raw) {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    fail(name + "='" + raw + "' must be one of 1|0|true|false");
}

function parseEnum(name, raw, allowed) {
    if (allowed.indexOf(raw) === -1) {
        fail(name + "='" + raw + "' -- did you mean " + allowed.join(' | ') + '?');
    }
    return raw;
}

/**
 * Parse the SOAK_* environment. `roster` is the array of valid lane names (kernel roster).
 * Returns a frozen config, or calls process.exit(2) on any bad/unknown input.
 */
export function readConfig(env, roster) {
    // 1) Reject any unknown SOAK_* key first, so a typo never gets a silent default.
    for (const key of Object.keys(env)) {
        if (key.indexOf('SOAK_') !== 0) continue;
        if (KNOWN_KEYS.indexOf(key) !== -1) continue;
        const hint = nearestKey(key);
        fail("unknown env key '" + key + "'" + (hint ? " (did you mean " + hint + '?)' : ''));
    }

    const has = (k) => Object.prototype.hasOwnProperty.call(env, k) && env[k] !== undefined;

    // 2) SMOKE flag (a bad value fails closed).
    const smoke = has('SOAK_SMOKE') ? parseBool('SOAK_SMOKE', env.SOAK_SMOKE) : false;
    // CI sets this so a run with no establishable provenance (no git SHA -- e.g. a shallow checkout)
    // FAILs closed at header build rather than producing an uncomparable stream (audit 1.12).
    const requireProvenance = has('SOAK_REQUIRE_PROVENANCE') ? parseBool('SOAK_REQUIRE_PROVENANCE', env.SOAK_REQUIRE_PROVENANCE) : false;

    // 3) CYCLES vs DURATION are mutually exclusive.
    const hasCycles = has('SOAK_CYCLES');
    const hasDuration = has('SOAK_DURATION');
    if (hasCycles && hasDuration) {
        fail('SOAK_CYCLES and SOAK_DURATION cannot be combined -- pick one endurance unit');
    }

    let cycles = smoke ? SMOKE_CYCLES : DEFAULT_CYCLES;
    let durationMs = 0;
    if (hasDuration) {
        durationMs = parseDuration(env.SOAK_DURATION);
        cycles = 0; // duration-bound: cycle count is open-ended
    } else if (hasCycles) {
        // integer >= MIN_ACTIVE_CYCLES, or exactly 0 for forever.
        cycles = parseIntEnv('SOAK_CYCLES', env.SOAK_CYCLES, MIN_ACTIVE_CYCLES, 0x7fffffff, true);
    }

    // 4) PICKS.
    let picks = smoke ? SMOKE_PICKS : DEFAULT_PICKS;
    if (has('SOAK_PICKS')) {
        picks = parseIntEnv('SOAK_PICKS', env.SOAK_PICKS, PICKS_MIN, PICKS_MAX, false);
    }

    // 5) SEED (uint32).
    let seed = DEFAULT_SEED;
    if (has('SOAK_SEED')) {
        const v = parseIntEnv('SOAK_SEED', env.SOAK_SEED, 0, 0xFFFFFFFF, true);
        seed = v >>> 0;
    }

    // 6) LANES -- a comma-separated subset of the roster (order follows the roster).
    let lanes = roster.slice();
    if (has('SOAK_LANES')) {
        const requested = env.SOAK_LANES.split(',').map((s) => s.trim()).filter((s) => s.length);
        if (requested.length === 0) fail("SOAK_LANES='" + env.SOAK_LANES + "' selects no lanes");
        for (const nm of requested) {
            if (roster.indexOf(nm) === -1) {
                fail("SOAK_LANES: unknown lane '" + nm + "' (roster: " + roster.join(', ') + ')');
            }
        }
        lanes = roster.filter((nm) => requested.indexOf(nm) !== -1);
    }

    // 7) MUSTFAIL (teeth knob; every mode is wired to trip a gate, validated, fail closed).
    const mustFail = has('SOAK_MUSTFAIL')
        ? parseEnum('SOAK_MUSTFAIL', env.SOAK_MUSTFAIL, MUSTFAIL_MODES)
        : null;

    // 8) OUT -- an empty string is invalid (fail closed, never a silent default-path fallback).
    if (has('SOAK_OUT') && env.SOAK_OUT === '') fail("SOAK_OUT='' is not a valid path");
    const out = has('SOAK_OUT') ? env.SOAK_OUT : null;

    return Object.freeze({
        cycles, durationMs, picks, seed, lanes, smoke, mustFail, out, requireProvenance,
        warmupCycles: WARMUP_CYCLES, gateN: GATE_N, minActiveCycles: MIN_ACTIVE_CYCLES,
        picksMin: PICKS_MIN, picksMax: PICKS_MAX,
        forever: cycles === 0 && durationMs === 0,
        durationBound: durationMs > 0,
    });
}
