import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SRT_PACKAGE_ROOT = join(
  REPO_ROOT,
  'node_modules',
  '@anthropic-ai',
  'sandbox-runtime',
);
const SRT_CLI = join(SRT_PACKAGE_ROOT, 'dist', 'cli.js');
const SRT_PACKAGE_JSON = join(SRT_PACKAGE_ROOT, 'package.json');
const EXPECTED_SRT_VERSION = '0.0.52';
const FIXED_GATE_ENV_KEYS = [
  'CLAUDE_CODE_TMPDIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'TMPDIR',
  'TZ',
];

function executableFromPath(name, pathValue = process.env.PATH || '') {
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the fixed host PATH for the required sandbox primitive.
    }
  }
  throw new Error(`proof gate sandbox requires ${name}`);
}

function assertSandboxRuntime() {
  if (process.platform !== 'linux') {
    throw new Error(`proof gate sandbox is unsupported on ${process.platform}`);
  }
  const manifest = JSON.parse(readFileSync(SRT_PACKAGE_JSON, 'utf8'));
  if (
    manifest.name !== '@anthropic-ai/sandbox-runtime' ||
    manifest.version !== EXPECTED_SRT_VERSION
  ) {
    throw new Error(
      `proof gate sandbox requires @anthropic-ai/sandbox-runtime ${EXPECTED_SRT_VERSION}`,
    );
  }
  accessSync(SRT_CLI, fsConstants.R_OK);
  const architecture =
    process.arch === 'x64'
      ? 'x64'
      : process.arch === 'arm64'
        ? 'arm64'
        : null;
  if (!architecture) {
    throw new Error(`proof gate sandbox is unsupported on ${process.arch}`);
  }
  accessSync(
    join(
      SRT_PACKAGE_ROOT,
      'vendor',
      'seccomp',
      architecture,
      'apply-seccomp',
    ),
    fsConstants.X_OK,
  );
}

export function buildProofGateSettings(tree, ripgrepPath) {
  const materializedTree = realpathSync(tree);
  const runtimePrefix = resolve(dirname(realpathSync(process.execPath)), '..');
  return {
    network: {
      // Objective gates have no legitimate endpoint, including loopback.
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      // Root masking makes reads allow-only. The fixture and its runtime
      // dependencies are the only host material remounted into that view.
      denyRead: ['/', '/sys'],
      allowRead: [
        materializedTree,
        SRT_PACKAGE_ROOT,
        runtimePrefix,
        '/usr',
        '/bin',
        '/lib',
        '/lib64',
        '/etc/ld.so.cache',
        '/etc/localtime',
      ],
      // SRT starts from a read-only host root and rebinds only this tree.
      allowWrite: [materializedTree],
      // SRT's compatibility defaults include these shared temp paths when
      // present. Gates use an isolated temp directory in the tree instead.
      denyWrite: ['/tmp/claude', '/private/tmp/claude'],
    },
    // SRT's mandatory-file scan runs before the jail. Pin its helper so the
    // child gate can receive a fixed PATH rather than the host search path.
    ripgrep: { command: ripgrepPath },
  };
}

export function buildProofGateEnvironment(runtimeRoot) {
  const home = join(runtimeRoot, 'home');
  const temp = join(runtimeRoot, 'tmp');
  return {
    CLAUDE_CODE_TMPDIR: temp,
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
    TMPDIR: temp,
    TZ: 'UTC',
  };
}

export function buildProofGateArgv(settingsPath, command, launchMarker) {
  // The marker is written only after SRT has entered the enforced child. It
  // distinguishes a legitimate nonzero objective result from SRT itself
  // failing with that same exit code.
  const wrapper =
    'printf "%s\\n" "$1" >&2; ' +
    'exec /bin/bash --noprofile --norc -c "$2"';
  return [
    SRT_CLI,
    '-s',
    settingsPath,
    '--',
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    wrapper,
    'proof-gate',
    launchMarker,
    command,
  ];
}

