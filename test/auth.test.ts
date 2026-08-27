import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type JWK,
} from 'jose';

import { verifyIdToken } from '../src/auth';
import type { Env } from '../src/env';

/**
 * These tests verify against a **locally generated** key pair (via
 * `createLocalJWKSet`, injected as `verifyIdToken`'s third argument)
 * rather than Google's real, network-fetched keys — `remoteFirebaseJWKS()`
 * itself is intentionally not exercised here (it's a thin, untestable-
 * without-real-network wrapper around `jose.createRemoteJWKSet`).
 */

const PROJECT_ID = 'vocably-idn-en';
const KEY_ID = 'test-key';
const env = { FIREBASE_PROJECT_ID: PROJECT_ID } as Env;

async function makeJwks(): Promise<{ jwks: JWTVerifyGetKey; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return { jwks, privateKey };
}

function requestWithAuthHeader(value: string | null): Request {
  return new Request('https://worker.example/translate', {
    headers: value ? { Authorization: value } : {},
  });
}

describe('verifyIdToken', () => {
  it('returns the uid for a validly signed token with the correct aud/iss', async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuedAt()
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject('student-uid-1')
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await verifyIdToken(requestWithAuthHeader(`Bearer ${token}`), env, jwks);

    expect(result).toEqual({ ok: true, uid: 'student-uid-1' });
  });

  it('rejects when there is no Authorization header', async () => {
    const { jwks } = await makeJwks();

    const result = await verifyIdToken(requestWithAuthHeader(null), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('rejects an Authorization header that is not a Bearer token', async () => {
    const { jwks } = await makeJwks();

    const result = await verifyIdToken(requestWithAuthHeader('Basic dXNlcjpwYXNz'), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('rejects a token signed for a different Firebase project (wrong audience)', async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuedAt()
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience('some-other-firebase-project')
      .setSubject('student-uid-1')
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await verifyIdToken(requestWithAuthHeader(`Bearer ${token}`), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a token with the wrong issuer', async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuedAt()
      .setIssuer('https://securetoken.google.com/some-other-firebase-project')
      .setAudience(PROJECT_ID)
      .setSubject('student-uid-1')
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await verifyIdToken(requestWithAuthHeader(`Bearer ${token}`), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects an expired token', async () => {
    const { jwks, privateKey } = await makeJwks();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuedAt(nowSeconds - 7200)
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject('student-uid-1')
      .setExpirationTime(nowSeconds - 3600)
      .sign(privateKey);

    const result = await verifyIdToken(requestWithAuthHeader(`Bearer ${token}`), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a malformed token', async () => {
    const { jwks } = await makeJwks();

    const result = await verifyIdToken(
      requestWithAuthHeader('Bearer not-a-real-jwt'),
      env,
      jwks,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('rejects a token signed by a key not in the JWKS (wrong signing key)', async () => {
    const { jwks } = await makeJwks();
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuedAt()
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject('student-uid-1')
      .setExpirationTime('1h')
      .sign(otherPrivateKey);

    const result = await verifyIdToken(requestWithAuthHeader(`Bearer ${token}`), env, jwks);

    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });
});
