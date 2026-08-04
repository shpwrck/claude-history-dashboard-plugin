import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// The launcher's container-arg builder is plain JS (Node built-ins only, no
// build step) so the published bin can import it at runtime; the test imports
// the same module directly to assert on the FINAL container argv (issue #3344).
import {
  buildServeArgs,
  claudeDataMounts,
  DEFAULT_IMAGE,
  DEFAULT_IMAGE_DIGEST,
  EGRESS_NETWORK,
  CLAUDE_MOUNT_TARGET,
  CREDENTIALS_BASENAME,
  CLAUDE_DATA_SUBDIRS,
  CLAUDE_DATA_FILES,
  REDACTED_ENV_PLACEHOLDER,
  SETTINGS_PROJECTION_DIRNAME,
  redactSettingsProjection,
  // @ts-expect-error - JS launcher module, no type declarations
} from '../../bin/serve-args.mjs';

const BIN = resolve(process.cwd(), 'bin/coding-agent-dashboard.mjs');
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { version: string };

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// One secret per documented secret-bearing settings.json class (the
// r17-rev-sec1 review's leak list). The projection must let NONE of these
// bytes through — by redaction (env values, hook commands) or by dropping the
// field entirely (mcpServers incl. nested env/headers/args, helper commands,
// statusLine, unknown keys).
const HOSTILE_SECRETS = {
  topLevelEnv: 'sk-ant-TOPLEVEL-ENV-SECRET-0xc0ffee',
  mcpNestedEnv: 'sk-mcp-NESTED-ENV-SECRET',
  mcpHeader: 'sk-mcp-HEADER-SECRET',
  mcpArg: 'sk-mcp-ARG-SECRET',
  hookCommand: 'SLACKWEBHOOKTOKEN123',
  apiKeyHelper: 'sk-ant-INLINE-HELPER-SECRET',
  awsAuthRefresh: 'AWSSSOREFRESH-SECRET',
  awsCredentialExport: 'AKIAINLINESECRET',
  otelHeadersHelper: 'hcaik_INLINE_OTEL_SECRET',
  statusLine: 'sk-STATUSLINE-SECRET',
} as const;

// A hostile-but-realistic settings.json carrying a secret in every class
// above, alongside the legitimate fields the dashboard reads.
function hostileSettings() {
  return {
    model: 'claude-opus-4',
    cleanupPeriodDays: 30,
    env: {
      ANTHROPIC_API_KEY: HOSTILE_SECRETS.topLevelEnv,
      DERIVED: '${BASE}/v1',
    },
    permissions: { allow: ['Bash(npm run *)'], deny: ['Read(.env)'] },
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command:
                `curl -s https://hooks.slack.com/services/${HOSTILE_SECRETS.hookCommand} -d done` +
                ' && node ~/.claude/hooks/notify.mjs ${NOTIFY_CHANNEL}',
              timeout: 5,
            },
          ],
        },
      ],
    },
    enabledPlugins: { 'claude-history-dashboard@repo': true },
    mcpServers: {
      corp: {
        command: 'corp-mcp',
        args: [`--token=${HOSTILE_SECRETS.mcpArg}`],
        env: { MCP_API_KEY: HOSTILE_SECRETS.mcpNestedEnv },
        headers: { Authorization: `Bearer ${HOSTILE_SECRETS.mcpHeader}` },
      },
    },
    apiKeyHelper: `echo ${HOSTILE_SECRETS.apiKeyHelper}`,
    awsAuthRefresh: `aws sso login --token ${HOSTILE_SECRETS.awsAuthRefresh}`,
    awsCredentialExport: `echo ${HOSTILE_SECRETS.awsCredentialExport}`,
    otelHeadersHelper: `echo ${HOSTILE_SECRETS.otelHeadersHelper}`,
    statusLine: {
      type: 'command',
      command: `echo ${HOSTILE_SECRETS.statusLine}`,
    },
  };
}

function tempFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cad-cli-'));
  const home = join(root, 'home');
  // A realistic ~/.claude: allowlisted history/config subpaths PLUS secrets that
  // must NEVER reach the container raw — the OAuth credential AND a settings
  // file carrying a secret in every documented secret-bearing class.
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(home, '.claude', 'history.jsonl'), '');
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify(hostileSettings()) + '\n'
  );
  // shadow-calls is narrowed to individual files, not the whole dir (#3604).
  mkdirSync(join(home, '.claude', 'shadow-calls', 'lib'), { recursive: true });
  writeFileSync(join(home, '.claude', 'shadow-calls', 'ledger.jsonl'), '');
  writeFileSync(
    join(home, '.claude', 'shadow-calls', 'calibration-report.json'),
    '{}\n'
  );
  // A sibling file that is NOT read by the dashboard and must stay unmounted.
  writeFileSync(
    join(home, '.claude', 'shadow-calls', 'lib', 'budget.mjs'),
    '// not read by the dashboard\n'
  );
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"SECRET"}}\n'
  );
  writeFileSync(join(home, '.claude.json'), '{}\n');
  const log = join(root, 'runtime.log');
  return {
    root,
    home,
    log,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFakeRuntime(dir: string, name: string, infoStatus = 0) {
  const runtimePath = join(dir, name);
  writeFileSync(
    runtimePath,
    `#!/bin/sh
printf '${name}\\t%s\\n' "$*" >> "$CAD_RUNTIME_LOG"
case "$1" in
  info) exit ${infoStatus} ;;
  rm) exit 0 ;;
  run) echo fake-container-id; exit 0 ;;
  *) exit 0 ;;
esac
`
  );
  chmodSync(runtimePath, 0o755);
}

// Parse a `--volume src:target:mode` value. Sources here are absolute unix paths
// with no ':' so a right-anchored split is unambiguous.
function parseVolume(spec: string): {
  source: string;
  target: string;
  mode: string;
} {
  const parts = spec.split(':');
  if (parts.length >= 3) {
    const mode = parts[parts.length - 1];
    const target = parts[parts.length - 2];
    const source = parts.slice(0, parts.length - 2).join(':');
    return { source, target, mode };
  }
  return { source: parts[0], target: parts[1] ?? '', mode: '' };
}

function volumeSpecs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--volume') out.push(args[i + 1]);
  }
  return out;
}

