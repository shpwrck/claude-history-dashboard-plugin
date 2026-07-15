// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SecretsAtRestSignal } from './parse-secrets-at-rest';
import type { RecommendationViews } from './recommendations';
import { useRecommendations } from './use-recommendations';

const BASE_VIEWS: RecommendationViews = {
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
};

const SIGNAL: SecretsAtRestSignal = {
  sessionId: 'secret-session-coordinate',
  totalCount: 2,
  countsByKind: { 'anthropic-key': 1, 'private-key': 1 },
  evidenceRefs: [
    {
      sessionId: 'secret-session-coordinate',
      entryIndex: 4,
      timestamp: '2026-07-15T10:00:00.000Z',
      toolUseId: 'tool-use-coordinate',
    },
  ],
};

describe('useRecommendations', () => {
  it('recomputes privacy-safe secrets-at-rest findings when only that signal changes', () => {
    const { result, rerender } = renderHook(
      ({ secretsAtRest }: { secretsAtRest?: SecretsAtRestSignal[] }) =>
        useRecommendations({ ...BASE_VIEWS, secretsAtRest }),
      { initialProps: { secretsAtRest: [] as SecretsAtRestSignal[] } }
    );

    expect(
      result.current.recommendations.find(
        (rec) => rec.id === 'security.secrets-at-rest'
      )
    ).toBeUndefined();

    rerender({ secretsAtRest: [SIGNAL] });

    const finding = result.current.recommendations.find(
      (rec) => rec.id === 'security.secrets-at-rest'
    );
    expect(finding).toMatchObject({
      id: 'security.secrets-at-rest',
      title: '2 secret-shaped value(s) persisted in plaintext transcripts',
      evidence: [
        'secret-s: 2 secret-shaped value(s) [anthropic-key, private-key]',
      ],
      evidenceRefs: SIGNAL.evidenceRefs,
    });
    expect(JSON.stringify(finding)).not.toContain('sk-ant-');

    rerender({
      secretsAtRest: [
        {
          ...SIGNAL,
          totalCount: 3,
          countsByKind: { 'anthropic-key': 2, 'private-key': 1 },
        },
      ],
    });
    expect(
      result.current.recommendations.find(
        (rec) => rec.id === 'security.secrets-at-rest'
      )?.title
    ).toBe('3 secret-shaped value(s) persisted in plaintext transcripts');

    rerender({ secretsAtRest: [] });
    expect(
      result.current.recommendations.find(
        (rec) => rec.id === 'security.secrets-at-rest'
      )
    ).toBeUndefined();
  });
});
