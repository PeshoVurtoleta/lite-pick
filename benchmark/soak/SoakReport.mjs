/**
 * @zakkster/lite-pick soak -- the JSONL analysis tool (audit 1.13).
 *
 *   node benchmark/soak/SoakReport.mjs [file.jsonl] [--baseline other.jsonl] [--out report.html]
 *                                       [--allow-override] [--allow-parity-mismatch]
 *
 * Reads a soak stream back and does three jobs:
 *   1. INTEGRITY: re-derive the verdict from the raw CYCLE records (via the SAME pure gates.mjs the run
 *      used, plus the failure signals the cycles carry) and check the stream is COMPLETE and consistent
 *      (record counts, a full lane x cycle grid, reason==='end', the exactly-derivable counters match).
 *      S12 (audit 2026-09-29) closed the fail-open paths: every summary counter is REQUIRED (deleting one
 *      no longer skips its check), `seq` must run 0..n-1 with no gap or duplicate, a cycle-bound run that
 *      ended must hold exactly header.config.cycles cycles per lane, and ANY `fatal` record (also one after
 *      the end summary) re-derives FAIL. Each issue is also printed to stderr as `soak:report: ISSUE <text>`.
 *      Exit 1 if it disagrees with the recorded verdict or the stream is inconsistent/incomplete -- so an
 *      edited summary or a dropped set of records is caught. (Consistent forgery of the cycle records
 *      themselves would need a MAC and is out of scope.)
 *   2. MARGINS: print each lane's gate margins (how close each gate came to its bound).
 *   3. REGRESSION (--baseline): diff two runs. FAILs on what does not depend on the machine: heap up
 *      > 2 MB (only when both ran the same Node major -- heap shifts with V8), a quality violation appearing
 *      where there was none (ALL kinds: oracle, weight-0, chi-square), a pool lane failing where it passed,
 *      or a lane missing. Throughput (down > 15%) and p99 (up > 25%) are REPORT-ONLY: one run against one
 *      run on a different VM is noise (research/soak-baseline.md: 16.6% between two runs on the SAME
 *      machine; hosted runners +/-10-20%) -- they print `soak:report: NOTE ...` and never fail. A zero or
 *      missing baseline value is a NOTE ("not compared"), never a silent skip. The baseline must itself pass
 *      integrity and not be an overridden stream.
 *
 * With --out it writes a self-contained HTML page of inline-SVG time-series (heap / throughput / p99 /
 * hot B/op per lane over cycles). It uses NO charting peer: lite-charts is a browser-canvas module with
 * no offline artifact (decisions/0014), so the SVG is hand-emitted here.
 *
 * A stream whose kernel or pool was OVERRIDDEN (SOAK_KERNEL / SOAK_POOL -- a teeth mutant) is not
 * evidence about the shipped code: the report exits 1 on it unless --allow-override is passed (to
 * analyse a mutant run on purpose). Likewise, a stream whose header parity (S6) is not ok -- the shipped
 * files did not match their pins when the run was made -- exits 1 unless --allow-parity-mismatch is passed.
 * A --baseline must be sound, GREEN, same-schema evidence: a foreign schema is BASELINE INCOMPATIBLE, an
 * integrity failure BASELINE INTEGRITY MISMATCH, and a re-derived non-PASS BASELINE NOT GREEN (all exit 1).
 *
 * Exit codes: 0 report ok (and, with --baseline, no regression); 1 integrity mismatch, a parity mismatch
 * (without --allow-parity-mismatch), a regression, an overridden kernel/pool (without --allow-override),
 * or a bad baseline (incompatible schema / integrity mismatch / not green); 2 a bad/unsupported stream
 * (missing file, a schemaVersion other than provenance.mjs's SCHEMA_VERSION, no summary), or an unknown flag.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGates, VERDICT } from './gates.mjs';
import { SCHEMA_VERSION } from './provenance.mjs';
import { GATE_N, WARMUP_CYCLES } from './config.mjs';
import { KERNEL_LANES } from './lanes.mjs';

// The static per-strategy flags, from the descriptor roster (single source of truth). Used to PIN each
// cycle's recorded flags so a forged flag (e.g. latencyLane:false on every PeakEWMA cycle to fake an
// inapplicable phase) is caught against the descriptor, not just cross-checked with the summary.
const REBUILD_LANES = new Set(['ConsistentHash', 'BoundedLoad', 'WeightedRandom']);   // strategies with a rebuild() table
const LANE_FLAGS = new Map();
for (const l of KERNEL_LANES) LANE_FLAGS.set(l.name, { weighted: !!l.weighted, loadAware: !!l.loadAware, latencyLane: !!l.latency, hasRebuild: REBUILD_LANES.has(l.name) });

const SCHEMA = SCHEMA_VERSION;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_DIR = join(ROOT, 'benchmark', 'out');

// Regression thresholds (--baseline). A change worse than these on a shared lane is a FAIL.
const REG = { hotOpsDownPct: 15, p99UpPct: 25, heapUpMB: 2 };   // throughput/p99: report-only (see header)
const nodeMajor = (v) => { const m = /^v(\d+)\./.exec(String(v || '')); return m ? +m[1] : null; };

function die(code, msg) { process.stderr.write('soak:report: ' + msg + '\n'); process.exit(code); }

const KNOWN_FLAGS = ['--baseline', '--out', '--allow-override', '--allow-parity-mismatch'];
/** Smallest edit-distance known flag (did-you-mean), or null when nothing is close. */
function didYouMean(flag) {
    let best = null, bestD = Infinity;
    for (const k of KNOWN_FLAGS) {
        const d = editDistance(flag, k);
        if (d < bestD) { bestD = d; best = k; }
    }
    return bestD <= Math.max(2, (flag.length / 3) | 0) ? best : null;
}
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = row[0]; row[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[n];
}
function parseArgs(argv) {
    const a = { file: null, baseline: null, out: null, allowOverride: false, allowParityMismatch: false };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        // A flag that takes a value must get one: a trailing `--baseline` used to be dropped silently, so a requested
        // comparison never ran and the report still exited 0 (QA 2026-10-05). Fail closed instead.
        if (v === '--baseline' || v === '--out') {
            const val = argv[i + 1];
            if (val === undefined || val === '' || val.startsWith('--')) die(2, v + ' needs a path');
            if (v === '--baseline') a.baseline = val; else a.out = val;
            i++;
        }
        else if (v === '--allow-override') a.allowOverride = true;
        else if (v === '--allow-parity-mismatch') a.allowParityMismatch = true;
        else if (v.startsWith('--')) { const s = didYouMean(v); die(2, 'unknown flag ' + v + (s ? ' -- did you mean ' + s + '?' : '')); }
        else if (a.file === null) a.file = v;
        else die(2, 'unexpected argument ' + v);
    }
    return a;
}

