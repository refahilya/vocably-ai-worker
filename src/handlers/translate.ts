import type { Env } from '../env';
import { callChatCompletion, stripCodeFence, OpenAiCallError } from '../openai';

/**
 * `POST /translate` (DATA_MODEL.md §10.2) — called from two places on the
 * Flutter side: guru "Tambah Kosakata" (result gets written to Firestore
 * by the guru client) and siswa's lazy Word Detail translation display
 * (result shown on-screen only, never persisted). This endpoint itself
 * doesn't know or care which caller it is — that distinction lives
 * entirely on the Flutter side, per `DATA_MODEL.md` §2.
 */

interface TranslateRequestBody {
  word?: unknown;
  pos?: unknown;
}

const SYSTEM_PROMPT = `You are a bilingual English-Indonesian lexicographer for a vocabulary-learning app aimed at Indonesian students.

You will receive one English word and its part of speech. Produce the single most appropriate, natural Indonesian translation for that specific word used in that specific part of speech (not other senses of the word).

Respond with ONLY a JSON object (no markdown fences, no commentary): {"translation": "..."}. The translation must be a short Indonesian word or short phrase, not a full sentence or explanation.`;

export async function handleTranslate(request: Request, env: Env): Promise<Response> {
  let body: TranslateRequestBody;
  try {
    body = (await request.json()) as TranslateRequestBody;
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  if (typeof body.word !== 'string' || body.word.trim().length === 0) {
    return jsonError('"word" is required and must be a non-empty string.', 400);
  }
  if (typeof body.pos !== 'string' || body.pos.trim().length === 0) {
    return jsonError('"pos" is required and must be a non-empty string.', 400);
  }

  const userContent = JSON.stringify({ word: body.word, pos: body.pos });

  try {
    const content = await callChatCompletion(env, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ]);
    const parsed = JSON.parse(stripCodeFence(content)) as { translation?: unknown };
    if (typeof parsed.translation !== 'string' || parsed.translation.trim().length === 0) {
      return jsonError('AI backend returned an unexpected response shape.', 502);
    }
    return Response.json({ translation: parsed.translation.trim() });
  } catch (err) {
    if (err instanceof OpenAiCallError) {
      return jsonError(err.message, 502);
    }
    return jsonError('Failed to parse AI backend response.', 502);
  }
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
