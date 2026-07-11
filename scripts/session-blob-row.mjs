// Pure per-session parse row builder for ingest.mjs and the #855 worker
// prototype. No SQLite is opened here: callers get the exact session_blob row
// columns and can decide whether/how to persist them.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_BLOB_OUTPUT } from './lib/parser-output-versions.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(PROJECT_DIR, 'src', 'lib');
const READ_CHUNK_BYTES = 65_536;
const DEFAULT_MAX_BYTES = 67_108_864;
// The session_blob cache key consumes the session-blob output version from the
// single parser-output -> cache-invalidation SEAM (#2075):
// scripts/lib/parser-output-versions.mjs. Bump it THERE (and update its
// contract fingerprint) whenever parse-sessions / a signal parser changes its
// OUTPUT shape, or a signal column changes in src/lib/signals/index.ts — the
// forward-fence test fails if the output shape drifts without the bump. This is
// the gate for the session_blob rows that feed the dataset + recommendations —
// NOT ingest.mjs's PARSER_SIG_VERSION, which only keys the per-session
// transcript cache (sigOf/getTranscript).
//
// Version history (rationale stays here; the live value lives in the seam):
//   'project-backstop-v1' (#1765): parseSessionJsonl backstops tokenData.project
//       from the transcript cwd.
//   'rmrf-certainty-v2' (#2036): parse-tools deriveBashCommandSignals now emits
//       commandDangerousCertainty + commandDangerousFragment; without this bump
//       the cached blobs keep the old toolData and the dangerous-bypass fix stays
//       inert on deploy (only a manual cache wipe picked it up).
//   'cmd-skeleton-v3' (#2039): dangerous-command matchers now run on the
//       executable skeleton (heredoc/quoted/inline-script bodies stripped), so a
//       blob reparse is needed to drop substring false positives.
//   'force-with-lease-v4' (#2042): git push --force pattern no longer matches the
//       safe --force-with-lease / --force-if-includes variants; reparse to drop
//       them from the dangerous-command set.
//   'tool-use-id-v5' (#1928): TokenEntry now carries toolUseIds + toolResultBytes
//       (the ID linkage from assistant tool_use.id <-> user tool_result.tool_use_id),
//       enabling ID-based per-tool cost attribution; reparse so cached blobs gain
//       the linkage instead of shipping the change inert.
//   'context-composition-v6' (#1926): TokenEntry now carries contextHistoryTokens
//       + contextToolResultTokens (per-turn input-context composition snapshots);
//       reparse so cached blobs gain the bucket fields the composition view needs
//       instead of shipping the change inert.
//   'value-flow-slim-v7' (#2108): parseValueFlow now emits slim edges
//       ({ value, sourceToolUseId, targetToolUseId }) — the dropped
//       sessionId/source/target/confidence/reason were redundant or constant and
//       made valueFlow the dataset's heaviest field (~21 MB, ~78% of it edge
//       redundancy). Reparse so cached blobs shed the fat edges instead of
//       serving the change inert.
//   'timeline-backgroundable-kind-v8' (#2238): parseSessionTimeline now sets
//       `backgroundableKind` on tool_use entries (a long-running Bash toolchain
//       invocation, or an Agent/Task/Workflow/Monitor/ScheduleWakeup call),
//       preserved through slimSessionTimeline. The timeline_json column shape
//       changes, so without this bump the cached blobs keep the old parse and the
//       conversational-availability detector stays dark on live data (and blind to
//       blocking Agent/Workflow calls). timeline_json gates the dataset's
//       input.timelines, which is what the recs detector reads — so THIS is the
//       knob that forces session_blob reparsing, not PARSER_SIG_VERSION (the
//       transcript-view cache). Because those rows also feed the separately
//       persisted dataset body, a meaning change must turn over that downstream
//       cache too.
//   'timeline-background-truth-v9' (#2246): Agent/Task/Workflow now set
//       `backgrounded` only from an explicit run_in_background flag; foreground
//       calls remain backgroundableKind=true but become countable blocking work.
//       Reparse timeline_json so cached v8 blobs do not preserve the old
//       tool-kind inference and keep conversational-availability dark. Dataset
//       schema v11 turns over persisted bodies assembled from those v8 rows.
const SESSION_BLOB_PARSER_VERSION = SESSION_BLOB_OUTPUT.version;

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
const { parseValueFlow } = await import(join(LIB, 'parse-value-flow.ts'));
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
  parseValueFlow,
  parseToolInventory,
  parseAssistantFeatures,
  parseDeceitSignals,
  parseTaskSuccess: (merged, topText, name, fallbackProject, title) =>
    parseTaskSuccess(merged, name, { topText, fallbackProject, title }),
  deriveEntries,
});

export function sessionFileSignature(session) {
  return [
    `parser:${SESSION_BLOB_PARSER_VERSION}`,
    ...[session.topPath, ...session.subPaths].map((p) => {
      try {
        const s = statSync(p);
        return `${p}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${p}:0:0`;
      }
    }),
  ]
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
  ch.update(session.sourceId ?? '');
  ch.update('\0');
  ch.update(session.harness ?? '');
  ch.update('\0');
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
