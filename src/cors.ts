import type { Env } from './env';

/**
 * CORS handling (DATA_MODEL.md §10.1) — allowlist-based, never `*`.
 *
 * This is NOT real security (any non-browser caller, e.g. `curl`, ignores
 * CORS entirely) — it only stops other people's web pages from calling
 * this Worker from a signed-in student/teacher's browser. The real
 * protections are ID token verification (`src/auth.ts`) and rate
 * limiting (`src/rateLimit.ts`).
 */

function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** `null` if the request's Origin isn't on the allowlist (or is absent). */
export function matchOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

function corsHeaders(matchedOrigin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': matchedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Handles a CORS preflight `OPTIONS` request. Returns a `Response` whether
 * or not the origin matched — an unmatched origin gets a plain 204 with no
 * `Access-Control-Allow-Origin` header, which the browser then blocks
 * itself (this Worker doesn't need to distinguish the two cases with a
 * different status code).
 */
export function handlePreflight(request: Request, env: Env): Response {
  const matched = matchOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: matched ? corsHeaders(matched) : undefined,
  });
}

/** Adds the CORS headers for a matched origin onto an existing response. */
export function withCors(response: Response, matchedOrigin: string): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(matchedOrigin))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
