/**
 * pickEcosystem/live -- the live TUI (P2), run SCRIPTED over virtual workers (deterministic frames).
 *
 *   T1 the frames come from the live system: the header names it, the FLEET panel shows engine A and every
 *      worker, and a kill + a flaky worker + a slow worker are narrated in the DECISIONS stream (a supervisor
 *      restart, the breaker opening, failover reroutes "wX -> wY"); no request fails; the orchestrator shutdown
 *      ends with exit code 0; the per-frame data-path badge reads < 8 B/op.
 *   T2 two runs print byte-identical frames (the badge, a heap measurement, masked): the live TUI is as
 *      reproducible as the simulated one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TUI = fileURLToPath(new URL('../tui.mjs', import.meta.url));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function scripted() {
    const out = execFileSync(process.execPath,
        ['--expose-gc', TUI, '--frames', '30', '--script', '2:kill:2,2.6:flaky:1,3.2:slow:3'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    return out.replace(ANSI, '');
}

test('T1 the live TUI narrates the live system: fleet, decisions, shutdown', () => {
    const out = scripted();
    assert.match(out, /pool-scope LIVE scripted -- virtual workers strategy=p2c rate=2000 frames=30/);
    // The badge is Pool Scope's heap-delta estimate of the per-FRAME data path (12 Hz render work, not the request
    // path -- that is gated by allocation rate in alloc.test.mjs A1): 0.00 on Node 26, ~2.4 on Node 22. Same law
    // as every other gate here: < 8 B.
    const bpo = Number(/data-path=([0-9.]+) B\/op/.exec(out)[1]);
    assert.ok(bpo < 8, 'data path ' + bpo + ' B/op');
    assert.match(out, /FLEET engine A \(zero-alloc\)/);
    const last = out.slice(out.lastIndexOf('=== frame 29'));
    for (let i = 0; i < 8; i++) assert.match(last, new RegExp('w' + i + ' \u25cf '), 'worker ' + i + ' in the fleet row');
    assert.match(last, /failed 0 /, 'no failed request');
    assert.match(last, /w2 \u25cf up\s+r1/, 'the killed worker is back, restarted once');
    assert.match(out, /w2 restarted by its supervisor/);
    assert.match(out, /w1 breaker OPEN/);
    assert.match(out, /w1 -> w\d  failover/);
    assert.match(out, /shutdown exit code 0/);
});

test('T2 two scripted runs print byte-identical frames', () => {
    const mask = (s) => s.replace(/data-path=[0-9.]+ B\/op/, '').replace(/data [^ ]+ B\/op/g, '');
    assert.equal(mask(scripted()), mask(scripted()));
});
