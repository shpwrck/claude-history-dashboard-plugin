#!/usr/bin/env node
// Fetch registered external guidance sources into committed, static snapshots.
// No dashboard runtime path calls this script; recommendation rendering only
// reads the JSON files produced under data/external-guidance/.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./register-ts.mjs');

const {
  parseExternalGuidanceSnapshot,
  sourceForExternalGuidance,
} = await import('../src/lib/parse-external-guidance.ts');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT_DIR = join(ROOT, 'data', 'external-guidance');

export const GUIDANCE_ARTICLES = [
  {
    id: 'anthropic-usage-limits',
    source: 'anthropic-support',
    url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
    // The primary article links to this best-practices page for usage-limit
    // strategy; Anthropic currently states the concrete five-hour/weekly facts
    // there, so the snapshot records it as supporting content for fact extraction.
    factUrls: [
      'https://support.claude.com/en/articles/9797557-usage-limit-best-practices',
    ],
    target: { detectorId: 'cost.session-usage-limits' },
    suggestion: 'Review first-party Claude usage and length limit guidance.',
  },
];

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html, fallback) {
  const h1 = String(html ?? '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return htmlToText(h1[1]);
  const title = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return htmlToText(title[1]).replace(/\s*\|\s*Claude Help Center\s*$/i, '');
  return fallback;
}

export function extractUsageLimitFacts(text) {
  const normalized = String(text ?? '').toLowerCase();
  const facts = {};
  if (/\b(?:five-hour|5-hour)\b/.test(normalized) || /every five hours/.test(normalized)) {
    facts.rollingWindowHours = 5;
  }
  if (/\bweekly usage limit\b/.test(normalized) || /\bweekly limits\b/.test(normalized)) {
    facts.hasWeeklyLimit = true;
  }
  if (
    normalized.includes('claude.ai') &&
    normalized.includes('claude code') &&
    normalized.includes('claude desktop') &&
    normalized.includes('same usage limit')
  ) {
    facts.sharedAcrossSurfaces = true;
  }
  if (/\b200k tokens\b/.test(normalized) || /\b200,000 tokens\b/.test(normalized)) {
    facts.contextWindowTokens = 200000;
  }
  return facts;
}

function snapshotPath(article) {
  return join(SNAPSHOT_DIR, `${article.id}.json`);
}

async function readExistingSnapshot(article) {
  try {
    return JSON.parse(await readFile(snapshotPath(article), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function assertAllowedUrl(sourceId, url) {
  const source = sourceForExternalGuidance(sourceId);
  if (!source) throw new Error(`Unknown guidance source: ${sourceId}`);
  const parsed = new URL(url);
  const allowed = source.allowedUrlPrefixes.some((prefix) => {
    const p = new URL(prefix);
    return (
      parsed.protocol === p.protocol &&
      parsed.hostname === p.hostname &&
      parsed.port === p.port &&
      parsed.pathname.startsWith(p.pathname)
    );
  });
  if (!allowed) throw new Error(`${url} is outside ${sourceId}'s allowlist`);
}

async function fetchText(url, existing) {
  const headers = {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'claude-history-dashboard-guidance-ingest/0.1',
  };
  if (existing?.etag) headers['if-none-match'] = existing.etag;
  if (existing?.lastModified) headers['if-modified-since'] = existing.lastModified;

  const response = await fetch(url, { headers });
  if (response.status === 304) {
    return { status: 304, text: null, etag: existing?.etag, lastModified: existing?.lastModified };
  }
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return {
    status: response.status,
    text: await response.text(),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

function renderSnapshotContent(pages) {
  return `${pages
    .map(
      (page) =>
        `# Source: ${page.url}\n\nTitle: ${page.title}\n\n${page.text.trim()}`
    )
    .join('\n\n---\n\n')}\n`;
}

async function buildSnapshot(article, existing, now = new Date()) {
  assertAllowedUrl(article.source, article.url);
  for (const url of article.factUrls ?? []) assertAllowedUrl(article.source, url);

  const primary = await fetchText(article.url, existing);
  if (primary.status === 304 && existing) return { changed: false, snapshot: existing };

  const primaryText = htmlToText(primary.text);
  const pages = [
    {
      url: article.url,
      title: extractTitle(primary.text, article.id),
      text: primaryText,
    },
  ];

  for (const url of article.factUrls ?? []) {
    const fetched = await fetchText(url, null);
    pages.push({
      url,
      title: extractTitle(fetched.text, url),
      text: htmlToText(fetched.text),
    });
  }

  const content = renderSnapshotContent(pages);
  const contentHash = sha256(content);
  if (existing?.contentHash === contentHash) {
    return { changed: false, snapshot: existing };
  }

  const snapshot = {
    id: article.id,
    source: article.source,
    url: article.url,
    fetchedAt: now.toISOString(),
    ...(primary.etag ? { etag: primary.etag } : {}),
    ...(primary.lastModified ? { lastModified: primary.lastModified } : {}),
    contentHash,
    title: pages[0].title,
    suggestion: article.suggestion,
    target: article.target,
    facts: extractUsageLimitFacts(content),
    content,
  };
  parseExternalGuidanceSnapshot(snapshot);
  return { changed: true, snapshot };
}

async function writeSnapshot(article, snapshot) {
  const path = snapshotPath(article);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export async function ingestGuidance({ now = new Date() } = {}) {
  const results = [];
  for (const article of GUIDANCE_ARTICLES) {
    const existing = await readExistingSnapshot(article);
    const result = await buildSnapshot(article, existing, now);
    if (result.changed) await writeSnapshot(article, result.snapshot);
    results.push({ id: article.id, changed: result.changed, contentHash: result.snapshot.contentHash });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await ingestGuidance();
  const changed = results.filter((result) => result.changed);
  if (changed.length === 0) {
    console.log('No guidance drift.');
  } else {
    for (const result of changed) {
      console.log(`Updated ${result.id} (${result.contentHash}).`);
    }
  }
}
