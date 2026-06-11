import { describe, it, expect } from 'vitest';
import { appendClaudeMdFix } from './claude-md-append';
import { claudeMdMarksApplied } from './detectors/shared';
import type { RecFix } from './detectors/types';

const RATE_LIMIT_FIX: RecFix = {
  target: 'CLAUDE.md',
  label: 'Add rate-limit hygiene',
  note: 'Append to your project CLAUDE.md.',
  snippet: [
    '## Rate-limit hygiene',
    '',
    'Serialize heavy automated batches so a burst of agents does not trip 429s.',
  ].join('\n'),
  appliedMarkers: {
    headings: [/^##\s+rate-limit hygiene/i],
    bodyPhrases: ['serialize heavy automated batches'],
  },
};

describe('appendClaudeMdFix', () => {
  it('appends a CLAUDE.md fix snippet to the end of the body', () => {
    const current = '# Project conventions\n\nUse a worktree for PR work.\n';
    const result = appendClaudeMdFix(current, RATE_LIMIT_FIX);

    expect(result.status).toBe('appended');
    // Append-only: the existing content is preserved verbatim as a prefix.
    expect(result.body.startsWith('# Project conventions\n\nUse a worktree for PR work.')).toBe(
      true
    );
    expect(result.body).toContain('## Rate-limit hygiene');
    expect(result.appended).toContain('Serialize heavy automated batches');
  });

  it('creates the body from empty when the file does not yet exist', () => {
    const result = appendClaudeMdFix('', RATE_LIMIT_FIX);
    expect(result.status).toBe('appended');
    expect(result.body.trimStart().startsWith('## Rate-limit hygiene')).toBe(true);
  });

  it('never rewrites existing sections — original lines survive byte-for-byte', () => {
    const current = '## Existing\n\nDo not touch this line.\n';
    const result = appendClaudeMdFix(current, RATE_LIMIT_FIX);
    expect(result.body).toContain('## Existing');
    expect(result.body).toContain('Do not touch this line.');
    // The existing section is unchanged; only new content is added after it.
    const existingIdx = result.body.indexOf('## Existing');
    const newIdx = result.body.indexOf('## Rate-limit hygiene');
    expect(existingIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeGreaterThan(existingIdx);
  });

  it('is idempotent: a second append is a no-op once markers are present', () => {
    const once = appendClaudeMdFix('', RATE_LIMIT_FIX);
    const twice = appendClaudeMdFix(once.body, RATE_LIMIT_FIX);
    expect(twice.status).toBe('already-applied');
    expect(twice.body).toBe(once.body);
    expect(twice.appended).toBe('');
  });

  it('registers adoption via the normal marker transition (no special-casing)', () => {
    const result = appendClaudeMdFix('', RATE_LIMIT_FIX);
    // The same matcher the engine uses to suppress the finding now returns true
    // against the appended project body — adoption flows through the ordinary path.
    const matched = claudeMdMarksApplied(
      { claudeMd: { perProject: { proj: result.body } } },
      RATE_LIMIT_FIX.appliedMarkers
    );
    expect(matched).toBe(true);
  });

  it('refuses non-CLAUDE.md targets (opt-in append only writes CLAUDE.md)', () => {
    const settingsFix: RecFix = {
      target: 'settings.json',
      label: 'Add deny rules',
      note: 'merge into permissions',
      snippet: '{ "permissions": { "deny": ["Bash(rm -rf:*)"] } }',
    };
    const result = appendClaudeMdFix('# existing\n', settingsFix);
    expect(result.status).toBe('not-applicable');
    expect(result.body).toBe('# existing\n');
    expect(result.appended).toBe('');
  });

  it('treats a CLAUDE.md fix with no snippet as not-applicable', () => {
    const emptyFix: RecFix = {
      target: 'CLAUDE.md',
      label: 'x',
      note: 'x',
      snippet: '   ',
    };
    const result = appendClaudeMdFix('# existing\n', emptyFix);
    expect(result.status).toBe('not-applicable');
    expect(result.body).toBe('# existing\n');
  });

  it('dedupes on literal snippet text even without declared markers', () => {
    const markerlessFix: RecFix = {
      target: 'CLAUDE.md',
      label: 'Note',
      note: 'append',
      snippet: '## Heavy-batch note\n\nKeep fan-out under ten workers.',
    };
    const once = appendClaudeMdFix('', markerlessFix);
    expect(once.status).toBe('appended');
    const twice = appendClaudeMdFix(once.body, markerlessFix);
    expect(twice.status).toBe('already-applied');
    expect(twice.body).toBe(once.body);
  });
});
