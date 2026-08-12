import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AnthropicEgressError,
  AnthropicEgressHttpError,
  callAnthropic,
  callAnthropicMessages,
  egressScrub,
  type CallAnthropicRequest,
  type EgressScrubReceipt,
  type LlmCapReceipt,
} from './anthropic-egress';
import {
  getLlmUsageEntry,
  LLM_PHASE_1_EXPOSURE_DEFAULTS,
  LLM_USAGE_REGISTRY,
  validateLlmUsageRegistry,
} from './llm-registry';

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function capReceipt(
  overrides: Partial<LlmCapReceipt> = {}
): LlmCapReceipt {
  return {
    registryId: 'server.audit-judge',
    callBudget: { env: 'DASHBOARD_AUDIT_MAX_JUDGE_CALLS', limit: 64 },
    inputBounds: [
      { env: 'DASHBOARD_AUDIT_INPUT_MAX_ROWS', limit: 50_000 },
      { env: 'DASHBOARD_AUDIT_RESPONSE_MAX_BYTES', limit: 4_194_304 },
    ],
    outputTokenLimit: {
      env: 'DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS',
      limit: 1024,
    },
    spendControls: [
      'DASHBOARD_ENABLE_SERVER_LLM_AUDITS',
      'ANTHROPIC_API_KEY',
      'Anthropic Console workspace spend limit',
    ],
    ...overrides,
  };
}

describe('LLM usage registry', () => {
  it('has unique ids and exposes only the known server entries', () => {
    const ids = LLM_USAGE_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getLlmUsageEntry('server.usage-gauge')?.credential).toBe('oauth');
    expect(getLlmUsageEntry('server.audit-judge')?.rule).toBe('B');
    expect(getLlmUsageEntry('server.audit-judge')?.dataClass).toBe('scrubbed');
    expect(getLlmUsageEntry('server.audit-judge')?.egressScrub).toBe('redact');
    expect(LLM_USAGE_REGISTRY.every((entry) => entry.surface === 'server')).toBe(
      true
    );
  });

  it('cites a callSite.symbol that actually resolves in its callSite.file', () => {
    // The registry is the governance source of truth; a cited symbol that does
    // not appear in its file makes the manifest unauditable and masks drift.
    const root = fileURLToPath(new URL('../..', import.meta.url));
    for (const entry of LLM_USAGE_REGISTRY) {
      const { file, symbol } = entry.callSite;
      const source = readFileSync(join(root, file), 'utf8');
      expect(
        source.includes(symbol),
        `${entry.id}: callSite.symbol "${symbol}" not found in ${file}`
      ).toBe(true);
    }
  });

  it('validates complete call-site descriptors and exposure policies', () => {
    expect(validateLlmUsageRegistry()).toEqual([]);

    const audit = getLlmUsageEntry('server.audit-judge');
    expect(audit?.callSite).toEqual({
      file: 'scripts/server.mjs',
      symbol: '/api/audit.json',
    });
    expect(audit?.trigger).toBe('opt-in');
    expect(audit?.caps.callBudget.join('\n')).toContain(
      'DASHBOARD_AUDIT_MAX_JUDGE_CALLS'
    );
    expect(audit?.exposure).toEqual(LLM_PHASE_1_EXPOSURE_DEFAULTS);

    const serverEntries = LLM_USAGE_REGISTRY.filter(
      (entry) => entry.surface === 'server'
    );
    expect(serverEntries.map((entry) => entry.exposure)).toEqual([
      LLM_PHASE_1_EXPOSURE_DEFAULTS,
      LLM_PHASE_1_EXPOSURE_DEFAULTS,
    ]);
  });

  it('reports incomplete registry descriptors', () => {
    const [entry] = LLM_USAGE_REGISTRY;
    const errors = validateLlmUsageRegistry([
      {
        ...entry,
        callSite: { file: '', symbol: entry.callSite.symbol },
        caps: { ...entry.caps, callBudget: [] },
      },
    ]);

    expect(errors).toEqual([
      'server.usage-gauge: callSite.file and callSite.symbol are required',
      'server.usage-gauge: caps.callBudget/inputBounds/spendControls are required',
    ]);
  });
});

describe('AnthropicEgressHttpError', () => {
  it('bounds a large upstream body so it cannot leak a big payload', () => {
    const err = new AnthropicEgressHttpError(429, { error: 'x'.repeat(5000) });
    expect(typeof err.body).toBe('string');
    expect(err.body.length).toBeLessThanOrEqual(512 + 16);
    expect(err.body).toContain('…[truncated]');
    expect(err.status).toBe(429);
  });

  it('keeps a small body intact as a string', () => {
    const err = new AnthropicEgressHttpError(400, { type: 'error', message: 'bad' });
    expect(err.body).toBe('{"type":"error","message":"bad"}');
  });
});

