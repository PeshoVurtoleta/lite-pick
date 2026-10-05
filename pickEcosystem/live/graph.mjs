#!/usr/bin/env node
/**
 * pickEcosystem/live -- the system's REAL composition graph, for the hub page (capstone P4).
 *
 *   node graph.mjs          writes ../graph.json and ../graph.svg
 *
 * Boots the kernel (virtual workers -- the same `bootKernel` the page and the terminal run), then asks
 * lite-di-graph for the root container's `describe()` snapshot and one worker's child scope. Nothing is drawn by
 * hand: every box is a token the container holds, every line an edge it resolves. test/site.test.mjs regenerates
 * both files and compares them byte for byte, so a kernel change that rewires the system cannot leave a stale
 * picture on the hub.
 *
 * Layout: columns by dependency depth (a token sits one column right of its deepest dependency); tokens of the
 * same kind with the same dependencies and the same prefix are drawn as one box ("lb:* x10"), so the picture
 * stays readable without hiding an edge.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromContainer, toJSON, KIND_NAMES } from '@zakkster/lite-di-graph';
import { bootVirtual } from './virtual.js';

const BOX_W = 150, BOX_H = 24, ROW_GAP = 8, COL_W = 184, PAD = 20, HEAD = 30;
const KIND_COLOR = ['#7dd3fc', '#5fe39f', '#c6c9d0', '#f5b942', '#e879a8'];   // VALUE SINGLETON TRANSIENT FACTORY ALIAS

/** The root container's and one worker scope's snapshots, as lite-di-graph JSON strings. */
export async function snapshots() {
    const { kernel } = await bootVirtual();
    const root = toJSON(fromContainer(kernel.container));
    const scope = toJSON(fromContainer(kernel.fleet.scopes[0]));
    return { root, scope };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const prefixOf = (t) => (t.lastIndexOf(':') > 0 ? t.slice(0, t.lastIndexOf(':')) : '');

/** Group, layer and draw a snapshot (parsed lite-di-graph JSON) as an SVG string. */
export function render(root, scope) {
    // Group: same kind + same deps + same non-empty prefix, three or more.
    const groups = new Map();
    for (const n of root.nodes) {
        const p = prefixOf(n.token);
        const key = p ? n.kind + '|' + n.deps.join(',') + '|' + p : 'solo|' + n.token;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
    }
    const boxOf = new Map();
    const boxes = [];
    for (const members of groups.values()) {
        const split = members.length < 3;
        for (const set of split ? members.map((m) => [m]) : [members]) {
            const n = set[0];
            const label = set.length > 1 ? prefixOf(n.token) + ':* x' + set.length : n.token;
            const box = { label, kind: n.kind, deps: n.deps, opaque: !!n.opaqueDeps, members: set.map((m) => m.token), depth: 0, x: 0, y: 0 };
            boxes.push(box);
            for (const m of set) boxOf.set(m.token, box);
        }
    }
    // Depth: one column right of the deepest dependency.
    const depth = (b, seen) => {
        if (b._d !== undefined) return b._d;
        if (seen.has(b)) throw new Error('cycle at ' + b.label);
        seen.add(b);
        let d = 0;
        for (const t of b.deps) { const c = boxOf.get(t); if (c) d = Math.max(d, depth(c, seen) + 1); }
        b._d = d;
        return d;
    };
    for (const b of boxes) b.depth = depth(b, new Set());
    const cols = [];
    for (const b of boxes) (cols[b.depth] || (cols[b.depth] = [])).push(b);
    const maxRows = Math.max(...cols.map((c) => c.length));
    const plotH = maxRows * (BOX_H + ROW_GAP) - ROW_GAP;
    cols.forEach((col, d) => {
        const top = HEAD + PAD + (plotH - (col.length * (BOX_H + ROW_GAP) - ROW_GAP)) / 2;
        col.forEach((b, r) => { b.x = PAD + d * COL_W; b.y = top + r * (BOX_H + ROW_GAP); });
    });
    // Edges between boxes (deduplicated: a group's members share their edges).
    const edges = new Set();
    for (const e of root.edges) {
        const a = boxOf.get(e.from), b = boxOf.get(e.to);
        if (a && b && a !== b) edges.add(boxes.indexOf(a) + '>' + boxes.indexOf(b));
    }
    const scopeW = 4 * COL_W - (COL_W - BOX_W);
    const W = PAD * 2 + (cols.length - 1) * COL_W + BOX_W;
    const scopeY = HEAD + PAD + plotH + 40;
    const H = scopeY + 40 + scope.nodes.length * (BOX_H + ROW_GAP) + 14;
    let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
        '" role="img" aria-label="The composition graph of the running pickEcosystem kernel: ' + root.nodes.length + ' tokens, ' +
        root.edges.length + ' edges, exported by lite-di-graph">\n';
    s += '<style>text{font-family:ui-monospace,"JetBrains Mono",Menlo,monospace;font-size:11px;fill:#eae8e4}' +
        '.h{fill:#9ca2ae;font-size:10px;letter-spacing:.08em}.k{fill:#9ca2ae;font-size:9px}.e{fill:none;stroke:#3a4558;stroke-width:1}</style>\n';
    s += '<rect width="' + W + '" height="' + H + '" fill="#0d1117"/>\n';
    s += '<text class="h" x="' + PAD + '" y="' + (PAD + 4) + '">ROOT CONTAINER -- ' + root.nodes.length + ' TOKENS, ' + root.edges.length +
        ' EDGES (a token depends on the boxes to its left)</text>\n';
    for (const key of edges) {
        const [ai, bi] = key.split('>').map(Number);
        const a = boxes[ai], b = boxes[bi];
        const x1 = a.x, y1 = a.y + BOX_H / 2, x2 = b.x + BOX_W, y2 = b.y + BOX_H / 2, mx = (x1 + x2) / 2;
        s += '<path class="e" d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '"/>\n';
    }
    for (const b of boxes) {
        const col = KIND_COLOR[b.kind];
        s += '<g><title>' + esc(b.members.join(', ') + ' -- ' + KIND_NAMES[b.kind] + (b.opaque ? ' (deps opaque)' : ' <- ' + (b.deps.join(', ') || 'nothing'))) + '</title>' +
            '<rect x="' + b.x + '" y="' + b.y + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4" fill="#131922" stroke="' + col + '"/>' +
            '<text x="' + (b.x + 8) + '" y="' + (b.y + 16) + '">' + esc(b.label) + '</text></g>\n';
    }
    s += '<rect x="' + PAD + '" y="' + scopeY + '" width="' + scopeW + '" height="' + (H - scopeY - 14) + '" rx="6" fill="none" stroke="#3a4558" stroke-dasharray="4 4"/>\n';
    s += '<text class="h" x="' + (PAD + 10) + '" y="' + (scopeY + 18) + '">EACH WORKER\'S CHILD SCOPE (x8)</text>\n';
    scope.nodes.forEach((n, i) => {
        const y = scopeY + 28 + i * (BOX_H + ROW_GAP);
        s += '<rect x="' + (PAD + 10) + '" y="' + y + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4" fill="#131922" stroke="' + KIND_COLOR[n.kind] + '"/>' +
            '<text x="' + (PAD + 18) + '" y="' + (y + 16) + '">' + esc(n.token) + '</text>' +
            '<text class="k" x="' + (PAD + 10 + BOX_W + 10) + '" y="' + (y + 15) + '">' + KIND_NAMES[n.kind].toLowerCase() +
            ': brings worker i up (set.respawn); a supervisor, a health check and a breaker watch it</text>\n';
    });
    let lx = W - PAD;
    for (let k = KIND_NAMES.length - 1; k >= 0; k--) {
        if (k === 2 || k === 4) continue;                       // kinds this graph does not use
        const name = KIND_NAMES[k].toLowerCase();
        s += '<text class="k" x="' + lx + '" y="' + (PAD + 4) + '" text-anchor="end">' + name + '</text>';
        lx -= name.length * 5.6 + 6;
        s += '<rect x="' + (lx - 10) + '" y="' + (PAD - 5) + '" width="10" height="10" rx="2" fill="#131922" stroke="' + KIND_COLOR[k] + '"/>';
        lx -= 22;
    }
    s += '\n</svg>\n';
    return s;
}

/** Both files' contents. */
export async function build() {
    const { root, scope } = await snapshots();
    return { json: JSON.stringify({ root: JSON.parse(root), scope: JSON.parse(scope) }, null, 1) + '\n', svg: render(JSON.parse(root), JSON.parse(scope)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const out = await build();
    writeFileSync(new URL('../graph.json', import.meta.url), out.json);
    writeFileSync(new URL('../graph.svg', import.meta.url), out.svg);
    process.stdout.write('wrote pickEcosystem/graph.json + graph.svg\n', () => process.exit(0));
}
