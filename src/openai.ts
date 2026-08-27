import type { Env } from './env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Anything that goes wrong calling the AI backend (network, bad status,
 * or a response with no usable message content) — deliberately one type,
 * mirroring `tools/vocab_import/lib/translateClient.js`'s error handling
 * in the sibling Flutter repo's import pipeline, which this Worker's
 * `/translate` conceptually mirrors (single word instead of a batch). */
export class OpenAiCallError extends Error {}

/**
 * Calls the configured OpenAI-compatible chat-completions endpoint
 * (`env.OPENAI_BASE_URL` + `env.OPENAI_API_PATH`, e.g.
 * `https://ai.dinoiki.com/v1/chat/completions` — the same
 * account/endpoint already used by the Flutter repo's
 * `tools/vocab_import` pipeline, per the project owner's decision) and
 * returns the assistant message's raw text content.
 *
 * `fetchImpl` is injectable so tests can supply a fake instead of
 * hitting the real network (same pattern as the Node pipeline).
 */
export async function callChatCompletion(
  env: Env,
  messages: ChatMessage[],
  options: { temperature?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${env.OPENAI_BASE_URL}${env.OPENAI_API_PATH}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: options.temperature ?? 0.2,
        messages,
      }),
    });
  } catch (err) {
    throw new OpenAiCallError(
      `Network error calling AI backend: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const bodyText = await safeText(response);
    throw new OpenAiCallError(
      `AI backend returned ${response.status}: ${bodyText.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new OpenAiCallError('AI backend response had no message content.');
  }
  return content;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(unreadable response body)';
  }
}

/** Strips a ```json ... ``` / ``` ... ``` fence if the model added one
 * anyway, despite being told not to (same defensive parsing as the
 * Node pipeline's `parseModelJsonArray`). */
export function stripCodeFence(content: string): string {
  let text = content.trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\n?/, '')
      .replace(/```$/, '')
      .trim();
  }
  return text;
}
