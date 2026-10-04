/**
 * @zakkster/lite-pick soak -- run provenance header (audit RECOMMENDATIONS 1.12).
 *
 * buildHeader() gathers everything needed to COMPARE two runs: schema + package version, the git SHA
 * and dirty flag (read-only), the sha256 of the kernel files under test (so a patched kernel is
 * visible), the V8 + node versions, the execArgv flags, the machine's memory + CPU, the seed formula,
 * every gate constant, and the timer floor. A missing git SHA is null + a gitError field (fail
 * closed, never a fabricated value). COLD: runs once at startup.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { VERSION, KERNEL_URL, KERNEL_OVERRIDE, POOL_URL, POOL_OVERRIDE } from './kernel.mjs';
import { sha256File, checkParity } from './parity.mjs';
import { SEED_FORMULA } from './seeds.mjs';
import * as G from './gates.mjs';

// 3: header.kernel gains poolUrl/poolOverride (the LOADED pool is hashed) + header.parity (S6); cycle
// records gained gcPauseAvgMs/hotOps*N (S2). soak:report imports this constant (one source of truth).
// 4: pool cycle records gain assert8/downDispatch (S10), assert9/inflightArea/attemptArea (Little's law),
// simulated RTTs (rttP50Ns/rttP99Ns/rttMeanNs/svcMeanNs), simUs/events/traceHash (S9 deterministic simulation).
// 5: keyed lanes run at M = 4099 (was 257; S14), and oracle-lane quality records gain propertyChecks /
// propertyViol (+ rejMax/skipped kept for WeightedRandom, which now also runs a per-category oracle).
export const SCHEMA_VERSION = 5;

const PICK_PATH = fileURLToPath(KERNEL_URL);   // the RESOLVED kernel (SOAK_KERNEL override or in-tree)
const POOL_PATH = fileURLToPath(POOL_URL);     // the RESOLVED pool (SOAK_POOL override or in-tree) -- S6: it
                                               // hashed the in-tree Pool.js even when a mutant was loaded

// S14: git runs in the repository that holds this file (the SHA must not depend on the caller's cwd), with
// stderr captured (a "fatal: not a git repository" is reported in `error`, not printed), and `dirty` counts
// only TRACKED changes (an untracked scratch file does not make a run's kernel dirty).
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const GIT_OPTS = { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

function gitInfo() {
    try {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], GIT_OPTS).trim();
        let dirty = null;   // null (unknown), never false, if the status probe fails
        try {
            const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], GIT_OPTS);
            dirty = st.trim().length > 0;
        } catch (e) { /* dirty stays null: we could not determine it */ }
        return { sha, dirty, error: null };
    } catch (e) {
        return { sha: null, dirty: null, error: String(e && e.message ? e.message : e) };
    }
}

/** Measure the performance.now() floor (smallest nonzero delta) in nanoseconds. */
function timerFloorNs() {
    let floor = Infinity;
    for (let i = 0; i < 1000; i++) {
        const a = performance.now();
        let b = performance.now();
        while (b === a) b = performance.now();
        const d = (b - a) * 1e6;   // ms -> ns
        if (d > 0 && d < floor) floor = d;
    }
    return floor === Infinity ? 0 : +floor.toFixed(1);
}

/** Build the header record body (the caller stamps type/seq/tMs). */
export function buildHeader(cfg) {
    const git = gitInfo();
    // Fail closed when the caller demands provenance and none is establishable (CI: audit 1.12).
    if (cfg && cfg.requireProvenance && git.sha === null) {
        process.stderr.write('soak: FAIL -- SOAK_REQUIRE_PROVENANCE set but no git SHA (' + (git.error || 'unknown') + ')\n');
        process.exit(2);
    }
    const pickSha = sha256File(PICK_PATH);
    const poolSha = sha256File(POOL_PATH);
    const parity = checkParity();   // the IN-TREE shipped files vs benchmark/soak/parity.json (S6)
    const cpus = os.cpus();
    return {
        schemaVersion: SCHEMA_VERSION,
        pkgVersion: VERSION,
        startedAt: new Date().toISOString(),
        gitSha: git.sha,
        gitDirty: git.dirty,
        gitError: git.error,
        kernel: {
            pickSha256: pickSha,
            poolSha256: poolSha,
            kernelUrl: KERNEL_URL,
            kernelOverride: KERNEL_OVERRIDE,   // true when SOAK_KERNEL swapped in a scratch/mutant kernel
            poolUrl: POOL_URL,
            poolOverride: POOL_OVERRIDE,       // true when SOAK_POOL swapped in a scratch/mutant pool
        },
        // ok: true (pins match) | false (a shipped file differs) | null (pin file unreadable: unknown).
        parity: { ok: parity.ok, mismatched: parity.mismatched.map((m) => m.file), error: parity.error },
        node: process.version,
        v8: process.versions.v8,
        execArgv: process.execArgv.slice(),
        os: {
            platform: os.platform(),
            arch: os.arch(),
            totalmem: os.totalmem(),
            freemem: os.freemem(),
            cpuModel: cpus.length ? cpus[0].model : null,
            cpuCount: cpus.length,
        },
        config: {
            cycles: cfg.cycles, durationMs: cfg.durationMs, picks: cfg.picks, seed: cfg.seed,
            lanes: cfg.lanes, smoke: cfg.smoke, mustFail: cfg.mustFail,
            warmupCycles: cfg.warmupCycles, gateN: cfg.gateN, minActiveCycles: cfg.minActiveCycles,
        },
        seedFormula: SEED_FORMULA,
        gates: {
            heapMult: G.HEAP_MULT, heapSlackMB: G.HEAP_SLACK_MB,
            rssMult: G.RSS_MULT, rssSlackMB: G.RSS_SLACK_MB,
            hotOpsRatio: G.HOTOPS_RATIO,
            gcPauseMult: G.GCPAUSE_MULT, gcPauseAddMs: G.GCPAUSE_ADD_MS,
            gcMajorMax: G.GC_MAJOR_MAX, hotAllocMax: G.HOTALLOC_MAX,
            mwAlpha: G.MW_ALPHA,   // S2: timing drifts also need a one-sided Mann-Whitney p < this
            latP99Mult: G.LAT_P99_MULT, rssKeep: G.RSS_KEEP, rssLate: G.RSS_LATE,
        },
        timerFloorNs: timerFloorNs(),
    };
}

export { PICK_PATH, POOL_PATH };
