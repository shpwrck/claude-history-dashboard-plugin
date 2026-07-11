import { describe, it, expect } from 'vitest';
import { detector } from './secrets-at-rest';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { SecretsAtRestSignal } from '../../parse-secrets-at-rest';
import { parseSecretsAtRest } from '../../parse-secrets-at-rest';

const NOW = Date.parse('2026-07-09T00:00:00Z');

// Synthetic, obviously-fake credentials matching the shared SECRET_PATTERNS.
const FAKE_ANTHROPIC = 'sk-ant-api03-FAKEfakeFAKE1234567890abcdefZZ';
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE';
const GIT_SHA = '9f83a1c7b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f1';

function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function signal(overrides: Partial<SecretsAtRestSignal> = {}): SecretsAtRestSignal {
  return {
    sessionId: 'leaky-1',
    totalCount: 2,
    countsByKind: { 'anthropic-key': 2 },
    evidenceRefs: [
      { sessionId: 'leaky-1', entryIndex: 3, timestamp: '2026-07-08T00:00:00.000Z' },
    ],
    lastObserved: '2026-07-08T00:00:00.000Z',
    ...overrides,
  };
}

function liveConfigWithCleanup(cleanupPeriodDays: number): LiveConfig {
  return { settings: { cleanupPeriodDays } } as unknown as LiveConfig;
}

describe('security.secrets-at-rest', () => {
  it('fires when secret-shaped values sit at rest', () => {
    const rec = detector.rule(baseInput({ secretsAtRest: [signal()] }), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('security.secrets-at-rest');
    expect(rec!.category).toBe('security');
    expect(rec!.claimClass).toBe('accounting');
    expect(rec!.proofTier).toBe('accounting');
    expect(rec!.view).toBe('sessions');
    expect(rec!.affected).toBe(1);
    expect(rec!.title).toContain('2 secret-shaped value');
  });

  it('stays silent below the gate (no signal / empty / all-zero)', () => {
    expect(detector.rule(baseInput(), NOW)).toBeNull();
    expect(detector.rule(baseInput({ secretsAtRest: [] }), NOW)).toBeNull();
    expect(detector.rule(baseInput({ secretsAtRest: null }), NOW)).toBeNull();
    expect(
      detector.rule(
        baseInput({ secretsAtRest: [signal({ totalCount: 0, countsByKind: {} })] }),
        NOW
      )
    ).toBeNull();
  });

  it('self-suppresses once cleanupPeriodDays bounds retention to the recommended window or tighter', () => {
    // 7 days == the recommended bound → suppressed.
    expect(
      detector.rule(
        baseInput({ secretsAtRest: [signal()], liveConfig: liveConfigWithCleanup(7) }),
        NOW
      )
    ).toBeNull();
    // 3 days (tighter) → suppressed.
    expect(
      detector.rule(
        baseInput({ secretsAtRest: [signal()], liveConfig: liveConfigWithCleanup(3) }),
        NOW
      )
    ).toBeNull();
    // 30 days (looser than the bound) → still fires.
    expect(
      detector.rule(
        baseInput({ secretsAtRest: [signal()], liveConfig: liveConfigWithCleanup(30) }),
        NOW
      )
    ).not.toBeNull();
  });

  it('reads CRITICAL for cloud/provider keys, WARNING otherwise', () => {
    const critical = detector.rule(
      baseInput({
        secretsAtRest: [signal({ countsByKind: { 'aws-access-key-id': 1 }, totalCount: 1 })],
      }),
      NOW
    );
    expect(critical!.severity).toBe('critical');

    const warning = detector.rule(
      baseInput({
        secretsAtRest: [signal({ countsByKind: { 'github-token': 1 }, totalCount: 1 })],
      }),
      NOW
    );
    expect(warning!.severity).toBe('warning');
  });

  it('carries valid, allowlisted provenance and a validated fix snippet', () => {
    const rec = detector.rule(baseInput({ secretsAtRest: [signal()] }), NOW)!;
    // Provenance contract: shape valid + present (it is on PROVENANCE_DETECTORS).
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
    expect(rec.provenance!.inference).toBeTruthy();
    // Fix is a self-contained, copy-paste-safe settings.json snippet.
    expect(rec.fix!.target).toBe('settings.json');
    expect(rec.fix!.fixKind).toBe('validated');
    expect(rec.fix!.snippet).toContain('cleanupPeriodDays');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('demotes a stale last-observed date to "as of <date>" and marks provenance.stale', () => {
    const stale = detector.rule(
      baseInput({ secretsAtRest: [signal({ lastObserved: '2026-05-01T00:00:00.000Z' })] }),
      NOW
    )!;
    expect(stale.provenance!.asOf).toBe('2026-05-01');
    expect(stale.provenance!.stale).toBe(true);
    expect(stale.detail).toContain('last observed 2026-05-01');

    const fresh = detector.rule(baseInput({ secretsAtRest: [signal()] }), NOW)!;
    expect(fresh.provenance!.stale).toBe(false);
    expect(fresh.detail).toContain('as of 2026-07-08');
  });

  it('SECURITY: an end-to-end parse→detect never surfaces the matched value', () => {
    // Build the signal the real way: parse a transcript that contains a real
    // synthetic key, then feed the detector — so this exercises the whole path.
    const transcript = [
      {
        type: 'user',
        timestamp: '2026-07-08T00:00:00.000Z',
        message: { role: 'user', content: `deploy with ${FAKE_ANTHROPIC}` },
      },
      {
        type: 'user',
        timestamp: '2026-07-08T00:01:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: `AWS_ACCESS_KEY_ID=${FAKE_AWS}` },
          ],
        },
        toolUseResult: { stdout: `AWS_ACCESS_KEY_ID=${FAKE_AWS}` },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');

    const sig = parseSecretsAtRest(transcript, 'e2e-1.jsonl');
    expect(sig).not.toBeNull();
    const rec = detector.rule(baseInput({ secretsAtRest: [sig!] }), NOW)!;
    expect(rec).not.toBeNull();

    const json = JSON.stringify(rec);
    expect(json).not.toContain(FAKE_ANTHROPIC);
    expect(json).not.toContain(FAKE_AWS);
    expect(json).not.toContain('sk-ant-');
    expect(json).not.toContain('AKIA');
  });

  it('stays dark when the only high-entropy strings are benign (git SHA)', () => {
    const transcript = [
      {
        type: 'user',
        timestamp: '2026-07-08T00:00:00.000Z',
        message: { role: 'user', content: `HEAD is now ${GIT_SHA}` },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const sig = parseSecretsAtRest(transcript, 'clean-1.jsonl');
    expect(sig).toBeNull();
    // With no signal, the detector emits nothing.
    expect(detector.rule(baseInput({ secretsAtRest: [] }), NOW)).toBeNull();
  });
});
