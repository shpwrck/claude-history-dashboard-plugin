import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractBrevityFacts,
  extractUsageLimitFacts,
  GUIDANCE_ARTICLES,
  guidanceArticleById,
} from './external-guidance-registry';
import { renderExternalGuidanceContent } from './external-guidance';
import { DETECTORS } from './detectors';
import { emittableIdsFor } from './detectors/dual-emit';

const SNAPSHOT_DIR = fileURLToPath(
  new URL('../../data/external-guidance', import.meta.url)
);

interface RawPage {
  url: string;
  title?: string;
  contentHash: string;
  content: string;
}

interface RawSnapshot {
  id: string;
  source: string;
  url: string;
  contentHash: string;
  suggestion: string;
  target: Record<string, string>;
  pages: RawPage[];
}

function readRawSnapshots(): Map<string, RawSnapshot> {
  const out = new Map<string, RawSnapshot>();
  for (const name of readdirSync(SNAPSHOT_DIR)) {
    if (!name.endsWith('.json')) continue;
    const raw = JSON.parse(
      readFileSync(join(SNAPSHOT_DIR, name), 'utf8')
    ) as RawSnapshot;
    expect(name).toBe(`${raw.id}.json`);
    out.set(raw.id, raw);
  }
  return out;
}

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

describe('guidance registry resolution (#1302 regression)', () => {
  it('every detectorId target resolves to an id the engine can actually emit', () => {
    const emittable = new Set<string>();
    for (const d of DETECTORS) {
      for (const id of emittableIdsFor(d.id)) emittable.add(id);
    }
    for (const article of GUIDANCE_ARTICLES) {
      if (!article.target.detectorId) continue;
      expect(
        emittable.has(article.target.detectorId),
        `${article.id} targets ${article.target.detectorId}, which no detector emits — the reference could never attach (the original #1401 bug)`
      ).toBe(true);
    }
  });

  it('guidanceArticleById resolves registered ids and rejects unknown ones', () => {
    expect(guidanceArticleById('anthropic-usage-limits')?.url).toContain(
      'support.claude.com'
    );
    expect(guidanceArticleById('nope')).toBeUndefined();
  });
});

describe('registry <-> snapshot coverage (#1407)', () => {
  it('committed snapshots and the registry agree exactly', () => {
    const snapshots = readRawSnapshots();
    expect([...snapshots.keys()].sort()).toEqual(
      GUIDANCE_ARTICLES.map((a) => a.id).sort()
    );
    for (const article of GUIDANCE_ARTICLES) {
      const snapshot = snapshots.get(article.id);
      expect(snapshot, `missing snapshot for ${article.id} — run npm run ingest:guidance`).toBeDefined();
      if (!snapshot) continue;
      // The snapshot is DERIVED from the registry; any divergence means a
      // hand-edit that the next ingest run would silently revert.
      expect(snapshot.source).toBe(article.source);
      expect(snapshot.url).toBe(article.url);
      expect(snapshot.suggestion).toBe(article.suggestion);
      expect(snapshot.target).toEqual(article.target);
      expect(snapshot.pages.map((p) => p.url)).toEqual([
        article.url,
        ...(article.factUrls ?? []),
      ]);
    }
  });
});

describe('snapshot contentHash drift-guard (#1303)', () => {
  it('every committed page hash and combined hash match the committed content', () => {
    for (const [id, snapshot] of readRawSnapshots()) {
      for (const page of snapshot.pages) {
        expect(
          sha256(page.content),
          `${id}: contentHash of page ${page.url} does not match its content`
        ).toBe(page.contentHash);
      }
      expect(
        sha256(renderExternalGuidanceContent(snapshot.pages)),
        `${id}: top-level contentHash does not match the rendered pages`
      ).toBe(snapshot.contentHash);
    }
  });
});

describe('extractUsageLimitFacts (inline fixtures, decoupled from scraped prose)', () => {
  it('extracts the rolling window, weekly limit, shared surfaces, and context window', () => {
    expect(
      extractUsageLimitFacts(
        'Your five-hour session resets. Weekly limits apply. ' +
          'claude.ai, Claude Code, and Claude Desktop count towards the same usage limit. ' +
          'The context window is 200K tokens.'
      )
    ).toEqual({
      rollingWindowHours: 5,
      hasWeeklyLimit: true,
      sharedAcrossSurfaces: true,
      contextWindowTokens: 200000,
    });
  });

  it('extracts nothing from unrelated text', () => {
    expect(extractUsageLimitFacts('How to install the desktop app.')).toEqual({});
    expect(extractUsageLimitFacts('')).toEqual({});
  });

  it('matches alternate phrasings independently', () => {
    expect(extractUsageLimitFacts('limits reset every five hours')).toEqual({
      rollingWindowHours: 5,
    });
    expect(extractUsageLimitFacts('a weekly usage limit applies')).toEqual({
      hasWeeklyLimit: true,
    });
    expect(extractUsageLimitFacts('supports 200,000 tokens of context')).toEqual({
      contextWindowTokens: 200000,
    });
  });
});

describe('extractBrevityFacts (inline fixtures, decoupled from scraped prose)', () => {
  it('extracts the full set of brevity tactics from representative prose', () => {
    expect(
      extractBrevityFacts(
        'Budget models benefit from structured rather than conversational prompts. ' +
          'The four dimensions: Context, Task, Constraint, Output Format. ' +
          'Every token of social nicety is a token stolen from actual reasoning. ' +
          'Telegram Style: Omit articles, conjunctions, filler. ' +
          'Request minimal output, e.g. "Code only. No explanation." ' +
          'Words and Phrases to Eliminate add length. ' +
          'Sacrifice grammar before sacrificing precision.'
      )
    ).toEqual({
      preferStructuredPrompts: true,
      promptDimensions: 'context, task, constraint, output-format',
      dropSocialNiceties: true,
      telegramStyle: true,
      requestMinimalOutput: true,
      eliminateFillerPhrases: true,
      precisionOverGrammar: true,
    });
  });

  it('extracts nothing from unrelated text', () => {
    expect(extractBrevityFacts('How to install the desktop app.')).toEqual({});
    expect(extractBrevityFacts('')).toEqual({});
  });

  it('matches alternate phrasings independently', () => {
    expect(extractBrevityFacts('In follow-ups, avoid pleasantries.')).toEqual({
      dropSocialNiceties: true,
    });
    expect(extractBrevityFacts('Add "Code only. No explanation." to the prompt.')).toEqual({
      requestMinimalOutput: true,
    });
  });

  it('requires all four dimension keywords before claiming the dimensions fact', () => {
    // "four dimensions" alone, without the dimension vocabulary, must not match.
    expect(extractBrevityFacts('There are four dimensions to consider.')).toEqual(
      {}
    );
  });
});
