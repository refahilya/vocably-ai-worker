# Vocably AI Worker

Cloudflare Worker AI proxy for **Vocably** (`CLAUDE.md` §2/§7 Milestone 5,
`DATA_MODEL.md` §10). **Separate codebase from the Flutter app** — never
imported by anything under the Flutter repo's `lib/`, deployed
independently via `wrangler`.

The only reason this exists: `OPENAI_API_KEY` must never be present in
the Flutter web client (its whole bundle is inspectable via DevTools).
This Worker holds that key and proxies three AI-backed operations for
the Flutter client — it never talks to Firestore itself (see
`src/index.ts`'s doc comment / `DATA_MODEL.md` §10.1: the client always
writes results back to Firestore itself, with integrity enforced by
Firestore Security Rules).

## Endpoints

All three require `Authorization: Bearer <Firebase ID token>`, verified
manually (`src/auth.ts`, `jose` — no Firebase Admin SDK in the Workers
runtime).

- `POST /translate` — one word + POS → one Indonesian translation. Used
  by guru's "Tambah Kosakata" (result gets written to Firestore by the
  guru client) and by siswa's lazy Word Detail translation display
  (shown on-screen only, never persisted) — this endpoint doesn't
  distinguish the two; that's entirely the Flutter side's business.
- `POST /generate-story` — Fase 1 (Storyfier, `SPEC.md` §5.1, `DATA_MODEL.md`
  §10.2). Generates an N-sentence English story (plus Indonesian translation)
  where each target word appears once wrapped in `[[targetWord|usedForm]]` in
  narrative-driven order, validated by `validateMarkers()` with a one-retry
  fallback.
