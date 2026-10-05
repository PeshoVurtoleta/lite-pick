/**
 * pickEcosystem/live -- the KERNEL OVERLAY must-fail controls (B4). Proves `npm run overlay` has teeth:
 *   0. a CLEAN unmutated root -> overlay exits 0 (so control 1's non-zero is a real signal, not a flaky fail).
 *   1. a root whose Pool.js is a MUTANT that breaks capstone behaviour (the settle note sign flipped, so
 *      BoundedLoad's occupancy never drains -> G8 engine B fails INCONSISTENT) -> overlay exits NON-ZERO and the
 *      captured suite output names the G8 gate (not an npm ENOENT / wrong-reason failure).
 *   2. a root MISSING any one of Pick.js / Pool.js / Pick.d.ts / Pool.d.ts -> overlay fails closed with exit 2
 *      naming the missing file; a --root that is a regular file -> exit 2.
 *   3. an unknown flag -> overlay exits 2 with a did-you-mean.
 *   4. a SYMLINKED lite-pick (npm link / file: / pnpm): the overlay must rebuild lite-pick from the real pinned
 *      install inside its own temp tree and NEVER write THROUGH the link -- the link TARGET's Pool.js sha is
 *      unchanged after a full run, and the run still overlays correctly (exit 0). A cheap teeth proof shows the
 *      old write-through copy WOULD have clobbered that target, so the sha-unchanged check is not vacuous.
 * Prints "ok (N controls)" and exits 0, or names the control and exits 1. Run by `npm run overlay:teeth`.
 *
 * The link TARGET is always a SCRATCH copy of the package -- never the repo root or the real live/node_modules.
 */

