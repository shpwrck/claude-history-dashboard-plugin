// #2071 (epic #1474): a recs request must assemble the ~128 MB dataset ONCE and
// reuse it for both the recs build and the suppression-transition emit, instead
// of assembling it twice. The reuse is plumbed by an optional `dataset` param on
// assembleRecommendations / assembleRecommendationResult / recordSuppressionTransitions
// (-> assembleRecommendationContext). These tests prove that param is:
//   (1) HONORED — the provided dataset drives the output (an injected dataset
//       with no sessions yields different recs than the real corpus), so a
//       request can assemble once and pass the result in; and
//   (2) EQUIVALENT — injecting a freshly-assembled dataset produces recs
//       byte-identical to letting the function assemble internally, so the
//       reuse changes nothing about the served output.
//
// Fixture mirrors session-blob-cache-parity.test.mjs: a throwaway
// $HOME/.claude/projects with real transcripts so the signal parsers produce
// non-empty per-session rows. HOME + CHD_DB_PATH are read at ingest module load,
// so they MUST be set before the dynamic import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function assistantLine({ text, toolName, toolInput, ts, model }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, input: toolInput },
      ],
    },
  });
}

function userLine(text, ts) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
}

function sessionJsonl(spec) {
  return [userLine(spec.prompt, spec.ts), assistantLine(spec)].join('\n') + '\n';
}

const SESSIONS = {
  'sess-alpha': {
    prompt: 'do the alpha thing',
    text: 'Here is the alpha answer.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.txt' },
    ts: '2026-01-01T00:00:00.000Z',
    model: 'claude-opus-4',
  },
  'sess-beta': {
    prompt: 'do the beta thing',
    text: 'Beta result computed.',
    toolName: 'Bash',
    toolInput: { command: 'ls /tmp' },
    ts: '2026-01-02T00:00:00.000Z',
    model: 'claude-sonnet-4',
  },
};

function buildFixtureHome() {
  const home = join(tmpdir(), `chd-2071-home-${randomUUID()}`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });
  for (const [sid, spec] of Object.entries(SESSIONS)) {
    writeFileSync(join(proj, `${sid}.jsonl`), sessionJsonl(spec));
  }
  return home;
}

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-2071-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

test('assembleRecommendations honors an injected dataset and is equivalent to an internal assemble (#2071)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = buildFixtureHome();
  try {
    const ingest = await loadIngest(home);
    ingest.ingest();

    const dataset = ingest.assembleDataset();
    assert.ok(dataset.entries.length > 0, 'fixture produced a non-empty dataset');

    // Assert on the full result (recommendations + domainCoverage). domainCoverage
    // is the robust observable: it is non-empty even when a tiny synthetic corpus
    // fires zero recommendations, and its PROVE/INFER/CANNOT_SEE status per domain
    // is derived from the dataset's signal inputs.
    const internal = ingest.assembleRecommendationResult();
    assert.ok(internal.domainCoverage.length > 0, 'domainCoverage computed from the dataset');

    // (2) EQUIVALENT: injecting a freshly-assembled dataset == assembling internally.
    const injected = ingest.assembleRecommendationResult(undefined, { dataset });
    assert.deepEqual(
      injected,
      internal,
      'injecting the freshly-assembled dataset yields an identical result'
    );

    // (1) HONORED: an injected dataset with every signal array emptied drives
    // DIFFERENT coverage (e.g. `cost` flips PROVE->CANNOT_SEE once tokenData is
    // gone) — proving the provided object is consumed, not silently re-assembled
    // from module state. Emptying arrays (not deleting keys) keeps it a valid,
    // no-data dataset the engine already handles.
    const emptied = Object.fromEntries(
      Object.entries(dataset).map(([k, v]) => [k, Array.isArray(v) ? [] : v])
    );
    const overEmpty = ingest.assembleRecommendationResult(undefined, { dataset: emptied });
    assert.notDeepEqual(
      overEmpty.domainCoverage,
      internal.domainCoverage,
      'an injected all-empty dataset must change domain coverage (param is consumed)'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});
