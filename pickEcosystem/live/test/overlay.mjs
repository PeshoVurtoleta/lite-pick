/**
 * pickEcosystem/live -- the KERNEL OVERLAY gate (B4, the audit's alternative to a bytes-identical check).
 *
 * The capstone pins the PUBLISHED bricks (lite-pick 1.1.0); the repo ROOT carries the working-tree kernel
 * (Pick.js/Pool.js/*.d.ts), which is usually AHEAD of the last release (e.g. an unreleased Pool.js fast path).
 * A "must be byte-identical" check would be red until every release -- the wrong gate. Instead this overlay
 * runs the capstone's OWN test suite a second time against the ROOT kernel:
 *
 *   1. copy pickEcosystem/live (minus node_modules) + a copy of its node_modules into a throwaway temp dir,
 *   2. overwrite node_modules/@zakkster/lite-pick/{Pick,Pool}.js + {Pick,Pool}.d.ts with the ROOT files
 *      (and drop the same four at the temp repo root, so the suite's `../../../Pick.js` parity import and the
 *      `@zakkster/lite-pick` import both see the root kernel),
 *   3. VERIFY by sha256 that the overlay actually took (fail closed: exit 2 if any file did not land),
 *   4. print an info line naming which of the four DIFFER from the pinned 1.1.0 (the expected dev skew),
 *   5. run `npm test` there and exit with its code.
 *
 * Flags: `--root <dir>` (default ../.. -- the repo root from pickEcosystem/live). An unknown flag is a typo,
 * not a silent default: exit 2 with a did-you-mean. The temp dir is always removed (no dirs left behind).
 *
 * Run by `npm run overlay`; the must-fail controls are `npm run overlay:teeth` (test/overlay-teeth.mjs).
 */

import { cpSync, copyFileSync, rmSync, mkdtempSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILES = ['Pick.js', 'Pool.js', 'Pick.d.ts', 'Pool.d.ts'];
const liveDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (s) => process.stderr.write(s + '\n');

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---- flags (fail closed on a typo) ------------------------------------------------------------
const FLAGS = ['--root'];
function editDistance(a, b) {
    const m = a.length, n = b.length;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = d[0]; d[0] = i;
        for (let j = 1; j <= n; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
    }
    return d[n];
}
const repoRoot = resolve(liveDir, '..', '..');   // the capstone's own repo (demo/ and the default kernel live here)
let root = repoRoot;                             // the KERNEL tree under overlay (Pick/Pool .js/.d.ts); --root overrides
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
        const v = argv[++i];
        if (v == null || v === '' || v.startsWith('--')) { log('overlay: --root needs a path'); process.exit(2); }
        root = resolve(v);
        continue;
    }
    let best = null, bestD = Infinity;
    for (const f of FLAGS) { const dd = editDistance(a, f); if (dd < bestD) { bestD = dd; best = f; } }
    log('overlay: unknown flag ' + a + (best && bestD <= 4 ? ' (did you mean ' + best + '?)' : ''));
    process.exit(2);
}

// ---- preflight: the root must carry all four kernel files (fail closed) -----------------------
for (const f of FILES) {
    if (!existsSync(join(root, f))) { log('overlay: root ' + root + ' is missing ' + f + ' -- not a kernel tree'); process.exit(2); }
}
const pinnedPkg = join(liveDir, 'node_modules', '@zakkster', 'lite-pick');
if (!existsSync(join(pinnedPkg, 'package.json'))) { log('overlay: pinned @zakkster/lite-pick not installed under ' + liveDir + '/node_modules'); process.exit(2); }
const pinnedVersion = JSON.parse(readFileSync(join(pinnedPkg, 'package.json'), 'utf8')).version;

