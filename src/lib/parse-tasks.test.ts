/**
 * parse-tasks.test.ts
 *
 * Tests for parseTasksDir (real-fs variant tested via tmp dir) and summarizeTasks.
 * Inline fixtures are shaped exactly like the real ~/.claude/tasks artifact and
 * mirror the mock data from proto/539-tasks/gen-mock.mjs.
 *
 * Issue #559.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_ARTIFACT_MAX_FILE_BYTES } from './bounded-fs';
import {
  parseTasksDir,
  summarizeTasks,
  COLD_DAYS,
  PILEUP_MIN,
  type TaskRecord,
} from './parse-tasks';

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<{
    id: string;
    subject: string;
    description: string;
    activeForm: string;
    owner: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
    metadata: { pr: string };
  }>
): Record<string, unknown> {
  return {
    id: '1',
    subject: 'Do the thing',
    description: 'Full description.',
    activeForm: 'Doing the thing',
    owner: 'agent-wave1',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

// ── Tmp-dir helpers ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = join(tmpdir(), `parse-tasks-test-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a session directory under tmpRoot.
 * Returns the session ID used.
 */
function writeSession(
  sessionId: string,
  tasks: Array<Record<string, unknown>>
): string {
  const dir = join(tmpRoot, sessionId);
  mkdirSync(dir, { recursive: true });
  tasks.forEach((t, i) => {
    writeFileSync(join(dir, `${i + 1}.json`), JSON.stringify(t));
  });
  return sessionId;
}

// ── parseTasksDir ────────────────────────────────────────────────────────────

describe('parseTasksDir', () => {
  it('returns an empty array when the dir does not exist', () => {
    expect(parseTasksDir('/nonexistent/tasks/path')).toEqual([]);
  });

  it('parses a single session with mixed statuses', () => {
    const sid = 'session-basic-' + Date.now();
    writeSession(sid, [
      makeTask({ id: '1', status: 'completed', subject: 'Alpha' }),
      makeTask({ id: '2', status: 'in_progress', subject: 'Beta' }),
      makeTask({ id: '3', status: 'pending', subject: 'Gamma' }),
    ]);
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.status).sort()).toEqual([
      'completed',
      'in_progress',
      'pending',
    ]);
  });

  it('extracts pr from metadata.pr', () => {
    const sid = 'session-pr-' + Date.now();
    writeSession(sid, [
      makeTask({
        id: '1',
        status: 'completed',
        metadata: { pr: 'https://github.com/acme/repo/pull/42' },
      } as Parameters<typeof makeTask>[0]),
    ]);
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records[0].pr).toBe('https://github.com/acme/repo/pull/42');
  });

  it('skips malformed JSON silently', () => {
    const sid = 'session-bad-json-' + Date.now();
    const dir = join(tmpRoot, sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.json'), '{ not: valid json ');
    writeFileSync(join(dir, '2.json'), JSON.stringify(makeTask({ id: '2', status: 'completed' })));
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records).toHaveLength(1); // only the valid file
  });

  it('skips files with unknown/missing status silently', () => {
    const sid = 'session-bad-status-' + Date.now();
    writeSession(sid, [
      { id: '1', subject: 'Broken', status: 'unknown', blocks: [], blockedBy: [] },
      makeTask({ id: '2', status: 'pending' }),
    ]);
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records).toHaveLength(1);
  });

  it('skips _session.json sidecar files', () => {
    const sid = 'session-sidecar-' + Date.now();
    const dir = join(tmpRoot, sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '_session.json'),
      JSON.stringify({ project: 'test', daysSinceActive: 5 })
    );
    writeFileSync(join(dir, '1.json'), JSON.stringify(makeTask({ id: '1', status: 'completed' })));
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records).toHaveLength(1);
  });

  it('normalises missing blocks/blockedBy to empty arrays', () => {
    const sid = 'session-noblocks-' + Date.now();
    const dir = join(tmpRoot, sid);
    mkdirSync(dir, { recursive: true });
    // Write raw JSON without blocks/blockedBy fields
    writeFileSync(
      join(dir, '1.json'),
      JSON.stringify({ id: '1', subject: 'Solo', status: 'pending' })
    );
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records[0].blocks).toEqual([]);
    expect(records[0].blockedBy).toEqual([]);
  });

  it('records mtimeMs for each task', () => {
    const sid = 'session-mtime-' + Date.now();
    writeSession(sid, [makeTask({ id: '1', status: 'pending' })]);
    const records = parseTasksDir(tmpRoot).filter((r) => r.sessionId === sid);
    expect(records[0].mtimeMs).toBeGreaterThan(0);
    expect(typeof records[0].mtimeMs).toBe('number');
  });

  it('skips task files above the configured byte cap', () => {
    const sid = 'session-oversized-' + Date.now();
    writeSession(sid, [
      makeTask({ id: '1', status: 'completed', subject: 'Small' }),
      makeTask({ id: '2', status: 'pending', subject: 'x'.repeat(512) }),
    ]);

    const records = parseTasksDir(tmpRoot, { maxFileBytes: 256 }).filter(
      (r) => r.sessionId === sid
    );

    expect(records.map((r) => r.id)).toEqual(['1']);
  });

  it('caps task artifact directory discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-tasks-entry-cap-'));
    try {
      const sessionDir = join(dir, 'session-cap');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, '1.json'), JSON.stringify(makeTask({ id: '1', status: 'completed' })));
      writeFileSync(join(sessionDir, '2.json'), JSON.stringify(makeTask({ id: '2', status: 'pending' })));
      writeFileSync(join(sessionDir, '3.json'), JSON.stringify(makeTask({ id: '3', status: 'pending' })));

      const records = parseTasksDir(dir, { maxEntries: 2 });

      expect(records).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── summarizeTasks ────────────────────────────────────────────────────────────

