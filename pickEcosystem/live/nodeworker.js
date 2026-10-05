/**
 * pickEcosystem/live -- a lite-worker-pool SET-MODE transport over node:worker_threads (the terminal surface;
 * the browser uses lite-worker-pool's default Blob-URL workers). Implements the set-mode surface:
 * send / onRaw / onError / onPost / post / terminate. The worker speaks the set protocol: READY on load,
 * a flagged buffer + "lwp:terr" on a transform throw, "lwp:ctl" control values in. An unexpected thread exit
 * (the crash fault calls process.exit) is a death: onError.
 */

import { Worker } from 'node:worker_threads';

const ENTRY = `
const { parentPort, workerData } = require('node:worker_threads');
const fn = (0, eval)('(' + workerData.src + ')');
let ctl = new Float64Array(0);
parentPort.on('message', (msg) => {
  if (msg instanceof ArrayBuffer) {
    const f = new Float64Array(msg);
    try { f[1] = fn(f[1], ctl); f[2] = 0; }
    catch (e) { f[2] = 1; parentPort.postMessage({ t: 'lwp:terr', d: { message: (e && e.message) || String(e) } }); }
    parentPort.postMessage(msg, [msg]);
    return;
  }
  if (msg && msg.t === 'lwp:ctl') ctl = msg.d instanceof Float64Array ? msg.d : new Float64Array(0);
});
parentPort.postMessage({ t: 'lwp:ready', d: null });
`;

/** The `spawn` for createWorkerSet: one real OS thread per worker. */
export function nodeSetSpawn(spec) {
    const worker = new Worker(ENTRY, { eval: true, workerData: { src: spec.workerFn.toString() } });
    let raw = null, err = null, post = null, terminating = false;
    worker.on('error', (e) => { if (err !== null) err(e instanceof Error ? e : new Error(String(e))); });
    worker.on('exit', (code) => { if (!terminating && err !== null) err(new Error('worker thread exited with code ' + code)); });
    worker.on('message', (msg) => {
        if (msg instanceof ArrayBuffer) { if (raw !== null) raw(msg); return; }
        if (msg && typeof msg.t === 'string' && post !== null) post(msg.t, msg.d);
    });
    return {
        send(buf, transfer) { worker.postMessage(buf, transfer || [buf]); },
        onRaw(fn) { raw = fn; return () => { raw = null; }; },
        onError(fn) { err = fn; return () => { err = null; }; },
        onPost(fn) { post = fn; return () => { post = null; }; },
        post(type, data) { worker.postMessage({ t: type, d: data }); },
        terminate() { terminating = true; worker.terminate(); },
    };
}
