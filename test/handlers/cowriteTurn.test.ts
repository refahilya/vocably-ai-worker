import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleCowriteTurn,
  MAX_GENERATION_ATTEMPTS,
  UNCREDITED_CLAIM_FEEDBACK,
} from '../../src/handlers/cowriteTurn';
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

function rawChatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function requestBody(body: unknown): Request {
  return new Request('https://worker.example/cowrite-turn', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Stubs `fetch` with the given model replies, in order. */
function stubModel(...replies: Response[]): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn();
  for (const reply of replies) fetchImpl.mockResolvedValueOnce(reply);
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function sentMessages(
  fetchImpl: ReturnType<typeof vi.fn>,
  call = 0,
): { role: string; content: string }[] {
  const [, requestInit] = fetchImpl.mock.calls[call] as [string, RequestInit];
  return JSON.parse(requestInit.body as string).messages;
}

function systemPromptOf(fetchImpl: ReturnType<typeof vi.fn>): string {
  return sentMessages(fetchImpl).find((m) => m.role === 'system')?.content ?? '';
}

function userPayloadOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(sentMessages(fetchImpl).find((m) => m.role === 'user')?.content ?? '{}');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validBody = {
  transcript: [{ sender: 'siswa', text: 'I run every day.' }],
  remainingWords: ['run', 'souvenir'],
  requestSuggestion: false,
};

describe('handleCowriteTurn — request validation', () => {
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

  it('rejects an ordinary turn whose transcript does not end with the student turn', async () => {
    const response = await handleCowriteTurn(
      requestBody({
        ...validBody,
        transcript: [
          { sender: 'siswa', text: 'I run every day.' },
          { sender: 'ai', text: 'The park was quiet.' },
        ],
      }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a forcedWord that is not one of remainingWords', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...validBody, forcedWord: 'banana' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('rejects forcedWord combined with requestSuggestion', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...validBody, requestSuggestion: true, forcedWord: 'run' }),
      env,
    );
    expect(response.status).toBe(400);
  });
});

describe('handleCowriteTurn — ordinary turn', () => {
  it('returns the structured result with assessedStudentTurn and aiUsedWords: []', async () => {
    stubModel(
      chatResponse({
        feedback: 'Bagus, kamu memakai "run" dengan benar.',
        hasError: false,
        wordsUsedCorrectly: ['run'],
        aiTurn: 'At the end of the path, a stranger was waiting for you.',
      }),
    );

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aiTurn: 'At the end of the path, a stranger was waiting for you.',
      feedback: 'Bagus, kamu memakai "run" dengan benar.',
      hasError: false,
      wordsUsedCorrectly: ['run'],
      suggestion: null,
      aiUsedWords: [],
      assessedStudentTurn: 'I run every day.',
    });
  });

  it('sends the current student turn separately from the earlier story context', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'A dog barked behind the gate.',
      }),
    );

    await handleCowriteTurn(
      requestBody({
        transcript: [
          { sender: 'siswa', text: 'I goes to school.' },
          { sender: 'ai', text: 'The bell rang loudly.' },
          { sender: 'siswa', text: 'We walked home together.' },
        ],
        remainingWords: ['run'],
        requestSuggestion: false,
      }),
      env,
    );

    const user = userPayloadOf(fetchImpl);
    expect(user.currentStudentTurn).toBe('We walked home together.');
    expect(user.storySoFar).toEqual([
      { sender: 'siswa', text: 'I goes to school.' },
      { sender: 'ai', text: 'The bell rang loudly.' },
    ]);
  });

  it('never reports aiUsedWords for an ordinary turn, even when the model claims one', async () => {
    stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'She bought a souvenir.',
        aiUsedWords: ['souvenir'],
      }),
      // Acceptable continuation, but the model still (wrongly) claims usage.
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'She smiled at the old seller.',
        aiUsedWords: ['souvenir'],
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        ...validBody,
        transcript: [{ sender: 'siswa', text: 'We went to the market.' }],
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      aiTurn: 'She smiled at the old seller.',
      aiUsedWords: [],
    });
  });

  it('strips wordsUsedCorrectly entries that are absent from the student turn or only substrings', async () => {
    stubModel(
      chatResponse({
        feedback: 'Bagus!',
        hasError: false,
        wordsUsedCorrectly: ['run', 'souvenir', 'attack'],
        aiTurn: 'Then a loud noise came from the shop.',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'The attacker ran to the store.' }],
        remainingWords: ['run', 'souvenir', 'attack'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(await response.json()).toMatchObject({ wordsUsedCorrectly: ['run'] });
  });

  it('empties wordsUsedCorrectly for bare words, fragments, and target-word lists', async () => {
    for (const text of [
      'attack',
      'the button',
      'attack button completely',
      'attack, button, completely',
    ]) {
      stubModel(
        chatResponse({
          feedback: 'Gunakan dalam kalimat.',
          hasError: true,
          wordsUsedCorrectly: ['attack', 'button', 'completely'],
          aiTurn: 'A guard looked around the room.',
        }),
      );

      const response = await handleCowriteTurn(
        requestBody({
          transcript: [{ sender: 'siswa', text }],
          remainingWords: ['attack', 'button', 'completely'],
          requestSuggestion: false,
        }),
        env,
      );

      expect(await response.json()).toMatchObject({ wordsUsedCorrectly: [] });
    }
  });

  it('CW-05: credits a target reported as a surface form or formatted string when it is in the student text', async () => {
    stubModel(
      chatResponse({
        feedback: 'Seharusnya "attacked" karena kejadian lampau.',
        hasError: true,
        wordsUsedCorrectly: ['attacked', '"Village."'],
        aiTurn: 'The villagers ran to the old tower for safety.',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'Yesterday the monster attack the village.' }],
        remainingWords: ['attack', 'village', 'souvenir'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(await response.json()).toMatchObject({
      hasError: true,
      wordsUsedCorrectly: ['attack', 'village'],
    });
  });

  it('CW-05: a retry that repairs the bot sentence preserves the first attempt\'s student credit', async () => {
    const fetchImpl = stubModel(
      // Attempt 1: valid student assessment, invalid bot sentence (echo).
      chatResponse({
        feedback: 'Bagus, "attack" dipakai dengan tepat.',
        hasError: false,
        wordsUsedCorrectly: ['attack'],
        aiTurn: 'The monster attacked the village!',
      }),
      // Attempt 2: valid bot sentence, but the assessment omits "attack".
      chatResponse({
        feedback: 'Kalimat yang menarik.',
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'The villagers grabbed torches and chased it into the forest.',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'The monster attacked the village.' }],
        remainingWords: ['attack', 'souvenir'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      aiTurn: 'The villagers grabbed torches and chased it into the forest.',
      feedback: 'Bagus, "attack" dipakai dengan tepat.',
      hasError: false,
      wordsUsedCorrectly: ['attack'],
      suggestion: null,
      aiUsedWords: [],
      assessedStudentTurn: 'The monster attacked the village.',
    });
  });

  it('CW-05: when attempt 1 is malformed, the assessment comes from the first well-formed attempt', async () => {
    stubModel(
      rawChatResponse('not json'),
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: ['attack'],
        aiTurn: 'A loud horn sounded from the castle walls.',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'The monsters attacks the village.' }],
        remainingWords: ['attack'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(await response.json()).toMatchObject({ wordsUsedCorrectly: ['attack'] });
  });

  it('retries once when aiTurn echoes the student turn, and returns the second result', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'The monster attacked the village!',
      }),
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'The villagers grabbed torches and chased it into the forest.',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'The monster attacked the village.' }],
        remainingWords: ['souvenir'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({
      aiTurn: 'The villagers grabbed torches and chased it into the forest.',
    });
  });

  it('CW-02: two well-formed but unacceptable continuations fail with 502 instead of showing one', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'He bought a souvenir.',
      }),
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'He kept the souvenir.',
      }),
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'never requested',
      }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        ...validBody,
        transcript: [{ sender: 'siswa', text: 'We went to the market.' }],
      }),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS);
    // Neither unacceptable continuation reaches the client.
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/acceptable story continuation/);
    expect(body).not.toHaveProperty('aiTurn');
  });

  it('CW-02: an echo followed by a second echo also fails with 502', async () => {
    const echo = {
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: [],
      aiTurn: 'The monster attacked the village!',
    };
    stubModel(chatResponse(echo), chatResponse(echo));

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'The monster attacked the village.' }],
        remainingWords: ['souvenir'],
        requestSuggestion: false,
      }),
      env,
    );

    expect(response.status).toBe(502);
  });

  it('CW-02: an unacceptable first attempt followed by a malformed one fails with 502', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: 'Coba pakai kata "souvenir" di kalimat berikutnya, ya.',
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'He bought a souvenir.',
      }),
      rawChatResponse('not json'),
    );

    const response = await handleCowriteTurn(
      requestBody({
        ...validBody,
        transcript: [{ sender: 'siswa', text: 'We went to the market.' }],
      }),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(502);
  });

  it('retries once on malformed JSON, then succeeds', async () => {
    const fetchImpl = stubModel(
      rawChatResponse('not json at all'),
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'A bird sang nearby.',
      }),
    );

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it('returns 502 when every attempt is malformed', async () => {
    stubModel(chatResponse({ aiTurn: 'ok' }), chatResponse({ aiTurn: 'ok' }));

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(502);
  });

  it('returns 502 when the AI backend call fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const response = await handleCowriteTurn(requestBody(validBody), env);

    expect(response.status).toBe(502);
  });
});