describe('buildServeArgs container hardening (issue #3344)', () => {
  const DATA_DIR = '/fake/home/.claude';
  const present = new Set([
    join(DATA_DIR, 'projects'),
    join(DATA_DIR, 'history.jsonl'),
    // shadow-calls is narrowed to individual files, not the whole dir (#3604).
    join(DATA_DIR, 'shadow-calls', 'ledger.jsonl'),
    join(DATA_DIR, 'shadow-calls', 'calibration-report.json'),
    // The raw settings file exists on the host but must never be auto-mounted.
    join(DATA_DIR, 'settings.json'),
  ]);
  const exists = (p: string) => present.has(p);

  function build(overrides: Record<string, unknown> = {}) {
    return buildServeArgs(
      { host: '127.0.0.1', port: 5173 },
      {
        runtime: { isPodman: true },
        dataDir: DATA_DIR,
        exists,
        includeSources: false,
        ...overrides,
      }
    ) as string[];
  }

  it('pins the default image by an immutable sha256 digest', () => {
    const args = build();
    const image = args[args.length - 1];
    expect(image).toBe(DEFAULT_IMAGE);
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(DEFAULT_IMAGE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Readable tag is preserved alongside the pin.
    expect(image).toContain('ghcr.io/shpwrck/claude-history-dashboard:latest@');
  });

  it('never mounts ~/.claude or ~/.claude.json wholesale', () => {
    const args = build();
    for (const spec of volumeSpecs(args)) {
      const { target } = parseVolume(spec);
      expect(target).not.toBe(CLAUDE_MOUNT_TARGET); // /home/node/.claude
      expect(target).not.toBe('/home/node/.claude.json');
    }
  });

  it('mounts only allowlisted, existing, credential-free subpaths (each :ro)', () => {
    const args = build();
    const specs = volumeSpecs(args).map(parseVolume);
    const dataMounts = specs.filter((v) =>
      v.target.startsWith(`${CLAUDE_MOUNT_TARGET}/`)
    );
    // Present allowlisted paths are mounted read-only...
    expect(dataMounts).toContainEqual({
      source: join(DATA_DIR, 'projects'),
      target: `${CLAUDE_MOUNT_TARGET}/projects`,
      mode: 'ro',
    });
    expect(dataMounts).toContainEqual({
      source: join(DATA_DIR, 'history.jsonl'),
      target: `${CLAUDE_MOUNT_TARGET}/history.jsonl`,
      mode: 'ro',
    });
    for (const v of dataMounts) expect(v.mode).toBe('ro');
    // ...and absent allowlisted paths are omitted (no root-owned host stubs).
    expect(
      dataMounts.some((v) => v.target === `${CLAUDE_MOUNT_TARGET}/plans`)
    ).toBe(false);
  });

  it('never exposes the OAuth credential file as a mount source, and masks it', () => {
    const args = build();
    const specs = volumeSpecs(args).map(parseVolume);
    // The real host credential file is never a bind-mount source.
    expect(
      specs.some((v) => v.source.endsWith(`/${CREDENTIALS_BASENAME}`))
    ).toBe(false);
    // Defense in depth: an empty /dev/null source masks the credential target.
    expect(specs).toContainEqual({
      source: '/dev/null',
      target: `${CLAUDE_MOUNT_TARGET}/${CREDENTIALS_BASENAME}`,
      mode: 'ro',
    });
  });

  it('attaches the container to the internal no-egress network', () => {
    const args = build();
    const idx = args.indexOf('--network');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(EGRESS_NETWORK);
    // Inbound is still published.
    expect(args).toContain('--publish');
    expect(args).toContain('127.0.0.1:5173:5173');
  });

  it('keeps the read-only / cap-drop / no-new-privileges hardening', () => {
    const args = build();
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('no-new-privileges:true');
    expect(args).toContain('--userns=keep-id'); // podman
  });

  it('omits --userns=keep-id for docker and CODING_AGENT_SOURCES when unset', () => {
    const args = build({ runtime: { isPodman: false }, includeSources: false });
    expect(args).not.toContain('--userns=keep-id');
    expect(args).not.toContain('CODING_AGENT_SOURCES');
  });

  it('claudeDataMounts skips missing paths and never auto-mounts raw settings', () => {
    const mounts = claudeDataMounts(DATA_DIR, exists) as Array<{
      source: string;
      target: string;
    }>;
    // Present allowlisted paths only; nested shadow-calls files project at their
    // nested targets; the raw settings.json is NOT in the allowlist (#3604).
    expect(mounts.map((m) => m.target)).toEqual([
      `${CLAUDE_MOUNT_TARGET}/projects`,
      `${CLAUDE_MOUNT_TARGET}/history.jsonl`,
      `${CLAUDE_MOUNT_TARGET}/shadow-calls/ledger.jsonl`,
      `${CLAUDE_MOUNT_TARGET}/shadow-calls/calibration-report.json`,
    ]);
  });

  it('narrows shadow-calls to individual files (never the whole dir)', () => {
    // shadow-calls/ must not appear in either allowlist as a bare dir name.
    expect(CLAUDE_DATA_SUBDIRS).not.toContain('shadow-calls');
    // The only shadow-calls entries are the individual files the server reads.
    const shadowFiles = (CLAUDE_DATA_FILES as string[]).filter((f) =>
      f.startsWith('shadow-calls/')
    );
    expect(shadowFiles).toEqual([
      'shadow-calls/ledger.jsonl',
      'shadow-calls/calibration-report.json',
      'shadow-calls/OFF',
    ]);

    const args = build();
    const targets = volumeSpecs(args)
      .map(parseVolume)
      .map((v) => v.target);
    // The whole shadow-calls dir is never a mount target...
    expect(targets).not.toContain(`${CLAUDE_MOUNT_TARGET}/shadow-calls`);
    // ...only the present narrowed files are.
    expect(targets).toContain(`${CLAUDE_MOUNT_TARGET}/shadow-calls/ledger.jsonl`);
    expect(targets).toContain(
      `${CLAUDE_MOUNT_TARGET}/shadow-calls/calibration-report.json`
    );
  });

  it('never mounts a raw settings file, and mounts the redacted projection instead', () => {
    // Without a redacted source, the raw settings.json is NOT mounted at all
    // (it is deliberately absent from the allowlist).
    const bare = build();
    const bareSpecs = volumeSpecs(bare).map(parseVolume);
    expect(
      bareSpecs.some((v) => v.source === join(DATA_DIR, 'settings.json'))
    ).toBe(false);
    expect(
      bareSpecs.some((v) => v.target === `${CLAUDE_MOUNT_TARGET}/settings.json`)
    ).toBe(false);

    // With a redacted source supplied by serve(), the redacted copy mounts at
    // the settings target :ro — and the raw source is still never mounted.
    const redacted = '/tmp/cad-proj/settings.json';
    const withProjection = build({
      settingsSources: { 'settings.json': redacted },
      exists: (p: string) => present.has(p) || p === redacted,
    });
    const specs = volumeSpecs(withProjection).map(parseVolume);
    expect(specs).toContainEqual({
      source: redacted,
      target: `${CLAUDE_MOUNT_TARGET}/settings.json`,
      mode: 'ro',
    });
    expect(
      specs.some((v) => v.source === join(DATA_DIR, 'settings.json'))
    ).toBe(false);
  });
});

describe('redactSettingsProjection (issue #3604) — allowlist projection', () => {
  it('lets NO secret byte from any documented secret-bearing class survive', () => {
    const out = redactSettingsProjection(
      JSON.stringify(hostileSettings())
    ) as string;
    for (const [cls, secret] of Object.entries(HOSTILE_SECRETS)) {
      expect(out, `class "${cls}" leaked`).not.toContain(secret);
    }
  });

  it('DROPS every field outside the read-set allowlist (mcpServers, helper commands, statusLine, unknown keys)', () => {
    const parsed = JSON.parse(
      redactSettingsProjection(
        JSON.stringify({ ...hostileSettings(), someUnknownKey: 'whatever' })
      ) as string
    );
    // Only the fields the dashboard reads survive, nothing else.
    expect(Object.keys(parsed).sort()).toEqual([
      'cleanupPeriodDays',
      'enabledPlugins',
      'env',
      'hooks',
      'model',
      'permissions',
    ]);
    expect(parsed).not.toHaveProperty('mcpServers');
    expect(parsed).not.toHaveProperty('apiKeyHelper');
    expect(parsed).not.toHaveProperty('awsAuthRefresh');
    expect(parsed).not.toHaveProperty('awsCredentialExport');
    expect(parsed).not.toHaveProperty('otelHeadersHelper');
    expect(parsed).not.toHaveProperty('statusLine');
    expect(parsed).not.toHaveProperty('someUnknownKey');
  });

  it('keeps what the dashboard reads: model, cleanupPeriodDays, permission rules, plugin ids, env keys', () => {
    const parsed = JSON.parse(
      redactSettingsProjection(JSON.stringify(hostileSettings())) as string
    );
    // mergeLiveSettings scalars (detectors/shared.ts model checks;
    // stale-projects/secrets-at-rest cleanupPeriodDays).
    expect(parsed.model).toBe('claude-opus-4');
    expect(parsed.cleanupPeriodDays).toBe(30);
    // Permission rules are literal match patterns (Permissions view,
    // deny-rule/dangerous-bypass detectors) — verbatim.
    expect(parsed.permissions).toEqual({
      allow: ['Bash(npm run *)'],
      deny: ['Read(.env)'],
    });
    // Plugin ids gate bundle enumeration (readPlugins) — keys kept, boolean values.
    expect(parsed.enabledPlugins).toEqual({
      'claude-history-dashboard@repo': true,
    });
    // Env KEYS are retained (ConfigHygiene resolves references by NAME)...
    expect(Object.keys(parsed.env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'DERIVED',
    ]);
    // ...values are placeholdered.
    expect(parsed.env.ANTHROPIC_API_KEY).toBe(REDACTED_ENV_PLACEHOLDER);
  });

  it('keeps hook STRUCTURE with the command redacted to placeholder + ${NAME} tokens', () => {
    const parsed = JSON.parse(
      redactSettingsProjection(JSON.stringify(hostileSettings())) as string
    );
    // Structure survives: event key, group matcher, entry type/timeout — so
    // Stop-hook presence (readStopHookConfigState, hook-overhead) still works.
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].matcher).toBe('');
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(1);
    const entry = parsed.hooks.Stop[0].hooks[0];
    expect(entry.type).toBe('command');
    expect(entry.timeout).toBe(5);
    // The command's literal text (which held the webhook token) is gone...
    expect(entry.command).not.toContain(HOSTILE_SECRETS.hookCommand);
    expect(entry.command).toContain(REDACTED_ENV_PLACEHOLDER);
    // ...but its ${NAME} reference survives for the missing-env diagnostic.
    expect(entry.command).toContain('${NOTIFY_CHANNEL}');
  });

  it('preserves ${NAME} interpolation tokens so the missing-env diagnostic is unchanged', () => {
    const raw = JSON.stringify({
      env: {
        BASE: 'https://secret-host.internal/v1',
        DERIVED: '${BASE}/models?key=${MISSING_KEY}',
      },
    });
    const parsed = JSON.parse(redactSettingsProjection(raw) as string);
    // The literal secret host is gone...
    expect(parsed.env.BASE).toBe(REDACTED_ENV_PLACEHOLDER);
    // ...but every interpolation reference config-hygiene resolves is kept, in
    // order, so its dependency graph (${BASE}, ${MISSING_KEY}) is identical.
    const names = [
      ...(parsed.env.DERIVED as string).matchAll(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
      ),
    ].map((m) => m[1]);
    expect(names).toEqual(['BASE', 'MISSING_KEY']);
    expect(parsed.env.DERIVED).not.toContain('secret-host');
  });

  it('drops to {} on unparseable input rather than passing raw bytes through', () => {
    const out = redactSettingsProjection(
      '{ "env": { "ANTHROPIC_API_KEY": "sk-ant-LEAK" '
    ) as string;
    expect(out).not.toContain('sk-ant-LEAK');
    expect(JSON.parse(out)).toEqual({});
  });

  it('projects a minimal settings file to its allowlisted fields (still valid JSON)', () => {
    const raw = JSON.stringify({ model: 'claude-sonnet', hooks: {} });
    const parsed = JSON.parse(redactSettingsProjection(raw) as string);
    expect(parsed).toEqual({ model: 'claude-sonnet', hooks: {} });
  });
});

