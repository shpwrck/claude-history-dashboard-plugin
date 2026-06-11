import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  unzipBundle,
  unzipBundleFromChunks,
  shouldSkipFile,
  isMetadataOnlyPath,
  extractProjectName,
  extractWorkflowSessionId,
  isZipPath,
  isMemoryPath,
  isWorkflowPath,
  collectUploadSessions,
  collectUploadTranscriptEntries,
  collectUploadTranscriptSessionIds,
  collectUploadMemories,
  collectUploadWorkflows,
  UploadTooLargeError,
  type LoadedFile,
} from './unzip-upload';

describe('shouldSkipFile', () => {
  it('keeps history and session transcripts', () => {
    expect(shouldSkipFile('history.jsonl')).toBe(false);
    expect(shouldSkipFile('projects/my-proj/abc.jsonl')).toBe(false);
  });

  it('skips sensitive files even when they end in .json', () => {
    expect(shouldSkipFile('settings.json')).toBe(true);
    expect(shouldSkipFile('credentials.json')).toBe(true);
    expect(shouldSkipFile('.env')).toBe(true);
    expect(shouldSkipFile('statsig_config.json')).toBe(true);
  });

  it('skips non-.jsonl files', () => {
    expect(shouldSkipFile('projects/my-proj/notes.txt')).toBe(true);
    expect(shouldSkipFile('report.html')).toBe(true);
  });

  it('skips blocked directories anywhere in the path', () => {
    expect(shouldSkipFile('node_modules/x/a.jsonl')).toBe(true);
    expect(shouldSkipFile('projects/p/.git/HEAD.jsonl')).toBe(true);
  });

  it('keeps targeted memory and workflow files (#538)', () => {
    expect(shouldSkipFile('projects/p/memory/note.md')).toBe(false);
    expect(shouldSkipFile('claude/projects/p/memory/note.md')).toBe(false);
    expect(shouldSkipFile('projects/p/sess-1/workflows/wf_abc.json')).toBe(false);
  });

  it('keeps current non-transcript dashboard artifacts (#1051)', () => {
    expect(shouldSkipFile('tasks/sess-1/1.json')).toBe(false);
    expect(shouldSkipFile('teams/t1/inboxes/agent.json')).toBe(false);
    expect(shouldSkipFile('sessions/123.json')).toBe(false);
    expect(shouldSkipFile('telemetry/1p_failed_events.json')).toBe(false);
    expect(shouldSkipFile('debug/sess-1.txt')).toBe(false);
    expect(shouldSkipFile('stats-cache.json')).toBe(false);
    expect(shouldSkipFile('file-history/sess-1/snapshot@v2')).toBe(false);
    expect(shouldSkipFile('plans/plan.md')).toBe(false);
    expect(shouldSkipFile('.last-update-result.json')).toBe(false);
    expect(shouldSkipFile('mcp-needs-auth-cache.json')).toBe(false);
  });

  it('skips insights usage-data artifacts now that insights is removed (#1170)', () => {
    expect(shouldSkipFile('usage-data/session-meta/sess-1.json')).toBe(true);
    expect(shouldSkipFile('usage-data/facets/sess-1.json')).toBe(true);
    expect(shouldSkipFile('usage-data/report.html')).toBe(true);
  });

  it('still skips the MEMORY.md index and stray .md/.json (#538)', () => {
    expect(shouldSkipFile('projects/p/memory/MEMORY.md')).toBe(true);
    expect(shouldSkipFile('projects/p/readme.md')).toBe(true);
    expect(shouldSkipFile('projects/p/memory/note.txt')).toBe(true);
    // A plain .json that is not a wf_* manifest stays out.
    expect(shouldSkipFile('projects/p/sess-1/workflows/notes.json')).toBe(true);
    expect(shouldSkipFile('projects/p/sess-1/other.json')).toBe(true);
  });

  it('keeps SENSITIVE_FILES blocked even under an admitted memory/workflow path (#538)', () => {
    expect(shouldSkipFile('projects/p/memory/settings.json')).toBe(true);
    expect(shouldSkipFile('projects/p/sess-1/workflows/credentials.json')).toBe(true);
  });

  it('treats file-history snapshots as metadata-only (#1051)', () => {
    expect(isMetadataOnlyPath('file-history/sess-1/snapshot@v2')).toBe(true);
    expect(isMetadataOnlyPath('projects/p/sess-1.jsonl')).toBe(false);
  });
});

