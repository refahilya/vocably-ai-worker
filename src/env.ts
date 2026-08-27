/**
 * Cloudflare Worker environment shape — every `vars`/secret/binding this
 * Worker reads. Kept in one place so every handler imports the same
 * type instead of re-declaring pieces of it.
 */
export interface Env {
  // --- Secrets (never in wrangler.jsonc — see .dev.vars.example / the
  // `wrangler secret put` instructions in README.md) ---
  OPENAI_API_KEY: string;

  // --- Non-secret config (wrangler.jsonc `vars`) ---
  OPENAI_BASE_URL: string;
  OPENAI_API_PATH: string;
  OPENAI_MODEL: string;
  FIREBASE_PROJECT_ID: string;
  /** Comma-separated list — see `src/cors.ts`. */
  ALLOWED_ORIGINS: string;

  // --- Optional native rate limiting binding (DATA_MODEL.md §10.1) ---
  // Deliberately optional (`?`): wrangler.jsonc ships without this binding
  // configured by default (see that file's comment), so `env.RATE_LIMITER`
  // is `undefined` unless the project owner has confirmed availability on
  // their plan and added it. `src/rateLimit.ts` checks for this at
  // runtime and falls back to an in-memory limiter when absent.
  RATE_LIMITER?: RateLimit;
}

/**
 * Minimal shape of Cloudflare's native Rate Limiting binding
 * (`@cloudflare/workers-types` doesn't ship a type for this yet as of
 * this Worker's creation) — just enough to call `.limit()`.
 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
