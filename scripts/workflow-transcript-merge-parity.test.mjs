// Regression harness for #636: nested Workflow-tool agent transcripts
// (subagents/workflows/<runId>/agent-*.jsonl) are merged into the parent
// session so their token spend reaches the Tokens/Cost dataset and reconciles
// with the parent. Run under the ts-resolver loader (ingest pulls .ts parsers):
//   node --import ./scripts/register-ts.mjs --test scripts/workflow-transcript-merge-parity.test.mjs
//
// What it proves:
//   (a) DISCOVERY. nestedWorkflowAgentTranscripts() finds agent-*.jsonl under
//       subagents/workflows/<runId>/, excludes journal.jsonl + .meta.json, and
//       is deterministic (sorted).
//   (b) MERGE + ATTRIBUTION. A full ingest()->assembleDataset() over a fixture
//       with a top-level session + a one-level subagent + a nested workflow
//       agent attributes ALL THREE tiers' tokens to the parent session's
//       tokenData row (the workflow-agent output is no longer invisible).
//   (c) IDEMPOTENT. The per-msg.id max-merge means enumerating the same nested
//       transcript can't double-count: a session whose ONLY assistant usage is
//       a workflow agent totals exactly that agent's tokens, not a multiple.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  listNestedWorkflowAgentTranscripts,
  nestedWorkflowAgentTranscripts,
} from './workflow-transcripts.mjs';

// One assistant turn carrying a usage block with a known output-token count.
function assistantUsageLine({ id, out, text }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: out },
    },
  });
}

function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

// Build a throwaway ~/.claude with one project, one parent session, one
// one-level subagent, and one nested workflow run holding two agent transcripts
// (+ a journal.jsonl and a .meta.json that MUST be ignored).
function buildFixtureHome() {
  const home = join(tmpdir(), `chd-636-home-${randomUUID()}`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  const sid = 'sess-parent';
  const sessDir = join(proj, sid);
  const saDir = join(sessDir, 'subagents');
  const runDir = join(saDir, 'workflows', 'wf_abc');
  mkdirSync(runDir, { recursive: true });

  // Parent top-level transcript: 100 output tokens.
  writeFileSync(
    join(proj, `${sid}.jsonl`),
    [userLine('go'), assistantUsageLine({ id: 'top-1', out: 100, text: 'top' })].join('\n') + '\n'
  );
  // One-level Task subagent: 30 output tokens.
  writeFileSync(
    join(saDir, 'agent-task.jsonl'),
    assistantUsageLine({ id: 'sub-1', out: 30, text: 'sub' }) + '\n'
  );
  // Nested workflow agents: 7 + 13 output tokens.
  writeFileSync(
    join(runDir, 'agent-aaa.jsonl'),
    assistantUsageLine({ id: 'wf-a', out: 7, text: 'wfa' }) + '\n'
  );
  writeFileSync(
    join(runDir, 'agent-bbb.jsonl'),
    assistantUsageLine({ id: 'wf-b', out: 13, text: 'wfb' }) + '\n'
  );
  // Decoys that MUST NOT be merged.
  writeFileSync(
    join(runDir, 'journal.jsonl'),
    JSON.stringify({ type: 'workflow_phase', index: 1, title: 'X' }) + '\n'
  );
  writeFileSync(join(runDir, 'agent-aaa.meta.json'), JSON.stringify({ label: 'a' }));

  return { home, saDir, runDir, sid };
}

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-636-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function writeTopSession(home, projectName, sessionId) {
  const proj = join(home, '.claude', 'projects', projectName);
  mkdirSync(proj, { recursive: true });
  const lines = [
    userLine(`start ${sessionId}`),
    assistantUsageLine({ id: `${sessionId}-a`, out: 1, text: 'ok' }),
  ];
  writeFileSync(
    join(proj, `${sessionId}.jsonl`),
    lines.join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// (a) DISCOVERY
// ---------------------------------------------------------------------------
test('(a) nestedWorkflowAgentTranscripts: finds agent-*.jsonl, excludes journal + meta, sorted', () => {
  const fx = buildFixtureHome();
  try {
    const found = nestedWorkflowAgentTranscripts(fx.saDir);
    assert.deepEqual(found, [
      join(fx.runDir, 'agent-aaa.jsonl'),
      join(fx.runDir, 'agent-bbb.jsonl'),
    ]);
  } finally {
    cleanup(fx.home);
  }
});

test('(a2) empty when no workflows/ dir', () => {
  const home = join(tmpdir(), `chd-636-empty-${randomUUID()}`);
  const saDir = join(home, '.claude', 'projects', '-p', 's', 'subagents');
  mkdirSync(saDir, { recursive: true });
  try {
    assert.deepEqual(nestedWorkflowAgentTranscripts(saDir), []);
  } finally {
    cleanup(home);
  }
});

test('(a3) nested workflow transcript discovery reports capped lists', () => {
  const fx = buildFixtureHome();
  try {
    const found = listNestedWorkflowAgentTranscripts(fx.saDir, { maxEntries: 1 });
    assert.deepEqual(found.paths, [join(fx.runDir, 'agent-aaa.jsonl')]);
    assert.equal(found.truncated, true);
    assert.equal(found.limit, 1);
  } finally {
    cleanup(fx.home);
  }
});

// ---------------------------------------------------------------------------
// (b) MERGE + ATTRIBUTION
// ---------------------------------------------------------------------------
test('(b) parent tokenData sums top-level + one-level subagent + nested workflow agents', async () => {
  const fx = buildFixtureHome();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest(fx.home);
    ingest.ingest();
    const dataset = ingest.assembleDataset();
    const row = dataset.tokenData.find((t) => t.sessionId === fx.sid);
    assert.ok(row, 'parent session present in tokenData');
    // 100 (top) + 30 (subagent) + 7 + 13 (workflow agents) = 150
    assert.equal(row.totalOutputTokens, 150);
    assert.equal(row.messageCount, 4);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home);
  }
});

test('(b2) ingest skips sessions above the merged transcript part cap', async () => {
  const fx = buildFixtureHome();
  const origHome = process.env.HOME;
  const origPartCap = process.env.DASHBOARD_INGEST_SESSION_MAX_PARTS;
  try {
    process.env.DASHBOARD_INGEST_SESSION_MAX_PARTS = '2';
    const ingest = await loadIngest(fx.home);
    const stats = ingest.ingest();
    const dataset = ingest.assembleDataset();
    assert.equal(stats.skippedSessions, 1);
    assert.equal(dataset.tokenData.some((t) => t.sessionId === fx.sid), false);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origPartCap === undefined) delete process.env.DASHBOARD_INGEST_SESSION_MAX_PARTS;
    else process.env.DASHBOARD_INGEST_SESSION_MAX_PARTS = origPartCap;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home);
  }
});