function mostRecentJsonl() {
    let names;
    try { names = readdirSync(OUT_DIR).filter((n) => n.endsWith('.jsonl')); }
    catch { die(2, 'no benchmark/out directory -- pass a file explicitly'); }
    if (!names.length) die(2, 'no *.jsonl in benchmark/out -- pass a file explicitly');
    names.sort();
    return join(OUT_DIR, names[names.length - 1]);
}

/** Parse a soak JSONL into { header, cycles, summary, fatals, loadIssues }. Fails closed on a bad stream.
 *  `summary` is the LAST summary (a crash after the end writes a second, reason 'fatal'); a fatal stream
 *  with no summary at all gets a synthesized FAIL summary (`synthesized`) and an issue. */
function load(path) {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { die(2, 'cannot read ' + path); }
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) die(2, 'empty stream ' + path);
    let header = null, summary = null, summaries = 0;
    const cycles = [], fatals = [], loadIssues = [];
    let seqBad = null;
    for (let i = 0; i < lines.length; i++) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { die(2, 'malformed JSONL line in ' + path); }
        if (o === null || typeof o !== 'object') die(2, 'non-object JSONL line in ' + path);
        // S12: seq is contiguous from 0 in file order -- a dropped, duplicated or reordered record shows.
        if (seqBad === null && o.seq !== i) seqBad = 'seq: record ' + i + ' has seq ' + JSON.stringify(o.seq) + ' (need ' + i + ')';
        if (o.type === 'header') header = o;
        else if (o.type === 'cycle') cycles.push(o);
        else if (o.type === 'summary') { summary = o; summaries++; }
        else if (o.type === 'fatal') fatals.push(o);
    }
    if (seqBad !== null) loadIssues.push(seqBad);
    if (!header) die(2, 'no header record in ' + path);
    if (header.schemaVersion !== SCHEMA) die(2, 'unsupported schemaVersion ' + header.schemaVersion + ' (need ' + SCHEMA + ') in ' + path);
    let synthesized = false;
    if (!summary) {
        if (!fatals.length) die(2, 'no summary record in ' + path + ' (an aborted run with no fatal handler?)');
        summary = { reason: 'fatal', verdict: 'FAIL', fatal: true };
        synthesized = true;
        loadIssues.push('no summary record: the run died before writing one (' + fatals[0].kind + ')');
    }
    // A second summary is legitimate only as the fatal handler's, after a fatal record.
    if (summaries > 1 && !(summary.reason === 'fatal' && fatals.length)) loadIssues.push(summaries + ' summary records (only a crash after the end writes a second)');
    return { header, cycles, summary, fatals, loadIssues, synthesized, path };
}

/** The summary counters main always writes (S12: REQUIRED -- a deleted counter is an issue, not a skip). */
const SUMMARY_COUNTERS = ['rollups', 'cyclesRun', 'qualityViolations', 'invariantFailures', 'retentionFailures',
    'poolFailures', 'findings', 'warnings', 'unhandledCount'];

/** A pool cycle that failed any assertion (also used by the baseline diff). */
function poolCycleFailed(c) {
    return c.assert1 === false || c.assert2 === false || c.assert3 === false ||
        c.assert4 === false || c.assert5_outcome === false || c.assert6_retention === false || c.lostRun === true ||
        c.assert8 === false || c.assert9 === false ||
        (c.trackerSize | 0) !== 0 || c.badCode != null || c.outcomeMiss != null;
}

/** The chaos phases that SHOULD fire for a lane -- MUST match main.mjs:applicablePhases (kept in sync;
 *  the cycle record carries the lane flags so the report re-derives this without trusting the summary). */
function applicablePhases(flags) {
    const a = ['flap', 'allDown', 'recover', 'sparse'];
    if (flags.weighted) a.push('weightRetune', 'allZero');
    if (flags.hasRebuild) a.push('rebuildStorm');
    if (flags.loadAware) a.push('hung');
    if (flags.latencyLane) a.push('slowNode', 'failFast', 'clockRegress', 'clockJump', 'clockFar', 'rttBurst');
    return a;
}

