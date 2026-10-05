/**
 * Pool Scope -- web/serve.mjs : a zero-dependency static file server for the BROWSER target (PS3).
 *
 *     npm run scope:web           # -> serves demo/pool-scope/web on http://127.0.0.1:8137
 *     node demo/pool-scope/web/serve.mjs [--port N] [--root DIR] [--page live]   (or PORT=N ...)
 *
 * `--page live` opens the capstone's LIVE page instead (pickEcosystem/live/: the running system over Web
 * Workers; `npm run web` there). It shares this page's renderer and stylesheet, so both trees are served.
 *
 * Node built-in http only (no bundler, no `serve` dependency): the page is pure static -- an import
 * map + relative brick imports + esm.sh for the siblings -- so this just streams files with correct
 * MIME types. It also serves the sibling bricks (../snapshot.mjs etc.) and ../../Pick.js by resolving
 * requests under the demo root, so the browser can load the kernel + the renderer-agnostic bricks
 * DIRECTLY (they import Pick.js as a relative path -- zero CDN needed for lite-pick itself).
 *
 * FAIL CLOSED (audit M-D1 / M-D2 / L26): binds to loopback ONLY; serves GET/HEAD only (else 405);
 * an ALLOWLIST limits reachable paths to the demo tree + the two kernel files the page imports + the live
 * page's own files (everything else -- /.git, /package.json, any node_modules or test directory -- is 404,
 * never touched on disk);
 * traversal is rejected with path.relative + a realpath symlink-escape check; a foreign Host header
 * is refused (DNS-rebinding defence); every response carries X-Content-Type-Options: nosniff.
 */

import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { extname, join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Root is the package root so the browser can reach ../snapshot.mjs and ../../Pick.js from /web/.
const PKG_ROOT = resolve(HERE, '..', '..', '..');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

// Port: an explicit --port wins, else the PORT env var, else the default. Validated as an integer
// in 1..65535 -- a bad value is a CLEAR error and a non-zero exit, never a crash (L26).
function resolvePort() {
    const argIdx = process.argv.indexOf('--port');
    let raw, src;
    if (argIdx >= 0) { raw = process.argv[argIdx + 1]; src = '--port'; }
    else if (process.env.PORT != null && process.env.PORT !== '') { raw = process.env.PORT; src = 'PORT env'; }
    else return 8137;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        process.stderr.write('pool-scope web: invalid port from ' + src + ': ' +
            JSON.stringify(raw == null ? '' : String(raw)) + ' (must be an integer 1-65535)\n');
        process.exit(2);
    }
    return n;
}

const PORT = resolvePort();
const ROOT = resolve(argVal('--root', PKG_ROOT));
// The REAL root (symlinks in its own path resolved once, at start): a file's realpath is compared against
// this, so a checkout under a symlinked directory (macOS /tmp -> /private/tmp) is not 403 on every file.
const ROOT_REAL = realpathSync(ROOT);

// Only these authorities are accepted in the Host header (DNS-rebinding defence): the loopback names
// the browser uses, with the exact serving port. A missing or foreign Host is refused (421).
const ALLOWED_HOSTS = new Set([
    'localhost:' + PORT, '127.0.0.1:' + PORT, '[::1]:' + PORT,
]);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
};

// The web page lives here. A bare "/" REDIRECTS to the page's real directory (with a trailing
// slash) so the browser's base URL is the web dir and the page's relative module imports
// (main.mjs, ../driver.mjs, ../../Pick.js) resolve correctly.
const LIVE_DIR = '/pickEcosystem/live/';
const WEB_DIR = argVal('--page', '') === 'live' ? LIVE_DIR : '/demo/pool-scope/web/';