import { copyFileSync, cpSync, writeFileSync, readFileSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const liveDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(liveDir, '..', '..');
const overlay = join(liveDir, 'test', 'overlay.mjs');
const FILES = ['Pick.js', 'Pool.js', 'Pick.d.ts', 'Pool.d.ts'];
const pinnedPkg = join(liveDir, 'node_modules', '@zakkster', 'lite-pick');
const log = (s) => process.stderr.write(s + '\n');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let fails = 0;
const check = (ok, what, detail) => { log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? ' -- ' + detail : '')); if (!ok) fails++; };
// capture BOTH streams: the overlaid `npm test` prints to the child overlay's stdout (inherited), so the gate
// name a mutant trips lands there -- a fail-closed overlay abort lands on stderr.
const runOverlay = (args, script) => spawnSync(process.execPath, [script || overlay, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

// control 0: a CLEAN root overlays and the suite passes -> exit 0 ------------------------------
{
    const r = runOverlay(['--root', repoRoot]);
    check(r.status === 0, 'a clean unmutated root overlays and the capstone suite passes', 'exit ' + r.status);
}

// control 1: a mutant root Pool.js breaks the overlaid suite -> non-zero, naming G8 -------------
// A FAILING G8 line, not merely a G8 line (a passing run lists `ok N - G8 ...` too): TAP `not ok N - G8` (piped
// Node 22) or the spec reporter's U+2716 mark (Node 26).
const G8_FAILED = /^\s*(?:not ok \d+ - |\u2716 )G8[^\n]*/m;
{
    const m = mkdtempSync(join(tmpdir(), 'overlay-teeth-mut-'));
    try {
        for (const f of FILES) copyFileSync(join(repoRoot, f), join(m, f));
        const src = readFileSync(join(m, 'Pool.js'), 'utf8');
        // Flip BOTH settle notes (the scalar first-attempt path `b.note(e0, -1)` and the failover-array path
        // `b.note(j, -1)`), so occupancy never drains -> BoundedLoad's total stays non-zero -> G8 engine B fails.
        const mutated = src.replace('b.note(e0, -1)', 'b.note(e0, 1)').replace('b.note(j, -1)', 'b.note(j, 1)');
        check(mutated !== src && !mutated.includes('b.note(e0, -1)'), 'the mutant actually changed root Pool.js (b.note settle sign)');
        writeFileSync(join(m, 'Pool.js'), mutated);
        const r = runOverlay(['--root', m]);
        const out = (r.stdout || '') + (r.stderr || '');
        check(r.status !== 0 && r.status !== 2, 'a mutant root Pool.js makes the overlaid capstone suite fail', 'exit ' + r.status);
        check(G8_FAILED.test(out), 'the failure is the G8 gate (not an ENOENT / wrong-reason failure)', out.match(G8_FAILED)?.[0] || '(no failing G8 line)');
    } finally { rmSync(m, { recursive: true, force: true }); }
}

// control 2: a root missing ANY one of the four kernel files (Pool.js, and each .js / .d.ts) -> exit 2 (fail
// closed, naming the missing file), and a --root that is a regular FILE, not a dir -> exit 2. A preflight that
// checked only the .js files would let a missing .d.ts reach copyFileSync -> ENOENT -> exit 1, not 2.
{
    for (const missing of FILES) {
        const m = mkdtempSync(join(tmpdir(), 'overlay-teeth-missing-'));
        try {
            for (const f of FILES) if (f !== missing) copyFileSync(join(repoRoot, f), join(m, f));
            const r = runOverlay(['--root', m]);
            check(r.status === 2 && r.stderr.includes('is missing ' + missing), 'a root missing ' + missing + ' exits 2 naming it', 'exit ' + r.status);
        } finally { rmSync(m, { recursive: true, force: true }); }
    }
    const r = runOverlay(['--root', join(repoRoot, 'Pool.js')]);
    check(r.status === 2, 'a --root that is a regular file (not a kernel dir) exits 2', 'exit ' + r.status);
}

// control 3: an unknown flag -> exit 2 with a did-you-mean --------------------------------------
{
    const r = runOverlay(['--rooot', repoRoot]);
    check(r.status === 2 && /did you mean --root\?/.test(r.stderr), 'an unknown flag exits 2 with a did-you-mean', 'exit ' + r.status);
}

// control 4: a SYMLINKED lite-pick -- the overlay must not write through the link ---------------
{
    // scratch repo: a FULL copy of the repo whose live/node_modules/@zakkster/lite-pick is a SYMLINK to a
    // throwaway copy of the pinned package. We run a copy of overlay.mjs that lives in this scratch tree, so its
    // liveDir / repoRoot resolve here. The link TARGET is scratch -- never the repo root or the real install.
    const scratchRepo = mkdtempSync(join(tmpdir(), 'overlay-teeth-link-repo-'));
    const target = mkdtempSync(join(tmpdir(), 'overlay-teeth-link-target-'));
    try {
        cpSync(realpathSync(pinnedPkg), target, { recursive: true, dereference: true });
        const origSha = sha256(join(target, 'Pool.js'));
        // build the scratch repo (dereference so the copy itself has no stray links), then swap lite-pick for a link
        cpSync(join(repoRoot, 'pickEcosystem'), join(scratchRepo, 'pickEcosystem'), { recursive: true, dereference: true });
        cpSync(join(repoRoot, 'demo'), join(scratchRepo, 'demo'), { recursive: true, dereference: true });
        for (const f of FILES) copyFileSync(join(repoRoot, f), join(scratchRepo, f));
        const scratchLink = join(scratchRepo, 'pickEcosystem', 'live', 'node_modules', '@zakkster', 'lite-pick');
        rmSync(scratchLink, { recursive: true, force: true });
        symlinkSync(target, scratchLink);
        check(sha256(join(scratchLink, 'Pool.js')) === origSha, 'the scratch lite-pick is a link onto the scratch target');

        const scratchOverlay = join(scratchRepo, 'pickEcosystem', 'live', 'test', 'overlay.mjs');
        const r = runOverlay([], scratchOverlay);
        check(r.status === 0, 'the overlay runs correctly through a symlinked lite-pick (suite passes)', 'exit ' + r.status);
        check(sha256(join(target, 'Pool.js')) === origSha, 'the symlink TARGET Pool.js is UNCHANGED (never written through the link)');

        // teeth: the OLD write-through copy (dereference top-level only, then copyFileSync) WOULD clobber the
        // target -- prove it cheaply so the sha-unchanged check above is not vacuous.
        const tmpNm = mkdtempSync(join(tmpdir(), 'overlay-teeth-link-old-'));
        try {
            cpSync(join(scratchRepo, 'pickEcosystem', 'live', 'node_modules'), tmpNm, { recursive: true, dereference: true });
            copyFileSync(join(repoRoot, 'Pool.js'), join(tmpNm, '@zakkster', 'lite-pick', 'Pool.js'));
            check(sha256(join(target, 'Pool.js')) !== origSha, 'the old write-through copy clobbers the link target (so the check has teeth)');
        } finally { rmSync(tmpNm, { recursive: true, force: true }); }
    } finally {
        rmSync(scratchRepo, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
    }
}

if (fails) { process.stderr.write('', () => process.exit(1)); }
else process.stdout.write('ok (5 controls)\n', () => process.exit(0));
