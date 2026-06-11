/**
 * Tests for the skill-candidate audit (#605 / #739).
 *
 * The draft-judge is injected, so these cover the deterministic successful-
 * trajectory detection -> judge-draft path without the network, plus the
 * per-candidate failure isolation the no-500 route contract relies on, and the
 * PROPOSE-ONLY / no-filesystem-write guarantee.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  detectSuccessfulTrajectories,
  runSkillCandidateAudit,
  parseDraftVerdict,
  DEFAULT_DETECT_OPTIONS,
  type SkillCandidateSession,
  type DraftJudgeFn,
} from './skill-candidates';

// A Read -> Edit -> Bash trajectory recurs across two SUCCESSFUL sessions; a
// third successful session is unrelated noise; a fourth session shares the same
// trajectory but ended BADLY and must be excluded.
const FIXTURE: SkillCandidateSession[] = [
  { sessionId: 's1', project: 'demo', tools: ['Read', 'Edit', 'Bash', 'Read', 'Grep'], good: true },
  { sessionId: 's2', project: 'demo', tools: ['Grep', 'Read', 'Edit', 'Bash'], good: true },
  { sessionId: 's3', project: 'demo', tools: ['WebFetch', 'WebSearch', 'WebFetch'], good: true },
  { sessionId: 'bad', project: 'demo', tools: ['Read', 'Edit', 'Bash'], good: false },
];

const draftJudge: DraftJudgeFn = async () => ({
  isFinding: true,
  rationale: 'Recurs and keeps working — worth a reusable artifact.',
  confidence: 'high',
  artifactType: 'skill',
  draft: 'name: read-edit-verify\nsteps:\n  - Read\n  - Edit\n  - Bash (verify)',
});

describe('detectSuccessfulTrajectories', () => {
  it('finds the cross-session SUCCESSFUL trajectory', () => {
    const found = detectSuccessfulTrajectories(FIXTURE);
    const hit = found.find((c) => c.signature === 'Read -> Edit -> Bash');
    expect(hit).toBeDefined();
    // Only the two GOOD sessions count — the bad session sharing the trajectory
    // is excluded.
    expect(hit!.sessions).toEqual(['s1', 's2']);
    expect(hit!.length).toBe(3);
  });

  it('excludes bad-outcome sessions from the trajectory evidence', () => {
    // If the only sessions carrying a trajectory failed, it must not surface.
    const allBad: SkillCandidateSession[] = [
      { sessionId: 'b1', project: 'demo', tools: ['Read', 'Edit', 'Bash'], good: false },
      { sessionId: 'b2', project: 'demo', tools: ['Read', 'Edit', 'Bash'], good: false },
    ];
    expect(detectSuccessfulTrajectories(allBad)).toEqual([]);
  });

  it('ignores trajectories confined to a single good session', () => {
    const single: SkillCandidateSession[] = [
      { sessionId: 'only', project: 'demo', tools: ['A', 'B', 'C', 'D'], good: true },
    ];
    expect(detectSuccessfulTrajectories(single)).toEqual([]);
  });

  it('skips single-tool retry-loop windows', () => {
    const retries: SkillCandidateSession[] = [
      { sessionId: 'r1', project: 'demo', tools: ['Bash', 'Bash', 'Bash'], good: true },
      { sessionId: 'r2', project: 'demo', tools: ['Bash', 'Bash', 'Bash'], good: true },
    ];
    expect(detectSuccessfulTrajectories(retries)).toEqual([]);
  });

  it('respects the topN cap', () => {
    const out = detectSuccessfulTrajectories(FIXTURE, {
      ...DEFAULT_DETECT_OPTIONS,
      topN: 1,
    });
    expect(out).toHaveLength(1);
  });
});

describe('runSkillCandidateAudit', () => {
  it('emits a propose-only finding carrying the draft + artifact type', async () => {
    const candidates = detectSuccessfulTrajectories(FIXTURE);
    const findings = await runSkillCandidateAudit(candidates, draftJudge);
    const f = findings.find((x) => x.id === 'skill-candidate:Read -> Edit -> Bash');
    expect(f).toBeDefined();
    expect(f!.domain).toBe('workflow');
    expect(f!.confidence).toBe('high');
    expect(f!.evidenceRefs).toContain('session:s1');
    // The summary names the artifact type ('skill').
    expect(f!.summary).toContain('reusable skill');
    // The rationale carries the proposed draft text (the proposal payload).
    expect(f!.judgeRationale).toContain('read-edit-verify');
    expect(f!.judgeRationale).toContain('DRAFT');
  });

  it('drops candidates the judge rejects', async () => {
    const reject: DraftJudgeFn = async () => ({
      isFinding: false,
      rationale: 'Too varied to crystallize.',
      confidence: 'low',
      artifactType: 'claude-md-rule',
      draft: '',
    });
    expect(
      await runSkillCandidateAudit(detectSuccessfulTrajectories(FIXTURE), reject)
    ).toEqual([]);
  });

  it('isolates a per-candidate judge failure', async () => {
    // Two distinct cross-session SUCCESSFUL trajectories so one can fail while
    // the other lands.
    const twoSeq: SkillCandidateSession[] = [
      { sessionId: 'a1', project: 'demo', tools: ['Read', 'Edit', 'Bash'], good: true },
      { sessionId: 'a2', project: 'demo', tools: ['Read', 'Edit', 'Bash'], good: true },
      { sessionId: 'c1', project: 'demo', tools: ['Grep', 'Glob', 'Read'], good: true },
      { sessionId: 'c2', project: 'demo', tools: ['Grep', 'Glob', 'Read'], good: true },
    ];
    const candidates = detectSuccessfulTrajectories(twoSeq);
    expect(candidates.length).toBeGreaterThan(1);
    const flaky: DraftJudgeFn = async ({ user }) => {
      if (user.includes(candidates[0].signature)) throw new Error('transient');
      return {
        isFinding: true,
        rationale: 'ok',
        confidence: 'medium',
        artifactType: 'command',
        draft: 'do the thing',
      };
    };
    const findings = await runSkillCandidateAudit(candidates, flaky);
    expect(findings.some((f) => f.id.includes(candidates[0].signature))).toBe(false);
    expect(findings.length).toBe(candidates.length - 1);
  });
});

describe('parseDraftVerdict', () => {
  it('extracts the artifact fields from a JSON reply', () => {
    const v = parseDraftVerdict(
      'Here: {"isFinding": true, "rationale": "yes", "confidence": "medium", ' +
        '"artifactType": "command", "draft": "/do-it"}'
    );
    expect(v).toEqual({
      isFinding: true,
      rationale: 'yes',
      confidence: 'medium',
      artifactType: 'command',
      draft: '/do-it',
    });
  });

  it('defaults safely on a malformed / non-JSON reply', () => {
    const v = parseDraftVerdict('no json here');
    expect(v.isFinding).toBe(false);
    expect(v.artifactType).toBe('claude-md-rule');
    expect(v.draft).toBe('');
  });

  it('coerces an invalid artifactType to claude-md-rule', () => {
    const v = parseDraftVerdict('{"isFinding": true, "artifactType": "bogus"}');
    expect(v.artifactType).toBe('claude-md-rule');
  });
});

describe('no-write guarantee (PROPOSE-ONLY)', () => {
  it('returns proposals only — every finding carries a draft, none is written', async () => {
    const findings = await runSkillCandidateAudit(
      detectSuccessfulTrajectories(FIXTURE),
      draftJudge
    );
    expect(findings.length).toBeGreaterThan(0);
    // A propose-only finding is a plain object with the draft embedded; there is
    // no side channel (no path, no write handle) on it.
    for (const f of findings) {
      expect(f.judgeRationale).toContain('Proposed');
      expect(Object.keys(f).sort()).toEqual(
        ['confidence', 'domain', 'evidenceRefs', 'id', 'judgeRationale', 'summary'].sort()
      );
    }
  });

  it('the module source imports no filesystem writer', () => {
    // Source-level assertion of the no-write contract: the audit must never
    // import fs / node:fs / writeFile etc. — it only PROPOSES.
    const src = readFileSync(
      fileURLToPath(new URL('./skill-candidates.ts', import.meta.url)),
      'utf8'
    );
    expect(/from\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(src)).toBe(false);
    expect(/writeFileSync|writeFile\b|appendFile|\bmkdir/.test(src)).toBe(false);
  });
});
