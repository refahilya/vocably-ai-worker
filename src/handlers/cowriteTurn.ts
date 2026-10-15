import type { Env } from '../env';
import { callChatCompletion, stripCodeFence, OpenAiCallError } from '../openai';
import {
  containsAnyTargetWord,
  containsIndonesianWords,
  containsTargetWordInText,
  extractSuggestedSentence,
  isBareOrFragmentTurn,
  isEchoOfStudentTurn,
  normalizeWord,
  validateBotTargetWords,
  validateStudentTargetWords,
} from '../cowriteValidator';

/**
 * `POST /cowrite-turn` (DATA_MODEL.md §10.2, SPEC.md §5.3) — Fase 3.
 * Consumed by `AiWorkerService.cowriteTurn` / `cowriteForcedTurn`
 * (`lib/services/ai_worker_service.dart`), driven by
 * `LearningFlowController.sendTurn` and `requestSuggestion`
 * (`lib/providers/learning_session_controller.dart`).
 *
 * **Decision ownership.** The Flutter client owns every Co-Write
 * decision: the consecutive-miss counter, whether the fallback is due,
 * which single word is forced (random pick), word-status updates, and
 * session completion. This endpoint owns only the prompt builders and the
 * deterministic validation of model output. The model never chooses a
 * target word, never counts turns, and never decides completion.
 *
 * **Language.** The client decides (deterministic
 * `containsIndonesianWords`) whether the student turn is Indonesian or
 * mixed, and sends `studentTurnContainsIndonesian`; the model never makes
 * that classification. When true, ordinary-turn feedback is one short,
 * polite Indonesian reminder to write in English. Every `aiTurn` must be
 * English and must stay in the story (never answering off-topic questions,
 * calculations, or requests); an `aiTurn` that `containsIndonesianWords`
 * flags is treated as a failed attempt and retried within the same limit.
 *
 * The request selects exactly one of three modes:
 *
 *  1. **Ordinary turn** (`requestSuggestion: false`, no `forcedWord`):
 *     assesses ONLY the current (latest) student turn — sent to the model
 *     as a separate `currentStudentTurn` field, apart from the story
 *     context, so feedback cannot drift onto an older message — and writes
 *     one continuation sentence that must not use any remaining target
 *     word. `wordsUsedCorrectly` is re-validated in code
 *     (`validateStudentTargetWords`). `aiUsedWords` is always `[]`: an
 *     ordinary AI turn never completes a target word, even if it happens
 *     to contain one. Up to 2 generations; a retry is made when the reply
 *     is malformed, empty, echoes the student, contains a remaining
 *     target word, or is Indonesian. If no attempt yields an acceptable
 *     `aiTurn`, the request fails with 502 — an unacceptable continuation
 *     is never returned just because its JSON was well-formed. The
 *     student-turn assessment (`feedback`, `hasError`,
 *     `wordsUsedCorrectly`) is taken from the FIRST well-formed attempt
 *     and kept: a retry only replaces `aiTurn`, so it can never erase a
 *     student's vocabulary credit. Vocabulary credit means meaningful use
 *     with an acceptable intended meaning — grammar/tense/inflection errors
 *     are reported via `hasError`/`feedback`, not by withholding credit.
 *     Feedback (CW-02) is about the current turn's target-word use first
 *     (credited use → specific acknowledgement; attempted but uncredited →
 *     the real issue; none → a gentle nudge), with at most one important
 *     grammar/meaning point; capitalization/punctuation/apostrophes are
 *     ignored. When the model claimed words but code credited none, its
 *     feedback is replaced by `UNCREDITED_CLAIM_FEEDBACK`.
 *     `assessedStudentTurn` echoes the exact student text
 *     that was assessed, so the client can verify the association.
 *  2. **Forced-word turn** (`forcedWord` set): the client has decided the
 *     fallback is due and chosen the word. The model writes one
 *     continuation sentence that uses exactly that word. The Worker
 *     accepts it only if the word actually occurs in `aiTurn` (whole word
 *     or inflection), no other remaining target word occurs, and it is not
 *     an echo; otherwise it retries once, then fails with 502 — it never
 *     reports an unvalidated word as used.
 *  3. **Suggestion** (`requestSuggestion: true`): returns one bare English
 *     sentence in `suggestion` (instruction prefixes/quotes stripped in
 *     code). The Indonesian wrapper ("Coba tulis \"...\"") is added by the
 *     client. No assessment, no `aiTurn` (returned as `""`).
 */

interface RawTranscriptTurn {
  sender?: unknown;
  text?: unknown;
}

