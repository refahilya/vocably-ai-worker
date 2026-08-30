import type { Env } from '../env';
import { callChatCompletion, stripCodeFence, OpenAiCallError } from '../openai';

/**
 * `POST /generate-story` (DATA_MODEL.md §10.2, SPEC.md §5.1) — Fase 1.
 * Not consumed by any Flutter screen yet (Milestone 7 builds that UI);
 * built now, to its full documented contract, because the Worker's
 * shared infrastructure (auth/CORS/rate limiting) is being set up in
 * this milestone regardless (`CLAUDE.md` §7 Milestone 5).
 *
 * Milestone 7 Phase 2 Stage 1 tightened the marking requirement from
 * "every target word appears at least once" to **exactly once**: each
 * requested target word must come back wrapped as exactly one
 * `[[targetWord|usedForm]]` marker — no omissions, no repeats, and no
 * markers for words outside the requested list. `validateMarkers()`
 * enforces this in code (never rely on prompt instructions alone — the
 * model doesn't reliably follow them). If validation fails, this
 * handler retries the generation exactly once before giving up
 * (DATA_MODEL.md §10.2: "kalau ada yang hilang, retry sekali... kalau
 * masih gagal, balikan error").
 */

interface GenerateStoryRequestBody {
  targetWords?: unknown;
  prompt?: unknown;
}

interface GenerateStoryResult {
  story: string;
  translation: string;
}

/**
 * Milestone 7 Phase 2 Stage 6: the sentence-count requirement is now
 * spelled out with the actual number (`wordCount`), not left for the
 * model to infer by counting the target-word list itself — a plain
 * "as many sentences as target words" instruction proved unreliable in
 * live testing, especially for `wordCount === 1` (an unusually terse
 * ask that models tend to "helpfully" over-elaborate on). This is
 * prompt-only, still enforced only by instruction, not by a code-level
 * sentence counter — see this file's other doc comments for why a
 * sentence-boundary parser was deliberately not added. The exact-marker
 * requirements (Stage 1) are unchanged, word for word.
 *
 * Milestone 7 Phase 2 Stage 8: added an explicit same-lexeme requirement
 * for `usedForm` — live testing found markers like [[actor|acted]] and
 * [[baby|girl]], where `usedForm` was a *different word* (a wrong
 * derivational form, or an outright synonym/related-word substitution)
 * rather than an inflection of `targetWord` itself. `validateMarkers()`
 * below only ever checked the `targetWord` half of each marker — it
 * cannot and does not check whether `usedForm` is genuinely a form of the
 * same word (see that function's own doc comment for why a code-level
 * morphology check was deliberately rejected). This is prompt-only,
 * enforced by instruction alone, same as the sentence-count strengthening
 * above.
 */