test('(b3) ingest caps project directory discovery', async () => {
  const home = join(tmpdir(), `chd-636-project-cap-${randomUUID()}`);
  const origHome = process.env.HOME;
  const origProjectCap = process.env.DASHBOARD_INGEST_PROJECT_MAX_DIRS;
  try {
    writeTopSession(home, 'proj-a', 'sess-a');
    writeTopSession(home, 'proj-b', 'sess-b');
    process.env.DASHBOARD_INGEST_PROJECT_MAX_DIRS = '1';
    const ingest = await loadIngest(home);
    assert.equal(ingest.INGEST_PROJECT_MAX_DIRS, 1);

    const stats = ingest.ingest();
    assert.equal(stats.total, 1);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origProjectCap === undefined) delete process.env.DASHBOARD_INGEST_PROJECT_MAX_DIRS;
    else process.env.DASHBOARD_INGEST_PROJECT_MAX_DIRS = origProjectCap;
    delete process.env.CHD_DB_PATH;
    cleanup(home);
  }
});

test('(b4) ingest caps top-level session discovery', async () => {
  const home = join(tmpdir(), `chd-636-session-cap-${randomUUID()}`);
  const origHome = process.env.HOME;
  const origSessionCap = process.env.DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES;
  try {
    writeTopSession(home, 'proj-a', 'sess-a');
    writeTopSession(home, 'proj-a', 'sess-b');
    process.env.DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES = '1';
    const ingest = await loadIngest(home);
    assert.equal(ingest.INGEST_SESSION_DISCOVERY_MAX_ENTRIES, 1);

    const stats = ingest.ingest();
    assert.equal(stats.total, 1);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origSessionCap === undefined) delete process.env.DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES;
    else process.env.DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES = origSessionCap;
    delete process.env.CHD_DB_PATH;
    cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// (c) IDEMPOTENT (no double-count)
// ---------------------------------------------------------------------------
test('(c) two ingests over the unchanged corpus yield identical parent totals', async () => {
  const fx = buildFixtureHome();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest(fx.home);
    ingest.ingest();
    const first = ingest
      .assembleDataset()
      .tokenData.find((t) => t.sessionId === fx.sid).totalOutputTokens;
    ingest.ingest();
    const second = ingest
      .assembleDataset()
      .tokenData.find((t) => t.sessionId === fx.sid).totalOutputTokens;
    assert.equal(first, 150);
    assert.equal(second, 150);
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home);
  }
});