describe('handleCowriteTurn — Indonesian / mixed-language input', () => {
  const mixedBody = {
    transcript: [{ sender: 'siswa', text: 'aku attack temanku' }],
    remainingWords: ['attack', 'souvenir'],
    requestSuggestion: false,
    studentTurnContainsIndonesian: true,
  };

  it('rejects a non-boolean studentTurnContainsIndonesian', async () => {
    const response = await handleCowriteTurn(
      requestBody({ ...mixedBody, studentTurnContainsIndonesian: 'yes' }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it('forwards the app-decided flag to the model (true, and false by default)', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: 'Coba tulis kalimatmu dalam bahasa Inggris, ya.',
        hasError: true,
        wordsUsedCorrectly: ['attack'],
        aiTurn: 'His friend laughed and ran toward the old bridge.',
      }),
    );
    const response = await handleCowriteTurn(requestBody(mixedBody), env);
    expect(userPayloadOf(fetchImpl).studentTurnContainsIndonesian).toBe(true);
    // The Worker still returns the code-validated assessment; deciding what
    // counts as independent mastery is the client's job.
    expect(await response.json()).toMatchObject({
      feedback: 'Coba tulis kalimatmu dalam bahasa Inggris, ya.',
      wordsUsedCorrectly: ['attack'],
    });

    const fetchDefault = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'A bird sang nearby.',
      }),
    );
    await handleCowriteTurn(requestBody(validBody), env);
    expect(userPayloadOf(fetchDefault).studentTurnContainsIndonesian).toBe(false);
  });

  it('retries an Indonesian aiTurn, uses the English one, and keeps the first assessment', async () => {
    const fetchImpl = stubModel(
      // Attempt 1: valid assessment, but the bot mirrors Indonesian.
      chatResponse({
        feedback: 'Coba tulis kalimatmu dalam bahasa Inggris, ya.',
        hasError: true,
        wordsUsedCorrectly: ['attack'],
        aiTurn: 'Lalu temanmu tertawa dan lari ke taman.',
      }),
      // Attempt 2: English continuation, but the assessment drops the credit.
      chatResponse({
        feedback: 'Bagus!',
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'Your friend laughed and ran toward the park.',
      }),
    );

    const response = await handleCowriteTurn(requestBody(mixedBody), env);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      aiTurn: 'Your friend laughed and ran toward the park.',
      feedback: 'Coba tulis kalimatmu dalam bahasa Inggris, ya.',
      hasError: true,
      wordsUsedCorrectly: ['attack'],
      suggestion: null,
      aiUsedWords: [],
      assessedStudentTurn: 'aku attack temanku',
    });
  });

  it('does not reject an English aiTurn that only looks Indonesian-ish (homographs)', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'They spread jam on bread while Dan checked the main gate.',
      }),
    );

    await handleCowriteTurn(requestBody(validBody), env);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forced turn: an Indonesian sentence is not accepted even if it contains the word', async () => {
    const fetchImpl = stubModel(
      chatResponse({ aiTurn: 'Di toko itu ada souvenir yang lucu.' }),
      chatResponse({ aiTurn: 'At the shop they found a tiny souvenir shaped like a star.' }),
    );

    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'kami pergi ke toko' }],
        remainingWords: ['souvenir', 'button'],
        requestSuggestion: false,
        forcedWord: 'souvenir',
      }),
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({
      aiTurn: 'At the shop they found a tiny souvenir shaped like a star.',
      aiUsedWords: ['souvenir'],
    });
  });
});

