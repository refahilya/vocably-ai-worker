import { describe, expect, it, vi } from 'vitest';

import { OpenAiCallError, callChatCompletion, stripCodeFence } from '../src/openai';
import type { Env } from '../src/env';

const env = {
  OPENAI_BASE_URL: 'https://ai.example/v1',
  OPENAI_API_PATH: '/chat/completions',
  OPENAI_MODEL: 'gpt-4o-mini',
  OPENAI_API_KEY: 'test-key',
} as Env;

describe('callChatCompletion', () => {
  it('returns the assistant message content on success, calling the right URL/method', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
          status: 200,
        }),
      );

    const content = await callChatCompletion(env, [{ role: 'user', content: 'hi' }], {
      fetchImpl,
    });

    expect(content).toBe('hello');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ai.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the API key as a Bearer authorization header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

    await callChatCompletion(env, [], { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
  });

  it('throws OpenAiCallError on a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(callChatCompletion(env, [], { fetchImpl })).rejects.toThrow(OpenAiCallError);
  });

  it('throws OpenAiCallError on a non-OK status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));

    await expect(callChatCompletion(env, [], { fetchImpl })).rejects.toThrow(OpenAiCallError);
  });

  it('throws OpenAiCallError when the response has no message content', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    await expect(callChatCompletion(env, [], { fetchImpl })).rejects.toThrow(OpenAiCallError);
  });
});

describe('stripCodeFence', () => {
  it('returns plain content unchanged', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a ```json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a bare ``` fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});