/** The kernel + tiny lane ids present in the cycle stream (pool lanes are gated separately in the run). */
function laneIdsOf(cycles) {
    const seen = [];
    const set = new Set();
    for (const c of cycles) {
        if (c.tier === 'pool') continue;
        if (!set.has(c.lane)) { set.add(c.lane); seen.push(c.lane); }
    }
    return seen;
}

/** Re-derive the verdict PRIMARILY from the raw CYCLE records (the pure gate verdict + the failure
 *  signals the cycles themselves carry), and check the stream is COMPLETE and internally consistent.
 *  This detects an inconsistent or incomplete stream -- an edited summary counter, a dropped/truncated
 *  set of cycle records, an aborted run -- so the summary cannot claim a PASS the raw records deny. It
 *  does NOT defend against consistent forgery of the cycle records themselves (that needs a MAC; out of
 *  scope). Returns { gate, verdict, lanes, issues }. */
function rederive(doc) {
    const { header, cycles, summary, fatals } = doc;
    const issues = doc.loadIssues.slice();
    // S12: required counters (a non-negative integer each) -- skipped only for a synthesized summary,
    // which already carries its own issue.
    if (!doc.synthesized) {
        for (const k of SUMMARY_COUNTERS) {
            if (!Number.isInteger(summary[k]) || summary[k] < 0) issues.push('summary.' + k + ' missing or not a count (' + JSON.stringify(summary[k]) + ')');
        }
        if (summary.breaches !== undefined && !(Array.isArray(summary.breaches) && summary.breaches.every((b) => typeof b === 'string'))) {
            issues.push('summary.breaches is not an array of strings');
        }
    }
    const kt = cycles.filter((c) => c.tier !== 'pool');
    const poolC = cycles.filter((c) => c.tier === 'pool');
    const lanes = laneIdsOf(cycles);

    // --- completeness: the stream must be whole (catches dropped / truncated records, an aborted run) --
    // An interrupted run (reason 'signal') is legitimate evidence: it re-derives INCONCLUSIVE (S5) unless
    // it was a forever run, for which a signal is the normal end. Any OTHER non-end reason is an issue.
    if (summary.reason && summary.reason !== 'end' && summary.reason !== 'signal') issues.push('run did not complete (reason=' + summary.reason + ')');
    const forever = !!header.config && header.config.cycles === 0 && header.config.durationMs === 0;
    const interrupted = !!summary.reason && summary.reason !== 'end' && !(summary.reason === 'signal' && forever);
    if (!doc.synthesized && cycles.length !== summary.rollups) issues.push('cycle records ' + cycles.length + ' != summary.rollups ' + summary.rollups);
    if (!doc.synthesized && cycles.length !== summary.cyclesRun) issues.push('cycle records ' + cycles.length + ' != summary.cyclesRun ' + summary.cyclesRun);
    // laneRoster is REQUIRED (fail closed): without it the grid check would silently pass a dropped lane.
    if (!Array.isArray(header.laneRoster)) die(2, 'header has no laneRoster (stream predates it) -- regenerate the soak');
    const byLane = new Map();
    for (const c of cycles) {
        if (!byLane.has(c.lane)) byLane.set(c.lane, new Set());
        const set = byLane.get(c.lane);
        if (set.has(c.cycle)) issues.push('duplicate cycle record: ' + c.lane + ' cycle ' + c.cycle);
        set.add(c.cycle);
    }
    for (const id of header.laneRoster) if (!byLane.has(id)) issues.push('lane missing from stream: ' + id);
    for (const id of byLane.keys()) if (header.laneRoster.indexOf(id) === -1) issues.push('lane not in header.laneRoster: ' + id);
    const gridCounts = header.laneRoster.filter((id) => byLane.has(id)).map((id) => byLane.get(id).size);
    if (gridCounts.length) {
        if (summary.reason === 'signal') {
            // A signal arrives MID-cycle: main processes lanes in header.laneRoster order within a cycle, so
            // the lanes that completed the final cycle k are a PREFIX of the roster. Counts are therefore k
            // then k-1, non-increasing, differing by at most 1 -- anything else is a genuinely ragged grid.
            const hi = gridCounts[0];
            let ok = true, seenLow = false;
            for (const n of gridCounts) {
                if (n === hi) { if (seenLow) { ok = false; break; } }
                else if (n === hi - 1) { seenLow = true; }
                else { ok = false; break; }
            }
            if (!ok) issues.push('ragged lane x cycle grid (signal run: cycle counts must be k or k-1 as a roster prefix)');
        } else if (gridCounts.some((n) => n !== gridCounts[0])) {
            issues.push('ragged lane x cycle grid (lanes have differing cycle counts)');
        }
    }
    // S12: each lane's cycles are 0..k-1 (no hole), and a cycle-bound run that ENDED ran exactly
    // header.config.cycles of them -- dropping whole cycles AND the summary counters no longer passes.
    for (const [id, set] of byLane) {
        for (let k = 0; k < set.size; k++) if (!set.has(k)) { issues.push('cycle grid hole: ' + id + ' has ' + set.size + ' cycles but not cycle ' + k); break; }
    }
    const wantCycles = header.config && Number.isInteger(header.config.cycles) ? header.config.cycles : null;
    if (wantCycles === null) issues.push('header.config.cycles missing');
    else if (wantCycles > 0 && summary.reason === 'end') {
        for (const id of header.laneRoster) {
            const n = byLane.has(id) ? byLane.get(id).size : 0;
            if (n !== wantCycles) issues.push('lane ' + id + ' has ' + n + ' cycles, header.config.cycles = ' + wantCycles);
        }
    }
    // Validate the gate-shaping config against the source-of-truth constants (shrinks the header.config
    // trust residual: a tampered warmupCycles/gateN that would force SMOKE is caught). `smoke` stays a
    // legitimate runtime choice and is trusted (documented in ADR 0014).
    if (header.config && header.config.gateN !== GATE_N) issues.push('header.config.gateN ' + header.config.gateN + ' != ' + GATE_N);
    if (header.config && header.config.warmupCycles !== WARMUP_CYCLES) issues.push('header.config.warmupCycles ' + header.config.warmupCycles + ' != ' + WARMUP_CYCLES);
    // Pin each kernel/tiny cycle's recorded lane flags against the descriptor (a "#tiny" lane maps to its
    // base strategy), so a forged flag that would make an applicable phase look inapplicable is caught.
    for (const c of kt) {
        const base = c.lane.replace(/#tiny$/, '');
        const f = LANE_FLAGS.get(base);
        if (!f) { issues.push('unknown lane in stream: ' + c.lane); continue; }
        if (!!c.weighted !== f.weighted || !!c.loadAware !== f.loadAware || !!c.latencyLane !== f.latencyLane || !!c.hasRebuild !== f.hasRebuild) {
            issues.push('lane flags for ' + c.lane + ' cycle ' + c.cycle + ' do not match the descriptor'); break;
        }
    }

    // --- gate verdict re-computed from the cycle rollups (poolLaunched summed, not assumed 0) ----------
    const poolLaunched = poolC.reduce((s, c) => s + (c.launched | 0), 0);
    const gate = computeGates(kt, {
        warmupCycles: header.config ? header.config.warmupCycles : 0,
        gateN: header.config ? header.config.gateN : 0,
        smoke: header.config ? header.config.smoke : false,
        lanes, timerFloorNs: header.timerFloorNs, poolLaunched, interrupted,
    });

    // --- failure signals derived from the cycle records themselves ------------------------------------
    const qViol = kt.reduce((s, c) => s + ((c.quality && c.quality.totalViolations) | 0), 0);
    const invFail = cycles.filter((c) => c.invariant && c.invariant !== 'green').length;
    // Non-pool only: pool retention is already counted by poolCycleFailed (assert6 / trackerSize) and
    // surfaces as summary.poolFailures -- counting a pool cycle's trackerSize here too would double-count it.
    const trackFail = kt.filter((c) => (c.trackerSize | 0) !== 0).length;
    const poolFail = poolC.filter(poolCycleFailed).length;

    // qualityViolations is EXACTLY re-derivable (main sums cycle.quality.totalViolations) -> require it.
    if ((summary.qualityViolations | 0) !== qViol) issues.push('qualityViolations: summary ' + (summary.qualityViolations | 0) + ' != cycles ' + qViol);
    // The others aggregate at checkpoint granularity, so cross-check ONE-DIRECTIONALLY: if the cycles
    // reveal a failure, the summary counter must not deny it.
    if (invFail > 0 && (summary.invariantFailures | 0) === 0) issues.push('cycles show ' + invFail + ' non-green invariant(s) but summary.invariantFailures=0');
    if (trackFail > 0 && (summary.retentionFailures | 0) === 0) issues.push('cycles show ' + trackFail + ' non-zero trackerSize but summary.retentionFailures=0');
    if (poolFail > 0 && (summary.poolFailures | 0) === 0) issues.push('cycles show ' + poolFail + ' pool assertion failure(s) but summary.poolFailures=0');

    const smoke = header.config && header.config.smoke;

    // phasesNotFired -- RE-DERIVED from the per-cycle phase counts + per-lane applicability (the cycle
    // records carry the lane flags), NOT trusted from the summary. main runs this self-check only for a
    // non-smoke completed run.
    const phasesNotFiredDerived = [];
    if (!smoke && summary.reason === 'end') {
        const laneCycles = new Map();
        for (const c of kt) { if (!laneCycles.has(c.lane)) laneCycles.set(c.lane, []); laneCycles.get(c.lane).push(c); }
        for (const [lane, cs] of laneCycles) {
            for (const p of applicablePhases(cs[0])) {   // flags are constant across a lane's cycles
                let sum = 0;
                for (const c of cs) sum += (c.phase && c.phase[p]) | 0;
                if (sum === 0) phasesNotFiredDerived.push(lane + '.' + p);
            }
        }
    }
    // inconclusiveLanes -- RE-DERIVED UNCONDITIONALLY, exactly as main computes it (main fills the summary
    // list even under smoke; it only skips FOLDING it into the verdict). A KERNEL lane is inconclusive if
    // no cycle was green AND sufficiently windowed. (Smoke-gating this list would false-mismatch a genuine
    // smoke stream, whose summary carries the list.)
    const inconclusiveDerived = [];
    for (const lane of new Set(kt.filter((c) => c.tier === 'kernel').map((c) => c.lane))) {
        if (!kt.some((c) => c.lane === lane && c.quality && c.quality.green && !c.quality.insufficientData)) inconclusiveDerived.push(lane);
    }
    // cross-check both against the summary (both directions).
    const setEq = (a, b) => { const A = new Set(a), B = new Set(b); return A.size === B.size && [...A].every((x) => B.has(x)); };
    if (!setEq(summary.phasesNotFired || [], phasesNotFiredDerived)) issues.push('phasesNotFired: summary [' + (summary.phasesNotFired || []).join(',') + '] != cycles [' + phasesNotFiredDerived.join(',') + ']');
    if (!setEq(summary.inconclusiveLanes || [], inconclusiveDerived)) issues.push('inconclusiveLanes: summary [' + (summary.inconclusiveLanes || []).join(',') + '] != cycles [' + inconclusiveDerived.join(',') + ']');

    // final verdict from cycle data. Only findings / warnings / unhandledCount stay summary-trusted (they
    // are genuinely run-level, not in the cycle records -- the accepted residual, see the MAC caveat).
    const cycleFail = qViol > 0 || invFail > 0 || trackFail > 0 || poolFail > 0 || phasesNotFiredDerived.length > 0;
    const runLevelFail = (summary.findings | 0) !== 0 || (summary.warnings | 0) !== 0 || (summary.unhandledCount | 0) !== 0;
    let verdict = gate.verdict;
    // main: a crash is never PASS. S12: ANY fatal record counts, also one written after the end summary.
    if (fatals.length || summary.fatal || summary.reason === 'fatal') verdict = VERDICT.FAIL;
    else if (cycleFail || runLevelFail) verdict = VERDICT.FAIL;
    else if (verdict === VERDICT.PASS && !smoke && inconclusiveDerived.length !== 0) verdict = VERDICT.INCONCLUSIVE;
    return { gate, verdict, lanes, issues };
}

// --- per-lane time series helpers (for margins + SVG) --------------------------------------------
function seriesByLane(cycles, lane, key) {
    return cycles.filter((c) => c.lane === lane).sort((a, b) => a.cycle - b.cycle).map((c) => {
        const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), c);
        return typeof v === 'number' ? v : (v == null ? null : Number(v));
    });
}
function median(a) {
    const b = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
    if (!b.length) return null;
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
/** Late-window median of a per-cycle series (the last N post-warmup cycles). */
function lateMedian(cycles, lane, key, warmup, N) {
    const rows = cycles.filter((c) => c.lane === lane && c.cycle >= warmup).sort((a, b) => a.cycle - b.cycle);
    const late = rows.slice(Math.max(0, rows.length - N)).map((c) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), c));
    return median(late.map((v) => (typeof v === 'number' ? v : Number(v))));
}

