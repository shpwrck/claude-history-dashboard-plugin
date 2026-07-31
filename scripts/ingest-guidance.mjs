#!/usr/bin/env node
// Fetch registered external guidance sources into committed, static snapshots.
// No dashboard runtime path calls this script; recommendation rendering only
// reads the JSON files produced under data/external-guidance/.
//
// The article registry (which urls, which rec they attach to, which fact
// extractor runs) lives in src/lib/external-guidance-registry.ts (#1407) so
// the dashboard, the tests, and this script share one source of truth. The
// allowlist predicate is the lib's isAllowedUrl — a lib-side tightening
// reaches this write path.
//
// Provenance is per-page (#1407): every fetched page records its own url,
// contentHash, conditional-fetch metadata, and extracted text, so drift
// localizes to the page that changed and a 304 on the primary article can
// never mask drift on a fact-bearing supporting page (#1303).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

await import('./register-ts.mjs');

const {
  isAllowedUrl,
  parseExternalGuidanceSnapshot,
  renderExternalGuidanceContent,
  sourceForExternalGuidance,
} = await import('../src/lib/external-guidance.ts');
const { GUIDANCE_ARTICLES } = await import(
  '../src/lib/external-guidance-registry.ts'
);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT_DIR = join(ROOT, 'data', 'external-guidance');

// A snapshot whose CONTENT has not changed in this long is flagged in the run
// report. fetchedAt records the last content change (a clean revalidation
// does not advance it), so "stale" means "long-unchanged: worth a manual
// glance that the article still exists and the registry still points at the
// right place" — informational only, never fails the run.
export const STALE_AFTER_DAYS = 45;

// Ceiling on a single fetched guidance page (#3088). These are HTML support
// articles — tens of KiB of prose — so 5 MiB is orders of magnitude of headroom
// for a real page while refusing to pull an accidentally- or maliciously-huge
// response into memory and hand it to htmlToText. Overridable for tests and
// operators via DASHBOARD_GUIDANCE_PAGE_MAX_BYTES.
export const GUIDANCE_PAGE_MAX_BYTES = (() => {
  const raw = process.env.DASHBOARD_GUIDANCE_PAGE_MAX_BYTES;
  const parsed = raw == null || raw === '' ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 1024 * 1024;
})();

/** Stable code on the error thrown when a page exceeds its byte budget. */
export const GUIDANCE_PAGE_TOO_LARGE_CODE = 'ERR_GUIDANCE_PAGE_TOO_LARGE';

function guidancePageTooLargeError(url, maxBytes, observed) {
  const err = new Error(
    `Guidance page exceeds the ${maxBytes}-byte limit: ${url}` +
      (observed != null ? ` (declared ${observed} bytes)` : '')
  );
  err.code = GUIDANCE_PAGE_TOO_LARGE_CODE;
  err.maxBytes = maxBytes;
  return err;
}

/**
 * Read a fetch Response body as UTF-8 text, refusing to buffer more than
 * `maxBytes` (#3088).
 *
 * `response.text()` reads to EOF, so a huge or hostile page was slurped whole
 * before anyone could object. This instead:
 *   1. rejects up front when a declared Content-Length already exceeds the
 *      budget — no body byte is read at all;
 *   2. streams `response.body` chunk-by-chunk, aborting (and cancelling the
 *      stream) the moment the running total passes the budget, so an oversized
 *      body is never fully materialized;
 *   3. falls back to `response.text()` only when no readable stream is present
 *      (minimal/test doubles), still enforcing the cap on the decoded length as
 *      a backstop.
 *
 * @throws an error with code {@link GUIDANCE_PAGE_TOO_LARGE_CODE} when the body
 *         is over budget.
 */
