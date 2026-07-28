import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { detector, isSupportedMcpServerName, shellQuote, displayServerName } from './mcp-needs-auth';
import { validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { McpAuthState } from '../../parse-mcp-auth';
import type { Session } from '../../../types';
import type { SessionAttribution } from '../../parse-agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InputWithMcpAuth = RecommendationInput & { mcpAuth?: McpAuthState | null };

/** Minimal valid RecommendationInput baseline */
function baseInput(overrides: Partial<InputWithMcpAuth> = {}): InputWithMcpAuth {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function sdkSession(id: string): Session {
  return {
    sessionId: id,
    entrypoint: 'sdk-cli',
    startTime: '2026-06-04T00:00:00Z',
    endTime: '2026-06-04T01:00:00Z',
    messageCount: 10,
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Session;
}

function cliSession(id: string): Session {
  return {
    sessionId: id,
    entrypoint: 'cli',
    startTime: '2026-06-04T00:00:00Z',
    endTime: '2026-06-04T01:00:00Z',
    messageCount: 5,
    tokens: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Session;
}

function attribution(sessionId: string, mcpServers: Record<string, number>): SessionAttribution {
  return {
    sessionId,
    agents: {},
    skills: {},
    mcpServers: Object.fromEntries(
      Object.entries(mcpServers).map(([k, v]) => [k, { invocations: v, outputTokens: 0 }])
    ),
    mcpTools: {},
  };
}

// Prototype scenario: github + cloudflare-api are blocking (unattended calls);
// notion is advisory (no unattended call history).
const PROTOTYPE_AUTH_STATE: McpAuthState = {
  serversNeedingAuth: ['github', 'cloudflare-api', 'notion'],
  entries: {
    github: { needsAuth: true, reason: 'oauth_token_expired' },
    'cloudflare-api': { needsAuth: true, reason: 'refresh_token_revoked' },
    notion: { needsAuth: true, reason: '401_unauthorized' },
  },
};

// ---------------------------------------------------------------------------
// Detector: basic gating
// ---------------------------------------------------------------------------

describe('reliability.mcp-needs-auth', () => {
  it('returns null when mcpAuth is absent', () => {
    expect(detector.rule(baseInput(), 0)).toBeNull();
  });

  it('returns null when mcpAuth is null', () => {
    expect(detector.rule(baseInput({ mcpAuth: null }), 0)).toBeNull();
  });

  it('returns null when no servers need auth (empty state)', () => {
    const st: McpAuthState = { serversNeedingAuth: [], entries: {} };
    expect(detector.rule(baseInput({ mcpAuth: st }), 0)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Advisory-only (no unattended call data)
  // ---------------------------------------------------------------------------

  it('fires as WARNING when servers need auth but no unattended calls data', () => {
    const st: McpAuthState = {
      serversNeedingAuth: ['notion'],
      entries: { notion: { needsAuth: true, reason: '401_unauthorized' } },
    };
    const result = detector.rule(baseInput({ mcpAuth: st }), 0);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('reliability.mcp-needs-auth');
    expect(result?.severity).toBe('warning');
    expect(result?.unattended).toBeFalsy();
    expect(result?.fix?.target).toBe('command');
    expect(result?.fix?.snippet).toBe('claude mcp auth notion');
  });

  // ---------------------------------------------------------------------------
  // Blocking scenario (prototype mock)
  // ---------------------------------------------------------------------------

  it('fires as CRITICAL when a blocking server (unattended calls > 0) needs auth', () => {
    const s1 = sdkSession('sess-sdk-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1, cliSession('sess-cli-1')],
      attribution: [
        attribution('sess-sdk-1', { github: 1442, 'cloudflare-api': 318 }),
        attribution('sess-cli-1', { notion: 12 }), // cli session — should NOT count
      ],
    });

    const result = detector.rule(input, 0);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('critical');
    expect(result?.unattended).toBe(true);
    expect(result?.affected).toBe(3); // 2 blocking + 1 advisory
  });

  it('includes blocking server names in title', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 1442, 'cloudflare-api': 318 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.title).toMatch(/blocking/);
    expect(result?.title).toMatch(/2/);
  });

  it('emits re-auth commands plus a gate snippet fix when blocking servers exist', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 500 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.fix).toBeDefined();
    expect(result?.fix?.snippet).toContain('claude mcp auth');
    expect(result?.fix?.snippet).toContain('github');
    expect(result?.fix?.snippet).toContain('cloudflare-api');
    expect(result?.fix?.snippet).toContain('exit 1');
  });

  it('evidence includes claude mcp auth commands', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 1442 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.evidence?.some((e) => e.includes('claude mcp auth'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Attribution scoping: CLI sessions must NOT bump blocking count
  // ---------------------------------------------------------------------------

  it('treats servers only called in cli sessions as advisory', () => {
    const st: McpAuthState = {
      serversNeedingAuth: ['notion'],
      entries: { notion: { needsAuth: true, reason: '401_unauthorized' } },
    };
    const input = baseInput({
      mcpAuth: st,
      sessions: [cliSession('cli-sess')],
      attribution: [attribution('cli-sess', { notion: 500 })],
    });
    const result = detector.rule(input, 0);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('warning'); // advisory only
    expect(result?.unattended).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  it('has the correct id, category, and dataDeps declared', () => {
    expect(detector.id).toBe('reliability.mcp-needs-auth');
    expect(detector.category).toBe('reliability');
    expect(detector.dataDeps).toContain('attribution');
    expect(detector.dataDeps).toContain('sessions');
  });
});

// ---------------------------------------------------------------------------
// Shell safety of the generated fix (#3212 command injection, #3213
// copy-paste safety).
//
// Server names are KEYS of mcp-needs-auth-cache.json — untrusted text. These
// tests execute the emitted lines through a REAL POSIX shell with a `claude`
// stub, so they prove what a user's copy-paste actually does rather than
// re-stating our own quoting rules.
// ---------------------------------------------------------------------------

/** Names that must be accepted — the shapes real MCP servers use. */
const SUPPORTED_NAMES = [
  'github',
  'cloudflare-api',
  'notion',
  'Claude_Code_Remote',
  'postgres.v2',
  'a',
  '0-day',
  '_internal',
  'x'.repeat(128),
];

/**
 * Names that must never reach a command line.
 *
 * SAFETY RULE for this file: every payload here MUST be inert. These strings
 * are fed to code whose whole job is to keep them out of a shell, and the tests
 * below run generated lines through a real `/bin/sh` — so if the code under
 * test regresses, a payload WILL execute on the developer's machine. Use
 * `echo`, never a command with a side effect (no `rm`, no `curl`, no `>`
 * redirection, no `touch`). The metacharacter coverage is what matters, not the
 * destructiveness of the payload.
 */
const HOSTILE_NAMES = [
  'two words',
  'evil; echo INJECTED',
  'evil && echo INJECTED',
  '$(echo INJECTED)',
  '`echo INJECTED`',
  '${HOME}',
  "quo'te",
  'quo"te',
  'new\nline',
  '-rf',
  '--help',
  'pipe|cat',
  'redir<in',
  'glob*',
  '~root',
  'back\\slash',
  'hash#comment',
  'sub\tstitute',
  '',
  'x'.repeat(129),
];

/**
 * The only line shape this test harness will hand to a real shell: the literal
 * `claude mcp auth` prefix plus one token made solely of shell-inert
 * characters. Anything else is a regression in the code under test, and running
 * it would execute the payload rather than measure it — so the harness reports
 * it as data instead of executing the script.
 */
const EXECUTABLE_LINE_RE = /^claude mcp auth [A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Execute every `claude mcp auth …` line of a snippet with `claude` replaced by
 * a stub that reports its argv, and return one argv array per line. Any shell
 * expansion, word splitting, or injected command in the copied text shows up
 * here as a different argv.
 *
 * Refuses to execute anything that is not already provably inert (see
 * {@link EXECUTABLE_LINE_RE}) and throws instead, so a regression fails the
 * test without running the payload.
 */
function runReauthLines(snippet: string): string[][] {
  const lines = snippet.split('\n').filter((l) => l.startsWith('claude mcp auth'));
  if (lines.length === 0) return [];
  const unsafe = lines.filter((l) => !EXECUTABLE_LINE_RE.test(l));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to execute non-inert generated line(s): ${unsafe.map((l) => JSON.stringify(l)).join(' | ')}`
    );
  }
  const script = ['claude() { printf "%s\\n" "$#" "$@"; }', ...lines].join('\n');
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  const tokens = out.split('\n');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const argvs: string[][] = [];
  let i = 0;
  while (i < tokens.length) {
    const count = Number(tokens[i]);
    argvs.push(tokens.slice(i + 1, i + 1 + count));
    i += 1 + count;
  }
  return argvs;
}

function authState(names: string[]): McpAuthState {
  return {
    serversNeedingAuth: names,
    entries: Object.fromEntries(
      names.map((n) => [n, { needsAuth: true, reason: 'oauth_token_expired' }])
    ),
  };
}

/** All named servers classified as BLOCKING (unattended calls > 0). */
function blockingInput(names: string[]): InputWithMcpAuth {
  return baseInput({
    mcpAuth: authState(names),
    sessions: [sdkSession('sess-1')],
    attribution: [attribution('sess-1', Object.fromEntries(names.map((n) => [n, 42])))],
  });
}

/** All named servers classified as ADVISORY (no unattended call history). */
function advisoryInput(names: string[]): InputWithMcpAuth {
  return baseInput({ mcpAuth: authState(names) });
}

/** Every human-readable string the recommendation exposes. */
function allStrings(rec: NonNullable<ReturnType<typeof detector.rule>>): string[] {
  return [rec.title, rec.detail, rec.action, ...(rec.evidence ?? []), rec.fix?.snippet ?? '',
    rec.fix?.note ?? ''];
}

describe('reliability.mcp-needs-auth — shell safety (#3212, #3213)', () => {
  // -------------------------------------------------------------------------
  // Name grammar
  // -------------------------------------------------------------------------

  it.each(SUPPORTED_NAMES)('accepts the canonical server name %j', (name) => {
    expect(isSupportedMcpServerName(name)).toBe(true);
  });

  it.each(HOSTILE_NAMES)('rejects the unsupported server name %j', (name) => {
    expect(isSupportedMcpServerName(name)).toBe(false);
  });

  it('rejects non-string keys defensively', () => {
    expect(isSupportedMcpServerName(undefined)).toBe(false);
    expect(isSupportedMcpServerName(42)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Quoting helper: real-shell round trip
  // -------------------------------------------------------------------------

  // Safe to execute because shellQuote is what is under test here and every
  // payload in HOSTILE_NAMES is inert by construction (see the note there).
  it.each([...SUPPORTED_NAMES, ...HOSTILE_NAMES])(
    'shellQuote(%j) round-trips through /bin/sh as exactly one argv element',
    (value) => {
      const script = `claude() { printf "%s\\n" "$#"; printf "%s" "$1"; }\nclaude ${shellQuote(value)}`;
      const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
      const nl = out.indexOf('\n');
      expect(out.slice(0, nl)).toBe('1');
      expect(out.slice(nl + 1)).toBe(value);
    }
  );

  // -------------------------------------------------------------------------
  // #3213 acceptance: every supported name copies as exactly one argv element
  // -------------------------------------------------------------------------

  it('passes each supported server name as exactly one argv element (blocking)', () => {
    const rec = detector.rule(blockingInput(SUPPORTED_NAMES), 0);
    const argvs = runReauthLines(rec!.fix!.snippet);
    expect(argvs).toHaveLength(SUPPORTED_NAMES.length);
    expect(argvs.map((a) => a[2]).sort()).toEqual([...SUPPORTED_NAMES].sort());
    for (const argv of argvs) expect(argv.slice(0, 2)).toEqual(['mcp', 'auth']);
  });

  it('passes each supported server name as exactly one argv element (advisory)', () => {
    const rec = detector.rule(advisoryInput(SUPPORTED_NAMES), 0);
    const argvs = runReauthLines(rec!.fix!.snippet);
    expect(argvs.map((a) => a[2]).sort()).toEqual([...SUPPORTED_NAMES].sort());
  });

  it('keeps the plain, readable form for ordinary names', () => {
    const rec = detector.rule(advisoryInput(['notion']), 0);
    expect(rec?.fix?.snippet).toBe('claude mcp auth notion');
  });

  // -------------------------------------------------------------------------
  // #3212 acceptance: hostile names emit no executable shell
  // -------------------------------------------------------------------------

  it.each(HOSTILE_NAMES)('emits no executable fix when the only server name is %j', (name) => {
    const rec = detector.rule(blockingInput([name]), 0);
    expect(rec).not.toBeNull();
    // Still reported — the server really does need re-auth …
    expect(rec!.affected).toBe(1);
    // … but with no copy-paste command at all.
    expect(rec!.fix).toBeUndefined();
    expect(rec!.action).toContain('No copy-paste command is offered');
    expect(rec!.action).toContain('re-authenticate those servers by hand');
    for (const s of allStrings(rec!)) {
      expect(s).not.toContain(`claude mcp auth ${name}`);
      expect(s.split('\n').some((l) => l.startsWith('claude mcp auth'))).toBe(false);
    }
  });

  it.each(HOSTILE_NAMES)('never lets %j reach the executable snippet alongside a valid name', (name) => {
    const rec = detector.rule(blockingInput(['github', name]), 0);
    const snippet = rec!.fix!.snippet;
    // The valid server still gets its command …
    expect(runReauthLines(snippet)).toEqual([['mcp', 'auth', 'github']]);
    // … and nothing derived from the hostile name is anywhere in the snippet.
    if (name !== '') expect(snippet).not.toContain(name);
    expect(snippet).not.toContain('claude mcp auth github\nclaude mcp auth');
    // The user is told what to do about the rejected name instead.
    expect(rec!.detail).toContain('are not valid MCP');
    expect(rec!.fix!.note).toContain('re-authenticate those servers by hand');
  });

  it('summarises rejected blockers by count in the CI gate instead of naming them', () => {
    const rec = detector.rule(blockingInput(['github', 'evil; echo INJECTED', '$(echo INJECTED)']), 0);
    const snippet = rec!.fix!.snippet;
    expect(snippet).toContain('2 server(s) with an unsupported name');
    expect(snippet).not.toContain('INJECTED');
    expect(snippet).not.toContain('$(echo');
    // The only command substitution left is the gate's own template line.
    expect(snippet.split('$(').length - 1).toBe(1);
    expect(snippet).toContain('exit 1');
  });

  it('does not let a rejected name inject a second command line', () => {
    const rec = detector.rule(advisoryInput(['github', 'x\nclaude mcp auth attacker']), 0);
    expect(runReauthLines(rec!.fix!.snippet)).toEqual([['mcp', 'auth', 'github']]);
    expect(rec!.fix!.snippet).not.toContain('attacker');
  });

  it('reports a rejected name as inert, escaped data rather than a command', () => {
    const hostile = 'evil; echo INJECTED';
    const rec = detector.rule(blockingInput(['github', hostile]), 0);
    const evidence = rec!.evidence ?? [];
    expect(evidence).toContain('claude mcp auth github');
    const line = evidence.find((e) => e.includes('unsupported MCP server name'));
    expect(line).toBeDefined();
    expect(line!.startsWith('claude ')).toBe(false);
    expect(line).toContain(JSON.stringify(hostile));
    expect(displayServerName(hostile)).toBe(JSON.stringify(hostile));
    expect(displayServerName('github')).toBe('github');
  });

  it('escapes control characters when displaying a rejected name', () => {
    const rec = detector.rule(advisoryInput(['bad\nname']), 0);
    expect(rec!.detail).not.toContain('\n');
    expect(rec!.detail).toContain('bad\\nname');
  });

  // -------------------------------------------------------------------------
  // The fix may only be labelled `validated` because of the above
  // -------------------------------------------------------------------------

  it('declares the emitted fix validated and passes the portability gate', () => {
    for (const input of [
      blockingInput(SUPPORTED_NAMES),
      advisoryInput(SUPPORTED_NAMES),
      blockingInput(['github', ...HOSTILE_NAMES]),
    ]) {
      const rec = detector.rule(input, 0);
      expect(rec!.fix!.fixKind).toBe('validated');
      expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    }
  });
});
