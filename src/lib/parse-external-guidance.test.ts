import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExternalGuidanceParseError,
  externalGuidanceRef,
  parseExternalGuidanceSnapshot,
  readExternalGuidanceSnapshots,
  sourceForExternalGuidance,
} from './parse-external-guidance';

const snapshot = {
  id: 'anthropic-usage-limits',
  source: 'anthropic-support',
  url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
  fetchedAt: '2026-06-12T00:00:00.000Z',
  contentHash: 'sha256:abc123',
  title: 'How do usage and length limits work?',
  suggestion: 'Review the first-party Claude usage limits guidance.',
  target: { detectorId: 'cost.session-usage-limits' },
  facts: {
    rollingWindowHours: 5,
    hasWeeklyLimit: true,
  },
};

describe('parseExternalGuidanceSnapshot (#1300)', () => {
  it('round-trips a fixture snapshot into trust-tiered guidance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'external-guidance-'));
    try {
      await writeFile(
        join(dir, 'anthropic-usage-limits.json'),
        JSON.stringify(snapshot),
        'utf8'
      );

      const guidance = readExternalGuidanceSnapshots(dir);

      expect(guidance).toHaveLength(1);
      expect(guidance[0]).toMatchObject({
        id: 'anthropic-usage-limits',
        source: 'anthropic-support',
        trustTier: 'first-party',
        url: snapshot.url,
        contentHash: 'sha256:abc123',
        target: { detectorId: 'cost.session-usage-limits' },
        facts: {
          rollingWindowHours: 5,
          hasWeeklyLimit: true,
        },
      });

      expect(sourceForExternalGuidance(guidance[0].source)?.label).toBe(
        'Anthropic Support'
      );
      expect(externalGuidanceRef(guidance[0])).toEqual({
        label: 'How do usage and length limits work?',
        url: snapshot.url,
        source: 'Anthropic Support',
        trustTier: 'first-party',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a source URL outside the registry allowlist', () => {
    expect(() =>
      parseExternalGuidanceSnapshot({
        ...snapshot,
        url: 'https://support.claude.com.evil.example/en/articles/11647753-how-do-usage-and-length-limits-work',
      })
    ).toThrow(ExternalGuidanceParseError);
  });

  it('reads the committed Anthropic usage-limits snapshot with session and weekly facts', () => {
    const dir = fileURLToPath(new URL('../../data/external-guidance', import.meta.url));
    const guidance = readExternalGuidanceSnapshots(dir);
    const usageLimits = guidance.find((entry) => entry.id === 'anthropic-usage-limits');

    expect(usageLimits).toBeDefined();
    expect(usageLimits?.url).toBe(
      'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work'
    );
    expect(usageLimits?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(usageLimits?.facts).toMatchObject({
      rollingWindowHours: 5,
      hasWeeklyLimit: true,
    });
  });
});
