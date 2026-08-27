import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetInMemoryRateLimiterForTests, checkRateLimit } from '../src/rateLimit';
import type { Env } from '../src/env';

afterEach(() => {
  _resetInMemoryRateLimiterForTests();
  vi.useRealTimers();
});

describe('checkRateLimit — native binding path', () => {
  it('delegates to env.RATE_LIMITER when present, and allows on success', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const env = { RATE_LIMITER: { limit } } as unknown as Env;

    const allowed = await checkRateLimit(env, 'uid-1');

    expect(allowed).toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: 'uid-1' });
  });

  it('returns false when the native binding rejects', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { RATE_LIMITER: { limit } } as unknown as Env;

    expect(await checkRateLimit(env, 'uid-1')).toBe(false);
  });
});

describe('checkRateLimit — in-memory fallback (no binding configured)', () => {
  const env = {} as Env;

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 30; i++) {
      expect(await checkRateLimit(env, 'uid-a')).toBe(true);
    }
  });

  it('rejects the request once the limit is exceeded within the window', async () => {
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(env, 'uid-b');
    }
    expect(await checkRateLimit(env, 'uid-b')).toBe(false);
  });

  it('tracks separate keys (uids) independently', async () => {
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(env, 'uid-c');
    }
    expect(await checkRateLimit(env, 'uid-c')).toBe(false);
    // A different uid must not be affected by uid-c's exhausted bucket.
    expect(await checkRateLimit(env, 'uid-d')).toBe(true);
  });

  it('resets once the window elapses', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(env, 'uid-e');
    }
    expect(await checkRateLimit(env, 'uid-e')).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(await checkRateLimit(env, 'uid-e')).toBe(true);
  });
});
