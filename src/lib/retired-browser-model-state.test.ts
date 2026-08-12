import { describe, expect, it, vi } from 'vitest';

import { purgeRetiredBrowserModelState } from './retired-browser-model-state';

describe('purgeRetiredBrowserModelState', () => {
  it('removes retired credentials and preferences without reading their values', () => {
    const durableRemove = vi.fn();
    const sessionRemove = vi.fn();

    purgeRetiredBrowserModelState({
      durable: { removeItem: durableRemove },
      session: { removeItem: sessionRemove },
    });

    expect(durableRemove.mock.calls.map(([key]) => key)).toEqual([
      'claude-history-dashboard:anthropic-api-key',
      'claude-history-dashboard:anthropic-default-model',
      'claude-history-dashboard:ask-fab-hidden',
    ]);
    expect(sessionRemove).toHaveBeenCalledExactlyOnceWith(
      'claude-history-dashboard:anthropic-api-key'
    );
  });

  it('continues purging when either storage backend is unavailable', () => {
    const sessionRemove = vi.fn();

    expect(() =>
      purgeRetiredBrowserModelState({
        durable: {
          removeItem: () => {
            throw new Error('blocked');
          },
        },
        session: { removeItem: sessionRemove },
      })
    ).not.toThrow();
    expect(sessionRemove).toHaveBeenCalledExactlyOnceWith(
      'claude-history-dashboard:anthropic-api-key'
    );
  });
});
