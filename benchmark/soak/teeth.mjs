/**
 * @zakkster/lite-pick soak -- the TEETH MANIFEST (audit 2026-09-29, burst 9b).
 *
 * Everything that can decide a soak verdict, as CHECKS, and the declared GAPS: checks no must-fail control
 * proves yet. A gate without a control is a gate nobody has seen trip -- the S11/coverage finding. The meta-
 * test test/SoakTeeth.test.js lists the battery (`MUSTFAIL_LIST=1 node _mustfail.mjs`: builds every mutant,
 * runs nothing) and FAILS when
 *   1. a check is neither covered by a control nor a declared gap (a new gate / oracle / mode with no teeth);
 *   2. a declared gap IS covered (stale -- delete it, so this list only ever shrinks honestly);
 *   3. a control's spec is not well-formed against this manifest (validSpec: an unknown family, gate,
 *      pool assertion, lane, kind or line cause -- a typo'd spec can never match and would only MISS at
 *      nightly time);
 *   4. the universe below drifted from the code: GATE_NAMES vs what computeGates() returns, the breach
 *      families / pool assertions / quality kinds main.mjs emits, the INCONCLUSIVE / NOTE causes, the roster;
 *   5. the nightly's two MUSTFAIL_ONLY regexes do not partition the battery (every control exactly once).
 *
 * A check is covered by a control that
 *   - kind 'breach' (tokens T): runs main.mjs, may exit 1, and asserts a `soak: BREACH` spec whose tokens
 *     include every token of T (spec 'quality lane=P2C' covers 'quality lane=P2C', not 'quality kind=oracle');
 *   - kind 'line' (prefix P): asserts a stderr-line spec that starts with P, with exit `exit`;
 *   - kind 'mode' (m): runs main.mjs with SOAK_MUSTFAIL=m, may exit 1, AND asserts a spec (the mode must be
 *     seen to trip something specific, not merely to exit non-zero).
 * A `soak: CRASH` is never a check: the battery counts a crash as a MISS for every control.
 *
 * Zero-dep (Node 18 runs `npm test` with no install): imports only the soak's own pure modules.
 */

import { GATE_NAMES } from './gates.mjs';
import { MUSTFAIL_MODES } from './config.mjs';
import { ROSTER } from './lanes.mjs';
import { POOL_LANES } from './pool-lane.mjs';

/** Families main.mjs / jsonl.mjs emit as `soak: BREACH <family>...` (`gate=`, `pool=` carry a value). */
export const BREACH_FAMILIES = Object.freeze(['gate', 'invariants', 'phases', 'pool', 'quality', 'retention', 'tracker']);
/** Pool-lane assertions (pool-lane.mjs A1..A6; A7 = unhandled rejection). */
export const POOL_ASSERTIONS = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
/** `soak: BREACH quality ... kind=` values (oracle violation, weight-0 pick, chi-square rejection). */
export const QUALITY_KINDS = Object.freeze(['oracle', 'weightZero', 'chiSquare']);
/** Every `soak: INCONCLUSIVE -- <cause>` line prefix (gates.mjs inconclusive[], main.mjs quality lanes). */
export const INCONCLUSIVE_CAUSES = Object.freeze(['run interrupted before its end', 'lane ', 'hotAlloc[', 'gcPause[',
    'quality windows never sufficient']);
/** Every `soak: NOTE -- <gate>[` report-only line (gates.mjs notes[]). */
export const NOTE_GATES = Object.freeze(['hotAlloc']);

function breachCheck(spec) { return { id: spec, kind: 'breach', tokens: spec.split(' ') }; }

/** The full universe, derived from the lists above (each list is itself pinned to the code by the test). */
export function checks() {
    const out = [];
    for (const g of GATE_NAMES) out.push(breachCheck('gate=' + g));
    for (const l of ROSTER) out.push(breachCheck('quality lane=' + l));
    for (const k of QUALITY_KINDS) out.push(breachCheck('quality kind=' + k));
    out.push(breachCheck('invariants'), breachCheck('invariants kind=freeze'), breachCheck('retention'));
    for (const a of POOL_ASSERTIONS) out.push(breachCheck('pool=' + a));
    out.push(breachCheck('phases'), breachCheck('tracker'));
    for (const c of INCONCLUSIVE_CAUSES) out.push({ id: 'soak: INCONCLUSIVE -- ' + c, kind: 'line', prefix: 'soak: INCONCLUSIVE -- ' + c, exit: 3 });
    for (const g of NOTE_GATES) out.push({ id: 'soak: NOTE -- ' + g + '[', kind: 'line', prefix: 'soak: NOTE -- ' + g + '[', exit: null });
    for (const m of MUSTFAIL_MODES) out.push({ id: 'mode=' + m, kind: 'mode', mode: m });
    return out;
}

