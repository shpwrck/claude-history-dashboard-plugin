import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExternalGuidanceParseError,
  externalGuidanceRef,
  isAllowedUrl,
  parseExternalGuidanceSnapshot,
  readExternalGuidanceSnapshots,
  SOURCE_REGISTRY,
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
  target: { detectorId: 'reliability.rate-limits' },
  facts: {
    rollingWindowHours: 5,
    hasWeeklyLimit: true,
  },
  pages: [
    {
      url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
      title: 'How do usage and length limits work?',
      contentHash: 'sha256:def456',
      content: 'Usage limits reset every five hours.',
    },
  ],
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
        target: { detectorId: 'reliability.rate-limits' },
        facts: {
          rollingWindowHours: 5,
          hasWeeklyLimit: true,
        },
        // Per-page provenance (#1407) — parsed WITHOUT the bulky content field.
        pages: [
          {
            url: snapshot.pages[0].url,
            title: snapshot.pages[0].title,
            contentHash: 'sha256:def456',
          },
        ],
      });
      expect(guidance[0].pages?.[0]).not.toHaveProperty('content');

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

  it('rejects a page URL outside the registry allowlist', () => {
    expect(() =>
      parseExternalGuidanceSnapshot({
        ...snapshot,
        pages: [
          {
            url: 'https://evil.example/en/articles/123',
            contentHash: 'sha256:def456',
          },
        ],
      })
    ).toThrow(ExternalGuidanceParseError);
  });

  it('reads the committed Anthropic usage-limits snapshot with per-page provenance', () => {
    const dir = fileURLToPath(new URL('../../data/external-guidance', import.meta.url));
    const guidance = readExternalGuidanceSnapshots(dir);
    const usageLimits = guidance.find((entry) => entry.id === 'anthropic-usage-limits');

    expect(usageLimits).toBeDefined();
    expect(usageLimits?.url).toBe(
      'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work'
    );
    expect(usageLimits?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The attach target must be resolvable (the registry-resolution test in
    // external-guidance-registry.test.ts pins it against the detector catalog).
    expect(usageLimits?.target.detectorId).toBe('reliability.rate-limits');
    // Shape only — fact VALUES are regex-extracted from scraped prose and
    // re-ingested on upstream drift, so pinning them here would redden CI on
    // an automated refresh (see the inline-fixture extractor tests instead).
    for (const page of usageLimits?.pages ?? []) {
      expect(page.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(usageLimits?.pages?.length).toBeGreaterThanOrEqual(1);
  });
});

describe('isAllowedUrl (#1407 — shared write-path predicate)', () => {
  const source = SOURCE_REGISTRY[0];

  it('accepts urls under an allowed prefix', () => {
    expect(
      isAllowedUrl('https://support.claude.com/en/articles/123-anything', source)
    ).toBe(true);
  });

  it('rejects host suffix tricks, protocol downgrades, ports, and other paths', () => {
    expect(
      isAllowedUrl(
        'https://support.claude.com.evil.example/en/articles/123',
        source
      )
    ).toBe(false);
    expect(
      isAllowedUrl('http://support.claude.com/en/articles/123', source)
    ).toBe(false);
    expect(
      isAllowedUrl('https://support.claude.com:8443/en/articles/123', source)
    ).toBe(false);
    expect(isAllowedUrl('https://support.claude.com/fr/articles/123', source)).toBe(
      false
    );
    expect(isAllowedUrl('not a url', source)).toBe(false);
  });
});