describe('coding-agent-dashboard CLI', () => {
  it('prints help and version without requiring a container runtime', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('coding-agent-dashboard serve');
    expect(help.stdout).toContain('coding-agent-dashboard stop');

    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(PACKAGE_JSON.version);
  });

  it('rejects unknown commands with a nonzero exit and help text', () => {
    const result = runCli(['launch']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown command: launch');
    expect(result.stderr).toContain('Usage:');
  });

  it('prefers podman, mounts an allowlisted secret-free projection (redacted settings, narrowed shadow-calls), denies egress, and passes CODING_AGENT_SOURCES through', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'podman');
      writeFakeRuntime(fixture.root, 'docker');
      const result = runCli(['serve', '--port', '4321'], {
        CAD_RUNTIME_LOG: fixture.log,
        CODING_AGENT_SOURCES: '[{"id":"team"}]',
        HOME: fixture.home,
        PATH: fixture.root,
        // Isolate the redacted-settings projection under the fixture.
        TMPDIR: fixture.root,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('fake-container-id');
      expect(result.stdout).toContain('http://127.0.0.1:4321');

      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('podman\tinfo');
      expect(log).toContain('podman\trm -f coding-agent-dashboard');
      // No-egress network is created and attached.
      expect(log).toContain(
        `podman\tnetwork create --internal ${EGRESS_NETWORK}`
      );
      expect(log).toContain('podman\trun --detach --name coding-agent-dashboard');
      expect(log).toContain(`--network ${EGRESS_NETWORK}`);
      expect(log).toContain('--publish 127.0.0.1:4321:5173');
      // Allowlisted subpaths are mounted read-only...
      expect(log).toContain(
        `--volume ${join(fixture.home, '.claude', 'projects')}:/home/node/.claude/projects:ro`
      );
      expect(log).toContain(
        `--volume ${join(fixture.home, '.claude', 'history.jsonl')}:/home/node/.claude/history.jsonl:ro`
      );
      // ...while the whole dir, ~/.claude.json, and the credential file are NOT.
      expect(log).not.toContain(
        `--volume ${join(fixture.home, '.claude')}:/home/node/.claude:ro`
      );
      expect(log).not.toContain('/home/node/.claude.json');
      expect(log).not.toContain(
        join(fixture.home, '.claude', '.credentials.json')
      );
      // Credential mask present.
      expect(log).toContain(
        '--volume /dev/null:/home/node/.claude/.credentials.json:ro'
      );

      // #3604 shadow-calls narrowing: only the individual files the dashboard
      // reads are mounted; the whole shadow-calls dir and its unread siblings
      // (e.g. lib/) are NOT.
      expect(log).toContain(
        `--volume ${join(fixture.home, '.claude', 'shadow-calls', 'ledger.jsonl')}:/home/node/.claude/shadow-calls/ledger.jsonl:ro`
      );
      expect(log).toContain(
        `--volume ${join(fixture.home, '.claude', 'shadow-calls', 'calibration-report.json')}:/home/node/.claude/shadow-calls/calibration-report.json:ro`
      );
      expect(log).not.toContain(
        `--volume ${join(fixture.home, '.claude', 'shadow-calls')}:/home/node/.claude/shadow-calls:ro`
      );
      expect(log).not.toContain(
        join(fixture.home, '.claude', 'shadow-calls', 'lib')
      );

      // #3604 settings projection: the RAW settings.json is never a mount
      // source; the allowlist projection is mounted at the settings target from
      // an unpredictable per-serve temp dir; and its bytes carry no secret from
      // ANY documented secret-bearing class.
      const rawSettings = join(fixture.home, '.claude', 'settings.json');
      const rawSettingsMount = `--volume ${rawSettings}:/home/node/.claude/settings.json:ro`;
      expect(log).not.toContain(rawSettingsMount);
      const projectedMount = log.match(
        /--volume (\S+):\/home\/node\/\.claude\/settings\.json:ro/
      );
      expect(projectedMount).not.toBeNull();
      const projected = projectedMount![1];
      // Written under the fixture's TMPDIR in the launcher's projection parent,
      // inside an unpredictable mkdtemp leaf.
      expect(projected.startsWith(join(fixture.root, SETTINGS_PROJECTION_DIRNAME) + '/')).toBe(
        true
      );
      expect(projected).toMatch(/serve-[^/]+\/settings\.json$/);
      const projectedBytes = readFileSync(projected, 'utf8');
      for (const [cls, secret] of Object.entries(HOSTILE_SECRETS)) {
        expect(projectedBytes, `class "${cls}" leaked`).not.toContain(secret);
      }
      const projectedSettings = JSON.parse(projectedBytes);
      expect(projectedSettings.env.ANTHROPIC_API_KEY).toBe(
        REDACTED_ENV_PLACEHOLDER
      );
      // The read-set fields still project so config hygiene keeps working.
      expect(projectedSettings.model).toBe('claude-opus-4');
      expect(projectedSettings.permissions).toEqual({
        allow: ['Bash(npm run *)'],
        deny: ['Read(.env)'],
      });
      // Dropped classes are absent as whole fields, not just value-redacted.
      expect(projectedSettings).not.toHaveProperty('mcpServers');
      expect(projectedSettings).not.toHaveProperty('apiKeyHelper');

      expect(log).toContain('--env CODING_AGENT_SOURCES');
      expect(log).toContain('--userns=keep-id');
      // Digest-pinned image ref.
      expect(log).toContain(DEFAULT_IMAGE);
      expect(log).toMatch(/@sha256:[0-9a-f]{64}/);
      expect(log).not.toContain('docker\t');
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to docker without podman-only flags', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'docker');
      const result = runCli(['serve', '--host', '0.0.0.0', '--port', '4999'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root,
        TMPDIR: fixture.root,
      });

      expect(result.status).toBe(0);
      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('docker\tinfo');
      expect(log).toContain(`docker\tnetwork create --internal ${EGRESS_NETWORK}`);
      expect(log).toContain('--publish 0.0.0.0:4999:5173');
      expect(log).not.toContain('--userns=keep-id');
      // The raw settings file is still never mounted under docker either.
      expect(log).not.toContain(
        `--volume ${join(fixture.home, '.claude', 'settings.json')}:/home/node/.claude/settings.json:ro`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('stop removes the managed container, the no-egress network, and the settings projection', () => {
    const fixture = tempFixture();
    try {
      writeFakeRuntime(fixture.root, 'podman');
      // A projection left behind by an earlier serve.
      const projectionParent = join(fixture.root, SETTINGS_PROJECTION_DIRNAME);
      mkdirSync(join(projectionParent, 'serve-stale'), { recursive: true });
      writeFileSync(join(projectionParent, 'serve-stale', 'settings.json'), '{}\n');

      const result = runCli(['stop'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root + delimiter + process.env.PATH,
        TMPDIR: fixture.root,
      });

      expect(result.status).toBe(0);
      const log = readFileSync(fixture.log, 'utf8');
      expect(log).toContain('podman\trm -f coding-agent-dashboard');
      expect(log).toContain(`podman\tnetwork rm ${EGRESS_NETWORK}`);
      expect(log).not.toContain('rm -f claude-history-dashboard');
      // The projection dir is cleaned up with the container.
      expect(existsSync(projectionParent)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails serve clearly when no runtime is healthy', () => {
    const fixture = tempFixture();
    try {
      const result = runCli(['serve'], {
        CAD_RUNTIME_LOG: fixture.log,
        HOME: fixture.home,
        PATH: fixture.root,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'Neither podman nor docker is available and healthy'
      );
    } finally {
      fixture.cleanup();
    }
  });
});

// Opt-in behavioral proof against a real podman runtime. Skipped in CI (no
// runtime), enabled with CAD_PODMAN_E2E=1. Point CAD_E2E_IMAGE at a locally
// available server image (the digest-pinned default cannot be pulled without a
// ghcr credential); e.g.
//   CAD_PODMAN_E2E=1 CAD_E2E_IMAGE=localhost/claude-history-dashboard:local \
//     npx vitest run src/lib/coding-agent-dashboard-cli.test.ts
const podmanE2E = process.env.CAD_PODMAN_E2E === '1';
describe('coding-agent-dashboard serve (real podman)', () => {
  const e2eImage = process.env.CAD_E2E_IMAGE || DEFAULT_IMAGE;
  const port = 5173 + Math.floor(1000 + Math.random() * 8000);

  function podman(args: string[], timeout = 30000) {
    return spawnSync('podman', args, { encoding: 'utf8', timeout });
  }

  (podmanE2E ? it : it.skip)(
    'serves inbound history while denying outbound egress and hiding credentials',
    async () => {
      const fixture = tempFixture();
      // A discoverable session so history loading has something real to read.
      const slug = 'e2e-project';
      mkdirSync(join(fixture.home, '.claude', 'projects', slug), {
        recursive: true,
      });
      writeFileSync(
        join(fixture.home, '.claude', 'projects', slug, 'sess.jsonl'),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'hello' },
        }) + '\n'
      );
      try {
        podman(['rm', '-f', 'coding-agent-dashboard']);
        // Scope the data dir via CLAUDE_DIR, NOT HOME: overriding HOME would
        // relocate podman's rootless image store to an empty temp dir and force
        // a pull. CLAUDE_DIR points the launcher at the fixture while podman
        // keeps the real store.
        const serve = runCli(['serve', '--port', String(port)], {
          CLAUDE_DIR: join(fixture.home, '.claude'),
          CODING_AGENT_DASHBOARD_IMAGE: e2eImage,
        });
        expect(serve.status).toBe(0);

        // Inbound published port works.
        let ok = false;
        for (let i = 0; i < 60 && !ok; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            ok = res.ok;
          } catch {
            ok = false;
          }
        }
        expect(ok).toBe(true);

        // Outbound egress is denied (no default route on the internal network).
        const egress = podman([
          'exec',
          'coding-agent-dashboard',
          'node',
          '-e',
          'const net=require("net");const s=net.connect(443,"1.1.1.1");s.setTimeout(4000);const done=(m)=>{try{s.destroy()}catch{};console.log(m);process.exit(0)};s.on("connect",()=>done("ALLOWED"));s.on("timeout",()=>done("BLOCKED_timeout"));s.on("error",(e)=>done("BLOCKED_"+e.code))',
        ]);
        expect(egress.stdout).toContain('BLOCKED');
        expect(egress.stdout).not.toContain('ALLOWED');

        // The OAuth credential is not readable inside the container.
        const creds = podman([
          'exec',
          'coding-agent-dashboard',
          'sh',
          '-c',
          'cat /home/node/.claude/.credentials.json 2>/dev/null || echo ENOENT',
        ]);
        expect(creds.stdout).not.toContain('SECRET');

        // No settings secret from any class reaches the container, and the
        // whole shadow-calls dir is not exposed (only the read files) (#3604).
        const settings = podman([
          'exec',
          'coding-agent-dashboard',
          'sh',
          '-c',
          'cat /home/node/.claude/settings.json 2>/dev/null || echo ENOENT',
        ]);
        for (const [cls, secret] of Object.entries(HOSTILE_SECRETS)) {
          expect(settings.stdout, `class "${cls}" leaked`).not.toContain(secret);
        }
        const shadowLib = podman([
          'exec',
          'coding-agent-dashboard',
          'sh',
          '-c',
          'cat /home/node/.claude/shadow-calls/lib/budget.mjs 2>/dev/null || echo ENOENT',
        ]);
        expect(shadowLib.stdout).toContain('ENOENT');
      } finally {
        runCli(['stop']);
        podman(['rm', '-f', 'coding-agent-dashboard']);
        podman(['network', 'rm', EGRESS_NETWORK]);
        fixture.cleanup();
      }
    }
  );
});
