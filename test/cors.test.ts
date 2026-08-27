import { describe, expect, it } from 'vitest';

import { handlePreflight, matchOrigin, withCors } from '../src/cors';
import type { Env } from '../src/env';

const env = {
  ALLOWED_ORIGINS: 'https://vocably-idn-en.web.app,http://localhost:5555',
} as Env;

describe('matchOrigin', () => {
  it('returns the origin when it is on the allowlist', () => {
    const request = new Request('https://worker.example/translate', {
      headers: { Origin: 'http://localhost:5555' },
    });
    expect(matchOrigin(request, env)).toBe('http://localhost:5555');
  });

  it('returns null when the origin is not on the allowlist', () => {
    const request = new Request('https://worker.example/translate', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(matchOrigin(request, env)).toBeNull();
  });

  it('returns null when there is no Origin header', () => {
    const request = new Request('https://worker.example/translate');
    expect(matchOrigin(request, env)).toBeNull();
  });
});

describe('handlePreflight', () => {
  it('returns 204 with CORS headers for an allowed origin', () => {
    const request = new Request('https://worker.example/translate', {
      method: 'OPTIONS',
      headers: { Origin: 'https://vocably-idn-en.web.app' },
    });
    const response = handlePreflight(request, env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://vocably-idn-en.web.app',
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('returns 204 with no CORS headers for a disallowed origin', () => {
    const request = new Request('https://worker.example/translate', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    const response = handlePreflight(request, env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('withCors', () => {
  it('adds CORS headers onto an existing response, preserving status/body', async () => {
    const original = Response.json({ ok: true }, { status: 201 });
    const wrapped = withCors(original, 'https://vocably-idn-en.web.app');
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://vocably-idn-en.web.app',
    );
    expect(await wrapped.json()).toEqual({ ok: true });
  });
});
