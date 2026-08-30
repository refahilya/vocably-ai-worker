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
 *
 * Milestone 7 Phase 2 Stage 1 strengthened the `aiTurn` instructions:
 * exactly one sentence, a natural continuation of the story so far, and
 * never a sentence manufactured just to bait the student toward (or
 * force in) a remaining target word — those are the student's words to
 * use, not the AI's. This is prompt-only; the response shape and every
 * other field's behavior are unchanged.
 *
 * Milestone 7 Phase 2 Stage 6, also prompt-only, no schema change:
 *  - `aiTurn` now must connect *specifically* to the student's own most
 *    recent turn, not just the story's general theme (live testing found
 *    AI continuations that felt disconnected from what the student had
 *    actually just written) — Stage 1's anti-bait/anti-plot-jump wording
 *    is kept verbatim, this only adds to it.
 *  - `feedback` is no longer tied exclusively to `hasError` — the
 *    original "only when there's an error, otherwise null" condition
 *    meant most turns (anything grammatically fine) got no feedback at
 *    all, which live testing surfaced as "feedback is missing entirely."
 *    No plumbing bug was found on either the Worker or Flutter side (the
 *    response field, its parsing, and its rendering in `cowrite_screen.
 *    dart` were all already correct and unchanged) — this was a
 *    too-narrow trigger condition, not a disconnected pipeline, so the
 *    fix is broadening when the model is asked to say *something*, not
 *    adding a new field or a new client-side mechanism.
 *
 * Milestone 7 Phase 2 Stage 8:
 *  - `wordsUsedCorrectly` (step 1) now explicitly excludes a bare word or
 *    a verbless fragment — live testing found a lone "baby" being
 *    reported as correctly used, which shouldn't count as productive
 *    vocabulary use. Prompt-only; still an EFL-appropriate bar (a short,
 *    simple, valid sentence is enough — no advanced grammar demanded).
 *  - New 3-turn AI fallback (step 2's added paragraph): if the student
 *    has completed more than 3 turns without using a remaining target
 *    word, the AI may use exactly one remaining word itself once, to
 *    help the student see it in context. The student-turn count is
 *    derived by the model directly from the `transcript` it already
 *    receives (counting "siswa" entries) — no new request field was
 *    added for this, per the Stage 8 investigation's conclusion that the
 *    transcript already carries everything needed.
 *  - New response field `aiUsedWords: string[]` — the CowriteTurnResult
 *    interface's own doc comment explains why this must stay a separate
 *    field from `wordsUsedCorrectly`, not merged into it: the "mandiri"/
 *    mastery pipeline downstream must never treat AI-assisted usage as
 *    student mastery, and merging the fields would make that
 *    unrecoverable on the client side.
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
  /**
   * Milestone 7 Phase 2 Stage 8 (3-turn fallback): remaining target
   * words the AI itself used in this response's `aiTurn` — semantically
   * distinct from `wordsUsedCorrectly` (which is exclusively the
   * student's own usage). Empty whenever no fallback target was used
   * this turn (the normal case). The client unions this into
   * `allWordsUsedCorrectly` (so Cowrite can still end) but never into
   * `independentWordsUsedCorrectly` (so it can never count as student
   * mastery) — see `learning_session_controller.dart`'s `sendTurn()`.
   */
  aiUsedWords: string[];
}

const SYSTEM_PROMPT = `You are the AI co-writing partner in an English vocabulary-learning app aimed at Indonesian students (Storyfier method, UIST '23, "co-write" phase). A student and you take turns writing sentences together to build one short story, trying to use a list of target English words.

You will receive: the conversation transcript so far (alternating "siswa"/student and "ai" turns), the list of target words (base form) NOT YET used correctly, and whether the student just asked for a writing suggestion.

Do the following, in order:
1. Look at the student's most recent turn (the last "siswa" entry in the transcript). Decide if it contains a grammar or spelling error (hasError). Always write a short, friendly comment in Indonesian about that turn (feedback) — if hasError is true, gently point out and briefly explain the correction; if it's correct, give brief encouraging feedback about what they wrote (e.g. praising a good word choice or a natural sentence). feedback should only be null if the student's turn is empty or there is truly nothing to comment on. List which of the remaining target words that turn used correctly, in a grammatically valid way (wordsUsedCorrectly — base form, exact spelling matching the target word list given). A target word only counts here if the student actually used it inside a real sentence or a meaningful clause — a bare word or short fragment by itself (e.g. just "baby", or "baby!", or "the baby" with no verb/predicate) does NOT count, even if correctly spelled, because it doesn't demonstrate the student can actually use the word, not just name it. This does not need to be sophisticated English — a short, simple, grammatically valid sentence is enough (e.g. "Baby sleeps." or "My baby is sleeping." both count); do not require advanced vocabulary or complex grammar, this is an EFL learner app.

2. Write your own next turn continuing the story (aiTurn) — EXACTLY one sentence, no more. It must connect directly to what the student just wrote in their most recent turn — respond to or build on their specific idea, action, or detail, not just the story's general theme, and never ignore what they just wrote. It must also follow naturally from what has already happened in the transcript so far: no arbitrary plot jumps, no sudden new characters or settings, no unnatural transitions just to change the subject. Never manufacture a "bait" sentence whose only purpose is to set up an opening for the student to use a remaining target word, and never force any of the remaining target words into your own sentence — those words are for the student to use, not you. Just continue the story naturally, as if the remaining target words did not exist — UNLESS the fallback rule below applies.

Fallback rule (use sparingly, only when it applies): count how many "siswa" entries appear in the transcript you were given, including the student's latest turn — this is how many turns the student has completed so far. If that count is MORE THAN 3 (i.e. the student has already completed at least 3 turns) AND remainingWords is not empty, you MAY use exactly ONE of the remainingWords naturally and correctly in this aiTurn, instead of avoiding all of them as instructed above — this is a deliberate exception meant to help a student who hasn't managed to use a word after several chances, by showing it used in context. Never do this before the student has completed at least 3 turns, and never use more than one remaining target word in the same aiTurn even if several remain. If you used a remaining target word in aiTurn this turn under this fallback rule, list it in aiUsedWords (base form, exact spelling matching remainingWords). If you did not use any remaining target word this turn (the normal case, including every turn before the student's 3rd), aiUsedWords must be an empty array — never list a word there that doesn't actually appear (in some form) in this turn's aiTurn, and never list one merely because it appeared earlier in the transcript.
3. If requestSuggestion is true, write one natural English sentence the student could write next, using one of the remaining target words (suggestion). Otherwise suggestion must be null.

Respond with ONLY a JSON object (no markdown fences, no commentary): {"aiTurn": "...", "feedback": "..." or null, "hasError": true or false, "wordsUsedCorrectly": ["..."], "suggestion": "..." or null, "aiUsedWords": ["..."]}.`;

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
    (value.suggestion === null || typeof value.suggestion === 'string') &&
    Array.isArray(value.aiUsedWords) &&
    value.aiUsedWords.every((w) => typeof w === 'string')
  );
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
