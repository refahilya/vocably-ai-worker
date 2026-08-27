import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleRequest, type RouterDeps } from '../src/index';
import type { Env } from '../src/env';

const env: Env = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_BASE_URL: 'https://ai.example/v1',
  OPENAI_API_PATH: '/chat/completions',
  OPENAI_MODEL: 'gpt-4o-mini',
  FIREBASE_PROJECT_ID: 'vocably-idn-en',
  ALLOWED_ORIGINS: 'https://vocably-idn-en.web.app',
};

const acceptAuth: RouterDeps['verifyIdToken'] = async () => ({ ok: true, uid: 'uid-1' });
const rejectAuth: RouterDeps['verifyIdToken'] = async () => ({
  ok: false,
  reason: 'missing_token',
});
const allowRate: RouterDeps['checkRateLimit'] = async () => true;
const denyRate: RouterDeps['checkRateLimit'] = async () => false;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleRequest — routing pipeline', () => {
  it('handles an OPTIONS preflight without needing auth/rate-limit deps at all', async () => {
    const request = new Request('https://worker.example/translate', {
      method: 'OPTIONS',
      headers: { Origin: 'https://vocably-idn-en.web.app' },
    });

    // Deliberately deps that would fail if called, to prove OPTIONS
    // short-circuits before either runs.
    const response = await handleRequest(request, env, {
      verifyIdToken: rejectAuth,
      checkRateLimit: denyRate,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://vocably-idn-en.web.app',
    );
  });

  it('rejects non-POST, non-OPTIONS requests with 405', async () => {
    const request = new Request('https://worker.example/translate', { method: 'GET' });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: allowRate,
    });

    expect(response.status).toBe(405);
  });

  it('returns 401 when the ID token is missing/invalid', async () => {
    const request = new Request('https://worker.example/translate', {
      method: 'POST',
      body: '{}',
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: rejectAuth,
      checkRateLimit: allowRate,
    });

    expect(response.status).toBe(401);
  });

  it('returns 429 when the rate limiter rejects an otherwise-valid caller', async () => {
    const request = new Request('https://worker.example/translate', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer whatever' },
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: denyRate,
    });

    expect(response.status).toBe(429);
  });

  it('returns 404 for an unknown path once auth/rate-limit pass', async () => {
    const request = new Request('https://worker.example/not-a-real-endpoint', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer whatever' },
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: allowRate,
    });

    expect(response.status).toBe(404);
  });

  it('dispatches /translate to the translate handler once auth/rate-limit pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"translation":"berlari"}' } }] }),
          { status: 200 },
        ),
      ),
    );
    const request = new Request('https://worker.example/translate', {
      method: 'POST',
      body: JSON.stringify({ word: 'run', pos: 'verb' }),
      headers: { Authorization: 'Bearer whatever' },
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: allowRate,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translation: 'berlari' });
  });

  it('adds CORS headers to the final response when the origin matched', async () => {
    const request = new Request('https://worker.example/not-a-real-endpoint', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer whatever', Origin: 'https://vocably-idn-en.web.app' },
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: allowRate,
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://vocably-idn-en.web.app',
    );
  });

  it('does not add CORS headers when the origin did not match the allowlist', async () => {
    const request = new Request('https://worker.example/not-a-real-endpoint', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer whatever', Origin: 'https://evil.example' },
    });

    const response = await handleRequest(request, env, {
      verifyIdToken: acceptAuth,
      checkRateLimit: allowRate,
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