describe('handleCowriteTurn — CW-02 feedback reconciliation with validated credit', () => {
  async function ordinaryReply(
    studentText: string,
    model: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    stubModel(chatResponse({ aiTurn: 'A guard looked around the quiet room.', ...model }));
    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: studentText }],
        remainingWords: ['attack', 'button', 'souvenir'],
        requestSuggestion: false,
        ...extra,
      }),
      env,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('does not pass on praise for a bare-word turn the validator rejects', async () => {
    const body = await ordinaryReply('attack!', {
      feedback: 'Bagus, kamu memakai "attack" dengan tepat.',
      hasError: false,
      wordsUsedCorrectly: ['attack'],
    });
    expect(body.wordsUsedCorrectly).toEqual([]);
    expect(body.feedback).toBe(UNCREDITED_CLAIM_FEEDBACK);
  });

  it('replaces feedback praising a target word that is not in the student turn', async () => {
    const body = await ordinaryReply('We walked to the market together.', {
      feedback: 'Bagus, "souvenir" dipakai dengan tepat.',
      hasError: false,
      wordsUsedCorrectly: ['souvenir'],
    });
    expect(body.wordsUsedCorrectly).toEqual([]);
    expect(body.feedback).toBe(UNCREDITED_CLAIM_FEEDBACK);
  });

  it('keeps the model feedback when its claimed words are validated', async () => {
    const body = await ordinaryReply('The soldiers attack the gate at night.', {
      feedback: 'Tepat, "attack" dipakai untuk serangan para prajurit.',
      hasError: false,
      wordsUsedCorrectly: ['attack'],
    });
    expect(body.wordsUsedCorrectly).toEqual(['attack']);
    expect(body.feedback).toBe('Tepat, "attack" dipakai untuk serangan para prajurit.');
  });

  it('keeps the model nudge when no target word is claimed', async () => {
    const body = await ordinaryReply('We walked to the market together.', {
      feedback: 'Coba pakai kata "souvenir" di kalimat berikutnya, ya.',
      hasError: false,
      wordsUsedCorrectly: [],
    });
    expect(body.feedback).toBe('Coba pakai kata "souvenir" di kalimat berikutnya, ya.');
  });

  it('never overrides the Indonesian reminder', async () => {
    const body = await ordinaryReply(
      'aku mau souvenir',
      {
        feedback: 'Coba tulis kalimatmu dalam bahasa Inggris, ya.',
        hasError: true,
        wordsUsedCorrectly: ['attack'],
      },
      { studentTurnContainsIndonesian: true },
    );
    expect(body.wordsUsedCorrectly).toEqual([]);
    expect(body.feedback).toBe('Coba tulis kalimatmu dalam bahasa Inggris, ya.');
  });

  it('a retry never replaces the reconciled first assessment', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: 'Bagus, "souvenir" dipakai dengan tepat.',
        hasError: false,
        wordsUsedCorrectly: ['souvenir'],
        aiTurn: 'He bought a souvenir.', // unacceptable: remaining target word
      }),
      chatResponse({
        feedback: 'Kalimat yang menarik.',
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'A cold wind blew through the market.',
      }),
    );
    const response = await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'We walked to the market together.' }],
        remainingWords: ['souvenir'],
        requestSuggestion: false,
      }),
      env,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({
      aiTurn: 'A cold wind blew through the market.',
      feedback: UNCREDITED_CLAIM_FEEDBACK,
      wordsUsedCorrectly: [],
    });
  });
});

