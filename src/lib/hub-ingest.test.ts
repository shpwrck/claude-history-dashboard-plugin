import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function withTemp<T>(name: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('hub transcript ingest (#697)', () => {
  it('adds a native hub projects root and dedupes duplicate sessionIds by larger snapshot', () => {
    withTemp('hub-ingest-', (dir) => {
      const claudeDir = join(dir, '.claude');
      const localProjects = join(claudeDir, 'projects');
      const hubProjects = join(dir, 'hub', 'projects');
      mkdirSync(localProjects, { recursive: true });
      mkdirSync(hubProjects, { recursive: true });

      writeSession(
        localProjects,
        'local-project',
        'local-session',
        transcript('local prompt')
      );
      writeSession(
        hubProjects,
        'hub-project',
        'hub-session',
        transcript('hub prompt', 'sdk-cli')
      );
      writeSession(
        localProjects,
        'shared-project',
        'shared-session',
        transcript('local shared prompt')
      );
      writeSession(
        hubProjects,
        'shared-project',
        'shared-session',
        `${transcript('hub shared prompt with the larger snapshot', 'sdk-cli')}\n${line({
          type: 'system',
          subtype: 'stop_hook_summary',
          timestamp: '2026-01-01T00:00:02.000Z',
        })}`
      );

      const code = `
        import { ingest, assembleDataset } from './scripts/ingest.mjs';
        ingest();
        const dataset = assembleDataset();
        console.log(JSON.stringify({
          entries: dataset.entries.map(({ sessionId, display, project }) => ({ sessionId, display, project })),
          tokenData: dataset.tokenData.map(({ sessionId, entrypoint }) => ({ sessionId, entrypoint })),
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
            CLAUDE_DIR: claudeDir,
            CLAUDE_HOME_DIR: dir,
            CHD_DB_PATH: join(dir, 'dashboard.db'),
            DASHBOARD_HUB_PROJECTS_DIR: hubProjects,
            CLAUDE_HUB_PROJECTS_DIR: '',
            CLAUDE_HUB_DIR: '',
            GIT_TERMINAL_PROMPT: '0',
          },
        }
      );

      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        entries: Array<{ sessionId: string; display: string; project: string }>;
        tokenData: Array<{ sessionId: string; entrypoint?: string }>;
      };

      expect(parsed.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'local-session', display: 'local prompt' }),
          expect.objectContaining({ sessionId: 'hub-session', display: 'hub prompt' }),
          expect.objectContaining({
            sessionId: 'shared-session',
            display: 'hub shared prompt with the larger snapshot',
          }),
        ])
      );
      expect(parsed.entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'shared-session',
            display: 'local shared prompt',
          }),
        ])
      );
      expect(parsed.tokenData).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'hub-session',
            entrypoint: 'sdk-cli',
          }),
          expect.objectContaining({
            sessionId: 'shared-session',
            entrypoint: 'sdk-cli',
          }),
        ])
      );
    });
  });
});