- `POST /cowrite-turn` — Fase 3 (`SPEC.md` §5.3, `DATA_MODEL.md` §10.2).
  The Flutter client owns every Co-Write decision: the miss counter,
  whether the fallback is due, which word is forced, word status, and
  completion. This endpoint owns only the prompt builders and the
  deterministic validation of model output (`src/cowriteValidator.ts`,
  kept in parity with the Flutter repo's `lib/utils/cowrite_validator.dart`).
  The client selects one of three modes:
  - **ordinary turn** — assesses only the current student turn (sent to
    the model separately from `storySoFar`), returning `feedback`,
    `hasError`, a code-validated `wordsUsedCorrectly`,
    `assessedStudentTurn`, and a one-sentence `aiTurn` that must not echo
    the student or use a remaining target word. `aiUsedWords` is always `[]`.
    **Vocabulary credit (CW-05):** a target word counts when used
    meaningfully with an acceptable intended meaning. Grammar, tense, and
    agreement errors, and a wrong inflection of the target, don't remove
    credit; they're reported through `hasError`/`feedback`. Bare words,
    lists, fragments, mere mentions, nonsense, and wrong meanings don't
    count. In code, a model-reported form (`attacked`, `"ATTACKS"`) is
    mapped to its remaining base target, which must then appear in the
    student's text. The student assessment comes from the **first**
    well-formed attempt; a retry only replaces `aiTurn`, so it can't
    erase credit.
    **Feedback (CW-02):** the feedback covers only the current turn's
    target-word use. A credited word gets specific acknowledgement, an
    attempted but uncredited word gets the real issue explained, and a
    turn with no target word gets a gentle nudge. At most one important
    grammar or meaning point is mentioned, and capitalization,
    punctuation and apostrophes are ignored. `hasError` means "important
    problem" and is used by the client only for a display indicator. When
    the model claimed words but validation credited none, `feedback` is
    replaced by the fixed `UNCREDITED_CLAIM_FEEDBACK`. The Flutter client
    holds the same text.
    **No acceptable continuation → 502.** If neither attempt yields an
    acceptable `aiTurn` (empty, echo, remaining target word, or
    Indonesian), the request fails with 502. A well-formed but
    unacceptable sentence is never returned.
    **Indonesian / mixed-language input:** the client decides whether the
    student turn is Indonesian or mixed (deterministic
    `containsIndonesianWords`) and sends the optional boolean
    `studentTurnContainsIndonesian` (default `false`; 400 if it isn't a
    boolean). The model never classifies the language. When the flag is
    true, `feedback` is one short, polite Indonesian reminder to write in
    English, and `wordsUsedCorrectly` is still assessed. The client then
    counts those words for session coverage only, not independent mastery.
  - **forced-word turn** (`forcedWord`, chosen by the client) — one
    continuation sentence that must contain that word (checked in code),
    with no other remaining word, and must not echo the student. Returns
    `aiUsedWords: [forcedWord]`, or 502 if no attempt validates.
  - **suggestion** (`requestSuggestion: true`) — returns only a bare
    English sentence. The client adds the Indonesian `Coba tulis "..."`.

  In every mode the bot's `aiTurn` must be **English** and stay in the
  story: it never mirrors the student's language and never answers
  off-topic questions, calculations, or requests. An `aiTurn` that
  `containsIndonesianWords` flags is treated as a failed attempt (ordinary
  and forced modes), like an echo. This detector is a word-list heuristic
  (unambiguous Indonesian function words; English homographs, mid-sentence
  names, and target words are ignored), not full language identification.

  Every mode makes at most `MAX_GENERATION_ATTEMPTS` (2) model calls.

## Local development

```bash
npm install
npm run dev        # wrangler dev
```

Copy `.dev.vars.example` to `.dev.vars` (gitignored) first, filling in a
real `OPENAI_API_KEY` — reuse the same key already configured in the
Flutter repo's root `.env` for `tools/vocab_import`, since both call the
same Dinoiki OpenAI-compatible account (`https://ai.dinoiki.com/v1`,
`gpt-4o-mini`), per the project owner's decision.

`http://localhost:5555` (the Flutter repo's fixed dev port, `CLAUDE.md`
§2) is in `wrangler.jsonc`'s single `vars.ALLOWED_ORIGINS` list alongside
the two production Firebase Hosting origins — see that file's comment
for why (a real end-to-end test found that local Flutter dev actually
points at the *deployed* Worker, not a locally-running `wrangler dev`
one, so localhost needs to be allowed on the real deployment too, not
just a separate dev-only config that a plain `wrangler deploy` never
reads).

Point the Flutter client at this local server:

```bash
flutter run -d chrome --web-port=5555 \
  --dart-define=WORKER_BASE_URL=http://localhost:8787
```

(`http://localhost:8787` is `wrangler dev`'s default port — see its
terminal output if it differs.)

## Testing

```bash
npm test        # vitest run — runs inside the real Workers runtime
                 # (workerd) via @cloudflare/vitest-plugin, not Node/jsdom
npm run typecheck
```

On a low-memory machine the default parallel run can crash at startup
with a Node "JavaScript heap out of memory" error. Run the files one at a
time instead: `npx vitest run --fileParallelism=false`.

No network calls, no real Firebase project needed — every test injects
a fake `fetch` (for the AI backend) and/or a locally-generated JWKS (for
token verification), never the real Google/OpenAI-compatible endpoints.

## Deploying

```bash
npx wrangler login                    # one-time, browser auth
npx wrangler secret put OPENAI_API_KEY   # prompts for the value, encrypted at rest
npm run deploy                        # wrangler deploy
```

This prints the deployed URL
(`https://vocably-ai-worker.<subdomain>.workers.dev`) — pass it to the
Flutter client via `--dart-define=WORKER_BASE_URL=<that URL>` for any
build that isn't pointed at a local `wrangler dev` server.

`wrangler deploy` publishes `vars.ALLOWED_ORIGINS` from `wrangler.jsonc`.
If your working copy adds a local-only origin, don't deploy it. Override
the list on the command line instead (the flag value is hidden in
wrangler's output):

```bash
npx wrangler deploy --var "ALLOWED_ORIGINS:https://vocably-idn-en.web.app,https://vocably-idn-en.firebaseapp.com,http://localhost:5555"
```

**Current deployment:** version `0bec79ee-2958-475e-97fe-64ababf31c9c`,
deployed 2026-10-15T17:08Z UTC with the override above. It includes the
Co-Write Phase 1/2, CW-05, Indonesian-input and CW-02 changes.
- It was deployed from an **uncommitted** working tree on top of
  `6239f7e`, so it matches no commit yet.
- Production smoke checks passed for CORS (allowed and blocked origins),
  401 without a valid token, and 405 for GET.
- Co-Write output quality hasn't been verified in production with an
  authenticated request.

### Rate limiting — a note on the Free plan

`wrangler.jsonc` ships **without** Cloudflare's native Rate Limiting
binding configured — its availability on the Workers Free plan couldn't
be confirmed from Cloudflare's docs while this was built. `src/
rateLimit.ts` auto-detects the binding and falls back to a zero-cost
in-memory per-isolate counter when it's absent (the project owner's
explicit decision, given this project's hard zero-billing constraint).

If you confirm Rate Limiting is available on your account's plan,
uncomment the `unsafe.bindings` block at the bottom of `wrangler.jsonc`
— no code changes needed, `rateLimit.ts` switches to it automatically
once `env.RATE_LIMITER` exists.

## Who does what

Mirrors the split already established for the Flutter repo's
`tools/vocab_import/` pipeline (`CLAUDE.md` §7 Milestone 4): Claude may
write and maintain every file in this repo, but the account-level
actions above (`wrangler login`, `wrangler secret put`, the first real
`wrangler deploy`) stay the project owner's, same reasoning — first use
of new automation against a real paid API / live Cloudflare account
deserves a human in the loop.