function buildSystemPrompt(wordCount: number): string {
  const sentenceWord = wordCount === 1 ? 'sentence' : 'sentences';
  return `You are a creative writing assistant for an English vocabulary-learning app aimed at Indonesian EFL (English as a Foreign Language) students (adapted from the Storyfier method, UIST '23).

You will receive a list of English target words (base form) and a short prompt/title, which may be written in any language (e.g. Indonesian).

Write ONE short story in English with EXACTLY ${wordCount} ${sentenceWord} — no more, no fewer. Count your sentences before answering. One target word goes in each sentence, in the same order the target words were given.

Write for a beginner-to-intermediate EFL learner, not a native speaker: use simple, common, everyday vocabulary (avoid advanced or rare words, unless one of them is a target word itself); prefer simple sentence structures with one main idea per sentence, avoiding unnecessary subordinate/relative clauses and avoiding stuffing multiple ideas into a single sentence. A sentence may still be a normal, natural length when that's genuinely needed for the meaning — the goal is clarity and naturalness for a learner, not artificially short or choppy sentences.

Critical rules, all mandatory:
- Every target word in the list must appear in the story EXACTLY ONCE — never omitted, and never repeated anywhere else in the story (marked or not).
- Wrap that single occurrence with double square brackets, in the exact format [[targetWord|usedForm]], where targetWord is exactly the base form you were given (identical spelling/case) and usedForm is whatever inflected form you naturally used in that sentence (e.g. [[run|ran]], [[study|studied]]). Always use the most natural, grammatically correct inflected form for the sentence — never force the base form into an ungrammatical sentence.
- usedForm MUST be the exact same word as targetWord, just in a natural grammatical form (tense, plural, etc.) — never a different word. Natural inflection is required and expected (e.g. [[run|ran]], [[run|running]], [[baby|babies]], [[actor|actors]]); substituting a different word, a synonym, or a semantically related word is FORBIDDEN, even if it fits the sentence better. For example, if the target word is "actor", usedForm must stay a form of "actor" (e.g. "actors") — writing [[actor|acted]] is WRONG, because "acted" is a form of the different word "act", not of "actor". Likewise, if the target word is "baby", usedForm must stay a form of "baby" (e.g. "babies") — writing [[baby|girl]] is WRONG, because "girl" is a completely different word, not a form of "baby". If a target word is awkward to inflect naturally, build the sentence around it rather than swapping in a different word.
- Do not add a [[...]] marker for any word that is not exactly one of the given target words.

Also provide a natural Indonesian translation of the whole story, WITHOUT any [[...]] markers in the translation (plain readable text).

Respond with ONLY a JSON object (no markdown fences, no commentary): {"story": "...", "translation": "..."}.`;
}

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
    if (!validateMarkers(result.story, words)) {
      result = await generateOnce(env, words, body.prompt); // retry once
      if (!validateMarkers(result.story, words)) {
        return jsonError(
          'AI backend failed to mark every target word exactly once in the story, even after a retry.',
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
      { role: 'system', content: buildSystemPrompt(words.length) },
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

/** Matches every `[[targetWord|usedForm]]` marker in a story, capturing
 * the `targetWord` part (group 1) exactly as written — no trimming or
 * case-folding, so callers can compare it byte-for-byte against the
 * requested target words. */
const MARKER_PATTERN = /\[\[([^|\]]+)\|([^\]]+)\]\]/g;

/**
 * Strict exactly-once validator (Milestone 7 Phase 2 Stage 1). Extracts
 * every `[[targetWord|...]]` marker from the story and checks, in code
 * (not just via prompt instructions, which the model doesn't reliably
 * follow), that the set of marked target words is exactly equal —
 * element-for-element — to the requested `words` list. Rejects:
 *  - a requested word with no marker at all (missing),
 *  - a requested word marked more than once (duplicate),
 *  - a marker whose captured word isn't exactly one of the requested
 *    words, spelling/case included (hallucinated or mismatched marker).
 *
 * Deliberately does **not** also validate sentence count in code (Stage
 * 6 considered and rejected this): a naive sentence-boundary splitter is
 * genuinely fragile against ordinary English punctuation (abbreviations
 * like "Mr.", initials, decimal numbers, ellipses), and marker-exactness
 * — not sentence count — is the invariant that actually protects
 * downstream data (Cloze blanks, `learningProgress`) from corruption; a
 * slightly-longer-than-asked story with perfectly correct markers is a
 * quality shortfall, not a correctness bug. Sentence count is enforced
 * by prompt strength alone (`buildSystemPrompt`'s explicit number), and
 * is not part of `validateMarkers`'s retry-triggering condition.
 *
 * Also deliberately does **not** validate that `usedForm` (the second
 * marker capture) is actually a grammatical form of `targetWord` (Stage
 * 8 investigation/decision) — a prefix/edit-distance/suffix-rule
 * heuristic would be exactly the kind of fragile code this project has
 * repeatedly rejected: English inflection is too irregular for a cheap
 * heuristic to get right (`go`→`went`, `be`→`was`, `good`→`better` share
 * no characters with their base form, so a naive check would reject
 * them; `actor`→`acted` *does* share a prefix despite being wrong,
 * so a naive check would accept it). This is enforced by prompt strength
 * alone (`buildSystemPrompt`'s explicit same-lexeme rule), not code.
 */
function validateMarkers(story: string, words: string[]): boolean {
  const requested = new Set(words);
  const seen = new Set<string>();

  for (const match of story.matchAll(MARKER_PATTERN)) {
    const targetWord = match[1];
    // The pattern's first group is a mandatory `+` capture, so a match
    // always has it — this guard only satisfies noUncheckedIndexedAccess.
    if (targetWord === undefined) continue;
    if (!requested.has(targetWord)) return false; // extra/hallucinated or case/spelling mismatch
    if (seen.has(targetWord)) return false; // duplicate marker for the same word
    seen.add(targetWord);
  }

  return seen.size === requested.size; // every requested word got exactly one marker
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