export async function readResponseTextCapped(response, maxBytes, url) {
  const declaredRaw = response.headers?.get?.('content-length');
  const declared = declaredRaw == null ? NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw guidancePageTooLargeError(url, maxBytes, declared);
  }

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength ?? value.length ?? 0;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort abort */
        }
        throw guidancePageTooLargeError(url, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // No stream available (a minimal Response double). Enforce the cap on the
  // decoded text so the budget still holds, even though this path cannot abort
  // mid-transfer.
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw guidancePageTooLargeError(url, maxBytes);
  }
  return text;
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

const NAMED_ENTITIES = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  amp: '&',
};

// SINGLE pass: each source-text entity decodes exactly once, so escaped text
// like "&amp;lt;" or its numeric twin "&#38;lt;" can never double-decode into
// a real "<" (sequential replace chains re-scan their own output).
function decodeHtmlEntities(text) {
  return text.replace(
    /&(nbsp|lt|gt|quot|amp|#\d+|#x[0-9a-f]+);/gi,
    (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        return safeCodePoint(match, parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith('#')) {
        return safeCodePoint(match, Number(lower.slice(1)));
      }
      return NAMED_ENTITIES[lower] ?? match;
    }
  );
}

// A single malformed numeric entity (e.g. "&#1114112;") must not abort the
// whole ingest run with a RangeError — keep the original text instead.
function safeCodePoint(original, codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

export function htmlToText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      // Comments first: a comment containing ">" would otherwise leak its
      // tail into the text when the generic tag-strip eats up to the first ">".
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html, fallback) {
  const h1 = String(html ?? '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return htmlToText(h1[1]);
  const title = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return htmlToText(title[1]).replace(/\s*\|\s*Claude Help Center\s*$/i, '');
  return fallback;
}

function snapshotPath(snapshotDir, article) {
  return join(snapshotDir, `${article.id}.json`);
}

async function readExistingSnapshot(snapshotDir, article) {
  try {
    return JSON.parse(await readFile(snapshotPath(snapshotDir, article), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function assertAllowedUrl(sourceId, url, context) {
  const source = sourceForExternalGuidance(sourceId);
  if (!source) throw new Error(`Unknown guidance source: ${sourceId}`);
  if (!isAllowedUrl(url, source)) {
    throw new Error(`${url} is outside ${sourceId}'s allowlist (${context})`);
  }
}

/**
 * Conditionally fetch one page. `existingPage` supplies the prior etag /
 * last-modified / content so a 304 (or unchanged content) reuses the page
 * verbatim WITHOUT masking the other pages — every page is revalidated on
 * every run (#1303: the old top-level 304 short-circuit skipped factUrls
 * entirely, making fact-page drift structurally invisible once an etag
 * persisted).
 */
async function fetchPage(article, url, existingPage, now, fetchImpl) {
  assertAllowedUrl(article.source, url, 'registry');
  const headers = {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'claude-history-dashboard-guidance-ingest/0.2',
  };
  if (existingPage?.etag) headers['if-none-match'] = existingPage.etag;
  if (existingPage?.lastModified) {
    headers['if-modified-since'] = existingPage.lastModified;
  }

  const response = await fetchImpl(url, { headers });
  if (response.status === 304 && existingPage) {
    return { changed: false, page: existingPage };
  }
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  // fetch follows redirects; the allowlist must hold for the FINAL url too,
  // or off-allowlist content could land stamped as first-party.
  if (response.url) {
    assertAllowedUrl(article.source, response.url, `redirect target of ${url}`);
  }

  const html = await readResponseTextCapped(response, GUIDANCE_PAGE_MAX_BYTES, url);
  const content = htmlToText(html);
  const contentHash = sha256(content);
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  if (existingPage?.contentHash === contentHash) {
    // Same bytes, possibly fresher validators — carry them without flagging drift.
    return {
      changed: false,
      page: {
        ...existingPage,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      },
    };
  }
  return {
    changed: true,
    page: {
      url,
      title: extractTitle(html, url),
      fetchedAt: now.toISOString(),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      contentHash,
      content,
    },
  };
}

export async function buildSnapshot(article, existing, now, fetchImpl) {
  const urls = [article.url, ...(article.factUrls ?? [])];
  const existingPages = new Map(
    (existing?.pages ?? []).map((page) => [page.url, page])
  );

  const pages = [];
  const changedPages = [];
  for (const url of urls) {
    const result = await fetchPage(
      article,
      url,
      existingPages.get(url) ?? null,
      now,
      fetchImpl
    );
    pages.push(result.page);
    if (result.changed) changedPages.push(url);
  }
  // A page dropped from the registry is drift too (the combined hash moves).
  const pageSetChanged =
    (existing?.pages ?? []).length !== pages.length ||
    pages.some((page, i) => existing?.pages?.[i]?.url !== page.url);

  const content = renderExternalGuidanceContent(pages);
  const contentHash = sha256(content);
  if (existing?.contentHash === contentHash && !pageSetChanged) {
    return { changed: false, changedPages: [], snapshot: existing };
  }

  const snapshot = {
    id: article.id,
    source: article.source,
    url: article.url,
    fetchedAt: now.toISOString(),
    contentHash,
    title: pages[0].title,
    suggestion: article.suggestion,
    target: article.target,
    // Per-article fact extraction (#1407): only an article that registered an
    // extractor gets facts stamped — never a global pass over boilerplate.
    ...(article.extractFacts ? { facts: article.extractFacts(content) } : {}),
    pages,
  };
  // Validate future-skew against the acquisition clock passed into this build,
  // not a second wall-clock read (keeps scripted/fake-clock ingestion exact).
  parseExternalGuidanceSnapshot(snapshot, now.getTime());
  return { changed: true, changedPages, snapshot };
}

async function writeSnapshot(snapshotDir, article, snapshot) {
  const path = snapshotPath(snapshotDir, article);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function ageDays(isoTimestamp, now) {
  const ms = now.getTime() - Date.parse(isoTimestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

export async function ingestGuidance({
  now = new Date(),
  fetchImpl = fetch,
  snapshotDir = SNAPSHOT_DIR,
  articles = GUIDANCE_ARTICLES,
} = {}) {
  const results = [];
  for (const article of articles) {
    const existing = await readExistingSnapshot(snapshotDir, article);
    const result = await buildSnapshot(article, existing, now, fetchImpl);
    if (result.changed) await writeSnapshot(snapshotDir, article, result.snapshot);
    const days = ageDays(result.snapshot.fetchedAt, now);
    results.push({
      id: article.id,
      changed: result.changed,
      changedPages: result.changedPages,
      contentHash: result.snapshot.contentHash,
      fetchedAt: result.snapshot.fetchedAt,
      ageDays: days,
      stale: days != null && days > STALE_AFTER_DAYS,
    });
  }
  return results;
}

/**
 * Drift/staleness report (#1303): which snapshots changed (and which pages
 * localized the drift), and which have not changed in over STALE_AFTER_DAYS.
 * Plain characters only — this lands in Actions logs and PR bodies.
 */
export function formatGuidanceReport(results) {
  const lines = [];
  const changed = results.filter((r) => r.changed);
  const stale = results.filter((r) => !r.changed && r.stale);
  lines.push(
    changed.length === 0
      ? 'No guidance drift.'
      : `Drift detected in ${changed.length} snapshot(s):`
  );
  for (const r of changed) {
    lines.push(`  ${r.id} (${r.contentHash})`);
    for (const url of r.changedPages) lines.push(`    changed page: ${url}`);
  }
  if (stale.length > 0) {
    lines.push(`Stale snapshots (unchanged for over ${STALE_AFTER_DAYS} days):`);
    for (const r of stale) {
      lines.push(`  ${r.id} (last refreshed ${r.fetchedAt}, ${r.ageDays} days ago)`);
    }
  }
  return lines.join('\n');
}

function isRunAsMain() {
  // pathToFileURL(realpathSync(...)) survives symlinks, percent-encoded paths,
  // and Windows separators where a bare string compare silently no-ops.
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  const results = await ingestGuidance();
  console.log(formatGuidanceReport(results));
}
