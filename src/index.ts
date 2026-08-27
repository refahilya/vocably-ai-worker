import type { Env } from './env';
import { handlePreflight, matchOrigin, withCors } from './cors';
import { verifyIdToken } from './auth';
import { checkRateLimit } from './rateLimit';
import { handleTranslate } from './handlers/translate';
import { handleGenerateStory } from './handlers/generateStory';
import { handleCowriteTurn } from './handlers/cowriteTurn';

/**
 * Vocably AI proxy Worker (`CLAUDE.md` §2/§7 Milestone 5, `DATA_MODEL.md`
 * §10). Every request — regardless of path — goes through the same
 * pipeline: CORS preflight short-circuit, origin check, Firebase ID
 * token verification, rate limiting, then dispatch to one of the three
 * documented endpoints. This Worker never touches Firestore (§10.1) —
 * it only calls the configured OpenAI-compatible backend and returns
 * raw results for the Flutter client to write.
 */

/** The two steps injectable for testing (mirrors `verifyIdToken`'s own
 * injectable-JWKS parameter) — lets `handleRequest`'s routing/CORS/
 * status-code logic be tested deterministically, without real network
 * calls to Google's JWKS endpoint or a real rate-limit window. */
export interface RouterDeps {
  verifyIdToken: typeof verifyIdToken;
  checkRateLimit: typeof checkRateLimit;
}

const defaultDeps: RouterDeps = { verifyIdToken, checkRateLimit };

export async function handleRequest(
  request: Request,
  env: Env,
  deps: RouterDeps = defaultDeps,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return handlePreflight(request, env);
  }

  const matchedOrigin = matchOrigin(request, env);

  if (request.method !== 'POST') {
    return respond(new Response('Method not allowed.', { status: 405 }), matchedOrigin);
  }

  const auth = await deps.verifyIdToken(request, env);
  if (!auth.ok) {
    return respond(
      Response.json({ error: 'Unauthorized: invalid or missing ID token.' }, { status: 401 }),
      matchedOrigin,
    );
  }

  const allowed = await deps.checkRateLimit(env, auth.uid);
  if (!allowed) {
    return respond(
      Response.json({ error: 'Rate limit exceeded. Please try again shortly.' }, { status: 429 }),
      matchedOrigin,
    );
  }

  const url = new URL(request.url);
  let response: Response;
  switch (url.pathname) {
    case '/translate':
      response = await handleTranslate(request, env);
      break;
    case '/generate-story':
      response = await handleGenerateStory(request, env);
      break;
    case '/cowrite-turn':
      response = await handleCowriteTurn(request, env);
      break;
    default:
      response = Response.json({ error: 'Not found.' }, { status: 404 });
  }

  return respond(response, matchedOrigin);
}

/** Adds CORS headers when the origin matched the allowlist; passes the
 * response through unchanged (still fine for non-browser callers, e.g.
 * curl during manual testing) when it didn't. */
function respond(response: Response, matchedOrigin: string | null): Response {
  return matchedOrigin ? withCors(response, matchedOrigin) : response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