function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }

// --- main ----------------------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const file = args.file || mostRecentJsonl();
const doc = load(file);
const { header, cycles, summary } = doc;
const { gate, verdict, lanes, issues } = rederive(doc);
const breachList = Array.isArray(summary.breaches) ? summary.breaches.filter((b) => typeof b === 'string') : [];

process.stdout.write('soak:report ' + file.replace(ROOT, '') + '\n');
process.stdout.write('  pkg ' + header.pkgVersion + '  git ' + (header.gitSha ? header.gitSha.slice(0, 7) : '?') +
    (header.gitDirty ? '-dirty' : '') + '  schema ' + header.schemaVersion +
    '  cycles ' + summary.cyclesRun + '  lanes ' + lanes.length + '  wall ' + summary.wallSec + 's\n');
if (header.bopBias) process.stdout.write('  hotAlloc bias floor ' + header.bopBias.biasBytes + ' B/window (spread ' + header.bopBias.spreadBytes + ')\n');
// S6: is this evidence about the SHIPPED code? An overridden kernel/pool (a teeth mutant) is not.
const kh = header.kernel || {};
const overridden = kh.kernelOverride === true || kh.poolOverride === true;
const par = header.parity || null;
process.stdout.write('  kernel ' + (kh.pickSha256 ? kh.pickSha256.slice(0, 12) : '?') + (kh.kernelOverride ? ' (OVERRIDDEN)' : '') +
    '  pool ' + (kh.poolSha256 ? kh.poolSha256.slice(0, 12) : '?') + (kh.poolOverride ? ' (OVERRIDDEN)' : '') +
    '  parity ' + (par === null ? '?' : par.ok === true ? 'OK' : par.ok === false ? 'MISMATCH (' + par.mismatched.join(', ') + ')' : 'UNKNOWN (' + par.error + ')') + '\n');

