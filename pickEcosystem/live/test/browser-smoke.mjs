/**
 * pickEcosystem/live -- the REAL-BROWSER smoke run (capstone P3, P4): the SITE AS DEPLOYED -- built by site.mjs
 * into a temporary directory, exactly what the Pages job uploads -- in headless Chrome, driven through its own keys
 * and buttons, against the pinned esm.sh modules.
 *
 *   npm run browser-smoke      (CHROME_PATH=... to choose the browser; CI uses the runner's Chrome)
 *
 * Zero dependencies: the page is served by demo/pool-scope/web/serve.mjs, Chrome is driven over the DevTools
 * protocol with Node's built-in WebSocket. Checks, in order:
 *   HUB         the site root redirects to the hub; it loads, the composition graph renders, and every relative
 *               link on it resolves inside the built site
 *   LIVE page   every module loads (no banner) and the system boots: 8 Web Workers up, requests served;
 *               the tour (key t)       -> its caption bar, step 2 kills w2 and the restart is narrated; t stops it
 *               kill w2 (key k)        -> "w2 restarted by its supervisor" in DECISIONS
 *               crash w5 (key c)       -> "w5 restarted by its supervisor" (the browser crash path: an uncaught
 *                                         error in the worker, not a silent close())
 *               flaky w1 (key f)       -> "w1 breaker OPEN", then heal (key x)
 *               engine B (key e)       -> still serving; back to A
 *               next strategy (key n)  -> the header follows
 *               the window narrows to 390 px after the charts mounted -> nothing stays wider (lite-charts follows)
 *               no request failed; graceful shutdown (key q) -> orchestrator exit code 0, nothing in flight
 *   SIM page    Pool Scope's simulated page (the shared renderer) loads with 12/12 workers
 *   both        no uncaught exception or console error
 * Prints "ok" and exits 0, or names the failed check and exits 1.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../site.mjs';

const SERVE = fileURLToPath(new URL('../../../demo/pool-scope/web/serve.mjs', import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 8790);
const BASE = 'http://127.0.0.1:' + PORT;
const log = (s) => process.stderr.write(s + '\n');
const checks = [];
const check = (ok, what) => { checks.push([ok, what]); log((ok ? '  ok   ' : '  FAIL ') + what + (failedProbe ? failedProbe() : '')); return ok; };
let failedProbe = null;   // set once the live page runs: each check line then shows the failed count so far
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(mac)) return mac;
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    for (const dir of (process.env.PATH || '').split(delimiter)) {
        for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
    }
    return null;
}

/** Resolve with the first stream chunk that matches `re` (or reject after `ms`). */
function waitFor(stream, re, ms, what) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + what)), ms);
        stream.on('data', function on(d) {
            buf += d.toString();
            const m = re.exec(buf);
            if (m) { clearTimeout(timer); stream.off('data', on); resolve(m); }
        });
    });
}

/** A minimal DevTools-protocol client over one page session. */
class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.session = null;
        this.listeners = [];
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
            } else if (msg.method) {
                for (const fn of this.listeners) fn(msg);
            }
        });
    }
    send(method, params, session) {
        const id = ++this.id;
        const m = { id, method, params: params || {} };
        if (session !== undefined ? session : this.session) m.sessionId = session !== undefined ? session : this.session;
        this.ws.send(JSON.stringify(m));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    on(fn) { this.listeners.push(fn); }
    async eval(expr) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result.value;
    }
    async key(ch) {
        if (this.refreshFailed) await this.refreshFailed();
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    /** Poll `expr` until it is truthy; resolve with its value, or with null after `ms`. */
    async until(expr, ms) {
        if (this.refreshFailed) await this.refreshFailed();
        const end = Date.now() + ms;
        for (;;) {
            let v = null;
            try { v = await this.eval(expr); } catch { v = null; }
            if (v) return v;
            if (Date.now() > end) return null;
            await sleep(100);
        }
    }
}