describe('collectUploadSessions (#1051)', () => {
  it('merges uploaded subagent transcripts into the top-level parent session', () => {
    const files: LoadedFile[] = [
      { name: 'sess-1.jsonl', text: '{"type":"user"}\n', project: 'p', path: 'projects/p/sess-1.jsonl' },
      { name: 'a.jsonl', text: '{"type":"assistant","sub":"a"}\n', project: 'p', path: 'projects/p/sess-1/subagents/a.jsonl' },
      { name: 'agent-1.jsonl', text: '{"type":"assistant","sub":"wf"}\n', project: 'p', path: 'projects/p/sess-1/subagents/workflows/wf_1/agent-1.jsonl' },
      { name: 'journal.jsonl', text: '{"type":"system","sub":"journal"}\n', project: 'p', path: 'projects/p/sess-1/subagents/workflows/wf_1/journal.jsonl' },
    ];

    const sessions = collectUploadSessions(files);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('sess-1.jsonl');
    expect(sessions[0].project).toBe('p');
    expect(sessions[0].text).toContain('"type":"user"');
    expect(sessions[0].text).toContain('"sub":"a"');
    expect(sessions[0].text).toContain('"sub":"wf"');
    expect(sessions[0].text).not.toContain('"sub":"journal"');
  });
});

describe('collectUploadTranscriptEntries (#1070)', () => {
  const line = (o: object) => JSON.stringify(o);

  it('derives history entries from top-level uploaded transcripts', () => {
    const files: LoadedFile[] = [
      {
        name: 'sess-1.jsonl',
        text: line({
          type: 'user',
          timestamp: '2026-01-02T03:04:05.000Z',
          cwd: '/home/u/project',
          message: { role: 'user', content: 'build the thing' },
        }),
        project: '-home-u-project',
        path: 'claude/projects/-home-u-project/sess-1.jsonl',
      },
      {
        name: 'history.jsonl',
        text: line({ sessionId: 'hist-only', display: 'from history' }),
        path: 'history.jsonl',
      },
    ];

    const entries = collectUploadTranscriptEntries(files);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      display: 'build the thing',
      project: '/home/u/project',
      sessionId: 'sess-1',
      timestamp: Date.parse('2026-01-02T03:04:05.000Z'),
    });
  });

  it('ignores subagent transcripts when deriving session entries', () => {
    const files: LoadedFile[] = [
      {
        name: 'sess-1.jsonl',
        text: line({
          type: 'user',
          message: { role: 'user', content: 'human prompt' },
        }),
        project: 'p',
        path: 'projects/p/sess-1.jsonl',
      },
      {
        name: 'agent.jsonl',
        text: line({
          type: 'user',
          message: { role: 'user', content: 'subagent task prompt' },
        }),
        project: 'p',
        path: 'projects/p/sess-1/subagents/agent.jsonl',
      },
    ];

    const entries = collectUploadTranscriptEntries(files);

    expect(entries.map((e) => e.display)).toEqual(['human prompt']);
  });

  it('collects all top-level transcript ids, including transcripts with no entries', () => {
    const files: LoadedFile[] = [
      {
        name: 'with-entry.jsonl',
        text: line({ type: 'user', message: { role: 'user', content: 'prompt' } }),
        path: 'projects/p/with-entry.jsonl',
      },
      {
        name: 'empty.jsonl',
        text: line({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
        path: 'projects/p/empty.jsonl',
      },
      {
        name: 'agent.jsonl',
        text: line({ type: 'user', message: { role: 'user', content: 'task' } }),
        path: 'projects/p/with-entry/subagents/agent.jsonl',
      },
    ];

    expect(collectUploadTranscriptSessionIds(files).sort()).toEqual([
      'empty',
      'with-entry',
    ]);
  });
});

