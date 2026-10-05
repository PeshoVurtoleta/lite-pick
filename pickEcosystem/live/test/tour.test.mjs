/**
 * pickEcosystem/live -- the guided tour (tour.js) does what its captions say, on the live kernel (virtual workers).
 *
 *   U1 played end to end: every step with an `expect` produces that DECISIONS line within its window; no request
 *      fails; afterwards all 8 workers are up and the strategy is back to P2C; the player ends by itself.
 *      Control: the same script with the kill step emptied misses "w2 restarted by its supervisor".
 *   U2 the script is well formed: increasing times, a caption on every step but the last (null = the end), only
 *      known verbs, every caption short enough for one line of the page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR, TourPlayer } from '../tour.js';
import { laneHas } from '../tour.js';
import { S_FAILED } from '../stats.js';
import { bootVirtual } from './harness.mjs';

/** Play `script`; returns the expectations it missed. */
async function play(script) {
    const { kernel: k, hub, run } = await bootVirtual();
    await run(1000);
    const player = new TourPlayer(k, script);
    player.start(hub.now());
    const t0 = hub.now();
    const pending = [];
    const misses = [];
    let seen = 0;
    while (player.active) {
        await run(100);
        player.tick(hub.now());
        while (seen <= player.step) {
            const s = script[seen++];
            if (s.expect) pending.push({ text: s.expect, since: t0 + s.at * 1000, until: t0 + (s.at + s.within) * 1000 });
        }
        for (let p = pending.length - 1; p >= 0; p--) {
            const e = pending[p];
            if (laneHas(k.stream.structural, e.text, e.since)) pending.splice(p, 1);
            else if (hub.now() > e.until) { misses.push(e.text); pending.splice(p, 1); }
        }
    }
    await run(2000);
    return { k, misses };
}

test('U1 the tour does what its captions say -- control: without the kill, the restart is missed', async () => {
    const { k, misses } = await play(TOUR);
    assert.deepEqual(misses, []);
    assert.equal(k.stats.c[S_FAILED], 0, 'no request failed during the tour');
    assert.deepEqual(Array.from(k.balancers.shared.up), new Array(8).fill(1), 'every worker back');
    assert.equal(k.balancers.name, 'p2c');
    const noKill = TOUR.map((s) => (s.act && s.act[0] === 'fault' && s.act[1] === 2 && s.act[2] === 'kill' ? { ...s, act: null } : s));
    const c = await play(noKill);
    assert.ok(c.misses.includes('w2 restarted by its supervisor'), 'control: ' + JSON.stringify(c.misses));
});

test('U2 the script is well formed', () => {
    const verbs = new Set(['strategy', 'fault', 'heal', 'reset']);
    for (let i = 0; i < TOUR.length; i++) {
        const s = TOUR[i];
        if (i > 0) assert.ok(s.at > TOUR[i - 1].at, 'step ' + i + ' after step ' + (i - 1));
        if (i === TOUR.length - 1) { assert.equal(s.say, null); assert.equal(s.act, null); continue; }
        assert.equal(typeof s.say, 'string');
        assert.ok(s.say.length <= 130, 'caption ' + i + ' fits a line (' + s.say.length + ')');
        assert.ok(/^[\x20-\x7e]+$/.test(s.say), 'caption ' + i + ' is ASCII');
        if (s.act) for (const a of Array.isArray(s.act[0]) ? s.act : [s.act]) assert.ok(verbs.has(a[0]), 'verb ' + a[0]);
        if (s.expect) assert.ok(s.within > 0 && TOUR[i + 1].at - s.at >= s.within, 'step ' + i + ' window ends before the next step');
    }
});