/**
 * Declared gaps: check id -> why it has no control yet. Bursts 9c2/9c3 (audit 2026-09-29) add the controls
 * and delete these lines; the meta-test fails on any line whose check became covered. NEVER add a line here to
 * make the meta-test pass for a NEW gate -- a new gate ships with its control.
 */
export const GAPS = Object.freeze({
    'gate=hotAlloc': '9c2: the gross tier (every window scavenged) has no control asserting it',
    'gate=gcPause': '9c3: needs a mutant that lengthens late GC pauses',
    'gate=rebuild': '9c3: the rebuild series can never activate (too few samples); make it report-only or add a micro-bench',
    'gate=totalPicks': '9c3: needs a run that does no work',
    'quality lane=SED': '9c2: shares the LeastConn argmin oracle path but is not proven on its own lane',
    'quality lane=NQ': '9c2: shares the LeastConn argmin oracle path but is not proven on its own lane',
    'invariants kind=freeze': '9c3: needs a run that drains positive-weight eligibility below 8',
    'phases': '9c3: needs a run where a chaos phase never fires',
    'tracker': '9c3: needs a run with a lite-leak tracker finding',
    'soak: INCONCLUSIVE -- hotAlloc[': '9c3: needs a lane whose every hot window saw a GC',
    'soak: INCONCLUSIVE -- gcPause[': '9c3: only reachable from a malformed record; prove via the report path or drop',
});

/** Values a `k=v` token of a BREACH spec may carry (lane ids: kernel, `#tiny`, pool). */
const TOKEN_VALUES = {
    gate: GATE_NAMES, pool: POOL_ASSERTIONS, kind: QUALITY_KINDS.concat(['freeze']),
    lane: ROSTER.concat(ROSTER.map((l) => l + '#tiny'), POOL_LANES),
};

/** null when `spec` (one of a control's specs) is well-formed against this manifest, else why not. */
export function validSpec(spec) {
    if (spec === null) return null;
    if (spec.startsWith('soak: ')) {
        for (const c of INCONCLUSIVE_CAUSES) if (spec.startsWith('soak: INCONCLUSIVE -- ' + c)) return null;
        for (const g of NOTE_GATES) if (spec.startsWith('soak: NOTE -- ' + g + '[')) return null;
        return 'line spec is no known INCONCLUSIVE cause / NOTE gate';
    }
    const toks = spec.split(' ').filter(Boolean);
    const fam = toks[0].split('=')[0];
    if (BREACH_FAMILIES.indexOf(fam) === -1) return 'unknown breach family ' + fam;
    for (const t of toks) {
        const eq = t.indexOf('=');
        if (eq === -1) { if (t !== toks[0]) return 'bare token ' + t + ' after the family'; continue; }
        const key = t.slice(0, eq), val = t.slice(eq + 1);
        if (!TOKEN_VALUES[key]) return 'unknown key ' + key;
        if (TOKEN_VALUES[key].indexOf(val) === -1) return 'unknown ' + key + ' value ' + val;
    }
    return null;
}

/** True when control `c` (a MUSTFAIL_LIST row; `specs` must ALL match, so any one of them proves its
 *  check) covers check `k`. */
export function covers(c, k) {
    const mayFail = c.status.indexOf(1) !== -1;
    if (k.kind === 'mode') return c.run === 'main' && c.mode === k.mode && mayFail && c.specs.length !== 0;
    if (c.run !== 'main') return false;
    return c.specs.some((sp) => {
        if (k.kind === 'line') return sp.startsWith(k.prefix) && (k.exit === null || c.status.indexOf(k.exit) !== -1);
        if (sp.startsWith('soak: ') || !mayFail) return false;
        const have = sp.split(' ').filter(Boolean);
        return k.tokens.every((t) => have.indexOf(t) !== -1);
    });
}
