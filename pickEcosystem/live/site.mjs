#!/usr/bin/env node
/**
 * pickEcosystem/live -- build the GitHub Pages site (capstone P4).
 *
 *   node site.mjs <outDir>        (npm run site -- ../../_site; the deploy job runs it)
 *
 * The site is exactly what the three pages reach, nothing more: the hub (pickEcosystem/index.html), the live
 * page and the simulated Pool Scope. From each page every relative src / href is followed, and from every module
 * every static and dynamic relative import (the walk test/web.test.mjs W2 also uses), so the copied tree is
 * complete by construction -- and never carries node_modules, tests, research or the package itself. The site
 * root redirects to the hub. Fails closed: a reference that does not resolve to a file in the repo is an error.
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const PAGES = ['pickEcosystem/index.html', 'pickEcosystem/live/index.html', 'demo/pool-scope/web/index.html'];

const read = (p) => readFileSync(p, 'utf8');

/** Every module reachable from `entry` by static or dynamic import: { files, bare, node, missing }. */
export function walk(entry) {
    const files = new Set(), bare = new Set(), node = new Set(), missing = [];
    const todo = [entry];
    while (todo.length) {
        const f = todo.pop();
        if (files.has(f)) continue;
        files.add(f);
        const src = read(f);
        const specs = [];
        for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
        for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
        for (const s of specs) {
            if (s.startsWith('node:')) node.add(s);
            else if (s.startsWith('.')) {
                const p = resolve(dirname(f), s);
                if (existsSync(p)) todo.push(p); else missing.push(f + ' -> ' + s);
            } else bare.add(s);
        }
    }
    return { files, bare, node, missing };
}

/** The relative src / href references of an HTML page (no external URLs, data: URIs or fragments). */
export function pageRefs(html) {
    const out = [];
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const u = m[1];
        if (/^(?:[a-z]+:|\/\/|#)/i.test(u)) continue;
        out.push(u.split('#')[0].split('?')[0]);
    }
    return out;
}

/** Repo-relative paths of every file the site needs, sorted; throws on a reference that does not resolve. */
export function siteFiles() {
    const want = new Set();
    const errors = [];
    const add = (abs, from) => {
        const rel = relative(REPO, abs);
        if (rel.startsWith('..') || !existsSync(abs)) { errors.push(from + ' -> ' + rel); return null; }
        want.add(rel.split(sep).join('/'));
        return rel;
    };
    for (const page of PAGES) {
        const abs = join(REPO, page);
        add(abs, '(pages)');
        for (const ref of pageRefs(read(abs))) {
            let target = resolve(dirname(abs), ref);
            if (ref.endsWith('/')) {
                target = join(target, 'index.html');
                if (PAGES.indexOf(relative(REPO, target).split(sep).join('/')) < 0) errors.push(page + ' links ' + ref + ', not a site page');
            }
            if (add(target, page) === null) continue;
            if (/\.m?js$/.test(target)) {
                const g = walk(target);
                for (const f of g.files) add(f, page + ' (module graph)');
                for (const m of g.missing) errors.push(m);
                for (const n of g.node) errors.push(page + ' reaches ' + n + ' (a Node-only module)');
            }
        }
    }
    if (errors.length) throw new Error('site: unresolved references:\n  ' + errors.join('\n  '));
    return [...want].sort();
}

const ROOT_INDEX = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"/>\n<title>lite-pick</title>\n' +
    '<meta http-equiv="refresh" content="0; url=pickEcosystem/"/>\n<link rel="canonical" href="pickEcosystem/"/>\n</head>\n' +
    '<body><p><a href="pickEcosystem/">lite-pick -- a load balancer you can watch work</a></p></body>\n</html>\n';

/** Copy the site into `out` (emptied first). Returns the repo-relative paths copied. Refuses to empty a directory
 *  that is not a previous site build (no `.nojekyll` marker), or one that contains the repo. */
export function buildSite(out) {
    const files = siteFiles();
    const dir = resolve(out);
    if (!relative(dir, REPO).startsWith('..')) throw new Error('site: refusing to build into ' + dir + ' (it contains the repo)');
    if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, '.nojekyll'))) {
        throw new Error('site: refusing to empty ' + dir + ' (not empty, and not a previous site build)');
    }
    rmSync(dir, { recursive: true, force: true });
    out = dir;
    for (const f of files) {
        const dst = join(out, f);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(join(REPO, f), dst);
    }
    writeFileSync(join(out, 'index.html'), ROOT_INDEX);
    writeFileSync(join(out, '.nojekyll'), '');
    return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const out = process.argv[2];
    if (!out) { process.stderr.write('usage: node site.mjs <outDir>\n'); process.exit(2); }
    const dir = resolve(out);
    if (existsSync(dir) && !statSync(dir).isDirectory()) { process.stderr.write('site: ' + dir + ' is not a directory\n'); process.exit(2); }
    const files = buildSite(dir);
    process.stdout.write('site: ' + files.length + ' files + index.html -> ' + dir + '\n', () => process.exit(0));
}