// ---- build the temp tree ----------------------------------------------------------------------
// A fail-closed abort must NOT skip the temp-dir cleanup, so the whole body runs inside main() and
// every failure RETURNS a code -- the single process.exit is after the finally (no temp dir leaks).
function main(base) {
    const liveCopy = join(base, 'pickEcosystem', 'live');
    const liveNm = join(liveDir, 'node_modules');
    // copy the whole pickEcosystem/ (the hub index.html/graph.json + the live source the suite reaches through
    // `../`) MINUS live/node_modules, which we copy separately so overwriting lite-pick never touches the real one.
    cpSync(join(repoRoot, 'pickEcosystem'), join(base, 'pickEcosystem'), {
        recursive: true,
        filter: (src) => src !== liveNm && !src.startsWith(liveNm + sep),
    });
    // dereference: live/node_modules may itself be a SYMLINK (the CI reproduction symlinks it to the one real
    // install) -- copy the real tree so overwriting lite-pick never writes THROUGH the link into the original.
    cpSync(liveNm, join(liveCopy, 'node_modules'), { recursive: true, dereference: true });
    // the suite's `../../../demo/...` and the source's `../../demo/...` both resolve to <temp-root>/demo -- demo is
    // a fixed capstone dependency, so it always comes from the real repo, never from --root (which is only the kernel)
    cpSync(join(repoRoot, 'demo'), join(base, 'demo'), { recursive: true });

    // ---- overlay the ROOT kernel: into node_modules AND at the temp repo root --------------------
    // cpSync dereference follows a symlinked TOP-LEVEL node_modules, but NOT a nested
    // node_modules/@zakkster/lite-pick link (npm link / file: / pnpm nest the link one level down) -- that
    // link survives the copy, and copyFileSync would then write THROUGH it into the real installed package (or,
    // with npm link, into the repo's working-tree Pool.js). Remove whatever landed at lite-pick and rebuild it
    // from the REAL pinned install (realpathSync resolves any link) as plain files inside the temp tree.
    const overlaidPkg = join(liveCopy, 'node_modules', '@zakkster', 'lite-pick');
    rmSync(overlaidPkg, { recursive: true, force: true });
    cpSync(realpathSync(pinnedPkg), overlaidPkg, { recursive: true, dereference: true });

    const realBase = realpathSync(base);
    const pinnedSha = {}, rootSha = {};
    for (const f of FILES) {
        pinnedSha[f] = sha256(join(overlaidPkg, f));     // the pinned bytes (now plain files), BEFORE we overwrite
        rootSha[f] = sha256(join(root, f));
        // unlink first: a FILE-level link inside the pinned package survives cpSync's dereference, and
        // copyFileSync onto a link writes THROUGH it -- removing the destination replaces the link, never its target
        rmSync(join(overlaidPkg, f), { force: true });
        copyFileSync(join(root, f), join(overlaidPkg, f));
        rmSync(join(base, f), { force: true });
        copyFileSync(join(root, f), join(base, f));      // `../../../Pick.js` parity import sees root too
    }
    // fail closed: every overlaid file must resolve to a real path INSIDE the temp tree -- never through a
    // surviving link to the real install or the working tree (the sha check alone would read back through it).
    for (const f of FILES) {
        const rp = realpathSync(join(overlaidPkg, f));
        if (!rp.startsWith(realBase + sep)) { log('overlay: ' + f + ' resolves outside the temp tree (' + rp + ') -- aborting'); return 2; }
        if (sha256(rp) !== rootSha[f]) { log('overlay: ' + f + ' did not land (sha mismatch) -- aborting'); return 2; }
    }
    // info line: which of the four differ from the pinned release (the expected unreleased dev skew)
    const differ = FILES.filter((f) => rootSha[f] !== pinnedSha[f]);
    const same = FILES.filter((f) => rootSha[f] === pinnedSha[f]);
    log('overlay: running the capstone suite against the ROOT kernel; ' +
        (differ.length ? differ.join(', ') + ' differ from pinned ' + pinnedVersion + ' (unreleased root change)' : 'every file matches pinned ' + pinnedVersion) +
        (same.length && differ.length ? '; ' + same.join(', ') + ' match' : ''));

    // ---- run the capstone suite against the overlaid tree ----------------------------------------
    const r = spawnSync('npm', ['test'], { cwd: liveCopy, stdio: 'inherit', shell: process.platform === 'win32' });
    return r.status === null ? 1 : r.status;
}

const base = mkdtempSync(join(tmpdir(), 'lite-pick-overlay-'));
let code = 2;
try {
    code = main(base);
} finally {
    rmSync(base, { recursive: true, force: true });
}
process.exit(code);
