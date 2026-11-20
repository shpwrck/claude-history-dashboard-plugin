import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSessionParseOffThread, sessionIdsOf, type SessionParseResult } from './session-parse-client';
import type { SessionParseFile } from './session-parse';

// #3810: the sample corpus parses through the neutral session parser, with a
// yielding main-thread fallback when a Worker is unavailable or fails.
const files: SessionParseFile[] = [
  {
    name: 's-1.jsonl',
    project: 'demo',
    text: JSON.stringify({
      type: 'user',
      sessionId: 's-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    }),
  },
];

const PASS_ORDER = [
  'sessionIndex',
  'tokens',
  'tools',
  'inventories',
  'timelines',
  'apiErrors',
  'permissions',
  'agentSettings',
  'attribution',
  'runtime',
  'churnGeometry',
  'valueFlow',
];

async function collect(): Promise<SessionParseResult[]> {
  const out: SessionParseResult[] = [];
  await runSessionParseOffThread(files, (msg) => out.push(msg));
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runSessionParseOffThread', () => {
  it('falls back to the main thread when Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const out = await collect();
    expect(out.map((m) => m.type)).toEqual(PASS_ORDER);
    expect(out[0]).toEqual({ type: 'sessionIndex', sessionIds: ['s-1'] });
  });

  it('falls back to the main thread when the worker fails to start', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked by CSP');
        }
      }
    );
    expect((await collect()).map((m) => m.type)).toEqual(PASS_ORDER);
  });

  it('falls back to the main thread when the worker reports an error', async () => {
    class FailingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'error' } } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FailingWorker);
    expect((await collect()).map((m) => m.type)).toEqual(PASS_ORDER);
  });

  it('relays worker messages and stops at done', async () => {
    const terminate = vi.fn();
    class OkWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(request: { files: SessionParseFile[] }) {
        queueMicrotask(() => {
          const ids = sessionIdsOf(request.files);
          this.onmessage?.({ data: { type: 'sessionIndex', sessionIds: ids } } as MessageEvent);
          this.onmessage?.({ data: { type: 'tokens', data: [] } } as MessageEvent);
          this.onmessage?.({ data: { type: 'done' } } as MessageEvent);
        });
      }
      terminate = terminate;
    }
    vi.stubGlobal('Worker', OkWorker);
    const out = await collect();
    expect(out).toEqual([
      { type: 'sessionIndex', sessionIds: ['s-1'] },
      { type: 'tokens', data: [] },
    ]);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('does nothing for an empty corpus', async () => {
    const onResult = vi.fn();
    await runSessionParseOffThread([], onResult);
    expect(onResult).not.toHaveBeenCalled();
  });
});
