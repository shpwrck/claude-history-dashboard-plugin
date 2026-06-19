import { describe, expect, it } from 'vitest';
import {
  wrapCommandSnippet,
  aliasCommandSnippet,
} from './repeated-command-snippet';

describe('wrapCommandSnippet', () => {
  it('wraps the command verbatim in an executable script under scripts/', () => {
    const snippet = wrapCommandSnippet('npm test');
    expect(snippet).toContain('scripts/npm.sh');
    expect(snippet).toContain('#!/usr/bin/env bash');
    expect(snippet).toContain('set -euo pipefail');
    // The original command body is preserved exactly.
    expect(snippet).toContain('\nnpm test\n');
    expect(snippet).toContain('chmod +x scripts/npm.sh');
    expect(snippet).toContain('./scripts/npm.sh');
  });

  it('derives the slug from the program name, stripping a leading path', () => {
    expect(wrapCommandSnippet('./scripts/deploy.sh --prod')).toContain(
      'scripts/deploy-sh.sh'
    );
  });

  it('preserves pipes, flags, and quotes inside the heredoc body', () => {
    const command = `git log --oneline | grep "fix" | head -5`;
    const snippet = wrapCommandSnippet(command);
    expect(snippet).toContain(command);
  });

  it('falls back to a stable slug for an empty command', () => {
    expect(wrapCommandSnippet('   ')).toContain('scripts/command.sh');
  });

  it('chooses a collision-safe delimiter when the body contains a line "SH"', () => {
    // A multi-line command whose body has a standalone `SH` line — if the
    // wrapper used a plain `SH` delimiter, that line would close the heredoc
    // early and the trailing lines would run as top-level shell on paste.
    const command = "cat > x <<'SH'\nhello\nSH\nrm -rf .";
    const snippet = wrapCommandSnippet(command);

    // The opener uses the escalated delimiter, not plain SH (which collides
    // with a body line). The body itself still legitimately contains `<<'SH'`.
    expect(snippet).toContain("mkdir -p scripts && cat > scripts/cat.sh <<'SH_1'");

    // The full command body round-trips verbatim inside the heredoc, and the
    // chosen closing delimiter sits on its own line immediately after it.
    expect(snippet).toContain(`\n${command}\nSH_1\n`);
  });

  it('escalates the delimiter suffix when SH and SH_1 both appear in the body', () => {
    const command = 'first\nSH\nSH_1\nlast';
    const snippet = wrapCommandSnippet(command);

    expect(snippet).toContain("<<'SH_2'");
    // Body preserved exactly, closed by the non-colliding delimiter on its own line.
    expect(snippet).toContain(`\n${command}\nSH_2\n`);
  });
});

describe('aliasCommandSnippet', () => {
  it('emits a single-quoted alias for a shell rc file', () => {
    expect(aliasCommandSnippet('npm test')).toBe("alias npm='npm test'");
  });

  it('escapes embedded single quotes safely', () => {
    expect(aliasCommandSnippet(`echo 'hi'`)).toBe(
      "alias echo='echo '\\''hi'\\'''"
    );
  });
});