describe('summarizeTasks', () => {
  function makeRecord(
    sessionId: string,
    status: 'pending' | 'in_progress' | 'completed',
    id = '1'
  ): TaskRecord {
    return {
      id,
      subject: 'Task',
      description: '',
      activeForm: '',
      owner: '',
      status,
      blocks: [],
      blockedBy: [],
      sessionId,
      mtimeMs: Date.now(),
    };
  }

  it('returns an empty array for empty input', () => {
    expect(summarizeTasks([])).toEqual([]);
  });

  it('computes completion rate correctly', () => {
    const tasks: TaskRecord[] = [
      makeRecord('s1', 'completed', '1'),
      makeRecord('s1', 'completed', '2'),
      makeRecord('s1', 'in_progress', '3'),
      makeRecord('s1', 'pending', '4'),
    ];
    const [summary] = summarizeTasks(tasks);
    expect(summary.sessionId).toBe('s1');
    expect(summary.total).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.open).toBe(2);
    expect(summary.rate).toBeCloseTo(0.5);
  });

  it('gives rate=1 for sessions with no tasks', () => {
    // summarizeTasks takes flat records; a session with no tasks never appears
    // because there's nothing to group. Test the all-completed case instead.
    const tasks: TaskRecord[] = [makeRecord('s2', 'completed', '1')];
    const [summary] = summarizeTasks(tasks);
    expect(summary.rate).toBe(1);
  });

  it('sorts worst-first', () => {
    const tasks: TaskRecord[] = [
      // s-good: 100%
      makeRecord('s-good', 'completed', '1'),
      // s-mid: 50%
      makeRecord('s-mid', 'completed', '1'),
      makeRecord('s-mid', 'pending', '2'),
      // s-bad: 0%
      makeRecord('s-bad', 'pending', '1'),
      makeRecord('s-bad', 'in_progress', '2'),
    ];
    const summaries = summarizeTasks(tasks);
    expect(summaries[0].sessionId).toBe('s-bad');
    expect(summaries[1].sessionId).toBe('s-mid');
    expect(summaries[2].sessionId).toBe('s-good');
  });

  it('groups tasks per session correctly across multiple sessions', () => {
    const tasks: TaskRecord[] = [
      makeRecord('a', 'completed', '1'),
      makeRecord('a', 'pending', '2'),
      makeRecord('b', 'completed', '1'),
    ];
    const summaries = summarizeTasks(tasks);
    const a = summaries.find((s) => s.sessionId === 'a')!;
    const b = summaries.find((s) => s.sessionId === 'b')!;
    expect(a.total).toBe(2);
    expect(b.total).toBe(1);
  });
});

// ── Abandonment: cold gate (≥7d) ─────────────────────────────────────────────

describe('abandonment cold gate logic (>=7d)', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it('COLD_DAYS is 7', () => {
    expect(COLD_DAYS).toBe(7);
  });

  it('a session idle exactly 7d is considered cold (boundary)', () => {
    const now = Date.now();
    const latestMtime = now - COLD_DAYS * MS_PER_DAY;
    const daysSinceLatest = Math.round((now - latestMtime) / MS_PER_DAY);
    expect(daysSinceLatest).toBeGreaterThanOrEqual(COLD_DAYS);
  });

  it('a session idle 6d is NOT cold', () => {
    const now = Date.now();
    const latestMtime = now - 6 * MS_PER_DAY;
    const daysSinceLatest = Math.round((now - latestMtime) / MS_PER_DAY);
    expect(daysSinceLatest).toBeLessThan(COLD_DAYS);
  });
});