interface TranscriptTurn {
  sender: 'siswa' | 'ai';
  text: string;
}

interface CowriteTurnRequestBody {
  transcript?: unknown;
  remainingWords?: unknown;
  requestSuggestion?: unknown;
  forcedWord?: unknown;
  /** App-decided (client `containsIndonesianWords`); optional, default false. */
  studentTurnContainsIndonesian?: unknown;
}

interface CowriteTurnResult {
  aiTurn: string;
  feedback: string | null;
  hasError: boolean;
  wordsUsedCorrectly: string[];
  suggestion: string | null;
  /**
   * Target words the AI's `aiTurn` validly used. Only ever non-empty in
   * forced-word mode, where it is exactly `[forcedWord]` after
   * deterministic validation. Ordinary turns always return `[]`. The
   * client counts it toward session-level usage only — never toward
   * independent student mastery.
   */
  aiUsedWords: string[];
  /** The exact student text that was assessed (ordinary mode), else null. */
  assessedStudentTurn: string | null;
}

/** Bounded generation strategy: first attempt + one retry. */
export const MAX_GENERATION_ATTEMPTS = 2;

const SHARED_CONTEXT = `You are the AI co-writing partner in an English vocabulary-learning app for Indonesian students (Storyfier method, "co-write" phase). The student and you take turns adding sentences to one short shared story, written in English. The app (not you) tracks the target words, decides when you must use one, and decides when the session ends. You are only a story co-writer, not a general assistant: never answer questions, calculations, or requests that are not part of the story.`;

const CONTINUATION_RULES = `Rules for your story turn (aiTurn):
- Write aiTurn in ENGLISH ONLY — even when the student writes in Indonesian or mixes Indonesian and English. Never reply in Indonesian and never mirror the student's language.
- EXACTLY one sentence, no more.
- Continue the story with a NEW event, action, reaction, or detail that moves it forward — the next thing that happens in the story.
- When currentStudentTurn is part of the story, connect directly to it — build on their specific idea, action, or detail.
- When currentStudentTurn is NOT part of the story (a question, a calculation, a request, a command to you, or chatter), do NOT answer, solve, or address it — continue the story from storySoFar instead.
- Do NOT repeat, paraphrase, summarize, or restate the student's sentence, and do not start by echoing it.
- Follow naturally from what has already happened in storySoFar: no arbitrary plot jumps, no sudden unrelated characters or settings, no unnatural transitions.
- Never manufacture a "bait" sentence whose only purpose is to set up an opening for the student to use a target word.`;

const ORDINARY_SYSTEM_PROMPT = `${SHARED_CONTEXT}

You will receive JSON with: storySoFar (earlier turns, oldest first, for context only; sender "siswa" is the student and "ai" is you), currentStudentTurn (the ONE sentence you must assess now), remainingTargetWords, and studentTurnContainsIndonesian (decided by the app, not by you: true when currentStudentTurn is written fully or partly in Indonesian).

1. Assess ONLY currentStudentTurn — never an earlier turn from storySoFar, never your own aiTurn, never the story as a whole, and never details that are not in currentStudentTurn. This is a vocabulary-learning app: the student's use of remainingTargetWords matters most, more than grammar.
   - wordsUsedCorrectly (decide this first): the remainingTargetWords (list each in its base form, exactly as written in remainingTargetWords) that currentStudentTurn uses MEANINGFULLY, with an acceptable intended meaning, inside a sentence or clause that expresses an idea. This judges vocabulary use, not grammar:
     - Grammar, tense, and subject-verb agreement errors in the sentence do NOT by themselves disqualify a target word.
     - A wrong inflection of the target word itself does NOT disqualify it when the intended meaning is clear and acceptable (e.g. "Yesterday the monster attack the village." and "The monsters attacks the village." both count for "attack").
     - Such errors may be reported through hasError and feedback (see below); they must never remove the word from wordsUsedCorrectly.
     - Do NOT count: a bare word, a list of words, or a fragment that expresses no idea (e.g. "attack", "attack, button, ability", "the button"); a mere mention of the word instead of a use (e.g. "I do not know the word attack."); nonsense; or a use whose meaning is wrong or unacceptable in context.
     - Never list a word that does not appear in currentStudentTurn.
   - hasError: true only if currentStudentTurn has an IMPORTANT problem: a target word used in a wrong form or with a wrong or unclear meaning, or a grammar or word-choice error that changes the meaning or makes the sentence hard to understand. Capitalization, punctuation, apostrophes, and small slips that do not change the meaning are NOT important problems: ignore them, and never mention them in feedback. Do not invent mistakes.
   - feedback: 1–2 short sentences in Indonesian about currentStudentTurn only. Use the FIRST case that applies:
     a. A target word is in wordsUsedCorrectly: name that word and say specifically what was good about how it was used. If hasError is true, add one brief correction of the important problem, quoting the corrected English (e.g. Seharusnya "attacked" karena kejadiannya sudah lampau.).
     b. The student tried to use a target word but it is NOT in wordsUsedCorrectly: briefly explain the real issue with that word (e.g. it is only mentioned, or its meaning does not fit) and how to fix it.
     c. No target word is used: give a gentle, actionable nudge to use one of remainingTargetWords in the next sentence (e.g. Coba pakai kata "souvenir" di kalimat berikutnya, ya.). If hasError is true, you may add one brief correction of the important problem.
     - Mention at most ONE grammar or meaning problem, and only an important one. Never give a list of corrections, and never let a grammar correction replace the vocabulary point.
     - Never say a target word was used correctly unless it is in your wordsUsedCorrectly. No generic praise (e.g. "Bagus!", "Kalimat yang menarik.") without a specific vocabulary point.
     EXCEPTION — when studentTurnContainsIndonesian is true: feedback must be exactly ONE short, polite sentence in Indonesian reminding the student to write their sentence in English (e.g. "Coba tulis kalimatmu dalam bahasa Inggris, ya."). No grammar lesson, no correction list, and no praise in that case.

2. Write aiTurn.
${CONTINUATION_RULES}
- Do NOT use any word from remainingTargetWords (in any form) — those words are for the student to use.

Respond with ONLY a JSON object (no markdown fences, no commentary): {"wordsUsedCorrectly": ["..."], "hasError": true or false, "feedback": "..." or null, "aiTurn": "..."}.`;