// ALLOWLIST: the ONLY paths this server will serve, matched against the path AFTER normalisation
// (so a traversal like /demo/pool-scope/../../package.json is judged as /package.json -> denied).
// The page imports exactly the demo tree + the two kernel files; nothing else is reachable.
function isAllowed(p) {
    if (p === '/Pick.js' || p === '/Pool.js') return true;
    if (p === '/demo/pool-scope' || p.startsWith('/demo/pool-scope/')) return true;
    // The live page: its top-level files only -- never its node_modules, tests, package files or dotfiles.
    if (p.startsWith(LIVE_DIR)) {
        const rest = p.slice(LIVE_DIR.length);
        return rest.indexOf('/') < 0 && !rest.startsWith('.') && !rest.startsWith('package');
    }
    return false;
}

function send(res, code, type, body, isHead) {
    res.writeHead(code, {
        'content-type': type,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
    });
    if (isHead || body == null) res.end();
    else res.end(body);
}

const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    const isHead = method === 'HEAD';
    try {
        // Method: GET/HEAD only (fail closed on everything else).
        if (method !== 'GET' && !isHead) {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'allow': 'GET, HEAD', 'x-content-type-options': 'nosniff' });
            res.end('405 method not allowed');
            return;
        }

        // Host: refuse a foreign Host header (DNS-rebinding defence).
        if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) {
            res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
            res.end('421 misdirected request (bad Host header)');
            return;
        }

        let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        if (urlPath === '/' || urlPath === '') {
            res.writeHead(302, { location: WEB_DIR, 'x-content-type-options': 'nosniff' });
            res.end();
            return;
        }
        // A page dir WITHOUT a trailing slash -> redirect (so relative imports resolve), not 404.
        if (urlPath === '/demo/pool-scope/web' || urlPath + '/' === LIVE_DIR) {
            res.writeHead(302, { location: urlPath + '/', 'x-content-type-options': 'nosniff' });
            res.end();
            return;
        }
        if (urlPath === '/demo/pool-scope/web/' || urlPath === LIVE_DIR) urlPath = urlPath + 'index.html';

        // Resolve inside ROOT, then reject any traversal escape via path.relative (not a prefix match).
        const abs = join(ROOT, urlPath);
        const rel = relative(ROOT, abs);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            send(res, 403, 'text/plain; charset=utf-8', '403 forbidden', isHead);
            return;
        }
        // Allowlist the NORMALISED path (leading-slash, posix form): everything outside the demo tree
        // and the two kernel files is 404 before we ever touch the filesystem.
        const served = '/' + rel.split('\\').join('/');
        if (!isAllowed(served)) {
            send(res, 404, 'text/plain; charset=utf-8', '404 not found', isHead);
            return;
        }

        // Realpath the target so a symlink cannot escape ROOT (fail closed if it does) -- AND re-run the
        // allowlist on the RESOLVED path (audit 2026-09-29 D4): an allowed-looking name inside the demo tree
        // that is a symlink to e.g. ../../../.git/config used to pass, because only the LEXICAL path was
        // allowlisted. Now both the requested and the resolved file must be allowlisted.
        const real = await realpath(abs);
        const realRel = relative(ROOT_REAL, real);
        if (realRel.startsWith('..') || isAbsolute(realRel)) {
            send(res, 403, 'text/plain; charset=utf-8', '403 forbidden', isHead);
            return;
        }
        if (!isAllowed('/' + realRel.split('\\').join('/'))) {
            send(res, 404, 'text/plain; charset=utf-8', '404 not found', isHead);
            return;
        }

        const body = await readFile(real);
        const type = MIME[extname(real).toLowerCase()] || 'application/octet-stream';
        send(res, 200, type, body, isHead);
    } catch {
        send(res, 404, 'text/plain; charset=utf-8', '404 not found: ' + (req.url || ''), isHead);
    }
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        process.stderr.write('pool-scope web: port ' + PORT + ' is already in use (EADDRINUSE). ' +
            'Try --port N or set PORT.\n');
    } else {
        process.stderr.write('pool-scope web: server error: ' + (err && err.message ? err.message : err) + '\n');
    }
    process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write('pool-scope web -- serving ' + ROOT + ' (loopback only)\n');
    process.stdout.write('  open  http://127.0.0.1:' + PORT + '/\n');
    process.stdout.write('  (Ctrl-C to stop)\n');
});