// 1. INTEGRITY -----------------------------------------------------------------------------------
const integrityOk = verdict === summary.verdict && issues.length === 0;
process.stdout.write('  verdict recorded=' + summary.verdict + '  re-derived=' + verdict +
    (integrityOk ? '  [integrity OK]' : '  [INTEGRITY MISMATCH]') + '\n');
for (const iss of issues) { process.stdout.write('    ! ' + iss + '\n'); process.stderr.write('soak:report: ISSUE ' + iss + '\n'); }
for (const f of doc.fatals) process.stdout.write('    FATAL ' + f.kind + (f.lane != null ? ' lane=' + f.lane : '') + (f.cycle != null ? ' cycle=' + f.cycle : '') + ': ' + f.message + '\n');
for (const b of breachList) process.stdout.write('    breach: ' + b + '\n');
for (const why of gate.inconclusive) process.stdout.write('    inconclusive: ' + why + '\n');
for (const nt of gate.notes) process.stdout.write('    note: ' + nt + '\n');

// 2. MARGINS -------------------------------------------------------------------------------------
process.stdout.write('  per-lane gate verdicts:\n');
for (const pl of gate.perLane) {
    const g = pl.gates || pl;
    const parts = [];
    for (const name of ['heap', 'rss', 'hotOps', 'hotOpsSparse', 'gcPause', 'gcMajor', 'hotAlloc', 'latencyP99']) {
        const gg = g[name];
        if (gg && gg.verdict && gg.verdict !== VERDICT.SMOKE && gg.verdict !== VERDICT.STUB) parts.push(name + '=' + gg.verdict);
    }
    process.stdout.write('    ' + (pl.lane || pl.laneName || '?').padEnd(20) + parts.join(' ') + '\n');
}