/**
 * Deterministic replacement feedback for a contradiction the model cannot
 * be trusted to avoid: it claimed target-word use (so its feedback likely
 * praises it), but code validation credited nothing. Mirrored verbatim by
 * the Flutter client (`kCowriteUncreditedClaimFeedback` in
 * `lib/utils/cowrite_feedback.dart`), which applies the same rule.
 */
export const UNCREDITED_CLAIM_FEEDBACK =
  'Belum ada kata target yang terhitung di kalimat ini. Coba pakai salah satu kata target yang belum terpakai dalam kalimat lengkap yang bermakna, ya.';

function forcedSystemPrompt(forcedWord: string, avoidWords: readonly string[]): string {
  const avoid =
    avoidWords.length > 0
      ? `- Do NOT use any of these other words (in any form): ${avoidWords.map((w) => `"${w}"`).join(', ')}.`
      : '';
  return `${SHARED_CONTEXT}

The app has decided that in this turn you must model the target word "${forcedWord}" for the student.

You will receive JSON with: storySoFar (earlier turns, oldest first) and currentStudentTurn (the student's latest sentence).

Write aiTurn.
${CONTINUATION_RULES}
- aiTurn MUST use the word "${forcedWord}" (base form or a correct grammatical form of it) exactly as a fluent writer would, with its correct meaning, as a natural part of the continuation.
${avoid}

Respond with ONLY a JSON object (no markdown fences, no commentary): {"aiTurn": "..."}.`;
}

