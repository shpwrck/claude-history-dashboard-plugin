// Pure per-session parse row builder for ingest.mjs and the #855 worker
// prototype. No SQLite is opened here: callers get the exact session_blob row
// columns and can decide whether/how to persist them.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(PROJECT_DIR, 'src', 'lib');
const READ_CHUNK_BYTES = 65_536;
const DEFAULT_MAX_BYTES = 67_108_864;

const { parseSessionJsonl } = await import(join(LIB, 'parse-sessions.ts'));
const { parseToolUsage } = await import(join(LIB, 'parse-tools.ts'));
const { parseAssistantFeatures } = await import(
  join(LIB, 'parse-assistant-features.ts')
);
const { parseDeceitSignals } = await import(
  join(LIB, 'parse-deceit-signals.ts')
);
const { parseTaskSuccess } = await import(join(LIB, 'parse-task-success.ts'));
const { parseToolInventory } = await import(join(LIB, 'parse-tool-inventory.ts'));
const { parseSessionTimeline } = await import(join(LIB, 'parse-timeline.ts'));
const { parseApiErrors } = await import(join(LIB, 'parse-errors.ts'));
const { parsePermissionData } = await import(join(LIB, 'parse-permissions.ts'));
const { parseAgentSettings, parseAttribution } = await import(
  join(LIB, 'parse-agents.ts')
);
const { parseRuntimeEvents } = await import(join(LIB, 'parse-runtime-events.ts'));
const { parseChurnGeometry } = await import(join(LIB, 'parse-churn-geometry.ts'));
const { parseJsonl } = await import(join(LIB, 'parse-utils.ts'));
const { safeJsonStringify } = await import(join(LIB, 'json-safe.ts'));
const { parseSessionTitles } = await import(join(LIB, 'parse-titles.ts'));
const { makeSessionSignals } = await import(join(LIB, 'signals/index.ts'));

function ingestSessionTooLargeError(maxBytes) {
  const err = new Error(`Merged session exceeds ${maxBytes} byte limit`);
  err.code = 'ERR_DASHBOARD_INGEST_SESSION_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

function isIngestSessionTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_INGEST_SESSION_TOO_LARGE';
}

function readUtf8FileCappedSync(filePath, maxBytes, initialBytes = 0) {
  const fd = openSync(filePath, 'r');
  const chunks = [];
  let bytes = initialBytes;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw ingestSessionTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
  };
}

function readMergedSessionSync(session, topRead, maxBytes) {
  let merged = topRead.text;
  let mergedBytes = topRead.bytes;
  for (const subPath of session.subPaths) {
    try {
      const prefix = merged.length && !merged.endsWith('\n') ? '\n' : '';
      const prefixBytes = Buffer.byteLength(prefix, 'utf8');
      if (mergedBytes + prefixBytes > maxBytes) {
        throw ingestSessionTooLargeError(maxBytes);
      }
      const { text, bytes } = readUtf8FileCappedSync(
        subPath,
        maxBytes,
        mergedBytes + prefixBytes
      );
      if (prefix) merged += prefix;
      mergedBytes = bytes;
      merged += text;
    } catch (err) {
      if (isIngestSessionTooLargeError(err)) throw err;
      /* skip unreadable subagent file */
    }
  }
  return merged;
}

function textBlocksToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function deriveEntries(topText, sessionId, fallbackProject, title) {
  const entries = [];
  for (const o of parseJsonl(topText)) {
    if (o.type !== 'user' || o.isMeta || o.isSidechain || !o.message) continue;
    if (o.message.role && o.message.role !== 'user') continue;
    const text = textBlocksToString(o.message.content).trim();
    if (!text) continue;
    entries.push({
      display: text.length > 2000 ? text.slice(0, 2000) : text,
      pastedContents: {},
      timestamp: o.timestamp ? Date.parse(o.timestamp) : 0,
      project: o.cwd || fallbackProject,
      sessionId,
      ...(title ? { title } : {}),
    });
  }
  return entries;
}

export const SESSION_SIGNALS = makeSessionSignals({
  parseSessionJsonl,
  parseToolUsage,
  parseSessionTimeline,
  parseApiErrors,
  parsePermissionData,
  parseAgentSettings,
  parseAttribution,
  parseRuntimeEvents,
  parseChurnGeometry,
  parseToolInventory,
  parseAssistantFeatures,
  parseDeceitSignals,
  parseTaskSuccess: (merged, topText, name, fallbackProject, title) =>
    parseTaskSuccess(merged, name, { topText, fallbackProject, title }),
  deriveEntries,
});

export function sessionFileSignature(session) {
  return [session.topPath, ...session.subPaths]
    .map((p) => {
      try {
        const s = statSync(p);
        return `${p}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${p}:0:0`;
      }
    })
    .join('|');
}

export function parseSessionBlobRow({ session, sig, topText, merged }) {
  const name = `${session.sessionId}.jsonl`;
  const titleMap = parseSessionTitles(merged);
  const title = titleMap[session.sessionId] ?? null;
  const ctx = {
    merged,
    topText,
    name,
    sessionId: session.sessionId,
    project: session.project,
    title,
  };
  const values = {};
  const json = {};
  for (const signal of SESSION_SIGNALS) {
    values[signal.id] = signal.parse(ctx);
    json[signal.id] = safeJsonStringify(values[signal.id]);
  }

  const ch = createHash('sha1');
  ch.update(session.project ?? '');
  ch.update('\0');
  ch.update(title ?? '');
  ch.update('\0');
  for (const signal of SESSION_SIGNALS) {
    ch.update(json[signal.id]);
    ch.update('\0');
  }
  const contentHash = ch.digest('hex');

  const byColumn = {};
  for (const signal of SESSION_SIGNALS) byColumn[signal.column] = json[signal.id];
  byColumn.session_id = session.sessionId;
  byColumn.sig = sig;
  byColumn.project = session.project;
  byColumn.title = title;
  byColumn.content_hash = contentHash;
  return { byColumn, contentHash };
}

export function parseSessionBlobRowFromDisk(
  session,
  sig = sessionFileSignature(session),
  options = {}
) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const topRead = readUtf8FileCappedSync(session.topPath, maxBytes);
  const merged = readMergedSessionSync(session, topRead, maxBytes);
  return parseSessionBlobRow({
    session,
    sig,
    topText: topRead.text,
    merged,
  });
}