// 2b. RETENTION DRAIN (report-only; no verdict effect) -------------------------------------------
// Per-lane max + median drainMs and max forcedGcTries, across every tier (kernel + pool). These are
// additive cycle fields (no SCHEMA_VERSION bump); an older stream without them prints `?`.
process.stdout.write('  per-lane retention drain (report-only):\n');
const drainLaneIds = [];
{
    const seen = new Set();
    for (const c of cycles) { if (!seen.has(c.lane)) { seen.add(c.lane); drainLaneIds.push(c.lane); } }
}
for (const id of drainLaneIds) {
    const drains = seriesByLane(cycles, id, 'drainMs').filter((v) => typeof v === 'number' && Number.isFinite(v));
    const tries = seriesByLane(cycles, id, 'forcedGcTries').filter((v) => typeof v === 'number' && Number.isFinite(v));
    const maxDrain = drains.length ? Math.max.apply(null, drains) : null;
    const medDrain = drains.length ? median(drains) : null;
    const maxTries = tries.length ? Math.max.apply(null, tries) : null;
    process.stdout.write('    ' + String(id).padEnd(20) +
        'drainMs max=' + (maxDrain == null ? '?' : maxDrain.toFixed(1)) +
        ' median=' + (medDrain == null ? '?' : medDrain.toFixed(1)) +
        '  forcedGcTries max=' + (maxTries == null ? '?' : maxTries) + '\n');
}