const SUGGESTION_SYSTEM_PROMPT = `${SHARED_CONTEXT}

The student asked for a writing suggestion for their next turn. You will receive JSON with: storySoFar (all turns so far, oldest first) and remainingTargetWords.

Write ONE simple, natural English sentence the student could write next: it continues the story from the last turn and uses exactly one of remainingTargetWords correctly. Return ONLY the English sentence itself — no instruction words (no "Try to write", "You could write", "Coba tulis"), no quotes, no explanation.

Respond with ONLY a JSON object (no markdown fences, no commentary): {"suggestion": "..."}.`;

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
  if (body.forcedWord !== undefined && body.forcedWord !== null && typeof body.forcedWord !== 'string') {
    return jsonError('"forcedWord" must be a string when provided.', 400);
  }
  if (
    body.studentTurnContainsIndonesian !== undefined &&
    typeof body.studentTurnContainsIndonesian !== 'boolean'
  ) {
    return jsonError('"studentTurnContainsIndonesian" must be a boolean when provided.', 400);
  }

  const transcript = body.transcript;
  const studentTurnContainsIndonesian = body.studentTurnContainsIndonesian === true;
  const remainingWords = body.remainingWords.map(normalizeWord).filter((w) => w.length > 0);
  const forcedWord = typeof body.forcedWord === 'string' ? normalizeWord(body.forcedWord) : null;

  try {
    if (forcedWord !== null) {
      if (body.requestSuggestion) {
        return jsonError('"forcedWord" cannot be combined with "requestSuggestion".', 400);
      }
      if (!remainingWords.includes(forcedWord)) {
        return jsonError('"forcedWord" must be one of "remainingWords".', 400);
      }
      const split = splitAtCurrentStudentTurn(transcript);
      if (!split) {
        return jsonError('A forced-word turn requires a student turn in "transcript".', 400);
      }
      return await forcedTurn(env, split, forcedWord, remainingWords);
    }
    if (body.requestSuggestion) {
      return await suggestionTurn(env, transcript, remainingWords);
    }
    const split = splitAtCurrentStudentTurn(transcript);
    if (!split) {
      return jsonError('"transcript" must end with the current student turn.', 400);
    }
    return await ordinaryTurn(env, split, remainingWords, studentTurnContainsIndonesian);
  } catch (err) {
    if (err instanceof OpenAiCallError) {
      return jsonError(err.message, 502);
    }
    return jsonError('Failed to parse AI backend response.', 502);
  }
}

interface SplitTranscript {
  storySoFar: TranscriptTurn[];
  currentStudentTurn: string;
}

/**
 * The current student turn is, by contract, the LAST transcript entry and
 * must be from the student — the client appends it right before calling.
 * Anything else means the client's transcript assembly is out of sync, so
 * it is rejected rather than assessing some older student message.
 */
function splitAtCurrentStudentTurn(transcript: readonly TranscriptTurn[]): SplitTranscript | null {
  const last = transcript[transcript.length - 1];
  if (!last || last.sender !== 'siswa' || !last.text.trim()) return null;
  return { storySoFar: transcript.slice(0, -1), currentStudentTurn: last.text };
}

async function ordinaryTurn(
  env: Env,
  split: SplitTranscript,
  remainingWords: readonly string[],
  studentTurnContainsIndonesian: boolean,
): Promise<Response> {
  const userContent = JSON.stringify({
    storySoFar: split.storySoFar,
    currentStudentTurn: split.currentStudentTurn,
    remainingTargetWords: remainingWords,
    studentTurnContainsIndonesian,
  });

  // The student-turn assessment (feedback, hasError, wordsUsedCorrectly)
  // comes from the FIRST well-formed attempt and is kept for the whole
  // request: a retry exists only to repair the bot's aiTurn, so it must
  // never replace (or silently erase) the student's vocabulary credit.
  let assessment: Pick<CowriteTurnResult, 'feedback' | 'hasError' | 'wordsUsedCorrectly'> | null =
    null;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const parsed = await generateJson(env, ORDINARY_SYSTEM_PROMPT, userContent, 0.7);
    if (!isValidOrdinaryOutput(parsed)) continue;

    if (assessment === null) {
      const wordsUsedCorrectly = validateStudentTargetWords(
        parsed.wordsUsedCorrectly,
        split.currentStudentTurn,
        remainingWords,
      );
      const modelFeedback =
        typeof parsed.feedback === 'string' ? parsed.feedback.trim() || null : null;
      // The model claimed target-word use but code credited none, so its
      // feedback would contradict the validated result (e.g. praising a
      // bare word). The Indonesian-reminder case is left untouched.
      const claimedButUncredited =
        parsed.wordsUsedCorrectly.some((w) => w.trim().length > 0) &&
        wordsUsedCorrectly.length === 0;
      assessment = {
        feedback:
          claimedButUncredited && !studentTurnContainsIndonesian
            ? UNCREDITED_CLAIM_FEEDBACK
            : modelFeedback,
        hasError: parsed.hasError,
        wordsUsedCorrectly,
      };
    }
    const credited = assessment.wordsUsedCorrectly;
    const stillRemaining = remainingWords.filter((w) => !credited.includes(w));
    const aiTurn = parsed.aiTurn.trim();

    const acceptable =
      aiTurn.length > 0 &&
      !isEchoOfStudentTurn(aiTurn, split.currentStudentTurn) &&
      !containsAnyTargetWord(aiTurn, stillRemaining) &&
      !containsIndonesianWords(aiTurn, remainingWords);
    if (!acceptable) continue;

    const result: CowriteTurnResult = {
      aiTurn,
      ...assessment,
      suggestion: null,
      aiUsedWords: [],
      assessedStudentTurn: split.currentStudentTurn,
    };
    return Response.json(result);
  }

  // No attempt produced an acceptable continuation. A well-formed but
  // unacceptable aiTurn (echo, remaining target word, Indonesian) is never
  // shown; the client rolls the student turn back and the student resends.
  return jsonError(
    assessment === null
      ? 'AI backend returned an unexpected response shape.'
      : 'AI did not produce an acceptable story continuation.',
    502,
  );
}

