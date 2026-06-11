import { describe, it, expect } from 'vitest';
import {
  parseConfigSections,
  parseConfigSet,
  countConfigReferences,
  type ConfigSource,
} from './parse-config-sections';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLAUDE_MD = `# Project conventions — Claude Code

@AGENTS.md

The shared conventions live in @AGENTS.md and are imported above.

## Working effectively

At the start of a task, run /recs — it pulls the local engine. The
\`compound-engineering:ce-commit\` skill commits. See \`src/lib/api-client.ts\`
and \`scripts/server.mjs\` for the boundary. The \`mcp__github__create_pull_request\`
tool opens PRs.

## Hooks

A \`SessionStart\` hook wired in \`settings.json\` injects recs. The
\`hooks.Stop\` and \`permissions.allow\` keys govern this.

\`\`\`bash
# This is example shell inside a fence — its /not-a-command and
# src/should-not/leak.ts must NOT become references.
gh issue create --label backlog
\`\`\`
`;

const WITH_FRONTMATTER = `---
name: my-skill
description: Does a thing
---

# Heading One

References \`src/lib/foo.ts\` and /do-thing.
`;

// ── Section splitting ────────────────────────────────────────────────────────

describe('parseConfigSections — structure', () => {
  it('explodes a document into one record per heading plus a preamble', () => {
    const secs = parseConfigSections({ scope: 'CLAUDE.md', content: CLAUDE_MD });
    const headings = secs.map((s) => s.heading);
    expect(headings).toEqual([
      'Project conventions — Claude Code',
      'Working effectively',
      'Hooks',
    ]);
    expect(secs.every((s) => s.sourceScope === 'CLAUDE.md')).toBe(true);
  });

  it('captures a pre-heading preamble as a level-0 section', () => {
    const secs = parseConfigSections({
      scope: 'X.md',
      content: 'intro prose with no heading\n\n# Later\n\nbody',
    });
    expect(secs[0].level).toBe(0);
    expect(secs[0].heading).toBe('');
    expect(secs[0].id).toBe('X.md#__preamble__');
    expect(secs[1].heading).toBe('Later');
  });

  it('does not emit an empty preamble when the doc starts with a heading', () => {
    const secs = parseConfigSections({ scope: 'X.md', content: '# A\n\nbody' });
    expect(secs).toHaveLength(1);
    expect(secs[0].heading).toBe('A');
  });

  it('disambiguates repeated headings with a stable -N suffix', () => {
    const secs = parseConfigSections({
      scope: 'X.md',
      content: '# Notes\n\na\n\n# Notes\n\nb',
    });
    expect(secs.map((s) => s.id)).toEqual(['X.md#notes', 'X.md#notes-2']);
  });

  it('strips a leading YAML frontmatter block', () => {
    const secs = parseConfigSections({
      scope: 'skills/my-skill/SKILL.md',
      content: WITH_FRONTMATTER,
    });
    // Frontmatter is not a section; first record is the real heading.
    expect(secs.map((s) => s.heading)).toEqual(['Heading One']);
  });

  it('does not treat a #-prefixed line inside a code fence as a heading', () => {
    const secs = parseConfigSections({ scope: 'CLAUDE.md', content: CLAUDE_MD });
    // The `# This is example shell` line lives inside the Hooks fence.
    expect(secs.map((s) => s.heading)).not.toContain('This is example shell inside a fence — its /not-a-command and');
    expect(secs).toHaveLength(3);
  });
});

// ── Reference extraction (one assertion family per kind) ─────────────────────

describe('parseConfigSections — references', () => {
  const secs = parseConfigSections({ scope: 'CLAUDE.md', content: CLAUDE_MD });
  const refsOf = (heading: string) =>
    secs.find((s) => s.heading === heading)!.references;
  const targets = (heading: string, kind: string) =>
    refsOf(heading)
      .filter((r) => r.kind === kind)
      .map((r) => r.target);

  it('extracts @path import references', () => {
    expect(targets('Project conventions — Claude Code', 'import')).toContain('AGENTS.md');
  });

  it('extracts /slash-command references', () => {
    expect(targets('Working effectively', 'command')).toContain('/recs');
  });

  it('extracts namespaced plugin:skill references', () => {
    expect(targets('Working effectively', 'skill')).toContain('compound-engineering:ce-commit');
  });

  it('extracts file-path references', () => {
    const files = targets('Working effectively', 'file');
    expect(files).toContain('src/lib/api-client.ts');
    expect(files).toContain('scripts/server.mjs');
  });

  it('extracts mcp__server__tool references', () => {
    expect(targets('Working effectively', 'mcp')).toContain('mcp__github__create_pull_request');
  });

  it('extracts hook/config-key references', () => {
    const keys = targets('Hooks', 'configKey');
    expect(keys).toContain('SessionStart');
    expect(keys).toContain('hooks.Stop');
    expect(keys).toContain('permissions.allow');
  });

  it('recognizes a bare config filename (settings.json) as a file reference', () => {
    expect(targets('Hooks', 'file')).toContain('settings.json');
  });

  it('ignores references that live inside fenced code blocks', () => {
    const hookRefs = refsOf('Hooks');
    expect(hookRefs.map((r) => r.target)).not.toContain('/not-a-command');
    expect(hookRefs.map((r) => r.target)).not.toContain('src/should-not/leak.ts');
  });

  it('dedupes and sorts references', () => {
    const refs = refsOf('Project conventions — Claude Code');
    const keys = refs.map((r) => `${r.kind} ${r.target}`);
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys).toEqual([...keys].sort());
  });
});

// ── Stable ids ───────────────────────────────────────────────────────────────