describe('isMemoryPath / isWorkflowPath (#538)', () => {
  it('classifies memory notes but not the index', () => {
    expect(isMemoryPath('projects/p/memory/foo.md')).toBe(true);
    expect(isMemoryPath('x/projects/p/memory/foo.md')).toBe(true);
    expect(isMemoryPath('projects/p/memory/MEMORY.md')).toBe(false);
    expect(isMemoryPath('projects/p/foo.md')).toBe(false);
  });

  it('classifies wf_*.json manifests only', () => {
    expect(isWorkflowPath('projects/p/sess-1/workflows/wf_x.json')).toBe(true);
    expect(isWorkflowPath('projects/p/sess-1/workflows/other.json')).toBe(false);
    expect(isWorkflowPath('projects/p/sess-1/wf_x.json')).toBe(false);
  });
});

describe('extractWorkflowSessionId (#538)', () => {
  it('pulls the parent session dir from a manifest path', () => {
    expect(
      extractWorkflowSessionId('projects/-home-me/abc-123/workflows/wf_x.json')
    ).toBe('abc-123');
    expect(
      extractWorkflowSessionId('claude/projects/p/sess-9/workflows/wf_y.json')
    ).toBe('sess-9');
  });

  it('returns undefined for a non-workflow path', () => {
    expect(extractWorkflowSessionId('projects/p/abc.jsonl')).toBeUndefined();
  });
});

describe('collectUploadMemories (#538)', () => {
  it('groups memory files by project slug, ignoring non-memory files', () => {
    const files: LoadedFile[] = [
      { name: 'a.md', text: '---\nname: a\n---\nbody', path: 'projects/p1/memory/a.md' },
      { name: 'b.md', text: '---\nname: b\n---\nbody', path: 'projects/p1/memory/b.md' },
      { name: 'c.md', text: 'no frontmatter', path: 'projects/p2/memory/c.md' },
      { name: 'sess.jsonl', text: '{}', path: 'projects/p1/sess.jsonl' },
      { name: 'note.md', text: 'stray', path: 'projects/p1/note.md' },
    ];
    const resp = collectUploadMemories(files);
    const p1 = resp.projects.find((p) => p.slug === 'p1');
    const p2 = resp.projects.find((p) => p.slug === 'p2');
    expect(p1?.files.map((f) => f.name).sort()).toEqual(['a.md', 'b.md']);
    expect(p2?.files.map((f) => f.name)).toEqual(['c.md']);
  });

  it('ignores files with no path', () => {
    const files: LoadedFile[] = [{ name: 'a.md', text: 'x' }];
    expect(collectUploadMemories(files).projects).toEqual([]);
  });
});

describe('collectUploadWorkflows (#538)', () => {
  it('parses manifests and injects the parent session id from the path', () => {
    const manifest = JSON.stringify({ runId: 'wf_1', workflowName: 'demo', status: 'completed' });
    const files: LoadedFile[] = [
      { name: 'wf_1.json', text: manifest, path: 'projects/p/sess-7/workflows/wf_1.json' },
    ];
    const resp = collectUploadWorkflows(files);
    expect(resp.runs).toHaveLength(1);
    expect(resp.runs[0].runId).toBe('wf_1');
    expect(resp.runs[0].sessionId).toBe('sess-7');
  });

  it('skips malformed JSON and non-workflow files without throwing', () => {
    const files: LoadedFile[] = [
      { name: 'wf_bad.json', text: '{not json', path: 'projects/p/s/workflows/wf_bad.json' },
      { name: 'wf_arr.json', text: '[]', path: 'projects/p/s/workflows/wf_arr.json' },
      { name: 'x.jsonl', text: '{}', path: 'projects/p/x.jsonl' },
    ];
    expect(collectUploadWorkflows(files).runs).toEqual([]);
  });
});

describe('extractProjectName', () => {
  it('pulls the slug from a projects/<slug>/ path', () => {
    expect(extractProjectName('projects/-home-me-repo/abc.jsonl')).toBe('-home-me-repo');
  });

  it('returns undefined when there is no projects/ segment', () => {
    expect(extractProjectName('history.jsonl')).toBeUndefined();
  });

  it('handles a leading prefix before projects/ (zip root folder)', () => {
    expect(extractProjectName('claude-spa-upload/projects/p/s.jsonl')).toBe('p');
  });
});