async function forcedTurn(
  env: Env,
  split: SplitTranscript,
  forcedWord: string,
  remainingWords: readonly string[],
): Promise<Response> {
  const avoidWords = remainingWords.filter((w) => w !== forcedWord);
  const systemPrompt = forcedSystemPrompt(forcedWord, avoidWords);
  const userContent = JSON.stringify({
    storySoFar: split.storySoFar,
    currentStudentTurn: split.currentStudentTurn,
  });

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const parsed = await generateJson(env, systemPrompt, userContent, 0.7);
    if (!isRecord(parsed) || typeof parsed.aiTurn !== 'string') continue;
    const aiTurn = parsed.aiTurn.trim();

    const usesForcedWord = containsTargetWordInText(aiTurn, forcedWord);
    const usesOtherTargets = containsAnyTargetWord(aiTurn, avoidWords);
    const echoes = isEchoOfStudentTurn(aiTurn, split.currentStudentTurn);
    const notEnglish = containsIndonesianWords(aiTurn, remainingWords);
    if (!aiTurn || !usesForcedWord || usesOtherTargets || echoes || notEnglish) continue;

    const result: CowriteTurnResult = {
      aiTurn,
      feedback: null,
      hasError: false,
      wordsUsedCorrectly: [],
      suggestion: null,
      aiUsedWords: validateBotTargetWords([], aiTurn, [forcedWord]),
      assessedStudentTurn: null,
    };
    return Response.json(result);
  }

  return jsonError(`AI did not produce a valid turn using "${forcedWord}".`, 502);
}

async function suggestionTurn(
  env: Env,
  transcript: readonly TranscriptTurn[],
  remainingWords: readonly string[],
): Promise<Response> {
  const userContent = JSON.stringify({
    storySoFar: transcript,
    remainingTargetWords: remainingWords,
  });

  let fallback: string | null = null;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const parsed = await generateJson(env, SUGGESTION_SYSTEM_PROMPT, userContent, 0.7);
    if (!isRecord(parsed) || typeof parsed.suggestion !== 'string') continue;
    const sentence = extractSuggestedSentence(parsed.suggestion);
    if (!sentence) continue;
    fallback = sentence;
    if (
      containsAnyTargetWord(sentence, remainingWords) &&
      !isBareOrFragmentTurn(sentence, remainingWords)
    ) {
      break;
    }
  }

  if (fallback === null) {
    return jsonError('AI backend returned an unexpected response shape.', 502);
  }
  const result: CowriteTurnResult = {
    aiTurn: '',
    feedback: null,
    hasError: false,
    wordsUsedCorrectly: [],
    suggestion: fallback,
    aiUsedWords: [],
    assessedStudentTurn: null,
  };
  return Response.json(result);
}

/** One model call; returns the parsed JSON, or `undefined` when the reply
 * is not valid JSON (treated by callers as a failed attempt). Network/HTTP
 * failures propagate as `OpenAiCallError` (502, no retry). */
async function generateJson(
  env: Env,
  systemPrompt: string,
  userContent: string,
  temperature: number,
): Promise<unknown> {
  const content = await callChatCompletion(
    env,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    { temperature },
  );
  try {
    return JSON.parse(stripCodeFence(content));
  } catch {
    return undefined;
  }
}

interface OrdinaryOutput {
  feedback: string | null;
  hasError: boolean;
  wordsUsedCorrectly: string[];
  aiTurn: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidOrdinaryOutput(value: unknown): value is OrdinaryOutput {
  return (
    isRecord(value) &&
    typeof value.aiTurn === 'string' &&
    (value.feedback === null || value.feedback === undefined || typeof value.feedback === 'string') &&
    typeof value.hasError === 'boolean' &&
    Array.isArray(value.wordsUsedCorrectly) &&
    value.wordsUsedCorrectly.every((w) => typeof w === 'string')
  );
}

function isValidTurn(turn: unknown): turn is TranscriptTurn {
  if (typeof turn !== 'object' || turn === null) return false;
  const t = turn as RawTranscriptTurn;
  return (t.sender === 'siswa' || t.sender === 'ai') && typeof t.text === 'string';
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