describe('egressScrub', () => {
  it('redacts transcript-derived secrets before egress and logs scrub metadata', () => {
    const receipts: EgressScrubReceipt[] = [];
    const content = {
      model: 'claude-sonnet-4-5-20250929',
      system: 'Return JSON',
      messages: [
        {
          role: 'user',
          content:
            'ACTION: bash cat /home/user/.claude/.credentials.json; ' +
            'leaked key sk-ant-abcdef0123456789ABCDEFG in the log; ' +
            'export DB_PASSWORD=hunter2supersecretvalue; ' +
            'ping ops@example.com',
        },
      ],
    };

    const result = egressScrub('server.audit-judge', content, {
      logger: (receipt) => receipts.push(receipt),
    });

    const payload = JSON.stringify(result.content);
    // The secret-shaped substrings must be gone from what would egress.
    expect(payload).not.toContain('sk-ant-abcdef0123456789ABCDEFG');
    expect(payload).not.toContain('hunter2supersecretvalue');
    expect(payload).not.toContain('/home/user/.claude');
    expect(payload).not.toContain('ops@example.com');
    expect(payload).toContain('[REDACTED_KEY]');
    expect(payload).toContain('[REDACTED_PATH]');
    expect(payload).toContain('[REDACTED_EMAIL]');
    expect(payload).toContain('DB_PASSWORD=[REDACTED]');
    // Non-secret content is preserved.
    expect(payload).toContain('claude-sonnet-4-5-20250929');
    expect(payload).toContain('Return JSON');

    expect(result.receipt).toMatchObject({
      registryId: 'server.audit-judge',
      mode: 'redact',
    });
    expect(result.receipt.inputBytes).toBeGreaterThan(0);
    expect(receipts).toEqual([result.receipt]);
    // The receipt itself must never carry the raw secret.
    expect(JSON.stringify(receipts)).not.toContain('sk-ant-abcdef');
  });

  it('rejects entries that are not configured for an egress scrub step', () => {
    expect(() =>
      egressScrub('server.usage-gauge', { ok: true }, {
        logger: () => undefined,
      })
    ).toThrow(/does not use an egress scrub step/);
  });

  it('rejects a redact entry without a scrub logger', () => {
    expect(() =>
      egressScrub(
        'server.audit-judge',
        { ok: true },
        {
          logger: undefined as unknown as (
            receipt: EgressScrubReceipt
          ) => void,
        }
      )
    ).toThrow(/requires a scrub logger/);
  });
});

