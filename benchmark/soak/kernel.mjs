/**
 * @zakkster/lite-pick soak -- the KERNEL SEAM.
 *
 * Every soak module imports the balancer roster + Prng + sentinels THROUGH this module, never from
 * ../../Pick.js directly. By default it resolves the in-tree kernel; SOAK_KERNEL=<path> swaps in a
 * scratch copy. That seam is what lets the must-fail battery (benchmark/soak/_mustfail.mjs) patch a
 * single kernel line and drive the mutant through the REAL main.mjs -> computeGates path, instead of
 * a parallel harness that calls the gate modules directly (which is how a hollow gate self-passes).
 *
 * Uses top-level await: importers of this module await the dynamic kernel import transitively.
 */

import { pathToFileURL } from 'node:url';

const envPath = process.env.SOAK_KERNEL;
export const KERNEL_URL = envPath ? pathToFileURL(envPath).href : new URL('../../Pick.js', import.meta.url).href;
export const KERNEL_OVERRIDE = !!envPath;

const K = await import(KERNEL_URL);

export const {
    RoundRobinBalancer, SmoothWRRBalancer, P2cBalancer, LeastConnBalancer, SedBalancer,
    NqBalancer, PeakEwmaBalancer, ConsistentHashBalancer, BoundedLoadBalancer, WeightedRandomBalancer,
    Prng, PICK_NONE, CH_PROBE_LIMIT, VERSION,
} = K;

// The POOL seam. Pool.js is byte-frozen (parity), so a pool-BEHAVIOR mutant (e.g. a failover that
// repeats an endpoint) is applied to a SCRATCH copy via SOAK_POOL and driven through the real main.
// The scratch copy's `from './Pick.js'` is rewritten to an absolute URL by the mutant writer, so the
// mutant Pool still uses the real (or SOAK_KERNEL) balancer instance passed to its constructor.
const poolPath = process.env.SOAK_POOL;
export const POOL_URL = poolPath ? pathToFileURL(poolPath).href : new URL('../../Pool.js', import.meta.url).href;
export const POOL_OVERRIDE = !!poolPath;
const P = await import(POOL_URL);
export const Pool = P.Pool;
