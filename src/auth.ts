import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Env } from './env';

/**
 * Manual Firebase ID token verification (DATA_MODEL.md §10.1) — the
 * Firebase Admin SDK doesn't run in the Workers runtime (Web-standard
 * API, not Node.js), so this replicates what it would do:
 *
 * 1. Fetch Google's current public signing keys and verify the token's
 *    RS256 signature against them.
 * 2. Check `aud` == this Firebase project's ID and `iss` ==
 *    `https://securetoken.google.com/{projectId}` — skipping `aud` would
 *    let a token from an unrelated Firebase project pass.
 * 3. `exp` is checked by `jwtVerify` itself.
 * 4. The verified `sub` claim is the caller's `uid`.
 *
 * Uses the JWKS-shaped variant of Google's public keys
 * (`.../service_accounts/v1/jwk/...`) rather than the X.509 variant named
 * in `DATA_MODEL.md` §10.1 — both publish the exact same
 * `securetoken@system.gserviceaccount.com` signing keys, just in a
 * different encoding; the JWKS one is what `jose`'s `createRemoteJWKSet`
 * (which already caches results and handles key rotation) expects
 * natively, avoiding hand-rolled X.509 parsing for an equivalent result.
 */
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let cachedJWKS: JWTVerifyGetKey | null = null;

/** The real, network-backed key set — created once per isolate. */
export function remoteFirebaseJWKS(): JWTVerifyGetKey {
  cachedJWKS ??= createRemoteJWKSet(new URL(JWKS_URL));
  return cachedJWKS;
}

export type AuthResult =
  | { ok: true; uid: string }
  | { ok: false; reason: 'missing_token' | 'invalid_token' };

/**
 * `jwks` is injectable so tests can verify against a locally-generated
 * key pair instead of Google's real, network-fetched keys — production
 * callers should omit it and get `remoteFirebaseJWKS()`.
 */
export async function verifyIdToken(
  request: Request,
  env: Env,
  jwks: JWTVerifyGetKey = remoteFirebaseJWKS(),
): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_token' };
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, reason: 'missing_token' };
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return { ok: false, reason: 'invalid_token' };
    }
    return { ok: true, uid: payload.sub };
  } catch {
    // Covers: bad signature, expired, wrong aud/iss, malformed token —
    // none of these are actionable differently by the caller, so one
    // bucket (mirrors DictionaryApiService's networkError bucketing on
    // the Flutter side of this project).
    return { ok: false, reason: 'invalid_token' };
  }
}
