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
          aiUsedWords: [],
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
      aiUsedWords: [],
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
          aiUsedWords: [],
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

  describe('aiUsedWords (Milestone 7 Phase 2 Stage 8: 3-turn fallback)', () => {
    it('returns 502 when the AI response is missing aiUsedWords entirely', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          chatResponse({
            aiTurn: 'That sounds fun!',
            feedback: null,
            hasError: false,
            wordsUsedCorrectly: ['run'],
            suggestion: null,
            // aiUsedWords omitted on purpose.
          }),
        ),
      );

      const response = await handleCowriteTurn(requestBody(validBody), env);

      expect(response.status).toBe(502);
    });

    it('accepts and passes through an empty aiUsedWords (the normal, non-fallback case)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          chatResponse({
            aiTurn: 'That sounds fun!',
            feedback: null,
            hasError: false,
            wordsUsedCorrectly: ['run'],
            suggestion: null,
            aiUsedWords: [],
          }),
        ),
      );

      const response = await handleCowriteTurn(requestBody(validBody), env);

      expect(response.status).toBe(200);
      expect((await response.json()) as { aiUsedWords: string[] }).toMatchObject({
        aiUsedWords: [],
      });
    });

    it('accepts and passes through a non-empty aiUsedWords (a fallback turn)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          chatResponse({
            aiTurn: 'My baby cousin was there too.',
            feedback: 'Bagus!',
            hasError: false,
            wordsUsedCorrectly: [],
            suggestion: null,
            aiUsedWords: ['baby'],
          }),
        ),
      );

      const response = await handleCowriteTurn(requestBody(validBody), env);

      expect(response.status).toBe(200);
      expect((await response.json()) as { aiUsedWords: string[] }).toMatchObject({
        aiUsedWords: ['baby'],
      });
    });
  });

  describe('system prompt instructions for aiTurn (Milestone 7 Phase 2 Stage 1)', () => {
    it('requires the AI turn to be exactly one sentence', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/exactly one sentence/i);
      expect(prompt).not.toMatch(/one or two sentences/i);
    });

    it('forbids baiting or forcing remaining target words into the AI turn', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/bait/i);
      expect(prompt).toMatch(/never force any of the remaining target words/i);
    });

    it('requires a natural continuation without arbitrary plot jumps', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/follow naturally from what has already happened/i);
      expect(prompt).toMatch(/no arbitrary plot jumps/i);
    });
  });

  describe('system prompt instructions (Milestone 7 Phase 2 Stage 6)', () => {
    it('requires the AI turn to connect directly to the student\'s latest turn', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/connect directly to what the student just wrote/i);
      expect(prompt).toMatch(/never ignore what they just wrote/i);
      // Stage 1's wording is preserved, not replaced.
      expect(prompt).toMatch(/follow naturally from what has already happened/i);
      expect(prompt).toMatch(/no arbitrary plot jumps/i);
      expect(prompt).toMatch(/bait/i);
      expect(prompt).toMatch(/never force any of the remaining target words/i);
    });

    it('no longer restricts feedback to only when there is an error', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).not.toMatch(/write brief friendly feedback in indonesian if so.*otherwise feedback must be null/i);
      expect(prompt).toMatch(/always write a short, friendly comment in indonesian/i);
      expect(prompt).toMatch(/encouraging feedback/i);
    });
  });

  // The tests below are prompt-CONTRACT regression tests only — they assert
  // the exact wording sent to the model, not actual model behavior. They
  // cannot and do not prove a real model will correctly reject a bare word,
  // wait for 3 turns, or use exactly one fallback word; that can only be
  // observed via live/manual testing against the real deployed Worker.
  describe('system prompt instructions (Milestone 7 Phase 2 Stage 8: bare-word rejection)', () => {
    it('explicitly excludes a bare word or verbless fragment from wordsUsedCorrectly', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/bare word/i);
      expect(prompt).toMatch(/does not count/i);
    });

    it('explicitly allows short, simple EFL-level sentences', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/short, simple, grammatically valid sentence is enough/i);
      expect(prompt).toMatch(/do not require advanced vocabulary or complex grammar/i);
    });
  });

  describe('system prompt instructions (Milestone 7 Phase 2 Stage 8: 3-turn fallback)', () => {
    it('requires more than 3 completed student turns before fallback is allowed', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/more than 3/i);
      expect(prompt).toMatch(/never do this before the student has completed at least 3 turns/i);
    });

    it('derives the student-turn count from the transcript, not a new field', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/count how many "siswa" entries appear in the transcript/i);
    });

    it('limits fallback to exactly one remaining word per turn', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/exactly one of the remainingwords/i);
      expect(prompt).toMatch(
        /never use more than one remaining target word in the same aiturn/i,
      );
    });

    it('still forbids using remaining target words before fallback applies (Stage 1 preserved)', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/never force any of the remaining target words/i);
      expect(prompt).toMatch(/continue the story naturally, as if the remaining target words did not exist/i);
    });

    it('requires aiUsedWords to reflect only words actually used this turn, in the response format', async () => {
      const prompt = await capturedSystemPrompt();
      expect(prompt).toMatch(/"aiUsedWords":\s*\[/);
      expect(prompt).toMatch(/never list a word there that doesn't actually appear/i);
    });
  });
});

async function capturedSystemPrompt(): Promise<string> {
  const fetchImpl = vi.fn().mockResolvedValue(
    chatResponse({
      aiTurn: 'That sounds fun!',
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: [],
      suggestion: null,
      aiUsedWords: [],
    }),
  );
  vi.stubGlobal('fetch', fetchImpl);

  await handleCowriteTurn(requestBody(validBody), env);

  const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
  const messages = JSON.parse(requestInit.body as string).messages as {
    role: string;
    content: string;
  }[];
  return messages.find((m) => m.role === 'system')?.content ?? '';
}
