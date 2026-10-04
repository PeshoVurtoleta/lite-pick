/**
 * @zakkster/lite-pick/pool -- diagnostics_channel events (1.1.0, research/1.1.0-kernel-and-api.md 7.2, D7).
 *
 *     node --test test/PoolChannels.test.js
 *
 * Falsifiable assertions:
 *   P1. Where `process.getBuiltinModule` exists (Node >= 20.16 / 22.3), a run publishes one DISPATCH per
 *       attempt `{ pool, endpoint, attempt, key, now }` and one SETTLE per attempt `{ pool, endpoint, attempt,
 *       ok, error, aborted }`, in order; where it does not (Node 18), Pool publishes nothing and still works.
 *   P2. Failover: dispatch 0, settle 0 (ok false, the error), dispatch 1 on a DIFFERENT endpoint, settle 1 ok.
 *   P3. A caller abort mid-flight settles with `aborted: true`.
 *   P4. One reused message object per channel; after publish its references are cleared (no retained Pool or
 *       error); a run started INSIDE a subscriber gets a fresh object, so the outer event stays intact for the
 *       remaining subscribers.
 *   P5. Keyed (`key`) and latency (`now`) runs carry those fields; unsubscribing stops delivery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { P2cBalancer, ConsistentHashBalancer, PeakEwmaBalancer } from '../Pick.js';
import { Pool, POOL_CHANNEL_DISPATCH, POOL_CHANNEL_SETTLE } from '../Pool.js';

const HAS = typeof process.getBuiltinModule === 'function';
const up = (n) => new Uint8Array(n).fill(1);

/** Subscribe both channels, copying each message; returns { events, raw, stop }. */
function listen() {
    const events = [], raw = [];
    const onD = (m) => { raw.push(m); events.push({ ch: 'dispatch', pool: m.pool, endpoint: m.endpoint, attempt: m.attempt, key: m.key, now: m.now }); };
    const onS = (m) => { raw.push(m); events.push({ ch: 'settle', pool: m.pool, endpoint: m.endpoint, attempt: m.attempt, ok: m.ok, error: m.error, aborted: m.aborted }); };
    dc.subscribe(POOL_CHANNEL_DISPATCH, onD);
    dc.subscribe(POOL_CHANNEL_SETTLE, onS);
    return { events, raw, stop() { dc.unsubscribe(POOL_CHANNEL_DISPATCH, onD); dc.unsubscribe(POOL_CHANNEL_SETTLE, onS); } };
}

test('P1: channel names are the module-prefixed constants', () => {
    assert.equal(POOL_CHANNEL_DISPATCH, 'lite-pick:pool:dispatch');
    assert.equal(POOL_CHANNEL_SETTLE, 'lite-pick:pool:settle');
});

test('P1: one dispatch + one settle per successful run (none where getBuiltinModule is absent)', async () => {
    const inf = new Uint32Array(4), pool = new Pool(new P2cBalancer(4, up(4), inf), inf);
    const l = listen();
    try {
        const out = await pool.run((i) => 'ok:' + i);
        if (!HAS) { assert.equal(l.events.length, 0, 'no channels without process.getBuiltinModule'); return; }
        assert.equal(l.events.length, 2);
        const [d, s] = l.events;
        assert.equal(d.ch, 'dispatch');
        assert.equal(d.pool, pool);
        assert.equal(out, 'ok:' + d.endpoint);
        assert.equal(d.attempt, 0);
        assert.equal(d.key, undefined);
        assert.equal(d.now, undefined);
        assert.deepEqual([s.ch, s.pool, s.endpoint, s.attempt, s.ok, s.error, s.aborted],
            ['settle', pool, d.endpoint, 0, true, undefined, false]);
    } finally { l.stop(); }
});

