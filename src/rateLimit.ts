import type { Env } from './env';

/**
 * Rate limiting (DATA_MODEL.md §10.1), keyed by the verified caller's
 * `uid` (never IP — many students share one school network).
 *
 * Prefers Cloudflare's native Rate Limiting binding when it's configured
 * (see `wrangler.jsonc`'s commented-out `unsafe.bindings` block) — it's
 * uncertain whether that binding is available on the Workers **Free**
 * plan (this project's hard zero-billing constraint), so this Worker
 * ships without it by default and falls back to a zero-cost in-memory
 * per-isolate counter instead (project owner's explicit decision).
 *
 * **Trade-off of the in-memory fallback (accepted, not a bug):** it
 * resets on cold start and isn't shared across Cloudflare's edge
 * locations/isolates, so it's an approximate limit, not an exact one —
 * good enough to stop a runaway client or a scripted abuse attempt at
 * this project's scale (~60 students), not a precise global quota. Once
 * the native binding is confirmed available and added to
 * `wrangler.jsonc`, this file switches to it automatically with no
 * caller-side changes needed.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

interface Bucket {
  count: number;
  windowStart: number;
}

/** Module-level — persists for the lifetime of one Worker isolate. */
const inMemoryBuckets = new Map<string, Bucket>();

function checkInMemory(key: string, now: number): boolean {
  const bucket = inMemoryBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    inMemoryBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  bucket.count += 1;
  return true;
}

/** `true` if the request is allowed to proceed. */
export async function checkRateLimit(env: Env, key: string): Promise<boolean> {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key });
    return success;
  }
  return checkInMemory(key, Date.now());
}

/** Test-only: clears the in-memory fallback's state between test cases. */
export function _resetInMemoryRateLimiterForTests(): void {
  inMemoryBuckets.clear();
}
