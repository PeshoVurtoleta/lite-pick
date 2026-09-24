/**
 * Pool Scope -- web/serve.mjs : a zero-dependency static file server for the BROWSER target (PS3).
 *
 *     npm run scope:web           # -> serves demo/pool-scope/web on http://localhost:8137
 *     node demo/pool-scope/web/serve.mjs [--port N] [--root DIR]
 *
 * Node built-in http only (no bundler, no `serve` dependency): the page is pure static -- an import
 * map + relative brick imports + esm.sh for the siblings -- so this just streams files with correct
 * MIME types. It also serves the sibling bricks (../snapshot.mjs etc.) and ../../Pick.js by resolving
 * requests under the demo root, so the browser can load the kernel + the renderer-agnostic bricks
 * DIRECTLY (they import Pick.js as a relative path -- zero CDN needed for lite-pick itself).
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Root is the package root so the browser can reach ../snapshot.mjs and ../../Pick.js from /web/.
const PKG_ROOT = resolve(HERE, '..', '..', '..');

function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const PORT = (argVal('--port', '8137') | 0) || 8137;
const ROOT = resolve(argVal('--root', PKG_ROOT));

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

// The web page lives here. A bare "/" REDIRECTS to the page's real directory (with a
// trailing slash) so the browser's base URL is the web dir and the page's relative module
// imports (main.mjs, ../driver.mjs, ../../Pick.js) resolve correctly. Serving index.html's
// bytes at "/" would leave the base at "/", making those relatives 404.
const WEB_DIR = '/demo/pool-scope/web/';

const server = createServer(async (req, res) => {
    try {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '') {
            res.writeHead(302, { location: WEB_DIR });
            res.end();
            return;
        }
        if (urlPath === WEB_DIR) urlPath = WEB_DIR + 'index.html';
        // Resolve inside ROOT and refuse traversal escapes (fail closed).
        const abs = normalize(join(ROOT, urlPath));
        if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }
        const body = await readFile(abs);
        const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 not found: ' + (req.url || ''));
    }
});

server.listen(PORT, () => {
    process.stdout.write('pool-scope web -- serving ' + ROOT + '\n');
    process.stdout.write('  open  http://localhost:' + PORT + '/\n');
    process.stdout.write('  (Ctrl-C to stop)\n');
});