describe('handleCowriteTurn — forced-word turn (application-selected fallback)', () => {
  const forcedBody = {
    transcript: [{ sender: 'siswa', text: 'We walked into the old museum.' }],
    remainingWords: ['souvenir', 'button'],
    requestSuggestion: false,
    forcedWord: 'souvenir',
  };

  it('names the selected word in the prompt and returns it as aiUsedWords after validation', async () => {
    const fetchImpl = stubModel(
      chatResponse({
        aiTurn: 'At the exit, a small shop sold a glowing souvenir shaped like a dragon.',
      }),
    );

    const response = await handleCowriteTurn(requestBody(forcedBody), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aiTurn: 'At the exit, a small shop sold a glowing souvenir shaped like a dragon.',
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: [],
      suggestion: null,
      aiUsedWords: ['souvenir'],
      assessedStudentTurn: null,
    });
    const system = systemPromptOf(fetchImpl);
    expect(system).toContain('"souvenir"');
    expect(system).toMatch(/do not use any of these other words.*"button"/i);
    expect(userPayloadOf(fetchImpl).currentStudentTurn).toBe('We walked into the old museum.');
  });

  it('retries when the selected word is missing, and accepts the valid retry', async () => {
    const fetchImpl = stubModel(
      chatResponse({ aiTurn: 'The lights flickered in the hallway.' }),
      chatResponse({ aiTurn: 'Near the door, a guard sold souvenirs to tourists.' }),
    );

    const response = await handleCowriteTurn(requestBody(forcedBody), env);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({ aiUsedWords: ['souvenir'] });
  });

  it('rejects an output that also uses another remaining target word', async () => {
    stubModel(
      chatResponse({ aiTurn: 'She pressed a button and got a souvenir.' }),
      chatResponse({ aiTurn: 'She pressed the button for a souvenir.' }),
    );

    const response = await handleCowriteTurn(requestBody(forcedBody), env);

    expect(response.status).toBe(502);
  });

  it('fails with 502 (never claims usage) when no attempt uses the selected word', async () => {
    const fetchImpl = stubModel(
      chatResponse({ aiTurn: 'The lights flickered.' }),
      chatResponse({ aiTurn: 'A cold wind blew.' }),
      chatResponse({ aiTurn: 'never requested souvenir' }),
    );

    const response = await handleCowriteTurn(requestBody(forcedBody), env);

    expect(fetchImpl).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS);
    expect(response.status).toBe(502);
  });

  it('rejects a substring-only "use" of the selected word', async () => {
    stubModel(
      chatResponse({ aiTurn: 'The souvenirshop was closed.' }),
      chatResponse({ aiTurn: 'The souvenirshop stayed closed.' }),
    );

    const response = await handleCowriteTurn(requestBody(forcedBody), env);

    expect(response.status).toBe(502);
  });
});

