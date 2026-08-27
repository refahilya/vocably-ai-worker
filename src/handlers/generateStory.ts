import type { Env } from '../env';
import { callChatCompletion, stripCodeFence, OpenAiCallError } from '../openai';

/**
 * `POST /generate-story` (DATA_MODEL.md §10.2, SPEC.md §5.1) — Fase 1.
 * Not consumed by any Flutter screen yet (Milestone 7 builds that UI);
 * built now, to its full documented contract, because the Worker's
 * shared infrastructure (auth/CORS/rate limiting) is being set up in
 * this milestone regardless (`CLAUDE.md` §7 Milestone 5).
 *
 * Every target word MUST come back wrapped as `[[targetWord|usedForm]]`
 * at least once. If the model misses one, this handler retries the
 * generation exactly once before giving up (DATA_MODEL.md §10.2: "kalau
 * ada yang hilang, retry sekali... kalau masih gagal, balikan error").
 */

interface GenerateStoryRequestBody {
  targetWords?: unknown;
  prompt?: unknown;
}

interface GenerateStoryResult {
  story: string;
  translation: string;
}

const SYSTEM_PROMPT = `You are a creative writing assistant for an English vocabulary-learning app aimed at Indonesian students (adapted from the Storyfier method, UIST '23).

You will receive a list of English target words (base form) and a short prompt/title, which may be written in any language (e.g. Indonesian). Write ONE short story in English, 3 to 5 sentences long, inspired by the prompt, that uses EVERY target word at least once.

Critical formatting rule: wrap EVERY occurrence of a target word in the story with double square brackets, in the exact format [[targetWord|usedForm]], where targetWord is exactly the base form you were given (identical spelling/case) and usedForm is whatever inflected form you naturally used in that sentence (e.g. [[run|ran]], [[study|studied]]). Always use the most natural, grammatically correct inflected form for the sentence — never force the base form into an ungrammatical sentence. If a target word appears more than once in your story, wrap every occurrence, not just the first.

Also provide a natural Indonesian translation of the whole story, WITHOUT any [[...]] markers in the translation (plain readable text).

Respond with ONLY a JSON object (no markdown fences, no commentary): {"story": "...", "translation": "..."}.`;

export async function handleGenerateStory(request: Request, env: Env): Promise<Response> {
  let body: GenerateStoryRequestBody;
  try {
    body = (await request.json()) as GenerateStoryRequestBody;
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  const targetWords = body.targetWords;
  if (
    !Array.isArray(targetWords) ||
    targetWords.length === 0 ||
    !targetWords.every((w) => typeof w === 'string' && w.trim().length > 0)
  ) {
    return jsonError(
      '"targetWords" is required and must be a non-empty array of non-empty strings.',
      400,
    );
  }
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    return jsonError('"prompt" is required and must be a non-empty string.', 400);
  }

  const words = targetWords as string[];

  try {
    let result = await generateOnce(env, words, body.prompt);
    if (!allWordsMarked(result.story, words)) {
      result = await generateOnce(env, words, body.prompt); // retry once
      if (!allWordsMarked(result.story, words)) {
        return jsonError(
          'AI backend failed to mark every target word in the story, even after a retry.',
          502,
        );
      }
    }
    return Response.json(result);
  } catch (err) {
    if (err instanceof OpenAiCallError) {
      return jsonError(err.message, 502);
    }
    return jsonError('Failed to parse AI backend response.', 502);
  }
}

async function generateOnce(
  env: Env,
  words: string[],
  prompt: string,
): Promise<GenerateStoryResult> {
  const userContent = JSON.stringify({ targetWords: words, prompt });
  const content = await callChatCompletion(
    env,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    { temperature: 0.7 },
  );
  const parsed = JSON.parse(stripCodeFence(content)) as {
    story?: unknown;
    translation?: unknown;
  };
  if (typeof parsed.story !== 'string' || typeof parsed.translation !== 'string') {
    throw new OpenAiCallError('AI backend returned an unexpected response shape.');
  }
  return { story: parsed.story, translation: parsed.translation };
}

function allWordsMarked(story: string, words: string[]): boolean {
  return words.every((word) => story.includes(`[[${word}|`));
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