// 3. REGRESSION (--baseline) ---------------------------------------------------------------------
let regressionFail = false;
// The baseline must be sound, GREEN, same-schema evidence or the diff is meaningless.
function baselineSchema(path) {
    try { return JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]).schemaVersion; } catch { return undefined; }
}
if (args.baseline) {
    // A foreign-schema baseline is INCOMPATIBLE (its fields differ) -- a hard error (exit 1), checked BEFORE
    // load() because load() would die(2) on a foreign schema, which is the wrong code for a bad baseline.
    const baseSchema = baselineSchema(args.baseline);
    if (baseSchema !== undefined && baseSchema !== SCHEMA) die(1, 'BASELINE INCOMPATIBLE -- baseline schema ' + baseSchema + ' != ' + SCHEMA + ' (regenerate the baseline on this schema)');
    const base = load(args.baseline);
    // S12: the baseline must itself be sound evidence -- integrity OK and not an overridden stream.
    const bd = rederive(base);
    const bkh = base.header.kernel || {};
    if (bd.issues.length || bd.verdict !== base.summary.verdict) {
        for (const iss of bd.issues) process.stderr.write('soak:report: ISSUE baseline: ' + iss + '\n');
        die(1, 'BASELINE INTEGRITY MISMATCH -- ' + (bd.verdict !== base.summary.verdict ? 're-derived ' + bd.verdict + ' != recorded ' + base.summary.verdict : bd.issues.length + ' issue(s)'));
    }
    if ((bkh.kernelOverride === true || bkh.poolOverride === true) && !args.allowOverride) die(1, 'the BASELINE ran an overridden kernel/pool; pass --allow-override to compare against it');
    // A baseline must be GREEN: a re-derived FAIL or INCONCLUSIVE is not a valid comparison point.
    if (bd.verdict !== VERDICT.PASS) die(1, 'BASELINE NOT GREEN -- re-derived ' + bd.verdict + ' (a baseline must be a PASS run)');
    const bwarm = base.header.config ? base.header.config.warmupCycles : 0;
    const bN = base.header.config ? base.header.config.gateN : 3;
    const cwarm = header.config ? header.config.warmupCycles : 0;
    const cN = header.config ? header.config.gateN : 3;
    const baseLanes = laneIdsOf(base.cycles);
    const baseSet = new Set(baseLanes);
    const curSet = new Set(lanes);
    process.stdout.write('  vs baseline ' + args.baseline.replace(ROOT, '') + ' (' + base.header.pkgVersion + '/' + (base.header.gitSha ? base.header.gitSha.slice(0, 7) : '?') + ', node ' + (base.header.node || '?') + '):\n');
    // A report-only observation: stdout for the reader, stderr `soak:report: NOTE` for the teeth / CI log.
    const note = (lane, text) => { process.stdout.write('    ' + lane.padEnd(20) + text + '\n'); process.stderr.write('soak:report: NOTE ' + lane + ' ' + text + '\n'); };
    const cm = nodeMajor(header.node), bm = nodeMajor(base.header.node);
    const heapComparable = cm !== null && cm === bm;
    if (!heapComparable) note('*', 'heap not compared: baseline ran node ' + (base.header.node || '?') + ', this run ' + (header.node || '?') + ' (heap shifts with the V8 version)');
    // A baseline lane MISSING from the current run is a regression (a lane silently dropped), not "no data".
    for (const bl of baseLanes) if (!curSet.has(bl)) { regressionFail = true; process.stdout.write('    ' + bl.padEnd(20) + 'LANE MISSING from current run (was in baseline)\n'); }
    const currentOnly = lanes.filter((l) => !baseSet.has(l));
    if (currentOnly.length) process.stdout.write('    (current-only lanes, not compared: ' + currentOnly.join(', ') + ')\n');
    for (const lane of lanes) {
        if (!baseSet.has(lane)) continue;   // compared below only when present in BOTH; missing handled above
        const curOps = lateMedian(cycles, lane, 'hotOpsDense', cwarm, cN);
        const baseOps = lateMedian(base.cycles, lane, 'hotOpsDense', bwarm, bN);
        const curP99 = lateMedian(cycles, lane, 'latency.p99', cwarm, cN);
        const baseP99 = lateMedian(base.cycles, lane, 'latency.p99', bwarm, bN);
        const curHeap = lateMedian(cycles, lane, 'heapUsedMB', cwarm, cN);
        const baseHeap = lateMedian(base.cycles, lane, 'heapUsedMB', bwarm, bN);
        // S12: totalViolations (oracle + weight-0 + chi-square), not `violations` (oracle only).
        const curQ = cycles.filter((c) => c.lane === lane).reduce((s, c) => s + ((c.quality && c.quality.totalViolations) | 0), 0);
        const baseQ = base.cycles.filter((c) => c.lane === lane).reduce((s, c) => s + ((c.quality && c.quality.totalViolations) | 0), 0);
        const notes = [];
        // Timing: REPORT-ONLY (machine-dependent). A zero/missing baseline value is said, not skipped.
        if (!(baseOps > 0) || curOps == null) note(lane, 'throughput not compared (baseline ' + baseOps + ', current ' + curOps + ')');
        else {
            const d = (curOps - baseOps) / baseOps * 100;
            if (d < -REG.hotOpsDownPct) note(lane, 'throughput ' + pct(d) + ' vs baseline (report-only; > ' + REG.hotOpsDownPct + '% down)');
        }
        if (!(baseP99 > 0) || curP99 == null) note(lane, 'p99 not compared (baseline ' + baseP99 + ', current ' + curP99 + ')');
        else {
            const d = (curP99 - baseP99) / baseP99 * 100;
            if (d > REG.p99UpPct) note(lane, 'p99 ' + pct(d) + ' vs baseline (report-only; > ' + REG.p99UpPct + '% up)');
        }
        if (heapComparable) {
            if (baseHeap == null || curHeap == null) note(lane, 'heap not compared (baseline ' + baseHeap + ', current ' + curHeap + ')');
            else if ((curHeap - baseHeap) > REG.heapUpMB) { regressionFail = true; notes.push('HEAP +' + (curHeap - baseHeap).toFixed(1) + ' MB (> ' + REG.heapUpMB + ' MB)'); }
        }
        if (baseQ === 0 && curQ > 0) { regressionFail = true; notes.push('QUALITY 0 -> ' + curQ + ' violations'); }
        if (notes.length) process.stdout.write('    ' + lane.padEnd(20) + notes.join('; ') + '\n');
    }
    // S12: pool lanes are diffed too -- a pool lane dropped, or failing where the baseline passed.
    const poolLanesOf = (cs) => [...new Set(cs.filter((c) => c.tier === 'pool').map((c) => c.lane))];
    const curPool = poolLanesOf(cycles);
    for (const pl of poolLanesOf(base.cycles)) {
        if (curPool.indexOf(pl) === -1) { regressionFail = true; process.stdout.write('    ' + pl.padEnd(20) + 'LANE MISSING from current run (was in baseline)\n'); continue; }
        const curF = cycles.filter((c) => c.lane === pl && poolCycleFailed(c)).length;
        const baseF = base.cycles.filter((c) => c.lane === pl && poolCycleFailed(c)).length;
        if (baseF === 0 && curF > 0) { regressionFail = true; process.stdout.write('    ' + pl.padEnd(20) + 'POOL 0 -> ' + curF + ' failing cycle(s)\n'); }
    }
    if (!regressionFail) process.stdout.write('    no regression on shared lanes (heap' + (heapComparable ? '' : ' not compared') + ', quality, pool, lanes; timing is report-only)\n');
}

// SVG report (--out) -----------------------------------------------------------------------------
if (args.out) { writeFileSync(args.out, renderHtml(doc, gate, verdict, integrityOk, issues, breachList)); process.stdout.write('  wrote ' + args.out + '\n'); }

