/**
 * @zakkster/lite-pick soak -- the PARITY gate (audit 2026-09-29 S6).
 *
 *   node benchmark/soak/parity.mjs            check (npm run parity)
 *   node benchmark/soak/parity.mjs --update   re-pin (npm run parity:update)
 *
 * The shipped code and the soak's invariant oracle -- PARITY_FILES -- are pinned by sha256 in the
 * committed benchmark/soak/parity.json. The check FAILs (exit 1) when any of them differs from its pin,
 * so a commit that changes shipped code must ALSO re-pin it, deliberately, in the same commit: a
 * benchmark-only change that touches the kernel by accident is caught in CI (the `gates` job) and in the
 * nightly. A missing or malformed pin file is exit 2 (fail closed, never "nothing to compare = OK").
 * `--update` rewrites the pins from the working tree. Library use: checkParity() for the soak header.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PIN_PATH = join(ROOT, 'benchmark', 'soak', 'parity.json');
export const PARITY_FILES = ['Pick.js', 'Pool.js', 'Pick.d.ts', 'Pool.d.ts', 'test/invariants.mjs'];

/** sha256 hex of a file, or null when it cannot be read. */
export function sha256File(path) {
    try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
        return null;
    }
}

/** Current hashes of PARITY_FILES (relative path -> hex | null). */
export function currentHashes() {
    const out = {};
    for (const f of PARITY_FILES) out[f] = sha256File(join(ROOT, f));
    return out;
}

/**
 * Compare the working tree against the pins. Returns { ok, mismatched: [{ file, pinned, actual }],
 * error } -- `error` (and ok=null) when the pin file is missing or malformed: unknown, never true.
 */
export function checkParity() {
    let pins;
    try {
        pins = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
    } catch (e) {
        return { ok: null, mismatched: [], error: 'cannot read ' + PIN_PATH + ': ' + (e && e.message ? e.message : e) };
    }
    if (!pins || typeof pins.files !== 'object' || pins.files === null) {
        return { ok: null, mismatched: [], error: 'malformed pin file (no "files" object)' };
    }
    const cur = currentHashes();
    const mismatched = [];
    for (const f of PARITY_FILES) {
        const pinned = typeof pins.files[f] === 'string' ? pins.files[f] : null;
        if (pinned === null || cur[f] === null || pinned !== cur[f]) mismatched.push({ file: f, pinned, actual: cur[f] });
    }
    for (const f of Object.keys(pins.files)) {
        if (PARITY_FILES.indexOf(f) === -1) mismatched.push({ file: f, pinned: pins.files[f], actual: 'not a parity file' });
    }
    return { ok: mismatched.length === 0, mismatched, error: null };
}

function short(h) { return h === null || h === undefined ? 'missing' : String(h).slice(0, 12); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    for (const a of args) {
        if (a !== '--update') { process.stderr.write('parity: unknown argument ' + a + '\n'); process.exit(2); }
    }
    if (args.indexOf('--update') !== -1) {
        const cur = currentHashes();
        const missing = PARITY_FILES.filter((f) => cur[f] === null);
        if (missing.length) { process.stderr.write('parity: FAIL -- cannot read ' + missing.join(', ') + '\n'); process.exit(2); }
        writeFileSync(PIN_PATH, JSON.stringify({ files: cur }, null, 2) + '\n');
        process.stdout.write('parity: pinned ' + PARITY_FILES.length + ' files -> benchmark/soak/parity.json\n');
        process.exit(0);
    }
    const r = checkParity();
    if (r.ok === null) { process.stderr.write('parity: FAIL -- ' + r.error + '\n'); process.exit(2); }
    if (!r.ok) {
        for (const m of r.mismatched) {
            if (m.actual === 'not a parity file') process.stderr.write('parity: FAIL -- ' + m.file + ' is pinned but is not one of PARITY_FILES\n');
            else process.stderr.write('parity: FAIL -- ' + m.file + ' sha256 ' + short(m.actual) + ' != pinned ' + short(m.pinned) + '\n');
        }
        process.stderr.write('parity: shipped code changed. If deliberate, run `npm run parity:update` and commit parity.json with it.\n');
        process.exit(1);
    }
    process.stdout.write('parity: OK (' + PARITY_FILES.length + ' files match benchmark/soak/parity.json)\n');
}
