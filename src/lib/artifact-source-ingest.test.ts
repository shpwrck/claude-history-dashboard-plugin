// #1643 — artifact-source interface + multi-root aggregating ingest.
//
// Drives the real `scripts/ingest.mjs` through the register-ts loader (the same
// harness as hub-ingest.test.ts) to assert the four acceptance properties:
//   (1) the artifact-source interface backs every source-relative read;
//   (2) ingest merges >1 source root, tagging sessions + history with sourceId;
//   (3) two roots with distinct UUIDs aggregate collision-free with per-source
//       provenance;
//   (4) single-source output is unchanged (parity) — every row carries the
//       default sourceId and the default-only run matches its own baseline.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const nodeBin = process.execPath;

function line(entry: object): string {
  return JSON.stringify(entry);
}

function transcript(prompt: string, entrypoint = 'cli'): string {
  return [
    line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: `/repo/${prompt.replaceAll(/\W+/g, '-').toLowerCase()}`,
      entrypoint,
      message: { role: 'user', content: prompt },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      entrypoint,
      message: {
        id: `${prompt}-assistant`,
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');
}

function writeSession(
  projectsRoot: string,
  project: string,
  sessionId: string,
  body: string
): void {
  const dir = join(projectsRoot, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${body}\n`);
}

function historyEntry(sessionId: string, display: string): object {
  return {
    display,
    pastedContents: {},
    timestamp: 1735689600000,
    project: `/repo/${sessionId}`,
    sessionId,
  };
}

interface IngestResult {
  entries: Array<{
    sessionId: string;
    display: string;
    sourceId?: string;
    harness?: string;
  }>;
  sources: Array<{
    id: string;
    member?: string;
    displayName?: string;
    repo?: string;
  }>;
  sourceId: string;
}

// Run the real ingest with a given env and report the entries + source list.
function runIngest(env: Record<string, string>): IngestResult {
  const code = `
    import { ingest, assembleDataset } from './scripts/ingest.mjs';
    ingest();
    const dataset = assembleDataset();
    console.log(JSON.stringify({
      entries: dataset.entries.map(({ sessionId, display, sourceId, harness }) =>
        ({ sessionId, display, sourceId, harness })),
      sources: (dataset.sources || []).map(({ id, member, displayName, repo }) =>
        ({ id, ...(member ? { member } : {}), ...(displayName ? { displayName } : {}), ...(repo ? { repo } : {}) })),
      sourceId: dataset.sourceId,
    }));
  `;
  const result = spawnSync(
    nodeBin,
    ['--import', './scripts/register-ts.mjs', '--input-type=module', '-e', code],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_HUB_PROJECTS_DIR: '',
        CLAUDE_HUB_DIR: '',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as IngestResult;
}

function withTemp<T>(name: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('artifact-source multi-root aggregating ingest (#1643)', () => {
  it('single source: every session + history entry carries the default sourceId (parity)', () => {
    withTemp('artifact-single-', (dir) => {
      const claudeDir = join(dir, '.claude');
      const localProjects = join(claudeDir, 'projects');
      mkdirSync(localProjects, { recursive: true });
      writeSession(
        localProjects,
        'solo-project',
        'solo-session',
        transcript('solo transcript prompt')
      );
      // A history-only session with no transcript still flows through and is
      // tagged with the same default sourceId.
      writeFileSync(
        join(claudeDir, 'history.jsonl'),
        `${line(historyEntry('history-only-session', 'history only prompt'))}\n`
      );

      const out = runIngest({
        CLAUDE_DIR: claudeDir,
        CLAUDE_HOME_DIR: dir,
        CHD_DB_PATH: join(dir, 'dashboard.db'),
      });

      // Exactly one source, the default id, and the top-level sourceId echoes it.
      expect(out.sources).toEqual([{ id: 'claude-code' }]);
      expect(out.sourceId).toBe('claude-code');

      const transcriptEntry = out.entries.find(
        (e) => e.sessionId === 'solo-session'
      );
      const historyOnly = out.entries.find(
        (e) => e.sessionId === 'history-only-session'
      );
      expect(transcriptEntry?.display).toBe('solo transcript prompt');
      expect(historyOnly?.display).toBe('history only prompt');
      // Parity property: every emitted entry carries the single default sourceId.
      for (const e of out.entries) {
        expect(e.sourceId).toBe('claude-code');
        expect(e.harness).toBe('claude-code');
      }
    });
  });

  it('single-source output is identical across two cold ingests (deterministic parity baseline)', () => {
    withTemp('artifact-parity-', (dir) => {
      const claudeDir = join(dir, '.claude');
      const localProjects = join(claudeDir, 'projects');
      mkdirSync(localProjects, { recursive: true });
      writeSession(localProjects, 'p1', 's1', transcript('first prompt'));
      writeSession(localProjects, 'p2', 's2', transcript('second prompt', 'sdk-cli'));
      writeFileSync(
        join(claudeDir, 'history.jsonl'),
        `${line(historyEntry('h1', 'legacy history prompt'))}\n`
      );

      const baseEnv = {
        CLAUDE_DIR: claudeDir,
        CLAUDE_HOME_DIR: dir,
      };
      const a = runIngest({ ...baseEnv, CHD_DB_PATH: join(dir, 'a.db') });
      const b = runIngest({ ...baseEnv, CHD_DB_PATH: join(dir, 'b.db') });

      const norm = (r: IngestResult) =>
        JSON.stringify({
          entries: [...r.entries].sort((x, y) =>
            `${x.sessionId}:${x.display}` < `${y.sessionId}:${y.display}` ? -1 : 1
          ),
          sources: r.sources,
          sourceId: r.sourceId,
        });
      expect(norm(a)).toBe(norm(b));
      expect(a.sources).toEqual([{ id: 'claude-code' }]);
    });
  });

  it('two source roots aggregate collision-free with per-source provenance', () => {
    withTemp('artifact-multi-', (dir) => {
      const claudeA = join(dir, 'a', '.claude');
      const claudeB = join(dir, 'b', '.claude');
      const projectsA = join(claudeA, 'projects');
      const projectsB = join(claudeB, 'projects');
      mkdirSync(projectsA, { recursive: true });
      mkdirSync(projectsB, { recursive: true });

      // Distinct session UUIDs in each root.
      writeSession(projectsA, 'proj-a', 'uuid-a', transcript('alpha prompt'));
      writeSession(projectsB, 'proj-b', 'uuid-b', transcript('beta prompt', 'sdk-cli'));

      const sources = [
        { id: 'machine-a', harness: 'claude-code', historyDir: projectsA },
        { id: 'machine-b', harness: 'claude-code', historyDir: projectsB },
      ];
      const out = runIngest({
        CLAUDE_DIR: claudeA,
        CLAUDE_HOME_DIR: join(dir, 'a'),
        CHD_DB_PATH: join(dir, 'dashboard.db'),
        CODING_AGENT_SOURCES: JSON.stringify(sources),
      });

      expect(out.sources).toEqual(
        expect.arrayContaining([{ id: 'machine-a' }, { id: 'machine-b' }])
      );
      const a = out.entries.find((e) => e.sessionId === 'uuid-a');
      const b = out.entries.find((e) => e.sessionId === 'uuid-b');
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      // Collision-free: distinct UUIDs both survive, each with its own provenance.
      expect(a?.sourceId).toBe('machine-a');
      expect(b?.sourceId).toBe('machine-b');
    });
  });

  it('surfaces per-member attribution from .sources/<id>/_source.json on the source descriptor (#1999)', () => {
    withTemp('artifact-member-', (dir) => {
      const claudeA = join(dir, 'a', '.claude');
      const claudeB = join(dir, 'b', '.claude');
      const projectsA = join(claudeA, 'projects');
      const projectsB = join(claudeB, 'projects');
      mkdirSync(projectsA, { recursive: true });
      mkdirSync(projectsB, { recursive: true });
      writeSession(projectsA, 'proj-a', 'uuid-a', transcript('alpha prompt'));
      writeSession(projectsB, 'proj-b', 'uuid-b', transcript('beta prompt'));

      // The push-ingest endpoint stamps member provenance out of band at
      // `<dirname(historyDir)>/.sources/<id>/_source.json`. Only machine-a has it.
      const metaDir = join(claudeA, '.sources', 'machine-a');
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        join(metaDir, '_source.json'),
        JSON.stringify({
          sourceId: 'machine-a',
          member: 'ada',
          displayName: 'Ada Lovelace',
          repo: 'https://github.com/shpwrck/example.git',
        })
      );

      const sources = [
        { id: 'machine-a', harness: 'claude-code', historyDir: projectsA },
        { id: 'machine-b', harness: 'claude-code', historyDir: projectsB },
      ];
      const out = runIngest({
        CLAUDE_DIR: claudeA,
        CLAUDE_HOME_DIR: join(dir, 'a'),
        CHD_DB_PATH: join(dir, 'dashboard.db'),
        CODING_AGENT_SOURCES: JSON.stringify(sources),
      });

      const sourceA = out.sources.find((s) => s.id === 'machine-a');
      const sourceB = out.sources.find((s) => s.id === 'machine-b');
      // machine-a carries the member label the dashboard groups by.
      expect(sourceA).toEqual({
        id: 'machine-a',
        member: 'ada',
        displayName: 'Ada Lovelace',
        repo: 'https://github.com/shpwrck/example.git',
      });
      // A source without _source.json is unchanged (no member fields).
      expect(sourceB).toEqual({ id: 'machine-b' });
    });
  });

  it('attributes shipped sessions to the pod/member that shipped them via the ledger (#2136)', () => {
    withTemp('artifact-shipped-', (dir) => {
      // The hub layout: ONE ingest dir whose shared projects/ holds every shipped
      // transcript; each shipper's provenance + per-artifact ledger live under
      // .sources/<podSourceId>/ (written by the push-ingest endpoint).
      const claudeDir = join(dir, '.claude');
      const projects = join(claudeDir, 'projects');
      mkdirSync(projects, { recursive: true });
      // Two transcripts in the shared dir, shipped by two different pods.
      writeSession(projects, 'workspace', 'uuid-pod-a', transcript('pod a prompt'));
      writeSession(projects, 'workspace', 'uuid-pod-b', transcript('pod b prompt'));

      const writeShipped = (sourceId: string, member: string, shippedUuid: string) => {
        const sdir = join(claudeDir, '.sources', sourceId);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(
          join(sdir, '_source.json'),
          JSON.stringify({ sourceId, member, displayName: member, repo: 'https://github.com/x/y' })
        );
        // Ledger keys are root-relative artifact paths; the transcript key carries the sessionId.
        writeFileSync(
          join(sdir, '.signatures.json'),
          JSON.stringify({
            'projects/workspace/bridge-pointer.json': '147:1',
            [`projects/workspace/${shippedUuid}.jsonl`]: '79271:1',
          })
        );
      };
      writeShipped('ri-pod-a', 'dashboard', 'uuid-pod-a');
      writeShipped('ri-pod-b', 'dashboard', 'uuid-pod-b');

      const out = runIngest({
        CLAUDE_DIR: claudeDir,
        CLAUDE_HOME_DIR: dir,
        CHD_DB_PATH: join(dir, 'dashboard.db'),
      });

      // The two pod sources are surfaced as distinct attributable sources w/ member.
      const podA = out.sources.find((s) => s.id === 'ri-pod-a');
      const podB = out.sources.find((s) => s.id === 'ri-pod-b');
      expect(podA).toEqual({ id: 'ri-pod-a', member: 'dashboard', displayName: 'dashboard', repo: 'https://github.com/x/y' });
      expect(podB).toEqual({ id: 'ri-pod-b', member: 'dashboard', displayName: 'dashboard', repo: 'https://github.com/x/y' });

      // Each shipped session is attributed to the pod that shipped it — NOT collapsed
      // into the default `claude-code` source.
      const a = out.entries.find((e) => e.sessionId === 'uuid-pod-a');
      const b = out.entries.find((e) => e.sessionId === 'uuid-pod-b');
      expect(a?.sourceId).toBe('ri-pod-a');
      expect(b?.sourceId).toBe('ri-pod-b');
    });
  });

  it('transcript-vs-history precedence is preserved ACROSS sources', () => {
    withTemp('artifact-precedence-', (dir) => {
      const claudeA = join(dir, 'a', '.claude');
      const claudeB = join(dir, 'b', '.claude');
      const projectsA = join(claudeA, 'projects');
      const projectsB = join(claudeB, 'projects');
      mkdirSync(projectsA, { recursive: true });
      mkdirSync(projectsB, { recursive: true });

      // Source A has the transcript for `shared-uuid` (authoritative).
      writeSession(
        projectsA,
        'proj-a',
        'shared-uuid',
        transcript('authoritative transcript prompt')
      );
      // Source B has ONLY a history.jsonl entry for the same sessionId — it must
      // be suppressed by the transcriptSessionIds precedence guard.
      writeFileSync(
        join(claudeB, 'history.jsonl'),
        `${line(historyEntry('shared-uuid', 'stale history prompt'))}\n`
      );

      const sources = [
        { id: 'machine-a', harness: 'claude-code', historyDir: projectsA },
        { id: 'machine-b', harness: 'claude-code', historyDir: projectsB },
      ];
      const out = runIngest({
        CLAUDE_DIR: claudeA,
        CLAUDE_HOME_DIR: join(dir, 'a'),
        CHD_DB_PATH: join(dir, 'dashboard.db'),
        CODING_AGENT_SOURCES: JSON.stringify(sources),
      });

      const sharedEntries = out.entries.filter(
        (e) => e.sessionId === 'shared-uuid'
      );
      // Exactly the transcript-derived entry survives; the history-only one for
      // the same sessionId is dropped (precedence preserved across sources).
      expect(sharedEntries.map((e) => e.display)).toEqual([
        'authoritative transcript prompt',
      ]);
      expect(sharedEntries[0]?.sourceId).toBe('machine-a');
    });
  });
});
