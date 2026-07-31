import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  shellQuote,
  isInertShellWord,
  shellQuoteMinimal,
  shellQuotePathWithHome,
} from './shell-quote';

/**
 * Every value below is INERT DATA. The round-trip harness never invokes a
 * command with them — it uses `set --` to load them as positional parameters
 * and `printf` to read them back — so a payload that looks like `rm -rf ~` or
 * `$(id)` is only ever compared as a string. Do not "improve" this harness by
 * running the generated line through a real command.
 */
const HOSTILE_VALUES = [
  // the one character single quotes cannot contain
  "it's",
  "''",
  "'; rm -rf ~ #",
  // whitespace
  'two words',
  '\ttab',
  'trailing ',
  // control operators
  'a;b',
  'a|b',
  'a&b',
  'a&&b',
  'a||b',
  'a>b',
  'a<b',
  'a(b)c',
  'a#b',
  // expansion
  '`id`',
  '$(id)',
  '${HOME}',
  '$HOME',
  '~',
  '~/.claude/skills/x',
  '*',
  'a?b',
  'a[b]c',
  'a{b,c}d',
  '!! ',
  // newlines
  'line1\nline2',
  'line1\r\nline2',
  // option lookalikes
  '-rf',
  '--help',
  '-',
  // boundaries
  '',
  'plain',
  '/home/me/.claude/skills/some-skill',
  'a'.repeat(200),
  'ünïcødé',
];

/**
 * Load `quoted` as the sole positional parameter of a real POSIX shell and read
 * it back. Proves the emitted text parses to exactly one argv element holding
 * the original value — the only property that makes a snippet copy-paste-safe.
 */
function argvThroughSh(quoted: string): { count: string; first: string } {
  const script = `set -- ${quoted}\nprintf '%s\\n' "$#"\nprintf '%s' "$1"`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  const newline = out.indexOf('\n');
  return { count: out.slice(0, newline), first: out.slice(newline + 1) };
}

describe('shellQuote', () => {
  it('always quotes, even a value that would not have needed it', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote('')).toBe("''");
  });

  it('closes, escapes and reopens each embedded single quote', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  it.each(HOSTILE_VALUES)(
    'shellQuote(%j) survives /bin/sh as exactly one argv element',
    (value) => {
      const { count, first } = argvThroughSh(shellQuote(value));
      expect(count).toBe('1');
      expect(first).toBe(value);
    }
  );
});

describe('isInertShellWord', () => {
  it('accepts words made only of characters no shell interprets', () => {
    expect(isInertShellWord('github')).toBe(true);
    expect(isInertShellWord('/home/me/.claude/skills/s')).toBe(true);
    expect(isInertShellWord('a_b-c.d@e%f+g=h:i,j')).toBe(true);
  });

  it.each([
    ['', 'the empty string needs `\'\'` to exist as an argument at all'],
    ['-rf', 'a leading dash reads as an option'],
    ['a b', 'whitespace splits'],
    ['a;b', 'control operator'],
    ['$(id)', 'command substitution'],
    ['`id`', 'backtick substitution'],
    ['$HOME', 'parameter expansion'],
    ['~', 'tilde expansion'],
    ['*', 'globbing'],
    ['a{b,c}', 'brace expansion'],
    ['a!b', 'history expansion'],
    ["it's", 'quote'],
    ['a\nb', 'newline'],
  ])('rejects %j (%s)', (value) => {
    expect(isInertShellWord(value)).toBe(false);
  });
});

