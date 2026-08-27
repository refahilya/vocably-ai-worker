import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCowriteTurn } from '../../src/handlers/cowriteTurn';
import type { Env } from '../../src/env';

const env = {
  OPENAI_BASE_URL: 'https://ai.example/v1',
  OPENAI_API_PATH: '/chat/completions',
  OPENAI_MODEL: 'gpt-4o-mini',
  OPENAI_API_KEY: 'test-key',
} as Env;

function chatResponse(contentObj: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(contentObj) } }] }),
    { status: 200 },
  );
}

function requestBody(body: unknown): Request {
  return new Request('https://worker.example/cowrite-turn', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validBody = {
  transcript: [{ sender: 'siswa', text: 'I run everyday.' }],
  remainingWords: ['run', 'souvenir'],
  requestSuggestion: false,
};

describe('handleCowriteTurn', () => {
  it('returns the structured result on a well-formed AI response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatResponse({
          aiTurn: 'That sounds fun!',
          feedback: null,
          hasError: false,
          wordsUsedCorrectly: ['run'],
          suggestion: null,
        }),
      ),
    );

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aiTurn: 'That sounds fun!',
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: ['run'],
      suggestion: null,
    });
  });

  it('passes through a non-null feedback/suggestion when the AI provides them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        chatResponse({
          aiTurn: 'Almost! Try again.',
          feedback: 'Kalimat itu perlu kata kerja bantu.',
          hasError: true,
          wordsUsedCorrectly: [],
          suggestion: 'You could write: "I bought a souvenir."',
        }),
      ),
    );

    const response = await handleCowriteTurn(
      requestBody({ ...validBody, requestSuggestion: true }),
      env,
    );

    const result = (await response.json()) as {
      feedback: string | null;
      hasError: boolean;
      suggestion: string | null;
    };
    expect(result.feedback).toBe('Kalimat itu perlu kata kerja bantu.');
    expect(result.hasError).toBe(true);
    expect(result.suggestion).toContain('souvenir');
  });

  it('rejects a transcript entry with an invalid sender', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...validBody, transcript: [{ sender: 'teacher', text: 'hi' }] }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a transcript entry missing text', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...validBody, transcript: [{ sender: 'siswa' }] }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a non-array remainingWords', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...validBody, remainingWords: 'run' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a missing requestSuggestion flag', async () => {
    const { requestSuggestion: _unused, ...rest } = validBody;
    const response = await handleCowriteTurn(requestBody(rest), env);
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await handleCowriteTurn(
      new Request('https://worker.example/cowrite-turn', { method: 'POST', body: 'not json' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('returns 502 when the AI response is missing a required field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse({ aiTurn: 'ok' })));

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(502);
  });

  it('returns 502 when the AI backend call fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(502);
  });
});
