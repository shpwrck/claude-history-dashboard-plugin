/**
 * Tests for parse-file-history.ts — scoreSession (pure math) and
 * parseFileHistoryDir (filesystem walk against a synthetic tmp dir).
 *
 * NEVER reads @v2 file bodies — only mtime-based structural counts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scoreSession,
  parseFileHistoryDir,
  aggregateByProject,
  type FileHistorySession,
} from './parse-file-history';

// ── Pure scoring math ─────────────────────────────────────────────────────────

describe('scoreSession (pure math)', () => {
  it('returns zero spanMin + churn burstRate when first === last', () => {
    const { spanMin, burstRate, reworkScore } = scoreSession({
      churn: 5,
      firstMs: 1_000_000,
      lastMs: 1_000_000,
    });
    expect(spanMin).toBe(0);
    // spanMin=0 => max(1, spanMin)=1 => burstRate = 5/1 = 5
    expect(burstRate).toBe(5);
    expect(reworkScore).toBe(+(5 * (1 + 5)).toFixed(1)); // 30.0
  });

  it('computes correct spanMin from ms gap', () => {
    // 120 000 ms = 2 min
    const { spanMin } = scoreSession({ churn: 4, firstMs: 0, lastMs: 120_000 });
    expect(spanMin).toBe(2);
  });

  it('computes burstRate = churn / spanMin when spanMin > 1', () => {
    // spanMin = 10, churn = 20 => burstRate = 2.00
    const { burstRate } = scoreSession({ churn: 20, firstMs: 0, lastMs: 600_000 });
    expect(burstRate).toBe(2.00);
  });

  it('reworkScore = churn * (1 + burstRate)', () => {
    // churn=6, spanMin=3 => burstRate=2 => score=6*(1+2)=18
    const { reworkScore } = scoreSession({ churn: 6, firstMs: 0, lastMs: 180_000 });
    expect(reworkScore).toBe(18.0);
  });

  it('handles churn=1 single snapshot gracefully', () => {
    const result = scoreSession({ churn: 1, firstMs: 5_000, lastMs: 5_000 });
    expect(result.spanMin).toBe(0);
    expect(result.reworkScore).toBeGreaterThan(0);
  });
});

// ── Filesystem walk ───────────────────────────────────────────────────────────

// We'll set a deterministic mtime (unix epoch seconds) via utimesSync.
const T0_MS = 1_780_000_000_000; // arbitrary base
const T1_MS = T0_MS + 120_000;   // +2 min later


// Create a synthetic file-history tree:
//
//  <tmp>/
//    sessionA/              2 @v2 snapshots, 2-minute span
//      abc123@v2
//      def456@v2
//    sessionB/              4 @v2 snapshots, 0-second span (all same mtime)
//      aaa111@v2
//      bbb222@v2
//      ccc333@v2
//      ddd444@v2
//    sessionC/              0 @v2 snapshots (only a .txt) — should be skipped
//      notes.txt
//    not-a-dir.txt          top-level file — should be skipped

const tmpRoot = mkdtempSync(join(tmpdir(), 'fh-test-'));

function makeSnap(dir: string, name: string, mtimeMs: number) {
  const p = join(dir, name);
  writeFileSync(p, ''); // empty marker; bodies never read
  const sec = mtimeMs / 1000;
  utimesSync(p, sec, sec);
}

// sessionA
const dirA = join(tmpRoot, 'sessionA');
mkdirSync(dirA);
makeSnap(dirA, 'abc123@v2', T0_MS);
makeSnap(dirA, 'def456@v2', T1_MS);

// sessionB — all same mtime => spanMin=0
const dirB = join(tmpRoot, 'sessionB');
mkdirSync(dirB);
for (const name of ['aaa111@v2', 'bbb222@v2', 'ccc333@v2', 'ddd444@v2']) {
  makeSnap(dirB, name, T0_MS);
}

// sessionC — no @v2 files, should be skipped
const dirC = join(tmpRoot, 'sessionC');
mkdirSync(dirC);
writeFileSync(join(dirC, 'notes.txt'), 'not a snapshot');

// top-level file
writeFileSync(join(tmpRoot, 'not-a-dir.txt'), 'top-level file');

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parseFileHistoryDir', () => {
  let sessions: FileHistorySession[];

  it('returns entries only for dirs with @v2 files', () => {
    sessions = parseFileHistoryDir(tmpRoot);
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sessionA', 'sessionB']);
  });

  it('sessionA: churn=2, spanMin=2, correct burst+rework', () => {
    sessions = parseFileHistoryDir(tmpRoot);
    const a = sessions.find((s) => s.sessionId === 'sessionA')!;
    expect(a.churn).toBe(2);
    expect(a.spanMin).toBe(2);
    // burstRate = 2/2 = 1.00
    expect(a.burstRate).toBe(1.00);
    // reworkScore = 2*(1+1) = 4.0
    expect(a.reworkScore).toBe(4.0);
    expect(a.firstMs).toBe(T0_MS);
    expect(a.lastMs).toBe(T1_MS);
  });

  it('sessionB: churn=4, spanMin=0, burstRate=churn/1=4, reworkScore=4*5=20', () => {
    sessions = parseFileHistoryDir(tmpRoot);
    const b = sessions.find((s) => s.sessionId === 'sessionB')!;
    expect(b.churn).toBe(4);
    expect(b.spanMin).toBe(0);
    expect(b.burstRate).toBe(4.00); // 4/max(1,0)=4
    expect(b.reworkScore).toBe(20.0); // 4*(1+4)
  });

  it('returns empty array for a nonexistent directory', () => {
    expect(parseFileHistoryDir('/nonexistent/path/that/does/not/exist')).toEqual([]);
  });

  it('caps snapshot artifact directory discovery without reading bodies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-file-history-cap-'));
    try {
      const sessionDir = join(dir, 'session-cap');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'a@v2'), 'body-a');
      writeFileSync(join(sessionDir, 'b@v2'), 'body-b');
      writeFileSync(join(sessionDir, 'c@v2'), 'body-c');

      const [session] = parseFileHistoryDir(dir, { maxEntries: 2 });

      expect(session.churn).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Project rollup ────────────────────────────────────────────────────────────

describe('aggregateByProject', () => {
  const sessions: FileHistorySession[] = [
    { sessionId: 's1', churn: 12, spanMin: 3, burstRate: 4, reworkScore: 60, firstMs: 0, lastMs: 180_000 },
    { sessionId: 's2', churn: 11, spanMin: 4, burstRate: 2.75, reworkScore: 41.25, firstMs: 0, lastMs: 240_000 },
    { sessionId: 's3', churn: 2,  spanMin: 2, burstRate: 1, reworkScore: 4, firstMs: 0, lastMs: 120_000 },
  ];

  const projectOf = new Map([
    ['s1', 'payments-api'],
    ['s2', 'payments-api'],
    ['s3', 'infra-scripts'],
  ]);

  it('rolls up two payments-api sessions correctly', () => {
    const projects = aggregateByProject(sessions, projectOf);
    const p = projects.find((x) => x.project === 'payments-api')!;
    expect(p.sessions).toBe(2);
    expect(p.totalChurn).toBe(23);
    expect(p.avgChurn).toBe(11.5);
  });

  it('sorts highest reworkSignature first', () => {
    const projects = aggregateByProject(sessions, projectOf);
    expect(projects[0].project).toBe('payments-api');
  });

  it('groups unknown sessionIds under "(unknown)"', () => {
    const projects = aggregateByProject(sessions, new Map());
    expect(projects).toHaveLength(1);
    expect(projects[0].project).toBe('(unknown)');
  });
});