describe('shellQuoteMinimal', () => {
  it('passes an inert word through unquoted so snippets stay readable', () => {
    expect(shellQuoteMinimal('github')).toBe('github');
    expect(shellQuoteMinimal('/home/me/.claude/skills/s')).toBe(
      '/home/me/.claude/skills/s'
    );
  });

  it('quotes everything else', () => {
    expect(shellQuoteMinimal("it's")).toBe("'it'\\''s'");
    expect(shellQuoteMinimal('-rf')).toBe("'-rf'");
    expect(shellQuoteMinimal('')).toBe("''");
  });

  it('is exactly the composition of its two parts, so they cannot drift', () => {
    for (const value of HOSTILE_VALUES) {
      expect(shellQuoteMinimal(value)).toBe(
        isInertShellWord(value) ? value : shellQuote(value)
      );
    }
  });

  it.each(HOSTILE_VALUES)(
    'shellQuoteMinimal(%j) survives /bin/sh as exactly one argv element',
    (value) => {
      const { count, first } = argvThroughSh(shellQuoteMinimal(value));
      expect(count).toBe('1');
      expect(first).toBe(value);
    }
  );
});

describe('shellQuotePathWithHome (#3254)', () => {
  /** Same inert-data harness, with HOME pinned so `~`/"$HOME" resolve predictably. */
  function argvThroughShWithHome(quoted: string): { count: string; first: string } {
    const script = `set -- ${quoted}\nprintf '%s\\n' "$#"\nprintf '%s' "$1"`;
    const out = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { HOME: '/home/shelltest', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const newline = out.indexOf('\n');
    return { count: out.slice(0, newline), first: out.slice(newline + 1) };
  }

  it('leaves an inert ~/ path unquoted so tilde expansion still works', () => {
    expect(shellQuotePathWithHome('~/.claude/settings.json')).toBe(
      '~/.claude/settings.json'
    );
    expect(shellQuotePathWithHome('~')).toBe('~');
    const { count, first } = argvThroughShWithHome(
      shellQuotePathWithHome('~/.claude/settings.json')
    );
    expect(count).toBe('1');
    expect(first).toBe('/home/shelltest/.claude/settings.json');
  });

  it('maps a hostile ~/ path to a "$HOME" splice plus the quoted remainder', () => {
    const hostile = "~/.claude/dir name/it's;$(echo INJECTED)/settings.json";
    expect(shellQuotePathWithHome(hostile)).toBe(
      `"$HOME"'/.claude/dir name/it'\\''s;$(echo INJECTED)/settings.json'`
    );
    const { count, first } = argvThroughShWithHome(shellQuotePathWithHome(hostile));
    expect(count).toBe('1');
    expect(first).toBe(
      "/home/shelltest/.claude/dir name/it's;$(echo INJECTED)/settings.json"
    );
  });

  it('follows shellQuoteMinimal for non-home paths', () => {
    expect(shellQuotePathWithHome('/etc/claude/settings.json')).toBe(
      '/etc/claude/settings.json'
    );
    expect(shellQuotePathWithHome('/tmp/two words.json')).toBe(
      "'/tmp/two words.json'"
    );
    expect(shellQuotePathWithHome('')).toBe("''");
  });

  it.each(HOSTILE_VALUES)(
    'shellQuotePathWithHome(%j) survives /bin/sh as exactly one argv element',
    (value) => {
      const { count, first } = argvThroughShWithHome(shellQuotePathWithHome(value));
      expect(count).toBe('1');
      // A `~`-led value may legitimately come back home-expanded; everything
      // else must round-trip byte-identical.
      if (value === '~') {
        expect(first).toBe('/home/shelltest');
      } else if (value.startsWith('~/')) {
        expect(first).toBe(`/home/shelltest${value.slice(1)}`);
      } else {
        expect(first).toBe(value);
      }
    }
  );
});

describe('what quoting does NOT do', () => {
  /**
   * Pins the module's central caveat so nobody later "hardens" a caller by
   * quoting alone: `'-rf'` and `-rf` are the same argv element. A caller that
   * must reject option lookalikes needs a grammar check or a `--` marker.
   */
  it('does not stop a value from being read as an option', () => {
    const { count, first } = argvThroughSh(shellQuote('-rf'));
    expect(count).toBe('1');
    expect(first).toBe('-rf');
  });
});