export function evaluateProofGateResult({
  error,
  stdout,
  stderr,
  gate,
  launchMarker,
}) {
  const exitCode =
    error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
  const out = `${stdout}\n${stderr}`;
  const sandboxStarted = String(stderr).includes(launchMarker);
  // A numeric child exit is the objective command's result. Timeouts, signals,
  // max-buffer kills, and spawn failures are launcher/transport failures even
  // if their normalized code happens to match the fixture's expected code.
  const objectiveExited =
    !error ||
    (typeof error.code === 'number' &&
      error.killed !== true &&
      !error.signal);
  const codeOk = exitCode === gate.expectExitCode;
  const matchOk = gate.expectMatch ? out.includes(gate.expectMatch) : true;
  return {
    pass: sandboxStarted && objectiveExited && codeOk && matchOk,
    exitCode,
    expected: gate.expectExitCode,
  };
}

export function proofGateSandboxPreflight() {
  let probeRoot = null;
  try {
    assertSandboxRuntime();
    executableFromPath('bwrap');
    executableFromPath('socat');
    const ripgrep = executableFromPath('rg');
    probeRoot = mkdtempSync(join(tmpdir(), 'proof-gate-preflight-'));
    const tree = join(probeRoot, 'tree');
    const runtimeRoot = join(tree, '.proof-gate-runtime-preflight');
    const controlRoot = join(probeRoot, 'control');
    mkdirSync(tree);
    mkdirSync(runtimeRoot);
    mkdirSync(join(runtimeRoot, 'home'));
    mkdirSync(join(runtimeRoot, 'tmp'));
    mkdirSync(controlRoot);
    const settingsPath = join(controlRoot, 'srt-settings.json');
    writeFileSync(
      settingsPath,
      `${JSON.stringify(buildProofGateSettings(tree, ripgrep), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const launchMarker = 'proof-gate-sandboxed:preflight';
    const probe = spawnSync(
      process.execPath,
      buildProofGateArgv(settingsPath, '/usr/bin/true', launchMarker),
      {
        cwd: tree,
        env: buildProofGateEnvironment(runtimeRoot),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (
      probe.status !== 0 ||
      !String(probe.stderr).includes(launchMarker)
    ) {
      return {
        ok: false,
        reason:
          String(probe.stderr || probe.error?.message || 'bubblewrap probe failed')
            .trim()
            .slice(0, 300),
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    if (probeRoot) rmSync(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Run one objective fixture gate inside the maintained sandbox-runtime.
 *
 * Host reads are allowlisted, host writes are confined to the disposable tree,
 * denied regions are private tmpfs views, network is empty-by-default, PID
 * state is namespaced, Unix sockets are seccomp-blocked, and the child receives
 * only FIXED_GATE_ENV_KEYS plus SRT's own namespace/proxy attestations.
 */
export function runProofGate(tree, gate) {
  return new Promise((resolveGate, rejectGate) => {
    const materializedTree = realpathSync(tree);
    const controlRoot = mkdtempSync(join(tmpdir(), 'proof-gate-control-'));
    const runtimeRoot = mkdtempSync(
      join(materializedTree, '.proof-gate-runtime-'),
    );
    const settingsPath = join(controlRoot, 'srt-settings.json');
    const launchMarker = `proof-gate-sandboxed:${randomUUID()}`;
    const cleanup = () => {
      rmSync(controlRoot, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    };

    try {
      assertSandboxRuntime();
      mkdirSync(join(runtimeRoot, 'home'));
      mkdirSync(join(runtimeRoot, 'tmp'));
      const env = buildProofGateEnvironment(runtimeRoot);
      const settings = buildProofGateSettings(
        materializedTree,
        executableFromPath('rg'),
      );
      writeFileSync(
        settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      execFile(
        process.execPath,
        buildProofGateArgv(settingsPath, gate.command, launchMarker),
        {
          cwd: materializedTree,
          env,
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          cleanup();
          resolveGate(
            evaluateProofGateResult({
              error,
              stdout,
              stderr,
              gate,
              launchMarker,
            }),
          );
        },
      );
    } catch (error) {
      cleanup();
      rejectGate(error);
    }
  });
}

export const PROOF_GATE_SANDBOX_CONTRACT = Object.freeze({
  srtVersion: EXPECTED_SRT_VERSION,
  environmentKeys: FIXED_GATE_ENV_KEYS,
  hostWritableRoots: ['materialized-tree'],
  hostReadableRoots: [
    'materialized-tree',
    'sandbox-runtime',
    'node-runtime',
    'system-runtime',
  ],
  networkAllowedDomains: [],
  processNamespace: 'isolated',
  unixSockets: 'seccomp-denied',
});