// ── Blocked-task pileup gate (≥2 behind unfinished root) ────────────────────

describe('blocked-task pileup gate logic (>=2)', () => {
  it('PILEUP_MIN is 2', () => {
    expect(PILEUP_MIN).toBe(2);
  });

  it('identifies tasks blocked behind an unfinished root', () => {
    // Mirrors the fraud-ml scenario from gen-mock.mjs
    const tasks: TaskRecord[] = [
      {
        id: 'r7',
        subject: 'Retrain fraud model v7',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        sessionId: 'fraud-ml',
        mtimeMs: Date.now() - 9 * 24 * 60 * 60 * 1000,
      },
      {
        id: '2',
        subject: 'Shadow-deploy v7 scorer',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'pending',
        blocks: [],
        blockedBy: ['r7'],
        sessionId: 'fraud-ml',
        mtimeMs: Date.now() - 9 * 24 * 60 * 60 * 1000,
      },
      {
        id: '3',
        subject: 'A/B harness for v7',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'pending',
        blocks: [],
        blockedBy: ['r7'],
        sessionId: 'fraud-ml',
        mtimeMs: Date.now() - 9 * 24 * 60 * 60 * 1000,
      },
    ];

    // Count tasks blocked behind 'r7' where root (r7) is not completed
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const groups = new Map<string, TaskRecord[]>();
    for (const t of tasks) {
      for (const rootId of t.blockedBy) {
        const root = byId.get(rootId);
        if (root && root.status !== 'completed') {
          const group = groups.get(rootId) ?? [];
          group.push(t);
          groups.set(rootId, group);
        }
      }
    }
    const pileups = [...groups.entries()].filter(
      ([, blocked]) => blocked.length >= PILEUP_MIN
    );
    expect(pileups).toHaveLength(1);
    expect(pileups[0][0]).toBe('r7');
    expect(pileups[0][1]).toHaveLength(2);
  });

  it('does NOT flag a pileup when root is completed', () => {
    const tasks: TaskRecord[] = [
      {
        id: 'root',
        subject: 'Root task',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'completed', // root is done — no pileup
        blocks: [],
        blockedBy: [],
        sessionId: 's1',
        mtimeMs: Date.now(),
      },
      {
        id: 'child1',
        subject: 'Child 1',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'pending',
        blocks: [],
        blockedBy: ['root'],
        sessionId: 's1',
        mtimeMs: Date.now(),
      },
      {
        id: 'child2',
        subject: 'Child 2',
        description: '',
        activeForm: '',
        owner: 'ml',
        status: 'pending',
        blocks: [],
        blockedBy: ['root'],
        sessionId: 's1',
        mtimeMs: Date.now(),
      },
    ];

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const groups = new Map<string, TaskRecord[]>();
    for (const t of tasks) {
      for (const rootId of t.blockedBy) {
        const root = byId.get(rootId);
        if (root && root.status !== 'completed') {
          const group = groups.get(rootId) ?? [];
          group.push(t);
          groups.set(rootId, group);
        }
      }
    }
    const pileups = [...groups.entries()].filter(
      ([, blocked]) => blocked.length >= PILEUP_MIN
    );
    expect(pileups).toHaveLength(0);
  });

  it('does NOT flag a pileup when only 1 task is blocked', () => {
    const tasks: TaskRecord[] = [
      {
        id: 'root',
        subject: 'Root',
        description: '',
        activeForm: '',
        owner: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        sessionId: 's2',
        mtimeMs: Date.now(),
      },
      {
        id: 'child1',
        subject: 'Child',
        description: '',
        activeForm: '',
        owner: '',
        status: 'pending',
        blocks: [],
        blockedBy: ['root'],
        sessionId: 's2',
        mtimeMs: Date.now(),
      },
    ];

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const groups = new Map<string, TaskRecord[]>();
    for (const t of tasks) {
      for (const rootId of t.blockedBy) {
        const root = byId.get(rootId);
        if (root && root.status !== 'completed') {
          const group = groups.get(rootId) ?? [];
          group.push(t);
          groups.set(rootId, group);
        }
      }
    }
    const pileups = [...groups.entries()].filter(
      ([, blocked]) => blocked.length >= PILEUP_MIN
    );
    expect(pileups).toHaveLength(0); // only 1 blocked, need >= 2
  });
});