test('P2: failover publishes dispatch/settle per attempt, the failed one with its error', { skip: !HAS }, async () => {
    const inf = new Uint32Array(4), pool = new Pool(new P2cBalancer(4, up(4), inf), inf);
    const boom = new Error('boom');
    const l = listen();
    try {
        let first = -1;
        await pool.run((i) => { if (first < 0) { first = i; throw boom; } return i; }, { tries: 2 });
        assert.deepEqual(l.events.map((e) => e.ch + e.attempt), ['dispatch0', 'settle0', 'dispatch1', 'settle1']);
        assert.equal(l.events[1].ok, false);
        assert.equal(l.events[1].error, boom);
        assert.equal(l.events[1].aborted, false);
        assert.equal(l.events[1].endpoint, first);
        assert.notEqual(l.events[2].endpoint, first, 'the failover went to a distinct endpoint');
        assert.equal(l.events[3].ok, true);
    } finally { l.stop(); }
});

test('P3: a caller abort mid-flight settles with aborted: true', { skip: !HAS }, async () => {
    const inf = new Uint32Array(4), pool = new Pool(new P2cBalancer(4, up(4), inf), inf);
    const ac = new AbortController();
    const l = listen();
    try {
        await assert.rejects(pool.run(() => { ac.abort(); throw new Error('cancelled'); }, { signal: ac.signal, tries: 3 }));
        assert.deepEqual(l.events.map((e) => e.ch), ['dispatch', 'settle'], 'no failover after an abort');
        assert.equal(l.events[1].aborted, true);
        assert.equal(l.events[1].ok, false);
    } finally { l.stop(); }
});

test('P4: one reused message per channel, cleared after publish; a nested run gets a fresh one', { skip: !HAS }, async () => {
    const inf = new Uint32Array(4), pool = new Pool(new P2cBalancer(4, up(4), inf), inf);
    const l = listen();
    try {
        await pool.run((i) => i);
        await pool.run((i) => i);
        const dMsgs = l.raw.filter((m) => 'key' in m), sMsgs = l.raw.filter((m) => 'ok' in m);
        assert.equal(new Set(dMsgs).size, 1, 'one dispatch message object');
        assert.equal(new Set(sMsgs).size, 1, 'one settle message object');
        assert.equal(dMsgs[0].pool, null, 'no Pool retained after publish');
        assert.equal(sMsgs[0].pool, null);
        assert.equal(sMsgs[0].error, undefined, 'no error retained after publish');
    } finally { l.stop(); }

    // Nested: the FIRST subscriber starts a run synchronously (its dispatch publishes before the run's first
    // await); the SECOND subscriber, still inside the outer publish, must see the OUTER event.
    const inner = new Uint32Array(4), innerPool = new Pool(new P2cBalancer(4, up(4), inner), inner);
    const seen = [];
    let nested = false;
    const first = (m) => { if (m.pool === pool && !nested) { nested = true; innerPool.run((i) => i); } };
    const second = (m) => { seen.push(m.pool); };
    dc.subscribe(POOL_CHANNEL_DISPATCH, first);
    dc.subscribe(POOL_CHANNEL_DISPATCH, second);
    try {
        await pool.run((i) => i);
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(seen, [innerPool, pool], 'inner event first (nested), then the intact outer event');
    } finally {
        dc.unsubscribe(POOL_CHANNEL_DISPATCH, first);
        dc.unsubscribe(POOL_CHANNEL_DISPATCH, second);
    }
});

test('P5: keyed runs carry the key, latency runs carry now; unsubscribe stops delivery', { skip: !HAS }, async () => {
    const chInf = new Uint32Array(8), ch = new Pool(new ConsistentHashBalancer(8, up(8), null, 257), chInf);
    const peInf = new Uint32Array(4), pe = new Pool(new PeakEwmaBalancer(4, up(4), peInf, 1e6), peInf);
    let t = 1000;
    const l = listen();
    try {
        await ch.run((i) => i, { key: 0xBEEF });
        await pe.run((i) => { t += 5; return i; }, { clock: () => t });
        assert.equal(l.events[0].key, 0xBEEF);
        assert.equal(l.events[2].now, 1000, 'the clock reading that drove pick(now)');
    } finally { l.stop(); }
    const before = l.events.length;
    await ch.run((i) => i, { key: 1 });
    assert.equal(l.events.length, before, 'nothing delivered after unsubscribe');
    for (let i = 0; i < 8; i++) assert.equal(chInf[i], 0);
});