describe('isZipPath', () => {
  it('matches case-insensitively', () => {
    expect(isZipPath('bundle.zip')).toBe(true);
    expect(isZipPath('BUNDLE.ZIP')).toBe(true);
    expect(isZipPath('history.jsonl')).toBe(false);
  });
});

describe('unzipBundle', () => {
  function buildZip(files: Record<string, string>): Uint8Array {
    const tree: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(files)) {
      tree[path] = strToU8(content);
    }
    return zipSync(tree);
  }

  it('accepts a native hub export zip rooted at projects/ (#697)', async () => {
    const zip = buildZip({
      'projects/hub-project/hub-session.jsonl': '{"type":"user"}\n',
      'projects/hub-project/hub-session/subagents/agent-a.jsonl': '{"type":"assistant"}\n',
    });

    const loaded = await unzipBundle(zip);

    expect(loaded.map((file) => file.path).sort()).toEqual([
      'projects/hub-project/hub-session.jsonl',
      'projects/hub-project/hub-session/subagents/agent-a.jsonl',
    ]);
    expect(loaded.every((file) => file.project === 'hub-project')).toBe(true);
  });

  it('extracts history + session transcripts with project attribution', async () => {
    const zip = buildZip({
      'history.jsonl': '{"display":"hi"}\n',
      'projects/-home-me-repo/sess-1.jsonl': '{"type":"user"}\n',
      'projects/-home-me-repo/sess-2.jsonl': '{"type":"assistant"}\n',
    });

    const loaded = await unzipBundle(zip);

    const history = loaded.find((f) => f.name === 'history.jsonl');
    expect(history?.text).toContain('"display":"hi"');
    expect(history?.project).toBeUndefined();

    const sessions = loaded.filter((f) => f.name.startsWith('sess-'));
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.project === '-home-me-repo')).toBe(true);
  });

  it('streams zip chunks without changing admitted files or attribution', async () => {
    const zip = buildZip({
      'history.jsonl': '{"display":"hi"}\n',
      'projects/-home-me-repo/sess-1.jsonl': '{"type":"user"}\n',
      'projects/-home-me-repo/memory/note.md': 'remember this',
      'projects/-home-me-repo/sess-1/workflows/wf_run.json': '{"runId":"wf_run"}',
      'settings.json': '{"apiKey":"SECRET"}',
      'projects/-home-me-repo/notes.txt': 'ignore me',
    });

    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < zip.byteLength; offset += 17) {
        yield zip.subarray(offset, offset + 17);
      }
    }

    const loaded = await unzipBundleFromChunks(chunks(), zip.byteLength);
    const names = loaded.map((f) => f.name).sort();

    expect(names).toEqual(['history.jsonl', 'note.md', 'sess-1.jsonl', 'wf_run.json']);
    expect(loaded.find((f) => f.name === 'sess-1.jsonl')?.project).toBe('-home-me-repo');
    expect(loaded.find((f) => f.name === 'note.md')?.path).toBe(
      'projects/-home-me-repo/memory/note.md'
    );
    expect(JSON.stringify(loaded)).not.toContain('SECRET');
  });

  it('drops sensitive files, non-.jsonl, and blocked dirs bundled in the zip', async () => {
    const zip = buildZip({
      'history.jsonl': '{}\n',
      'settings.json': '{"apiKey":"SECRET"}',
      'credentials.json': '{"token":"SECRET"}',
      '.env': 'KEY=SECRET',
      'projects/p/notes.txt': 'ignore me',
      'node_modules/pkg/cached.jsonl': '{}\n',
      'projects/p/good.jsonl': '{"type":"user"}\n',
    });

    const loaded = await unzipBundle(zip);
    const names = loaded.map((f) => f.name).sort();

    expect(names).toEqual(['good.jsonl', 'history.jsonl']);
    // No secret content should have been inflated into memory.
    expect(JSON.stringify(loaded)).not.toContain('SECRET');
  });

  it('returns an empty array for a zip with nothing relevant', async () => {
    const zip = buildZip({ 'readme.md': '# hi', 'settings.json': '{}' });
    expect(await unzipBundle(zip)).toEqual([]);
  });

  it('admits memory + workflow files and carries their path, still dropping sensitive .json (#538)', async () => {
    const zip = buildZip({
      'history.jsonl': '{}\n',
      'projects/p/memory/note.md': '---\nname: note\n---\nremember this',
      'projects/p/memory/MEMORY.md': '# index — should be skipped',
      'projects/p/sess-1/workflows/wf_run.json': '{"runId":"wf_run"}',
      'projects/p/sess-1/workflows/settings.json': '{"apiKey":"SECRET"}',
    });

    const loaded = await unzipBundle(zip);
    const names = loaded.map((f) => f.name).sort();

    expect(names).toEqual(['history.jsonl', 'note.md', 'wf_run.json']);
    const note = loaded.find((f) => f.name === 'note.md');
    expect(note?.path).toBe('projects/p/memory/note.md');
    // The sensitive manifest-dir settings.json was never inflated.
    expect(JSON.stringify(loaded)).not.toContain('SECRET');

    // And the admitted files round-trip through the collectors.
    expect(collectUploadMemories(loaded).projects[0]?.files[0]?.name).toBe('note.md');
    expect(collectUploadWorkflows(loaded).runs[0]?.sessionId).toBe('sess-1');
  });

  it('extracts current artifact files while preserving file-history privacy (#1051)', async () => {
    const zip = buildZip({
      'tasks/sess-1/1.json': '{"id":"1","subject":"Do it","status":"pending"}',
      'plans/plan.md': '## Work\n1. src/a.ts\n## Verification\nRun tests',
      'file-history/sess-1/snapshot@v2': 'SECRET SNAPSHOT BODY',
    });

    const loaded = await unzipBundle(zip);
    const names = loaded.map((f) => f.name).sort();

    expect(names).toEqual(['1.json', 'plan.md', 'snapshot@v2']);
    const snapshot = loaded.find((f) => f.name === 'snapshot@v2');
    expect(snapshot?.text).toBe('');
    expect(snapshot?.metadataOnly).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain('SECRET SNAPSHOT BODY');
  });

  // Fail-proof guards (#758). Tiny limits trip the guards with small fixtures so
  // we never have to allocate gigabytes to test the ceilings.
  describe('fail-proof size guards (#758)', () => {
    it('fails fast on a compressed input over the archive ceiling', async () => {
      const zip = buildZip({ 'history.jsonl': '{}\n' });
      await expect(
        unzipBundle(zip, { maxArchiveBytes: zip.byteLength - 1 })
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it('rejects a single entry over the per-file ceiling without decompressing it', async () => {
      const big = 'x'.repeat(5000);
      const zip = buildZip({ 'history.jsonl': '{}\n', 'projects/p/huge.jsonl': big });
      await expect(
        unzipBundle(zip, { maxEntryBytes: 1000 })
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it('rejects once the total inflated budget is exceeded', async () => {
      const zip = buildZip({
        'projects/p/a.jsonl': 'a'.repeat(800),
        'projects/p/b.jsonl': 'b'.repeat(800),
        'projects/p/c.jsonl': 'c'.repeat(800),
      });
      await expect(
        unzipBundle(zip, { maxTotalBytes: 1000 })
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it('rejects once the entry-count budget is exceeded', async () => {
      const zip = buildZip({
        'projects/p/a.jsonl': '{}\n',
        'projects/p/b.jsonl': '{}\n',
        'projects/p/c.jsonl': '{}\n',
      });
      await expect(
        unzipBundle(zip, { maxEntries: 2 })
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it('admits a normal bundle that sits under generous default limits', async () => {
      const zip = buildZip({
        'history.jsonl': '{}\n',
        'projects/p/sess-1.jsonl': '{"type":"user"}\n',
      });
      const loaded = await unzipBundle(zip);
      expect(loaded.map((f) => f.name).sort()).toEqual(['history.jsonl', 'sess-1.jsonl']);
    });

    it('carries a human-readable message the UI can surface', async () => {
      const zip = buildZip({ 'history.jsonl': '{}\n' });
      await expect(
        unzipBundle(zip, { maxArchiveBytes: 1 })
      ).rejects.toThrow(/upload limit/i);
    });
  });
});
