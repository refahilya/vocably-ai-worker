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

  it('accepts a story where every target word (multiple) is marked exactly once', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          story:
            'Yesterday I [[run|ran]] to the park. I bought a [[souvenir|souvenir]] there.',
          translation: '...',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run', 'souvenir'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate marker for the same target word (used twice)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse(
        '{"story":"I [[run|ran]] to the park, then [[run|ran]] home.","translation":"..."}',
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an extra marker for a word that was never requested', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      chatResponse(
        '{"story":"I [[run|ran]] to the park and grabbed a [[souvenir|souvenir]].","translation":"..."}',
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    // Only "run" was requested — the "souvenir" marker is hallucinated.
    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a marker whose spelling/case does not exactly match the requested word', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        chatResponse('{"story":"Yesterday I [[Run|ran]] to the park.","translation":"..."}'),
      );
    vi.stubGlobal('fetch', fetchImpl);

    // Requested word is lowercase "run"; the marker uses "Run".
    const response = await handleGenerateStory(
      requestBody({ targetWords: ['run'], prompt: 'liburan' }),
      env,
    );

    expect(response.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it(
    'tells the model the EXACT sentence count for a single target word (Milestone 7 ' +
      'Phase 2 Stage 6: an explicit number, not just "as many as target words")',
    async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          chatResponse(
            '{"story":"Yesterday I [[run|ran]] to the park.","translation":"Kemarin saya berlari ke taman."}',
          ),
        );
      vi.stubGlobal('fetch', fetchImpl);

      await handleGenerateStory(requestBody({ targetWords: ['run'], prompt: 'liburan' }), env);

      const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
      const sentSystemPrompt = (
        JSON.parse(requestInit.body as string).messages as { role: string; content: string }[]
      ).find((m) => m.role === 'system')?.content;
      expect(sentSystemPrompt).toMatch(/exactly 1 sentence\b/i);
    },
  );

  it('tells the model the EXACT sentence count for multiple target words', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      chatResponse(
        JSON.stringify({
          story:
            'Yesterday I [[run|ran]] to the park. I bought a [[souvenir|souvenir]] there.',
          translation: '...',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await handleGenerateStory(
      requestBody({ targetWords: ['run', 'souvenir'], prompt: 'liburan' }),
      env,
    );

    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sentSystemPrompt = (
      JSON.parse(requestInit.body as string).messages as { role: string; content: string }[]
    ).find((m) => m.role === 'system')?.content;
    expect(sentSystemPrompt).toMatch(/exactly 2 sentences\b/i);
  });

  it('tells the model to use simple, EFL-learner-appropriate language', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse(
          '{"story":"Yesterday I [[run|ran]] to the park.","translation":"Kemarin saya berlari ke taman."}',
        ),
      );
    vi.stubGlobal('fetch', fetchImpl);

    await handleGenerateStory(requestBody({ targetWords: ['run'], prompt: 'liburan' }), env);

    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sentSystemPrompt = (
      JSON.parse(requestInit.body as string).messages as { role: string; content: string }[]
    ).find((m) => m.role === 'system')?.content;
    expect(sentSystemPrompt).toMatch(/EFL/);
    expect(sentSystemPrompt).toMatch(/simple/i);
    expect(sentSystemPrompt).toMatch(/common, everyday vocabulary/i);
    expect(sentSystemPrompt).toMatch(/not artificially short/i);
  });

  it('no longer instructs the model to wrap every occurrence of a repeated target word', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse(
          '{"story":"Yesterday I [[run|ran]] to the park.","translation":"Kemarin saya berlari ke taman."}',
        ),
      );
    vi.stubGlobal('fetch', fetchImpl);

    await handleGenerateStory(requestBody({ targetWords: ['run'], prompt: 'liburan' }), env);

    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sentSystemPrompt = (
      JSON.parse(requestInit.body as string).messages as { role: string; content: string }[]
    ).find((m) => m.role === 'system')?.content;
    expect(sentSystemPrompt).not.toMatch(/wrap every occurrence/i);
    expect(sentSystemPrompt).toMatch(/exactly once/i);
  });

  // The tests below are prompt-CONTRACT regression tests only — they assert
  // the exact wording sent to the model, not actual model behavior. They
  // cannot and do not prove a real model will never again write
  // [[actor|acted]] or [[baby|girl]]; that can only be observed via live/
  // manual testing against the real deployed Worker.
  describe(
    'system prompt instructions (Milestone 7 Phase 2 Stage 8: usedForm must be the ' +
      'same word as targetWord, inflection allowed, substitution forbidden)',
    () => {
      async function capturedSystemPrompt(wordCount = 1): Promise<string> {
        const words = wordCount === 1 ? ['run'] : ['run', 'souvenir'];
        const fetchImpl = vi.fn().mockResolvedValueOnce(
          chatResponse(
            JSON.stringify({
              story: words.map((w) => `[[${w}|${w}]]`).join(' '),
              translation: '...',
            }),
          ),
        );
        vi.stubGlobal('fetch', fetchImpl);

        await handleGenerateStory(requestBody({ targetWords: words, prompt: 'liburan' }), env);

        const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
        return (
          JSON.parse(requestInit.body as string).messages as { role: string; content: string }[]
        ).find((m) => m.role === 'system')?.content ?? '';
      }

      it('requires usedForm to be the exact same word as targetWord', async () => {
        const prompt = await capturedSystemPrompt();
        expect(prompt).toMatch(/usedForm MUST be the exact same word as targetWord/i);
      });

      it('explicitly allows natural grammatical inflection', async () => {
        const prompt = await capturedSystemPrompt();
        expect(prompt).toMatch(/natural inflection is required and expected/i);
        expect(prompt).toMatch(/\[\[run\|ran\]\]/);
        expect(prompt).toMatch(/\[\[baby\|babies\]\]/);
      });

      it('explicitly forbids substituting a different word or synonym', async () => {
        const prompt = await capturedSystemPrompt();
        expect(prompt).toMatch(/substituting a different word, a synonym.*is FORBIDDEN/i);
      });

      it('explicitly treats actor -> acted as invalid, by name', async () => {
        const prompt = await capturedSystemPrompt();
        expect(prompt).toMatch(/\[\[actor\|acted\]\] is WRONG/i);
      });

      it('explicitly treats baby -> girl as invalid, by name', async () => {
        const prompt = await capturedSystemPrompt();
        expect(prompt).toMatch(/\[\[baby\|girl\]\] is WRONG/i);
      });
    },
  );

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
