import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleTranslate } from '../../src/handlers/translate';
import type { Env } from '../../src/env';

const env = {
  OPENAI_BASE_URL: 'https://ai.example/v1',
  OPENAI_API_PATH: '/chat/completions',
  OPENAI_MODEL: 'gpt-4o-mini',
  OPENAI_API_KEY: 'test-key',
} as Env;

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function requestBody(body: unknown): Request {
  return new Request('https://worker.example/translate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleTranslate', () => {
  it('returns the translation on a well-formed AI response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('{"translation":"berlari"}')));

    const response = await handleTranslate(requestBody({ word: 'run', pos: 'verb' }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translation: 'berlari' });
  });

  it('strips a code fence if the model added one anyway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(chatResponse('```json\n{"translation":"berlari"}\n```')),
    );

    const response = await handleTranslate(requestBody({ word: 'run', pos: 'verb' }), env);

    expect(await response.json()).toEqual({ translation: 'berlari' });
  });

  it('rejects a missing word', async () => {
    const response = await handleTranslate(requestBody({ pos: 'verb' }), env);
    expect(response.status).toBe(400);
  });

  it('rejects an empty-string word', async () => {
    const response = await handleTranslate(requestBody({ word: '   ', pos: 'verb' }), env);
    expect(response.status).toBe(400);
  });

  it('rejects a missing pos', async () => {
    const response = await handleTranslate(requestBody({ word: 'run' }), env);
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await handleTranslate(
      new Request('https://worker.example/translate', { method: 'POST', body: 'not json' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('returns 502 when the AI backend call fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const response = await handleTranslate(requestBody({ word: 'run', pos: 'verb' }), env);

    expect(response.status).toBe(502);
  });

  it('returns 502 when the AI response is not the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('{"oops":true}')));

    const response = await handleTranslate(requestBody({ word: 'run', pos: 'verb' }), env);

    expect(response.status).toBe(502);
  });

  it('returns 502 when the AI response content is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('definitely not json')));

    const response = await handleTranslate(requestBody({ word: 'run', pos: 'verb' }), env);

    expect(response.status).toBe(502);
  });
});