// ── SPA/server boundary (#2960) — structural, not Vite-stub-dependent ─────────
// The pure summarize half lives in the node-free leaf `parse-tasks-summary.ts`
// so browser-reachable code can value-import it without pulling `node:fs` into
// the sample bundle. These source-contract checks fail at unit-test time — before
// any build — if the leaf gains a node import or the browser component reaches
// back to the server-only `parse-tasks` for a value.
describe('SPA/server boundary (#2960)', () => {
  const readSrc = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('the summarize leaf imports no node built-in', () => {
    const leaf = readSrc('./parse-tasks-summary.ts');
    expect(leaf).not.toMatch(/from ['"]node:/);
    expect(leaf).not.toMatch(/\bfrom ['"]\.\/bounded-fs['"]/);
  });

  it('TaskHealthPf value-imports the summarize half from the node-free leaf, not parse-tasks', () => {
    const src = readSrc('../components/TaskHealthPf.tsx');
    const valueImportsFrom = (mod: string) =>
      src
        .split('\n')
        .some(
          (l) =>
            /^\s*import\b/.test(l) &&
            !/^\s*import\s+type\b/.test(l) &&
            l.includes(`from '${mod}'`)
        );
    // The value import must resolve to the leaf …
    expect(src).toContain("from '../lib/parse-tasks-summary'");
    // … and must NOT be a value import of the server-only parse-tasks module.
    expect(valueImportsFrom('../lib/parse-tasks')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Directory boundary + finite defaults (#3378)
// ---------------------------------------------------------------------------

describe('parseTasksDir — the tasks directory is the boundary (#3378)', () => {
  const taskFile = (status: string) =>
    JSON.stringify({ status, description: 'd', activeForm: 'a' });

  it('refuses a symlinked task file pointing outside the session directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tasks-outside-'));
    const dir = mkdtempSync(join(tmpdir(), 'tasks-boundary-'));
    const sessionDir = join(dir, 'sess-1');
    mkdirSync(sessionDir);

    const target = join(outside, 'stolen.json');
    writeFileSync(target, taskFile('pending'));
    symlinkSync(target, join(sessionDir, 'a.json'));

    // A real sibling proves the parser is otherwise working on this fixture.
    writeFileSync(join(sessionDir, 'b.json'), taskFile('completed'));

    const records = parseTasksDir(dir);
    expect(records.map((r) => r.status)).toEqual(['completed']);
  });

  it('refuses a symlinked SESSION directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tasks-outdir-'));
    mkdirSync(join(outside, 'foreign'));
    writeFileSync(join(outside, 'foreign', 'a.json'), taskFile('pending'));

    const dir = mkdtempSync(join(tmpdir(), 'tasks-dirlink-'));
    symlinkSync(join(outside, 'foreign'), join(dir, 'sess-linked'));

    expect(parseTasksDir(dir)).toEqual([]);
  });

  it('applies a finite per-file byte cap by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-cap-'));
    const sessionDir = join(dir, 'sess-1');
    mkdirSync(sessionDir);
    // Padding a valid record past the default budget must skip it. Before
    // #3378 the default was -1, i.e. no cap at all.
    const huge = JSON.stringify({
      status: 'pending',
      description: 'x'.repeat(DEFAULT_ARTIFACT_MAX_FILE_BYTES + 100),
      activeForm: 'a',
    });
    writeFileSync(join(sessionDir, 'big.json'), huge);
    expect(parseTasksDir(dir)).toEqual([]);
    // An explicit larger cap still wins, in both directions.
    expect(parseTasksDir(dir, { maxFileBytes: huge.length + 10 })).toHaveLength(1);
  });

  // #3157: the combined escape — a symlinked SESSION dir AND a symlinked task
  // file, both pointing outside the task root — yields no records from either,
  // while ordinary in-root files still parse.
  it('refuses both a symlinked session dir and a symlinked task file, still parsing in-root files (#3157)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tasks-3157-outside-'));
    // A foreign session directory and a foreign task file, both outside root.
    mkdirSync(join(outside, 'foreign-session'));
    writeFileSync(join(outside, 'foreign-session', '1.json'), taskFile('pending'));
    writeFileSync(join(outside, 'stolen.json'), taskFile('in_progress'));

    const dir = mkdtempSync(join(tmpdir(), 'tasks-3157-root-'));
    // (1) a symlinked SESSION directory pointing outside the root
    symlinkSync(join(outside, 'foreign-session'), join(dir, 'sess-linked'));
    // (2) a real session dir with a symlinked .json pointing outside …
    const realSession = join(dir, 'sess-real');
    mkdirSync(realSession);
    symlinkSync(join(outside, 'stolen.json'), join(realSession, 'a.json'));
    // … alongside an ordinary in-root file that MUST still parse.
    writeFileSync(join(realSession, 'b.json'), taskFile('completed'));

    const records = parseTasksDir(dir);
    // Neither escape yields a record; only the in-root file does.
    expect(records.map((r) => r.status)).toEqual(['completed']);
    expect(records.map((r) => r.sessionId)).toEqual(['sess-real']);
  });
});