const chromePath = findChrome();
if (chromePath === null) {
    log('browser-smoke: no Chrome found (set CHROME_PATH)');
    process.exit(1);
}

const site = mkdtempSync(join(tmpdir(), 'pick-site-'));
log('  site: ' + buildSite(site).length + ' files built into a temporary directory');
const server = spawn(process.execPath, [SERVE, '--port', String(PORT), '--page', 'hub', '--root', site], { stdio: ['ignore', 'pipe', 'pipe'] });
const profiles = [];
let chrome = null;
let code = 1;

/**
 * Start headless Chrome and resolve its DevTools URL. A runner's Chrome can stay silent at start-up (CI,
 * 2026-10-05: no DevTools line in 20 s, where it normally takes ~1 s). That is a LAUNCH failure, not a page
 * failure, so it gets exactly ONE relaunch on a fresh profile; each failed launch prints Chrome's exit
 * status and stderr tail, and a second failure fails the smoke. Nothing about the page checks is retried.
 */
async function launchChrome() {
    for (let attempt = 1; ; attempt++) {
        const profile = mkdtempSync(join(tmpdir(), 'pick-smoke-'));
        profiles.push(profile);
        chrome = spawn(chromePath, [
            '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
            '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            // CI containers often cannot use Chrome's user-namespace sandbox; a local run keeps it.
            ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []),
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let tail = '';
        chrome.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-1500); });
        try {
            return await waitFor(chrome.stderr, /DevTools listening on (ws:\/\/\S+)/, 20000, 'Chrome');
        } catch (e) {
            const proc = chrome;
            proc.kill('SIGKILL');
            chrome = null;
            log('  Chrome launch ' + attempt + ' failed: ' + e.message + ' (exit ' + proc.exitCode + ', signal ' + proc.signalCode + ')');
            log('  Chrome stderr tail: ' + (tail.trim() || '(empty)'));
            if (attempt >= 2) throw e;
        }
    }
}

