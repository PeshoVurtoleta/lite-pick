/**
 * pickEcosystem/live -- the heartbeat's TEETH (capstone P5): every gate and invariant of test/heartbeat.mjs is shown
 * to trip, by a planted defect driven through the REAL harness (HB_MUSTFAIL), never by calling a gate directly --
 * the ADR 0014 discipline (decisions/0014-soak-redesign.md, `soak:teeth`). Virtual workers, so the whole battery
 * takes about a minute.
 *
 *   node test/heartbeat-teeth.mjs        (npm run heartbeat:teeth; lite-pick's CI capstone job runs it)
 *
 * A control passes only if the run exits with the expected code AND, for a breach, one `heartbeat: BREACH` line
 * carries the expected family; a crash or a different breach is a miss.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HB = fileURLToPath(new URL('./heartbeat.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pick-hb-teeth-'));

const CONTROLS = [
    { name: 'clean run PASSes', env: { HB_CYCLES: '12' }, code: 0, line: /^heartbeat: PASS -- 12 cycles, 0 breaches/m },
    { name: 'too few cycles is INCONCLUSIVE, never PASS', env: { HB_CYCLES: '4' }, code: 3, line: /^heartbeat: INCONCLUSIVE -- 3 post-warm-up cycles/m },
    { name: 'unknown setting is bad config (did-you-mean)', env: { HB_CYCLE: '4' }, code: 2, line: /unknown setting HB_CYCLE \(did you mean HB_CYCLES\?\)/ },
    { name: 'bad value is bad config', env: { HB_WORKERS: 'threads' }, code: 2, line: /HB_WORKERS must be real or virtual/ },
    { name: 'lose (tries 1): a kill loses requests', env: { HB_CYCLES: '3', HB_MUSTFAIL: 'lose' }, code: 1, line: /^heartbeat: BREACH failed cycle=0 /m },
    { name: 'leak (replaced transports pinned)', env: { HB_CYCLES: '6', HB_MUSTFAIL: 'leak' }, code: 1, line: /^heartbeat: BREACH retention cycle=\d+ /m },
    // A restart that never completes also never counts as a restart: `faults` is expected beside `eligible`.
    { name: 'stuck (a restart that never completes)', env: { HB_CYCLES: '4', HB_MUSTFAIL: 'stuck' }, code: 1, line: /^heartbeat: BREACH eligible cycle=\d+ detail=w4 /m, also: ['faults'] },
    { name: 'slowleak (~1.5 MB of heap per cycle)', env: { HB_CYCLES: '12', HB_MUSTFAIL: 'slowleak' }, code: 1, line: /^heartbeat: BREACH gate=heap /m },
    // The flaky step waits for w1's breaker up to its cap (heartbeat.mjs FLAKY_CAP_S = 16.2 s, so the wait past 7.2 s
    // is 9 s); a breaker that never moves must still breach once the cap passes -- and the cycle-0 record must show the
    // full wait, so deleting the wait loop (a fixed window again) fails this control too.
    { name: 'nobreaker (the flaky fault never lands)', env: { HB_CYCLES: '3', HB_MUSTFAIL: 'nobreaker' }, code: 1, line: /^heartbeat: BREACH faults cycle=0 detail=the flaky worker's breaker never moved/m,
        stream: (recs) => { const c0 = recs.find((x) => x.type === 'cycle' && x.cycle === 0); return !!c0 && c0.flakyWaitS >= 8.9; } },
    { name: 'p99 (every worker 3x slower in the late window)', env: { HB_CYCLES: '12', HB_MUSTFAIL: 'p99' }, code: 1, line: /^heartbeat: BREACH gate=p99 /m },
];

let misses = 0;
for (let c = 0; c < CONTROLS.length; c++) {
    const ctl = CONTROLS[c];
    const env = { ...process.env, HB_WORKERS: 'virtual', HB_OUT: join(dir, 'c' + c + '.jsonl'), ...ctl.env };
    for (const k of Object.keys(env)) if (k.startsWith('HB_') && env[k] === undefined) delete env[k];
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--expose-gc', HB], { env, encoding: 'utf8', timeout: 300000 });
    const err = r.stderr || '';
    const breachLines = err.split('\n').filter((l) => l.startsWith('heartbeat: BREACH'));
    const crashed = r.status === null || /\n\s+at /.test(err);
    let ok = r.status === ctl.code && ctl.line.test(err) && !crashed;
    // A breach control must breach ONLY in the expected family, plus any it declares (nothing else broke).
    if (ok && ctl.code === 1) {
        const fams = [/BREACH (\S+)/.exec(ctl.line.source.replace(/\\/g, ''))[1]].concat(ctl.also || []);
        ok = breachLines.every((l) => fams.some((f) => l.startsWith('heartbeat: BREACH ' + f + ' ')));
    }
    // A control may also assert on the JSONL stream the run wrote (fail closed: unreadable = MISS).
    if (ok && ctl.stream) {
        try { ok = ctl.stream(readFileSync(env.HB_OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l))) === true; }
        catch { ok = false; }
    }
    process.stderr.write((ok ? '  ok   ' : '  MISS ') + ctl.name + '  (exit ' + r.status + ', ' + ((Date.now() - t) / 1000).toFixed(1) + ' s)\n');
    if (!ok) {
        misses++;
        process.stderr.write(err.split('\n').slice(-12).map((l) => '         | ' + l).join('\n') + '\n');
    }
}
// --- signal mid-run (async; a live child must be signalled -- spawnSync cannot) -----------------
// A run stopped by a signal AFTER it already has enough cycles must still be INCONCLUSIVE, never PASS:
// the run did not reach its own end. The SIGINT fires the instant cycle 12 is logged (>= the 11-cycle
// active floor), so HEAD -- which only knew the !active case -- would call this run PASS and the control
// MISSes there. NO sleeps: the signal is driven by the cycle-12 stderr line, the exit by the child's
// own 'close' event.
async function runSignalControl() {
    const name = 'signal mid-run is INCONCLUSIVE';
    const env = { ...process.env, HB_WORKERS: 'virtual', HB_CYCLES: '40', HB_OUT: join(dir, 'signal.jsonl') };
    const t = Date.now();
    const child = spawn(process.execPath, ['--expose-gc', HB], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let sent = false;
    const exit = await new Promise((resolve) => {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            err += chunk;
            if (!sent && /heartbeat: cycle 12:/.test(err)) { sent = true; child.kill('SIGINT'); }
        });
        child.on('close', (code) => resolve(code));
    });
    const crashed = /\n\s+at /.test(err);
    const ok = sent && exit === 3 && !crashed &&
        /^heartbeat: INCONCLUSIVE -- run interrupted before its end \(signal\) after \d+ cycles/m.test(err);
    process.stderr.write((ok ? '  ok   ' : '  MISS ') + name +
        '  (exit ' + exit + ', signal ' + (sent ? 'sent' : 'NEVER SENT') + ', ' + ((Date.now() - t) / 1000).toFixed(1) + ' s)\n');
    if (!ok) process.stderr.write(err.split('\n').slice(-12).map((l) => '         | ' + l).join('\n') + '\n');
    return ok;
}

if (!(await runSignalControl())) misses++;
const TOTAL = CONTROLS.length + 1;
rmSync(dir, { recursive: true, force: true });
if (misses) { process.stderr.write('heartbeat teeth: ' + misses + ' of ' + TOTAL + ' controls missed\n', () => process.exit(1)); }
else process.stdout.write('ok (' + TOTAL + ' controls)\n', () => process.exit(0));