describe('callAnthropic governance', () => {
  it('rejects calls with no registry entry', async () => {
    await expect(
      callAnthropic('server.missing-entry' as 'server.usage-gauge', {
        credential: { kind: 'oauth', token: 'oauth-token' },
        path: '/messages',
        containsClaudeData: false,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_REGISTRY_MISSING',
    });
  });

  it('rejects a retired browser registry id as missing', async () => {
    await expect(
      callAnthropic('browser.retired', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        capChecked: true,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_REGISTRY_MISSING',
    });
  });

  it('rejects OAuth usage when Claude-derived content is not explicitly absent', async () => {
    await expect(
      callAnthropic('server.usage-gauge', {
        credential: { kind: 'oauth', token: 'oauth-token' },
        path: '/messages',
        body: { messages: [{ role: 'user', content: 'session text' }] },
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_OAUTH_CLAUDE_DATA',
    });
  });

  it('rejects OAuth usage bodies that are not the fixed rate-limit probe', async () => {
    await expect(
      callAnthropic('server.usage-gauge', {
        credential: { kind: 'oauth', token: 'oauth-token' },
        path: '/messages',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        containsClaudeData: false,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_OAUTH_NON_PROBE_BODY',
    });
  });

  it('rejects Console-key audit calls until an opaque scrubbed body is present', async () => {
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        body: { messages: [{ role: 'user', content: 'prompt' }] },
        capChecked: true,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_SCRUB_MISSING',
    });
  });

  it.each([
    'X-Egress-Secret',
    'X-API-KEY',
    'aUtHoRiZaTiOn',
    'ANTHROPIC-VERSION',
    'Content-Type',
    'AnThRoPiC-BeTa',
  ])('rejects Rule-B caller header %s before fetch', async (headerName) => {
    let fetchCalls = 0;
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'safe prompt' }],
      },
      { logger: () => undefined }
    );
    const request = {
      credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
      path: '/messages',
      scrubbedBody: scrubbed,
      headers: { [headerName]: 'transcript-derived-secret' },
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({ ok: true });
      },
    } as unknown as CallAnthropicRequest;

    await expect(
      callAnthropic('server.audit-judge', request)
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CALLER_HEADERS',
    });
    expect(fetchCalls).toBe(0);
  });

  it.each([
    'X-Transcript-Data',
    'AUTHORIZATION',
    'aNtHrOpIc-BeTa',
    'Content-Type',
  ])('rejects Rule-A caller header %s before fetch', async (headerName) => {
    let fetchCalls = 0;
    const request = {
      credential: { kind: 'oauth', token: 'oauth-token' },
      path: '/messages',
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      containsClaudeData: false,
      headers: { [headerName]: 'transcript-derived-secret' },
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({ ok: true });
      },
    } as unknown as CallAnthropicRequest;

    await expect(
      callAnthropic('server.usage-gauge', request)
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CALLER_HEADERS',
    });
    expect(fetchCalls).toBe(0);
  });

  it('rejects Console-key audit calls when the cap control is not attested', async () => {
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        messages: [{ role: 'user', content: 'prompt' }],
      },
      {
        logger: () => undefined,
      }
    );
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        scrubbedBody: scrubbed,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
    });
  });

  it('rejects Console-key audit calls when the cap receipt is missing', async () => {
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        messages: [{ role: 'user', content: 'prompt' }],
      },
      {
        logger: () => undefined,
      }
    );
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        scrubbedBody: scrubbed,
        capChecked: true,
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
    });
  });

  it('rejects Console-key audit calls with a zero call budget receipt', async () => {
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        messages: [{ role: 'user', content: 'prompt' }],
      },
      {
        logger: () => undefined,
      }
    );
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        scrubbedBody: scrubbed,
        capChecked: true,
        capReceipt: capReceipt({
          callBudget: { env: 'DASHBOARD_AUDIT_MAX_JUDGE_CALLS', limit: 0 },
        }),
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
    });
  });

  it('rejects Console-key audit calls above the output token cap', async () => {
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'prompt' }],
      },
      {
        logger: () => undefined,
      }
    );
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        scrubbedBody: scrubbed,
        capChecked: true,
        capReceipt: capReceipt({
          outputTokenLimit: {
            env: 'DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS',
            limit: 1024,
          },
        }),
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_CAP_UNCHECKED',
    });
  });

  it('rejects Console-key audit calls with a mismatched scrub receipt', async () => {
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
        path: '/messages',
        body: { messages: [{ role: 'user', content: 'prompt' }] },
        scrubReceipt: {
          registryId: 'server.usage-gauge',
          mode: 'stub',
          inputBytes: 1,
          outputBytes: 1,
        },
        capChecked: true,
        capReceipt: capReceipt(),
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_SCRUB_MISSING',
    });
  });

  it('rejects fabricated scrub authorizers without calling fetch', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return response({ ok: true });
    };
    const forgedRequest = {
      credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
      path: '/messages',
      body: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: 'secret sk-ant-abcdef0123456789ABCDEFG',
          },
        ],
      },
      scrubReceipt: {
        registryId: 'server.audit-judge',
        mode: 'redact',
        inputBytes: 128,
        outputBytes: 128,
      },
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl,
    } as unknown as CallAnthropicRequest;

    await expect(
      callAnthropic('server.audit-judge', forgedRequest)
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_SCRUB_MISSING',
    });

    const forgedOpaqueRequest = {
      credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
      path: '/messages',
      scrubbedBody: {
        content: {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: 'secret sk-ant-abcdef0123456789ABCDEFG',
            },
          ],
        },
        receipt: {
          registryId: 'server.audit-judge',
          mode: 'redact',
          inputBytes: 128,
          outputBytes: 128,
        },
      },
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl,
    } as unknown as CallAnthropicRequest;

    await expect(
      callAnthropic('server.audit-judge', forgedOpaqueRequest)
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_SCRUB_MISSING',
    });
    expect(fetchCalls).toBe(0);
  });

  it('sends only the exact serialized output from the trusted scrub path', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response({ ok: true });
    };
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 512,
        messages: [
          {
            role: 'user' as const,
            content: 'secret sk-ant-abcdef0123456789ABCDEFG',
          },
        ],
      },
      { logger: () => undefined }
    );
    const trustedSerializedBody = JSON.stringify(scrubbed.content);

    // A caller can retain the public redacted view, but mutating that view must
    // not change the transmission snapshot authorized by the scrub operation.
    scrubbed.content.messages[0].content =
      'replacement sk-ant-zyxwvutsrqponmlk987654321';

    await callAnthropic('server.audit-judge', {
      credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
      path: '/messages',
      scrubbedBody: scrubbed,
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBe(trustedSerializedBody);
    expect(calls[0].init.body).not.toContain(
      'sk-ant-abcdef0123456789ABCDEFG'
    );
    expect(calls[0].init.body).not.toContain(
      'sk-ant-zyxwvutsrqponmlk987654321'
    );
    expect(calls[0].init.body).toContain('[REDACTED_KEY]');
  });

  it('rejects executable toJSON values before they can reintroduce secrets', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return response({ ok: true });
    };

    await expect(
      Promise.resolve().then(async () => {
        const scrubbed = egressScrub(
          'server.audit-judge',
          {
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 512,
            messages: [{ role: 'user' as const, content: 'safe prompt' }],
            toJSON() {
              return {
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 512,
                messages: [
                  {
                    role: 'user',
                    content: 'sk-ant-abcdef0123456789ABCDEFG',
                  },
                ],
              };
            },
          },
          { logger: () => undefined }
        );
        return callAnthropic('server.audit-judge', {
          credential: { kind: 'console-key', apiKey: 'sk-ant-test' },
          path: '/messages',
          scrubbedBody: scrubbed,
          capChecked: true,
          capReceipt: capReceipt(),
          fetchImpl,
        });
      })
    ).rejects.toMatchObject({
      code: 'ERR_DASHBOARD_LLM_SCRUB_UNSUPPORTED',
    });
    expect(fetchCalls).toBe(0);
  });

  it('fails closed on cyclic data and accessors without invoking caller code', () => {
    const cyclic: Record<string, unknown> = {
      model: 'claude-sonnet-4-5-20250929',
    };
    cyclic.self = cyclic;

    expect(() =>
      egressScrub('server.audit-judge', cyclic, {
        logger: () => undefined,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'ERR_DASHBOARD_LLM_SCRUB_UNSUPPORTED',
      })
    );

    let getterCalls = 0;
    const accessorBody = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 512,
    } as Record<string, unknown>;
    Object.defineProperty(accessorBody, 'messages', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [{ role: 'user', content: 'safe prompt' }];
      },
    });

    expect(() =>
      egressScrub('server.audit-judge', accessorBody, {
        logger: () => undefined,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'ERR_DASHBOARD_LLM_SCRUB_UNSUPPORTED',
      })
    );
    expect(getterCalls).toBe(0);
  });

  it('sends OAuth probes with OAuth headers and no browser direct-access header', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response({ ok: true });
    };

    await callAnthropic('server.usage-gauge', {
      credential: { kind: 'oauth', token: 'oauth-token' },
      path: '/messages',
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      containsClaudeData: false,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer oauth-token',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(
      (calls[0].init.headers as Record<string, string>)[
        'anthropic-dangerous-direct-browser-access'
      ]
    ).toBeUndefined();
  });

  it('sends Console-key message calls only after scrub and cap controls pass', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response({
        content: [{ type: 'text', text: '{"isFinding":true}' }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    };

    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 512,
        system: 'Return JSON',
        messages: [
          {
            role: 'user' as const,
            content: 'Judge this capped prompt.',
          },
        ],
      },
      {
        logger: () => undefined,
      }
    );

    const result = await callAnthropicMessages('server.audit-judge', {
      apiKey: 'sk-ant-test',
      scrubbedBody: scrubbed,
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl,
    });

    expect(result).toMatchObject({
      text: '{"isFinding":true}',
      inputTokens: 12,
      outputTokens: 3,
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(calls[0].init.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(calls[0].init.body).toContain('"max_tokens":512');
  });

  it('derives fallback response metadata from the trusted transmission snapshot', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      calls.push(init ?? {});
      return response({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    const scrubbed = egressScrub(
      'server.audit-judge',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 32,
        messages: [{ role: 'user' as const, content: 'safe prompt' }],
      },
      { logger: () => undefined }
    );
    scrubbed.content.model = 'caller-mutated-model';

    const result = await callAnthropicMessages('server.audit-judge', {
      apiKey: 'sk-ant-test',
      scrubbedBody: scrubbed,
      capChecked: true,
      capReceipt: capReceipt(),
      fetchImpl,
    });

    expect(result.model).toBe('claude-sonnet-4-5-20250929');
    expect(calls[0].body).toContain('"model":"claude-sonnet-4-5-20250929"');
    expect(calls[0].body).not.toContain('caller-mutated-model');
  });

  it('uses typed egress errors for policy failures', async () => {
    await expect(
      callAnthropic('server.audit-judge', {
        credential: { kind: 'oauth', token: 'wrong-kind' },
        path: '/messages',
        scrubReceipt: {
          registryId: 'server.audit-judge',
          mode: 'stub',
          inputBytes: 1,
          outputBytes: 1,
        },
        capChecked: true,
      })
    ).rejects.toBeInstanceOf(AnthropicEgressError);
  });
});