try {
    await waitFor(server.stdout, /open\s+http/, 10000, 'the static server');
    const m = await launchChrome();
    const ws = new WebSocket(m[1]);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const cdp = new Cdp(ws);
    const errors = [];
    cdp.on((msg) => {
        if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails;
            errors.push((d.exception && d.exception.description) || d.text);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            errors.push('console.error: ' + msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
        } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            errors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
        }
    });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, null);
    cdp.session = sessionId;
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // ---- the HUB --------------------------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: BASE + '/' });
    const hub = await cdp.until("document.readyState === 'complete' && location.pathname === '/pickEcosystem/' && document.title", 15000);
    check(hub === 'lite-pick capstone', 'hub: the site root redirects to it and it loads (' + hub + ')');
    check(await cdp.until("(() => { const i = document.querySelector('.graph img'); return i && i.complete && i.naturalWidth > 0; })()", 10000) === true,
        'hub: the composition graph renders');
    const links = await cdp.eval(`(async () => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
            const h = a.getAttribute('href');
            if (h.startsWith('#') || h.startsWith('//') || h.indexOf(':') >= 0) continue;
            const r = await fetch(new URL(h, location.href));
            out.push(h + ' ' + r.status);
        }
        return out;
    })()`);
    const broken = links.filter((l) => !/ 200$/.test(l));
    check(links.length >= 4 && broken.length === 0, 'hub: ' + links.length + ' relative links resolve in the built site' + (broken.length ? ': ' + broken.join(', ') : ''));

    // ---- the LIVE page ----------------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: BASE + '/pickEcosystem/live/' });
    const booted = await cdp.until('globalThis.__pickLive && __pickLive.kernel && __pickLive.kernel.stats.c[1] > 2000 && __pickLive.kernel.stats.c[1]', 45000);
    check(!!booted, 'live page: modules loaded and the system serves (' + booted + ' requests completed)');
    if (!booted) {
        log('  status: ' + await cdp.eval("document.getElementById('boot-status').textContent").catch(() => '?'));
        throw new Error('the live page did not boot');
    }
    let failedSoFar = 0;
    failedProbe = () => (failedSoFar ? '   [failed so far: ' + failedSoFar + ']' : '');
    const refreshFailed = async () => { try { failedSoFar = await cdp.eval('__pickLive.kernel ? __pickLive.kernel.stats.c[2] : 0'); } catch { /* page gone */ } };
    cdp.refreshFailed = refreshFailed;
    check(await cdp.eval("document.getElementById('cdn-error').hidden"), 'live page: no module-load banner');
    check(await cdp.eval("Array.from(__pickLive.kernel.balancers.shared.up).every((u) => u === 1)"), 'live page: all 8 Web Workers up and eligible');
    log('  ' + await cdp.eval("document.getElementById('boot-status').textContent + ' | cpu ' + document.getElementById('back-cpu').textContent + ' | render ' + document.getElementById('back-render').textContent"));

    // A decision at or after `since` (the page's clock): the panel shows only the newest lines, which may be older.
    const decided = (text, ms, since) => cdp.until('__pickLive.decisions(' + (since || 0) + ').some((d) => d.indexOf(' + JSON.stringify(text) + ') >= 0)', ms);
    const pageNow = () => cdp.eval('performance.now()');
    // One fault at a time: a worker is back only when it is back in rotation (READY and eligible), not when its
    // restart begins -- with `tries: 2`, a crash while another worker is still restarting can lose a request.
    const backIn = (w, since) => decided('w' + w + ' back in rotation', 10000, since);
    const select = (w) => cdp.eval('document.querySelector(\'.wchip[data-w="' + w + '"]\').click(), true');

    // The guided tour (key t): its caption bar appears, its second step kills w2 and says so, the restart is
    // narrated; key t again stops it.
    let since = await pageNow();
    await cdp.key('t');
    const cap1 = await cdp.until("!document.getElementById('tour').hidden && document.getElementById('tour-step').textContent", 3000);
    check(cap1 === 'TOUR 1/12', 'tour (key t): the caption bar shows step 1 (' + cap1 + ')');
    const cap2 = await cdp.until("document.getElementById('tour-caption').textContent.indexOf('w2 is killed') === 0", 12000);
    check(!!cap2 && !!await decided('w2 restarted by its supervisor', 6000, since), 'tour step 2: "w2 is killed" -- and its supervisor restarted it');
    await cdp.key('t');
    check(await cdp.until("document.getElementById('tour').hidden", 3000) === true, 'tour (key t again): stopped');
    await backIn(2, since);

    since = await pageNow();
    await select(2); await cdp.key('k');
    check(!!await decided('w2 restarted by its supervisor', 15000, since) && !!await backIn(2, since), 'kill w2 (key k): restarted by its supervisor, back in rotation');
    since = await pageNow();
    await select(5); await cdp.key('c');
    check(!!await decided('w5 restarted by its supervisor', 15000, since) && !!await backIn(5, since), 'crash w5 (key c): the worker died loudly, was restarted, back in rotation');
    since = await pageNow();
    await select(1); await cdp.key('f');
    check(!!await decided('w1 breaker OPEN', 15000, since), 'flaky w1 (key f): its breaker opened');
    await cdp.key('x');
    check(!!await decided('w1 breaker CLOSED', 15000, since) && !!await backIn(1, since), 'heal w1 (key x): the probe closed its breaker, back in rotation');
    await cdp.key('e');
    const atB = await cdp.eval('__pickLive.kernel.stats.c[1]');
    const servedB = await cdp.until('__pickLive.kernel.engine.mode === 1 && __pickLive.kernel.stats.c[1] > ' + (atB + 1000), 15000);
    check(!!servedB, 'engine B (key e): serving through /pool');
    await cdp.key('e');
    const s0 = await cdp.eval("document.getElementById('head-strategy').textContent");
    await cdp.key('n');
    const s1 = await cdp.until("document.getElementById('head-strategy').textContent !== " + JSON.stringify(s0) + " && document.getElementById('head-strategy').textContent", 3000);
    check(!!s1, 'next strategy (key n): ' + s0 + ' -> ' + s1);
    // The window narrows after the charts mounted (a phone rotating, a window dragged): nothing stays wider.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const narrow = await cdp.until("(() => { const w = document.documentElement.scrollWidth; const c = Math.max(...Array.from(document.querySelectorAll('canvas')).map((x) => x.getBoundingClientRect().width)); return w <= 390 && c <= 390 ? w + '/' + Math.round(c) : null; })()", 4000);
    check(!!narrow, 'narrowed to 390 px after mount: the page and every chart follow (' + narrow + ')');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(1000);
    await cdp.key('q');
    const exit = await cdp.until('__pickLive.exitCode !== null && String(__pickLive.exitCode)', 20000);
    if (!check(exit === '0', 'graceful shutdown (key q): orchestrator exit code ' + exit)) {
        log('  diagnosis: ' + await cdp.eval(`(() => { const k = __pickLive.kernel, e = k.engine, s = k.set;
            const w = []; for (let i = 0; i < 8; i++) w.push(i + ':' + s.state(i) + '/x' + s._exec[i] + '/q' + s._qCount[i] + '/busy' + Math.round(performance.now() - s.busySince(i)));
            const used = []; const free = new Set(Array.from(e.free.subarray(0, e.freeTop)));
            for (let r = 0; r < e.R; r++) if (!free.has(r)) used.push('r' + r + ' tries ' + e.rTries[r] + ' first ' + e.rFirst[r] + ' age ' + Math.round(performance.now() - e.rArrive[r]) + ' sent ' + Math.round(performance.now() - e.rSent[r]));
            return 'tableInUse ' + (e.R - e.freeTop) + ' [' + used.join('; ') + '] pendingB ' + e.pendingB + ' workers ' + w.join(' ') + ' inflight ' + Array.from(e.inflight) + ' counters ' + Array.from(k.stats.c); })()`));
    }
    const tally = await cdp.eval('(() => { const c = __pickLive.kernel.stats.c; return { ok: c[1], failed: c[2], failover: c[3], shed: c[4], pending: __pickLive.kernel.engine.pending(), restarts: Array.from(__pickLive.kernel.fleet.restarts) }; })()');
    log('  served ' + tally.ok + ', failed ' + tally.failed + ', failover ' + tally.failover + ', shed ' + tally.shed + ', restarts [' + tally.restarts + ']');
    check(tally.failed === 0, 'no request failed (failover covered kill, crash, flaky)');
    check(tally.pending === 0, 'nothing in flight after shutdown');
    check(/exit code 0/.test(await cdp.eval("document.getElementById('boot-status').textContent")), 'the page reports the exit code');

    // ---- the SIMULATED page (the shared renderer) -------------------------------------------------
    await cdp.send('Page.navigate', { url: BASE + '/demo/pool-scope/web/' });
    const sim = await cdp.until("globalThis.__poolScopeReady && document.getElementById('head-live').textContent === '12/12' && document.querySelectorAll('#wtable-body tr').length", 30000);
    check(sim === 12, 'simulated page: loads on the shared renderer, 12/12 workers');

    check(errors.length === 0, 'no uncaught exception or console error' + (errors.length ? ': ' + errors.slice(0, 3).join(' || ') : ''));
    await cdp.send('Browser.close', {}, null).catch(() => {});
    code = checks.every((c) => c[0]) ? 0 : 1;
} catch (e) {
    check(false, 'browser smoke: ' + (e && e.message || e));
    code = 1;
} finally {
    if (chrome !== null) chrome.kill();
    server.kill();
    for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { rmSync(site, { recursive: true, force: true }); } catch { /* best effort */ }
}
if (code === 0) process.stdout.write('ok\n', () => process.exit(0));
else process.stderr.write('', () => process.exit(1));
