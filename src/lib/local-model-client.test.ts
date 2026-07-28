import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LOCAL_MODEL,
  LocalModelError,
  assertLoopbackEndpoint,
  callLocalModel,
  chatCompletionsUrl,
  isLoopbackHost,
  readLocalModelConfig,
} from './local-model-client';

const okResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as Response;

describe('readLocalModelConfig', () => {
  it('returns null when the endpoint env is unset or blank (default, opt-out)', () => {
    expect(readLocalModelConfig({})).toBeNull();
    expect(readLocalModelConfig({ CHD_LOCAL_MODEL_ENDPOINT: '   ' })).toBeNull();
  });

  it('reads the endpoint and defaults the model name', () => {
    expect(
      readLocalModelConfig({ CHD_LOCAL_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1' })
    ).toEqual({ endpoint: 'http://127.0.0.1:11434/v1', model: DEFAULT_LOCAL_MODEL });
  });

  it('honors an explicit model name override', () => {
    expect(
      readLocalModelConfig({
        CHD_LOCAL_MODEL_ENDPOINT: 'http://localhost:8000/v1',
        CHD_LOCAL_MODEL_NAME: 'qwen2.5-coder',
      })
    ).toEqual({ endpoint: 'http://localhost:8000/v1', model: 'qwen2.5-coder' });
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback hosts only', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.5.9.9')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('rejects every non-loopback host', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    // A would-be external LLM host is rejected.
    expect(isLoopbackHost('api.example-llm.test')).toBe(false);
  });
});

describe('assertLoopbackEndpoint (governance: loopback-only egress)', () => {
  it('returns the URL for a loopback http(s) endpoint', () => {
    expect(assertLoopbackEndpoint('http://127.0.0.1:11434/v1').hostname).toBe(
      '127.0.0.1'
    );
  });

  it('refuses a non-loopback host', () => {
    expect(() => assertLoopbackEndpoint('https://example-llm.test/v1')).toThrow(
      LocalModelError
    );
    try {
      assertLoopbackEndpoint('https://example-llm.test/v1');
    } catch (err) {
      expect((err as LocalModelError).code).toBe(
        'ERR_LOCAL_MODEL_ENDPOINT_NOT_LOOPBACK'
      );
    }
  });

  it('refuses a non-http protocol and an invalid URL', () => {
    expect(() => assertLoopbackEndpoint('ftp://127.0.0.1/v1')).toThrow(
      LocalModelError
    );
    expect(() => assertLoopbackEndpoint('not a url')).toThrow(LocalModelError);
  });
});

describe('chatCompletionsUrl', () => {
  it('appends the OpenAI chat route to the loopback base', () => {
    expect(chatCompletionsUrl('http://127.0.0.1:11434/v1').toString()).toBe(
      'http://127.0.0.1:11434/v1/chat/completions'
    );
  });

  it('does not double-append when the base already targets chat/completions', () => {
    expect(
      chatCompletionsUrl('http://127.0.0.1:11434/v1/chat/completions').toString()
    ).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});

describe('callLocalModel (governance: target is loopback, never a third party)', () => {
  it('posts to the loopback endpoint and returns the normalized OpenAI response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse({
          model: 'qwen2.5-coder',
          choices: [{ message: { role: 'assistant', content: 'Focus on cache waste.' } }],
        })
      );

    const result = await callLocalModel({
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder',
      messages: [{ role: 'user', content: 'analyze' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ text: 'Focus on cache waste.', model: 'qwen2.5-coder' });
    // The request target is loopback and provably NOT a third-party API host.
    const target = String(fetchImpl.mock.calls[0][0]);
    expect(new URL(target).hostname).toBe('127.0.0.1');
    expect(target).not.toMatch(/anthropic/i);
  });

  it('refuses a non-loopback endpoint WITHOUT ever issuing a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      callLocalModel({
        endpoint: 'https://example-llm.test/v1',
        model: 'x',
        messages: [{ role: 'user', content: 'analyze' }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(LocalModelError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws LocalModelError when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      callLocalModel({
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'x',
        messages: [{ role: 'user', content: 'analyze' }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'ERR_LOCAL_MODEL_UNREACHABLE' });
  });

  it('throws LocalModelError on a non-OK status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    await expect(
      callLocalModel({
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'x',
        messages: [{ role: 'user', content: 'analyze' }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'ERR_LOCAL_MODEL_HTTP' });
  });
});

describe('local-model-client source (governance: no external Anthropic literal)', () => {
  it('contains no api.anthropic.com literal', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./local-model-client.ts', import.meta.url)),
      'utf8'
    );
    // Assembled at runtime so this assertion itself is not an offender.
    const banned = ['api', 'anthropic', 'com'].join('.');
    expect(source.includes(banned)).toBe(false);
  });
});

/**
 * #3132 — the loopback guard only vets the first hop. Default fetch follows
 * 3xx transparently and replays a 307/308 with the POST body intact, so a
 * local service could bounce the prompt to any external host while the module
 * still claimed "loopback only".
 */
describe('redirect refusal (governance: loopback holds for every hop)', () => {
  const redirectResponse = (status: number, location: string): Response =>
    ({
      ok: false,
      status,
      type: 'default',
      headers: new Headers({ location }),
      json: async () => ({}),
    }) as unknown as Response;

  it.each([307, 308, 301, 302, 303])(
    'refuses a %i redirect pointing off loopback and never calls the redirected host',
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(redirectResponse(status, 'https://example.invalid/v1/chat/completions'));

      await expect(
        callLocalModel({
          endpoint: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5-coder',
          messages: [{ role: 'user', content: 'secret prompt' }],
          fetchImpl: fetchImpl as unknown as typeof fetch,
        })
      ).rejects.toMatchObject({ code: 'ERR_LOCAL_MODEL_REDIRECT' });

      // Exactly one request, and it went to loopback.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][0])).toContain('127.0.0.1');
      for (const call of fetchImpl.mock.calls) {
        expect(String(call[0])).not.toContain('example.invalid');
      }
    }
  );

  it('asks fetch not to follow redirects in the first place', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ model: 'm', choices: [{ message: { content: 'ok' } }] })
    );

    await callLocalModel({
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'm',
      messages: [{ role: 'user', content: 'analyze' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses an opaqueredirect response, whose status reads 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ({
        ok: false,
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
        json: async () => ({}),
      }) as unknown as Response
    );

    await expect(
      callLocalModel({
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'm',
        messages: [{ role: 'user', content: 'analyze' }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'ERR_LOCAL_MODEL_REDIRECT' });
  });

  it('still accepts a normal loopback 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        model: 'qwen2.5-coder',
        choices: [{ message: { role: 'assistant', content: 'Focus on cache waste.' } }],
      })
    );

    await expect(
      callLocalModel({
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5-coder',
        messages: [{ role: 'user', content: 'analyze' }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toMatchObject({ text: 'Focus on cache waste.' });
  });
});
