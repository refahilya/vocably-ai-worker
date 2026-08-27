import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleGenerateStory } from '../../src/handlers/generateStory';
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
  return new Request('https://worker.example/generate-story', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleGenerateStory', () => {
  it('returns the story/translation when every target word is marked on the first try', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse(
          '{"story":"Yesterday I [[run|ran]] to the park.","translation":"Kemarin saya berlari ke taman."}',
        ),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      story: 'Yesterday I [[run|ran]] to the park.',
      translation: 'Kemarin saya berlari ke taman.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once when a target word is missing its marker, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse('{"story":"I went to the park.","translation":"Saya pergi ke taman."}'),
      )
      .mockResolvedValueOnce(
        chatResponse(
          '{"story":"Yesterday I [[run|ran]] to the park.","translation":"Kemarin saya berlari ke taman."}',
        ),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      story: 'Yesterday I [[run|ran]] to the park.',
      translation: 'Kemarin saya berlari ke taman.',
    });
  });

  it('gives up with a 502 if the retry also misses a marker', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        chatResponse('{"story":"I went to the park.","translation":"Saya pergi ke taman."}'),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires every target word to be marked, not just one of several', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        chatResponse('{"story":"I [[run|ran]] with my souvenir.","translation":"..."}'),
      );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run', 'souvenir'], prompt: 'liburan' }),
      env,
    );

    // "souvenir" appears in the prose but is never wrapped as
    // [[souvenir|...]], so this must fail (and retry) both times.
    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty targetWords array', async () => {
    const response = await handleGenerateStory(
      requestBody({ targetWords: [], prompt: 'liburan' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a missing prompt', async () => {
    const response = await handleGenerateStory(requestBody({ targetWords: ['run'] }), env);
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await handleGenerateStory(
      new Request('https://worker.example/generate-story', { method: 'POST', body: 'not json' }),
      env,
    );
    expect(response.status).toBe(400);
  });
});
