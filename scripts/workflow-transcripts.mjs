// Single source of truth for the SECOND merge level (#636): the per-agent
// transcripts of a Workflow-tool run, written under
//   <proj>/<sessionId>/subagents/workflows/<runId>/agent-*.jsonl
//
// The one-level subagent merge (readMergedSession in server.mjs, listSessions
// in ingest.mjs) reads only <sessionId>/subagents/*.jsonl and never recurses,
// so workflow-agent token usage, tool calls, and failures reach no parser and
// never reconcile with the Tokens/Cost tab. This helper enumerates those nested
// transcripts so both merge sites can fold them into the parent session.
//
// Scope is deliberately narrow:
//   - ONLY `agent-*.jsonl` (the message-level transcripts, same schema as a
//     normal session/subagent file — assistant lines carry `message.usage`, so
//     the existing per-`msg.id` max-merge in parse-sessions dedups them and no
//     token is double-counted even if a file is enumerated twice).
//   - NOT `journal.jsonl` (the run's orchestration log — a different event
//     shape with no `usage`; merging it would inject foreign lines into every
//     `c.merged` parser for no token/tool signal).
//   - NOT the `agent-*.meta.json` sidecars (not `.jsonl`).
import { opendirSync } from 'node:fs';
import { join } from 'node:path';

function normalizeMaxEntries(maxEntries) {
  const parsed = Number(maxEntries);
  if (!Number.isFinite(parsed)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(parsed));
}

function readDirentsBounded(dirPath, maxEntries) {
  const entries = [];
  let dir;
  try {
    dir = opendirSync(dirPath);
  } catch {
    return { entries, truncated: false, missing: true };
  }
  const limit = Math.max(1, maxEntries);
  let checked = 0;
  let truncated = false;
  try {
    for (;;) {
      const ent = dir.readSync();
      if (!ent) break;
      if (checked >= limit) {
        truncated = true;
        break;
      }
      checked += 1;
      entries.push(ent);
    }
  } finally {
    dir.closeSync();
  }
  return { entries, truncated, missing: false };
}

function discoveryReadLimit(outputLimit) {
  if (outputLimit === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return Math.max(1024, outputLimit + 1);
}

// Given a session's `subagents/` directory, return the absolute paths of every
// nested workflow-agent transcript, sorted for deterministic merge order.
// Best-effort: any unreadable dir yields [] rather than throwing, mirroring the
// tolerance of the one-level merge it extends. Uses `withFileTypes` (like
// listSessions / read-workflows / artifactSignature) so the run-dir check costs
// no extra stat — and so a symlinked run dir is skipped rather than followed
// out of the projects tree.
export function listNestedWorkflowAgentTranscripts(
  subagentsDir,
  { maxEntries = Number.MAX_SAFE_INTEGER } = {}
) {
  const limit = normalizeMaxEntries(maxEntries);
  const wfRoot = join(subagentsDir, 'workflows');
  const dirReadLimit = discoveryReadLimit(limit);
  const runRead = readDirentsBounded(wfRoot, dirReadLimit);
  if (runRead.missing) {
    return { paths: [], truncated: false, limit }; // no workflows/ dir (the common case) or unreadable
  }
  let truncated = runRead.truncated;
  const out = [];
  const runDirNames = runRead.entries
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort();
  for (const runDirName of runDirNames) {
    if (out.length >= limit) {
      return { paths: out, truncated: true, limit };
    }
    const runDir = join(wfRoot, runDirName);
    const fileRead = readDirentsBounded(
      runDir,
      discoveryReadLimit(limit - out.length)
    );
    if (fileRead.missing) continue; // skip unreadable run dir
    if (fileRead.truncated) truncated = true;
    const agentFiles = fileRead.entries
      .filter(
        (f) => f.isFile() && f.name.startsWith('agent-') && f.name.endsWith('.jsonl')
      )
      .map((f) => f.name)
      .sort();
    for (const name of agentFiles) {
      if (out.length >= limit) {
        return { paths: out, truncated: true, limit };
      }
      out.push(join(runDir, name));
    }
  }
  return { paths: out, truncated, limit };
}

export function nestedWorkflowAgentTranscripts(subagentsDir) {
  return listNestedWorkflowAgentTranscripts(subagentsDir).paths;
}
