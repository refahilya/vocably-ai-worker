import type { Env } from '../env';
import { callChatCompletion, stripCodeFence, OpenAiCallError } from '../openai';

/**
 * `POST /cowrite-turn` (DATA_MODEL.md §10.2, SPEC.md §5.3) — Fase 3.
 * Not consumed by any Flutter screen yet (Milestone 7 builds that UI);
 * built now, to its full documented contract, alongside `/generate-story`
 * — see that file's doc comment for why.
 *
 * `hasError`/`wordsUsedCorrectly` are returned as **structured** fields,
 * not left for the client to infer from free-text feedback — this is
 * what directly feeds `learningSessions.cowriteWordsUsedCorrectly` and
 * the mastery-status calculation (DATA_MODEL.md §3/§4). The "mandiri"
 * rule (a turn written using "saran menulis" doesn't count toward
 * mastery) is enforced entirely on the Flutter side, per DATA_MODEL.md
 * §10.2 — this endpoint doesn't need to know about it.
 */

interface RawTranscriptTurn {
  sender?: unknown;
  text?: unknown;
}

interface CowriteTurnRequestBody {
  transcript?: unknown;
  remainingWords?: unknown;
  requestSuggestion?: unknown;
}

interface CowriteTurnResult {
  aiTurn: string;
  feedback: string | null;
  hasError: boolean;
  wordsUsedCorrectly: string[];
  suggestion: string | null;
}

const SYSTEM_PROMPT = `You are the AI co-writing partner in an English vocabulary-learning app aimed at Indonesian students (Storyfier method, UIST '23, "co-write" phase). A student and you take turns writing sentences together to build one short story, trying to use a list of target English words.

You will receive: the conversation transcript so far (alternating "siswa"/student and "ai" turns), the list of target words (base form) NOT YET used correctly, and whether the student just asked for a writing suggestion.

Do the following, in order:
1. Look at the student's most recent turn (the last "siswa" entry in the transcript). Decide if it contains a grammar or spelling error (hasError), write brief friendly feedback in Indonesian if so (feedback), otherwise feedback must be null. List which of the remaining target words that turn used correctly, in a grammatically valid way (wordsUsedCorrectly — base form, exact spelling matching the target word list given).
2. Write your own next turn continuing the story naturally in English (aiTurn) — one or two sentences.
3. If requestSuggestion is true, write one natural English sentence the student could write next, using one of the remaining target words (suggestion). Otherwise suggestion must be null.

Respond with ONLY a JSON object (no markdown fences, no commentary): {"aiTurn": "...", "feedback": "..." or null, "hasError": true or false, "wordsUsedCorrectly": ["..."], "suggestion": "..." or null}.`;

export async function handleCowriteTurn(request: Request, env: Env): Promise<Response> {
  let body: CowriteTurnRequestBody;
  try {
    body = (await request.json()) as CowriteTurnRequestBody;
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  if (!Array.isArray(body.transcript) || !body.transcript.every(isValidTurn)) {
    return jsonError(
      '"transcript" is required and must be an array of {sender: "siswa"|"ai", text: string}.',
      400,
    );
  }
  if (
    !Array.isArray(body.remainingWords) ||
    !body.remainingWords.every((w) => typeof w === 'string')
  ) {
    return jsonError('"remainingWords" is required and must be an array of strings.', 400);
  }
  if (typeof body.requestSuggestion !== 'boolean') {
    return jsonError('"requestSuggestion" is required and must be a boolean.', 400);
  }

  const userContent = JSON.stringify({
    transcript: body.transcript,
    remainingWords: body.remainingWords,
    requestSuggestion: body.requestSuggestion,
  });

  try {
    const content = await callChatCompletion(
      env,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      { temperature: 0.7 },
    );
    const parsed = JSON.parse(stripCodeFence(content)) as Partial<CowriteTurnResult>;
    if (!isValidResult(parsed)) {
      return jsonError('AI backend returned an unexpected response shape.', 502);
    }
    return Response.json(parsed);
  } catch (err) {
    if (err instanceof OpenAiCallError) {
      return jsonError(err.message, 502);
    }
    return jsonError('Failed to parse AI backend response.', 502);
  }
}

function isValidTurn(turn: unknown): turn is { sender: 'siswa' | 'ai'; text: string } {
  if (typeof turn !== 'object' || turn === null) return false;
  const t = turn as RawTranscriptTurn;
  return (t.sender === 'siswa' || t.sender === 'ai') && typeof t.text === 'string';
}

function isValidResult(value: Partial<CowriteTurnResult>): value is CowriteTurnResult {
  return (
    typeof value.aiTurn === 'string' &&
    (value.feedback === null || typeof value.feedback === 'string') &&
    typeof value.hasError === 'boolean' &&
    Array.isArray(value.wordsUsedCorrectly) &&
    value.wordsUsedCorrectly.every((w) => typeof w === 'string') &&
    (value.suggestion === null || typeof value.suggestion === 'string')
  );
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
