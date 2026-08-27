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
- `POST /generate-story` — Fase 1 (Storyfier). Not consumed by any
  Flutter screen yet (Milestone 7 builds that UI) — built now, to its
  full `DATA_MODEL.md` §10.2 contract, alongside the shared
  auth/CORS/rate-limiting infrastructure this milestone sets up anyway.
- `POST /cowrite-turn` — Fase 3. Same status as `/generate-story`.

## Local development

```bash
npm install
npm run dev        # wrangler dev --env development
```

Copy `.dev.vars.example` to `.dev.vars` (gitignored) first, filling in a
real `OPENAI_API_KEY` — reuse the same key already configured in the
Flutter repo's root `.env` for `tools/vocab_import`, since both call the
same Dinoiki OpenAI-compatible account (`https://ai.dinoiki.com/v1`,
`gpt-4o-mini`), per the project owner's decision.

`npm run dev` uses the `development` environment in `wrangler.jsonc`,
which is the **only** place `http://localhost:5555` (the Flutter repo's
fixed dev port, `CLAUDE.md` §2) is in the CORS allowlist — a plain
`wrangler deploy` never includes it.

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
