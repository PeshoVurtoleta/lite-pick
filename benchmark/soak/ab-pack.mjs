/**
 * @zakkster/lite-pick soak -- the release-time A/B PACKER (research/soak-release-ab.md, #8b, D5).
 *
 * Two sides, two provenance paths, both ending in an unpacked `package/` tree the runner loads through
 * SOAK_KERNEL / SOAK_POOL:
 *
 *   fetchRelease(prev, scratchDir, outDir)
 *     A = the previous registry release. `npm pack <spec> --json` downloads the published tarball; its
 *     sha512 integrity is checked THREE ways that must all agree -- the sha512 of the tarball BYTES on
 *     disk, `npm view <spec> dist.integrity` (what the registry recorded), and the `.integrity` field of
 *     the pack JSON -- so the bytes are provably the published bytes before anything runs. Unpacks to
 *     <outDir>/A/package.
 *
 *   packTree(repoRoot, scratchDir, outDir)
 *     B = the release candidate. `npm pack` of the working tree (exactly what `npm publish` would upload),
 *     unpacked to <outDir>/B/package. Its Pick.js / Pool.js sha256 are returned alongside the pins from
 *     benchmark/soak/parity.json, and its VERSION (parsed from Pick.js) alongside package.json's version,
 *     so the runner can assert B IS the pinned shipped code (a mismatch is INCONCLUSIVE, never a FAIL).
 *
 * The two `package/` paths have equal length (<outDir>/A/package, <outDir>/B/package) so the only
 * difference between an A and a B process is which directory the kernel loads from (research 5.1, the
 * Mytkowicz link-order caution). Zero runtime deps: node:child_process / node:crypto / node:fs only.
 * COLD module -- runs a handful of times per A/B, never in a hot path.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = '@zakkster/lite-pick';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PARITY_JSON = fileURLToPath(new URL('./parity.json', import.meta.url));

/** sha256 hex of a file's bytes (the parity.json convention). */
export function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The Subresource-Integrity sha512 of a buffer: `sha512-<base64>` (npm's dist.integrity format). */
export function sha512Integrity(buf) {
    return 'sha512-' + createHash('sha512').update(buf).digest('base64');
}

/** Parse the single source-of-truth VERSION const out of a Pick.js without importing it. */
export function readVersion(pickPath) {
    const src = readFileSync(pickPath, 'utf8');
    const m = /export const VERSION = '([^']+)'/.exec(src);
    return m ? m[1] : null;
}

function readJsonVersion(pkgJsonPath) {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
}

/** Run npm, capturing stdout only (a wide buffer for the pack JSON; stderr notices are discarded). */
function npm(args, cwd) {
    return execFileSync('npm', args, {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** `npm pack --json` prints a JSON array; take it from the first '[' so a stray notice cannot poison it. */
function parsePackJson(out) {
    const i = out.indexOf('[');
    if (i === -1) throw new Error('npm pack --json produced no JSON array:\n' + out.slice(0, 400));
    const arr = JSON.parse(out.slice(i));
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('npm pack --json array was empty');
    return arr[0];
}

function untar(tarball, destRoot) {
    mkdirSync(destRoot, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', destRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
    return join(destRoot, 'package');
}

/**
 * A = the previous registry release. Returns:
 *   { side:'A', dir, tarball, integrity, version, pkgVersion, pickSha256, poolSha256 }
 * Throws (-> the runner maps to INCONCLUSIVE) on any registry/pack failure or a three-way integrity
 * disagreement. `prev` is a bare version string (e.g. '1.1.0'); the spec is PKG@prev.
 */
export function fetchRelease(prev, scratchDir, outDir) {
    const spec = PKG + '@' + prev;
    mkdirSync(scratchDir, { recursive: true });

    const meta = parsePackJson(npm(['pack', spec, '--json', '--pack-destination', scratchDir], scratchDir));
    const tarball = join(scratchDir, meta.filename);

    // Three-way sha512 (D5): the tarball bytes, the registry's recorded integrity, the pack JSON's field.
    const fileIntegrity = sha512Integrity(readFileSync(tarball));
    const viewIntegrity = npm(['view', spec, 'dist.integrity'], scratchDir).trim();
    const packIntegrity = String(meta.integrity || '');
    if (!packIntegrity) throw new Error('npm pack --json carried no integrity for ' + spec);
    if (fileIntegrity !== packIntegrity) {
        throw new Error('integrity mismatch for ' + spec + ': tarball bytes ' + fileIntegrity + ' != pack JSON ' + packIntegrity);
    }
    if (viewIntegrity !== packIntegrity) {
        throw new Error('integrity mismatch for ' + spec + ': npm view ' + viewIntegrity + ' != pack JSON ' + packIntegrity);
    }

    const dir = untar(tarball, join(outDir, 'A'));
    return {
        side: 'A', dir, tarball, integrity: packIntegrity,
        version: readVersion(join(dir, 'Pick.js')),
        pkgVersion: readJsonVersion(join(dir, 'package.json')),
        pickSha256: sha256File(join(dir, 'Pick.js')),
        poolSha256: sha256File(join(dir, 'Pool.js')),
    };
}

/**
 * B = the release candidate (npm pack of the tree). Returns:
 *   { side:'B', dir, tarball, integrity, version, pkgVersion, pickSha256, poolSha256,
 *     parityPickSha, parityPoolSha, parityOk, versionMatches }
 * No integrity cross-check (a local pack has no registry record yet); instead the runner asserts
 * pickSha256/poolSha256 == parity.json (B is the pinned shipped code) and version == package.json.
 */
export function packTree(repoRoot = REPO_ROOT, scratchDir, outDir, parityPath = PARITY_JSON) {
    mkdirSync(scratchDir, { recursive: true });
    const meta = parsePackJson(npm(['pack', '--json', '--pack-destination', scratchDir], repoRoot));
    const tarball = join(scratchDir, meta.filename);
    const dir = untar(tarball, join(outDir, 'B'));

    const pickSha256 = sha256File(join(dir, 'Pick.js'));
    const poolSha256 = sha256File(join(dir, 'Pool.js'));
    const version = readVersion(join(dir, 'Pick.js'));
    const pkgVersion = readJsonVersion(join(dir, 'package.json'));

    const parity = JSON.parse(readFileSync(parityPath, 'utf8'));
    const parityPickSha = parity.files['Pick.js'];
    const parityPoolSha = parity.files['Pool.js'];

    return {
        side: 'B', dir, tarball, integrity: String(meta.integrity || ''),
        version, pkgVersion, pickSha256, poolSha256,
        parityPickSha, parityPoolSha,
        parityOk: pickSha256 === parityPickSha && poolSha256 === parityPoolSha,
        versionMatches: version === pkgVersion,
    };
}

/** Hash an already-unpacked <dir>/package tree (control mode: --a-dir / --b-dir). */
export function hashUnpacked(side, pkgDir) {
    return {
        side, dir: pkgDir,
        version: readVersion(join(pkgDir, 'Pick.js')),
        pickSha256: sha256File(join(pkgDir, 'Pick.js')),
        poolSha256: sha256File(join(pkgDir, 'Pool.js')),
    };
}
