/**
 * Pool Scope -- siblings.mjs : the OPTIONAL PEER layer (PS2 lego-thesis seam).
 *
 *     import { SKETCH, ADAPTIVE, LATENCY_BACKING, DETECTOR_BACKING, HOTKEY_BACKING } from './siblings.mjs';
 *
 * This is the whole lego thesis in one file: Pool Scope PREFERS witnessed, paper-backed sibling
 * kernels for its latency / detector / hot-key math, but the KERNEL (lite-pick) imports NOTHING from
 * them and the demo STILL RUNS with the PS1 inlined math when a sibling is absent. The siblings live in
 * lite-pick's devDependencies ONLY (Pool Scope is repo-only, excluded from the tarball); peerDependencies
 * stays {} -- they are never a hard dep.
 *
 *   @zakkster/lite-sketch  -> DDSketch (relative-error latency quantiles, 0 B/op add, HARD +-alpha bound).
 *   @zakkster/lite-adaptive-> ADWIN (concept-drift -> oscillation), ForwardDecay (decayed per-worker
 *                             share/rate), HeavyKeeper (decayed top-k -> the HOT-KEY panel).
 *
 * The import is DYNAMIC + fail-open (top-level await, try/catch): a missing package, a load error, or an
 * env override degrades to `null`, and every consumer falls back to the PS1 inlined path behind the SAME
 * internal interface (a swap, not a rewrite). Force the fallback to prove graceful degradation:
 *   POOL_SCOPE_NO_SKETCH=1    -> latency falls back to the inline pre-alloc-sort ring.
 *   POOL_SCOPE_NO_ADAPTIVE=1  -> detectors / decayed-share / hot-keys fall back to the inline math.
 */

const noSketch = process.env.POOL_SCOPE_NO_SKETCH === '1';
const noAdaptive = process.env.POOL_SCOPE_NO_ADAPTIVE === '1';

let _sketch = null;
if (!noSketch) {
    try {
        const m = await import('@zakkster/lite-sketch');
        if (typeof m.DDSketch === 'function' && typeof m.SpaceSaving === 'function') {
            _sketch = { DDSketch: m.DDSketch, SpaceSaving: m.SpaceSaving, VERSION: m.VERSION };
        }
    } catch { _sketch = null; }
}

let _adaptive = null;
if (!noAdaptive) {
    try {
        const m = await import('@zakkster/lite-adaptive');
        if (typeof m.ADWIN === 'function' && typeof m.ForwardDecay === 'function' &&
            typeof m.HeavyKeeper === 'function') {
            _adaptive = { ADWIN: m.ADWIN, ForwardDecay: m.ForwardDecay, HeavyKeeper: m.HeavyKeeper, VERSION: m.VERSION };
        }
    } catch { _adaptive = null; }
}

/** The lite-sketch bricks (DDSketch + SpaceSaving), or null when the peer is absent / forced off. */
export const SKETCH = _sketch;

/** The lite-adaptive bricks (ADWIN + ForwardDecay + HeavyKeeper), or null when absent / forced off. */
export const ADAPTIVE = _adaptive;

/** On-screen backing indicators (the demo header prints these so the live wiring is visible). */
export const LATENCY_BACKING = _sketch ? 'lite-sketch' : 'inline (fallback)';
export const DETECTOR_BACKING = _adaptive ? 'lite-adaptive' : 'inline (fallback)';
export const HOTKEY_BACKING = _adaptive ? 'lite-adaptive' : 'inline (fallback)';