describe('parseConfigSections — id stability', () => {
  it('keeps a section id stable when its body changes', () => {
    const before = parseConfigSections({
      scope: 'A.md',
      content: '# Intro\n\noriginal body\n\n## Deep\n\nx',
    });
    const after = parseConfigSections({
      scope: 'A.md',
      content: '# Intro\n\ncompletely rewritten body with new refs src/x.ts\n\n## Deep\n\nx',
    });
    const idOf = (arr: typeof before, h: string) => arr.find((s) => s.heading === h)!.id;
    expect(idOf(after, 'Intro')).toBe(idOf(before, 'Intro'));
    expect(idOf(after, 'Deep')).toBe(idOf(before, 'Deep'));
  });

  it('keeps sibling ids stable when a section is inserted above', () => {
    const before = parseConfigSections({ scope: 'A.md', content: '# B\n\nx\n\n# C\n\ny' });
    const after = parseConfigSections({ scope: 'A.md', content: '# A\n\nnew\n\n# B\n\nx\n\n# C\n\ny' });
    const idOf = (arr: typeof before, h: string) => arr.find((s) => s.heading === h)!.id;
    expect(idOf(after, 'B')).toBe(idOf(before, 'B'));
    expect(idOf(after, 'C')).toBe(idOf(before, 'C'));
  });

  it('changes the hash when body content changes', () => {
    const a = parseConfigSections({ scope: 'A.md', content: '# H\n\none' })[0];
    const b = parseConfigSections({ scope: 'A.md', content: '# H\n\ntwo' })[0];
    expect(a.id).toBe(b.id);
    expect(a.hash).not.toBe(b.hash);
  });

  it('keeps distinct slug-colliding headings stable under reorder', () => {
    // `Hooks!` and `Hooks?` both slugify to `hooks`; their ids must be
    // content-addressed (heading hash), not positional, so reordering the
    // document does not swap which id points at which heading.
    const fwd = parseConfigSections({ scope: 'A.md', content: '# Hooks!\n\nx\n\n# Hooks?\n\ny' });
    const rev = parseConfigSections({ scope: 'A.md', content: '# Hooks?\n\ny\n\n# Hooks!\n\nx' });
    const idOf = (arr: typeof fwd, h: string) => arr.find((s) => s.heading === h)!.id;
    // The two distinct headings get two distinct ids...
    expect(idOf(fwd, 'Hooks!')).not.toBe(idOf(fwd, 'Hooks?'));
    // ...and each id is identical regardless of document order.
    expect(idOf(rev, 'Hooks!')).toBe(idOf(fwd, 'Hooks!'));
    expect(idOf(rev, 'Hooks?')).toBe(idOf(fwd, 'Hooks?'));
  });
});

// ── Privacy: no body text persisted ──────────────────────────────────────────

describe('parseConfigSections — privacy', () => {
  it('never includes section body text in any record field', () => {
    const secret = 'SUPERSECRETBODYTOKEN12345';
    const secs = parseConfigSections({
      scope: 'A.md',
      content: `# H\n\nThis paragraph contains ${secret} which must not leak.`,
    });
    const serialized = JSON.stringify(secs);
    expect(serialized).not.toContain(secret);
    // The record shape carries only structural fields — assert the exact keys.
    expect(Object.keys(secs[0]).sort()).toEqual(
      ['hash', 'heading', 'id', 'level', 'mtime', 'references', 'sourceScope'].sort(),
    );
  });

  it('does not retain prose even when it looks like a reference list', () => {
    const secs = parseConfigSections({
      scope: 'A.md',
      content: '# H\n\nThe quick brown fox jumped over the lazy dog repeatedly.',
    });
    expect(JSON.stringify(secs)).not.toContain('quick brown fox');
  });

  it('does not turn common English words into references', () => {
    // `Stop` / `Notification` are hook events but also plain words; `also:see`
    // is `word:word`; `/etc/passwd` is an absolute path, not a `/command`.
    const secs = parseConfigSections({
      scope: 'A.md',
      content: '# H\n\nPlease Stop and send a Notification; see also:see and edit /etc/passwd.',
    });
    const targets = secs[0].references.map((r) => r.target);
    expect(targets).not.toContain('Stop');
    expect(targets).not.toContain('Notification');
    expect(targets).not.toContain('also:see');
    expect(targets).not.toContain('/etc');
  });
});

// ── Set-level helpers ────────────────────────────────────────────────────────

describe('parseConfigSet', () => {
  it('flattens multiple sources sorted by scope then id', () => {
    const sources: ConfigSource[] = [
      { scope: 'CLAUDE.md', content: '# Z\n\nx' },
      { scope: 'AGENTS.md', content: '# A\n\ny' },
    ];
    const secs = parseConfigSet(sources);
    expect(secs.map((s) => s.sourceScope)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('carries mtime through when supplied and null otherwise', () => {
    const withM = parseConfigSections({ scope: 'A.md', content: '# H\n\nx', mtime: 1700000000000 });
    const without = parseConfigSections({ scope: 'A.md', content: '# H\n\nx' });
    expect(withM[0].mtime).toBe(1700000000000);
    expect(without[0].mtime).toBeNull();
  });

  it('counts references across a section set', () => {
    const secs = parseConfigSet([{ scope: 'CLAUDE.md', content: CLAUDE_MD }]);
    expect(countConfigReferences(secs)).toBeGreaterThan(0);
  });

  it('is tolerant of empty / nullish input', () => {
    expect(parseConfigSections({ scope: 'A.md', content: '' })).toEqual([]);
    expect(parseConfigSet([])).toEqual([]);
  });
});