// exit: an overridden kernel/pool, a parity mismatch, an integrity mismatch, or a regression is a hard
// failure. Overridden is checked first (a mutant run is also a parity mismatch, but 'NOT A RELEASE SOAK'
// is the precise reason); then parity (the shipped files did not match their pins when the run was made).
if (overridden && !args.allowOverride) die(1, 'NOT A RELEASE SOAK -- the stream ran an overridden ' + (kh.kernelOverride ? 'kernel' : 'pool') + ' (SOAK_KERNEL/SOAK_POOL); pass --allow-override to analyse it anyway');
if (!(par && par.ok === true) && !args.allowParityMismatch) die(1, 'PARITY MISMATCH -- header.parity.ok is ' + (par === null ? 'absent' : JSON.stringify(par.ok)) + (par && Array.isArray(par.mismatched) && par.mismatched.length ? ' (' + par.mismatched.join(', ') + ')' : '') + '; the shipped files did not match their pins -- pass --allow-parity-mismatch to analyse it anyway');
if (!integrityOk) die(1, 'INTEGRITY MISMATCH -- ' + (verdict !== summary.verdict ? 're-derived verdict ' + verdict + ' != recorded ' + summary.verdict : issues.length + ' consistency issue(s)'));
if (regressionFail) die(1, 'REGRESSION vs baseline');
process.exit(0);

// --- HTML / SVG (self-contained, no external deps) ----------------------------------------------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function sparkline(values, w, h, color) {
    const nums = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    const fin = nums.filter((v) => v != null);
    if (fin.length < 2) return '<svg width="' + w + '" height="' + h + '"></svg>';
    const min = Math.min.apply(null, fin), max = Math.max.apply(null, fin);
    const span = max - min || 1;
    const n = nums.length;
    let d = '';
    for (let i = 0; i < n; i++) {
        if (nums[i] == null) continue;
        const x = (i / (n - 1)) * (w - 4) + 2;
        const y = h - 2 - ((nums[i] - min) / span) * (h - 4);
        d += (d ? ' L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
        '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>' +
        '<title>min ' + min.toFixed(2) + ' max ' + max.toFixed(2) + '</title></svg>';
}
function renderHtml(doc, gate, verdict, integrityOk, issues, breachList) {
    const { header, cycles, summary } = doc;
    const lanes = laneIdsOf(cycles);
    const metrics = [
        { key: 'heapUsedMB', label: 'heap MB', color: '#3b82f6' },
        { key: 'hotOpsDense', label: 'throughput/s', color: '#10b981' },
        { key: 'latency.p99', label: 'p99 ns', color: '#f59e0b' },
        { key: 'hotBytesPerOp', label: 'hot B/op', color: '#ef4444' },
        { key: 'drainMs', label: 'drain ms', color: '#8b5cf6' },
    ];
    let rows = '';
    for (const lane of lanes) {
        let cells = '<td class="lane">' + esc(lane) + '</td>';
        for (const m of metrics) {
            const s = seriesByLane(cycles, lane, m.key);
            const last = [...s].reverse().find((v) => typeof v === 'number');
            cells += '<td>' + sparkline(s, 160, 34, m.color) + '<div class="v">' + (last == null ? '-' : last.toFixed(m.key === 'hotBytesPerOp' ? 3 : 2)) + '</div></td>';
        }
        rows += '<tr>' + cells + '</tr>';
    }
    const head = metrics.map((m) => '<th>' + esc(m.label) + '</th>').join('');
    const vColor = verdict === 'PASS' ? '#10b981' : verdict === 'FAIL' ? '#ef4444' : '#f59e0b';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>lite-pick soak ' + esc(header.pkgVersion) + '</title><style>' +
        ':root{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:900px;margin:0 auto}' +
        'h1{font-size:18px;margin:0 0 4px}.meta{color:#888;font-size:12px;margin-bottom:16px}' +
        '.verdict{display:inline-block;padding:2px 10px;border-radius:6px;color:#fff;font-weight:600;background:' + vColor + '}' +
        'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #8883;vertical-align:top}' +
        'th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#888}.lane{font-weight:600;white-space:nowrap}' +
        '.v{font-size:11px;color:#888;margin-top:-4px}svg{display:block}</style></head><body>' +
        '<h1>lite-pick soak &middot; <span class="verdict">' + esc(verdict) + '</span></h1>' +
        '<div class="meta">pkg ' + esc(header.pkgVersion) + ' &middot; git ' + esc(header.gitSha ? header.gitSha.slice(0, 7) : '?') + (header.gitDirty ? '-dirty' : '') +
        ' &middot; ' + esc(String(summary.cyclesRun)) + ' cycles &middot; ' + esc(String(lanes.length)) + ' lanes &middot; ' + esc(String(summary.wallSec)) + 's' +
        ' &middot; node ' + esc(header.node || '?') + '</div>' +
        // S12: the integrity status and any fatal record are part of the evidence -- show them.
        '<div class="meta">integrity: <b style="color:' + (integrityOk ? '#10b981' : '#ef4444') + '">' + (integrityOk ? 'OK' : 'MISMATCH') + '</b>' +
        ' &middot; recorded ' + esc(summary.verdict) + ', re-derived ' + esc(verdict) +
        (issues.length ? '<br>' + issues.map(esc).join('<br>') : '') + '</div>' +
        (doc.fatals.length ? '<div class="meta" style="color:#ef4444">' + doc.fatals.map((f) => 'FATAL ' + esc(f.kind) + ': ' + esc(f.message)).join('<br>') + '</div>' : '') +
        (breachList.length ? '<div class="meta" style="color:#ef4444">' + breachList.map(esc).join('<br>') + '</div>' : '') +
        '<table><thead><tr><th>lane</th>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="meta" style="margin-top:16px">Time axis = cycle. Generated by benchmark/soak/SoakReport.mjs (no charting peer; inline SVG).</div>' +
        '</body></html>';
}