describe('handleCowriteTurn — writing suggestion', () => {
  it('returns only the bare English sentence, stripping English instruction prefixes', async () => {
    stubModel(chatResponse({ suggestion: 'Try to write: "I bought a souvenir at the shop."' }));

    const response = await handleCowriteTurn(
      requestBody({ ...validBody, requestSuggestion: true }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aiTurn: '',
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: [],
      suggestion: 'I bought a souvenir at the shop.',
      aiUsedWords: [],
      assessedStudentTurn: null,
    });
  });

  it('instructs the model to return only the English sentence, without instruction words', async () => {
    const fetchImpl = stubModel(chatResponse({ suggestion: 'I bought a souvenir.' }));

    await handleCowriteTurn(requestBody({ ...validBody, requestSuggestion: true }), env);

    const system = systemPromptOf(fetchImpl);
    expect(system).toMatch(/return only the english sentence itself/i);
    expect(system).toMatch(/no instruction words/i);
  });
});

// Prompt-contract tests: they pin the wording sent to the model, not the
// model's actual behavior — real output quality can only be judged live.
describe('ordinary-turn prompt contract', () => {
  async function ordinarySystemPrompt(): Promise<string> {
    const fetchImpl = stubModel(
      chatResponse({
        feedback: null,
        hasError: false,
        wordsUsedCorrectly: [],
        aiTurn: 'A bird sang.',
      }),
    );
    await handleCowriteTurn(requestBody(validBody), env);
    return systemPromptOf(fetchImpl);
  }

  it('assesses only the current student turn, not earlier turns, the story, or the bot sentence', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/assess only currentStudentTurn/i);
    expect(prompt).toMatch(/never an earlier turn from storySoFar, never your own aiTurn, never the story as a whole/i);
    expect(prompt).toMatch(/sender "siswa" is the student and "ai" is you/);
    expect(prompt).toMatch(/do not invent mistakes/i);
    expect(prompt).toMatch(/in indonesian/i);
  });

  it('CW-02: feedback prioritises current-turn target-word use over grammar', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/use of remainingTargetWords matters most, more than grammar/i);
    expect(prompt).toMatch(/use the FIRST case that applies/i);
    // The three cases, in priority order.
    const credited = prompt.search(/a\. A target word is in wordsUsedCorrectly/);
    const attempted = prompt.search(/b\. The student tried to use a target word but it is NOT in wordsUsedCorrectly/);
    const none = prompt.search(/c\. No target word is used: give a gentle, actionable nudge/);
    expect(credited).toBeGreaterThan(-1);
    expect(attempted).toBeGreaterThan(credited);
    expect(none).toBeGreaterThan(attempted);
    // Credit is decided before feedback is written.
    const format = prompt.slice(prompt.lastIndexOf('Respond with ONLY'));
    expect(format.indexOf('"wordsUsedCorrectly"')).toBeLessThan(format.indexOf('"feedback"'));
  });

  it('CW-02: minor mechanics are not important errors, and only one important problem is mentioned', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/hasError: true only if currentStudentTurn has an IMPORTANT problem/);
    expect(prompt).toMatch(
      /capitalization, punctuation, apostrophes, and small slips that do not change the meaning are NOT important problems/i,
    );
    expect(prompt).toMatch(/never mention them in feedback/i);
    expect(prompt).toMatch(/mention at most ONE grammar or meaning problem/i);
    expect(prompt).toMatch(/never let a grammar correction replace the vocabulary point/i);
  });

  it('CW-02: forbids praise that is not backed by the credited words', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/never say a target word was used correctly unless it is in your wordsUsedCorrectly/i);
    expect(prompt).toMatch(/no generic praise .* without a specific vocabulary point/i);
    // The old "always praise when there is no error" rule is gone.
    expect(prompt).not.toMatch(/what the student did well/i);
  });

  it('asks for a continuation with a new development that does not echo the student', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/exactly one sentence/i);
    expect(prompt).toMatch(/new event, action, reaction, or detail/i);
    expect(prompt).toMatch(/do not repeat, paraphrase, summarize, or restate/i);
    expect(prompt).toMatch(/no arbitrary plot jumps/i);
    expect(prompt).toMatch(/bait/i);
  });

  it('forbids target words in ordinary turns and delegates no fallback decision to the model', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/do not use any word from remainingTargetWords/i);
    expect(prompt).not.toMatch(/fallback rule/i);
    expect(prompt).not.toMatch(/count how many/i);
    expect(prompt).not.toMatch(/aiUsedWords/);
  });

  it('bot continuation is English-only and never mirrors the student language', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toContain('Write aiTurn in ENGLISH ONLY');
    expect(prompt).toMatch(/even when the student writes in Indonesian or mixes Indonesian and English/i);
    expect(prompt).toMatch(/never reply in Indonesian and never mirror the student's language/i);
    // The old instruction that pushed the bot to engage with whatever the
    // student wrote is gone.
    expect(prompt).not.toMatch(/never ignore what they just wrote/i);
  });

  it('off-topic questions, calculations, and requests are not answered; the story continues', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/not a general assistant/i);
    expect(prompt).toMatch(/never answer questions, calculations, or requests that are not part of the story/i);
    expect(prompt).toContain(
      'When currentStudentTurn is NOT part of the story (a question, a calculation, a request, a command to you, or chatter), do NOT answer, solve, or address it — continue the story from storySoFar instead',
    );
    expect(prompt).toMatch(/when currentStudentTurn is part of the story, connect directly to it/i);
  });

  it('Indonesian input gets one short, polite Indonesian reminder decided by the app flag', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/studentTurnContainsIndonesian \(decided by the app, not by you/);
    expect(prompt).toMatch(
      /when studentTurnContainsIndonesian is true: feedback must be exactly ONE short, polite sentence in Indonesian reminding the student to write their sentence in English/,
    );
    expect(prompt).toContain('"Coba tulis kalimatmu dalam bahasa Inggris, ya."');
    expect(prompt).toMatch(/no grammar lesson/i);
  });

  it('the forced-fallback prompt is also English-only and story-bound', async () => {
    const fetchImpl = stubModel(chatResponse({ aiTurn: 'A guard sold a small souvenir at the gate.' }));
    await handleCowriteTurn(
      requestBody({
        transcript: [{ sender: 'siswa', text: 'We walked into the old museum.' }],
        remainingWords: ['souvenir'],
        requestSuggestion: false,
        forcedWord: 'souvenir',
      }),
      env,
    );
    const prompt = systemPromptOf(fetchImpl);
    expect(prompt).toContain('Write aiTurn in ENGLISH ONLY');
    expect(prompt).toMatch(/not a general assistant/i);
  });

  it('CW-05: credits meaningful vocabulary use regardless of grammar, tense, agreement, or target inflection errors', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/uses MEANINGFULLY, with an acceptable intended meaning/);
    expect(prompt).toMatch(/judges vocabulary use, not grammar/i);
    expect(prompt).toMatch(
      /grammar, tense, and subject-verb agreement errors in the sentence do not by themselves disqualify/i,
    );
    expect(prompt).toMatch(/wrong inflection of the target word itself does not disqualify/i);
    expect(prompt).toContain('"Yesterday the monster attack the village."');
    expect(prompt).toMatch(/must never remove the word from wordsUsedCorrectly/i);
    // The old grammar gate on vocabulary credit is gone.
    expect(prompt).not.toMatch(/grammatically valid sentence/i);
    expect(prompt).not.toMatch(/in a grammatically valid way/i);
  });

  it('CW-05: still excludes bare words, lists, fragments, mere mentions, nonsense, and wrong meanings', async () => {
    const prompt = await ordinarySystemPrompt();
    expect(prompt).toMatch(/do not count: a bare word, a list of words, or a fragment/i);
    expect(prompt).toContain('"attack, button, ability"');
    expect(prompt).toMatch(/a mere mention of the word instead of a use/i);
    expect(prompt).toContain('"I do not know the word attack."');
    expect(prompt).toMatch(/nonsense/i);
    expect(prompt).toMatch(/meaning is wrong or unacceptable in context/i);
    expect(prompt).toMatch(/never list a word that does not appear in currentStudentTurn/i);
    expect(prompt).toMatch(/base form, exactly as written in remainingTargetWords/i);
  });
});
