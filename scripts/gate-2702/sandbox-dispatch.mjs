import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { shellQuote } from "../lib/shell-quote.mjs";
import { GATE_2702_SIDEKICK_VERSION } from "./behavior-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const SRT_PACKAGE_ROOT = join(
  PROJECT_ROOT,
  "node_modules",
  "@anthropic-ai",
  "sandbox-runtime",
);
const SRT_PACKAGE_JSON = join(SRT_PACKAGE_ROOT, "package.json");
const SRT_CLI = join(SRT_PACKAGE_ROOT, "dist", "cli.js");
const SRT_INDEX = join(SRT_PACKAGE_ROOT, "dist", "index.js");
const EXPECTED_SRT_VERSION = "0.0.52";
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_PLUGIN_FILES = 1024;
const MAX_PLUGIN_BYTES = 16 * 1024 * 1024;
const MODEL_DOMAIN = "api.anthropic.com";
const SIDEKICK_SNAPSHOT_ROOTS = [".claude-plugin", "hooks", "scripts"];
// Derived, not re-typed: the snapshot directory must track the same pin the
// runtime enforces. Two hand-written copies of "0.3.3" would disagree the
// moment the pin moves, and the disagreement would surface as an opaque
// pre-dispatch attestation failure rather than a version bump.
const SIDEKICK_SNAPSHOT_DIRECTORY = `claude-sidekick-${GATE_2702_SIDEKICK_VERSION}`;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const GATE_2702_SANDBOX_ENV_KEYS = [
  "CHD_EXPERIMENT_2702_ATTEMPT",
  "CHD_EXPERIMENT_2702_BASE_SHA",
  "CHD_EXPERIMENT_2702_RUN_DIR",
  "CHD_EXPERIMENT_2702_SUBJECT",
  "CHD_EXPERIMENT_2702_TREATMENT",
  "CHD_EXPERIMENT_2702_TRIAL_ID",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "DISABLE_AUTOUPDATER",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_USERCONFIG",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

// SRT adds these inside the network namespace. They are not inherited from
// the host and remain part of the documented child-environment contract.
export const GATE_2702_SRT_INJECTED_ENV_KEYS = [
  "ALL_PROXY",
  "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "CLOUDSDK_PROXY_TYPE",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "FTP_PROXY",
  "GIT_SSH_COMMAND",
  "GRPC_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "OLDPWD",
  "PWD",
  "RSYNC_PROXY",
  "SANDBOX_RUNTIME",
  "SHLVL",
  "all_proxy",
  "ftp_proxy",
  "grpc_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function regularFile(path, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    fail(`${label} is not a bounded regular file: ${path}`);
  }
  return metadata;
}

function fileIdentity(path, label, maximumBytes = 8 * 1024 * 1024) {
  const metadata = regularFile(path, label, maximumBytes);
  const bytes = readFileSync(path);
  return {
    path,
    byteLength: metadata.size,
    contentDigest: sha256(bytes),
  };
}

function commandPath(name, env = process.env) {
  const result = spawnSync(
    "/bin/sh",
    ["-c", 'command -v -- "$1"', "gate-2702", name],
    {
      env: { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  const command = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !command) {
    fail(`C5 sandbox requires ${name}`);
  }
  const resolved = realpathSync(command);
  regularFile(resolved, `${name} executable`);
  return { name, command, resolved };
}

function runtimeVersion(tool) {
  const result = spawnSync(tool.command, ["--version"], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  const value = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return result.status === 0 && value ? value.slice(0, 200) : null;
}

export function gate2702SandboxEnabled(env = process.env) {
  return (
    env.CHD_EXPERIMENT_2702_TEST_MODE !== "1" ||
    env.CHD_EXPERIMENT_2702_TEST_SANDBOX === "1"
  );
}

export function gate2702SandboxProbeAction(enforceable, env = process.env) {
  if (enforceable) return "run";
  if (env.CHD_REQUIRE_GATE_2702_SANDBOX_PROBE === "1") {
    fail(
      "required gate-2702 sandbox denial proof needs a namespace-capable host",
    );
  }
  return "skip";
}

/**
 * The isolated HOME a jailed arm runs under, or null when the arm is
 * dispatched unjailed. ONE derivation with three consumers (accounting's
 * Sidekick ledger root, the behavior-context capture, and its live re-check),
 * because a second copy is how those three start disagreeing.
 *
 * The path is deterministic from the registered run directory, so a caller at
 * preflight -- before any pre-dispatch receipt exists -- agrees by
 * construction with a caller that reads the attested value afterwards. When a
 * receipt IS supplied, its attested `isolatedHome` must equal that derivation
 * or the arm's home is not bound to the registered run, and we fail closed.
 */
export function gate2702IsolatedHome({
  runDir,
  preDispatch = null,
  env = process.env,
  // What an ABSENT pre-dispatch receipt means. The consumers genuinely differ,
  // so the policy is stated at the call site rather than guessed here; only
  // this varies, the derivation above stays shared.
  //   "none"   -- accounting runs AFTER dispatch, so a missing receipt means
  //               the arm was never jailed and its ledger is the host's.
  //   "derive" -- the behavior-context capture runs at preflight, BEFORE the
  //               receipt exists, and must predict the home the worker will
  //               get so it agrees with the attested value later.
  unattested = "none",
}) {
  if (typeof runDir !== "string" || !runDir) {
    fail("isolated home requires the registered run directory");
  }
  const expected = resolve(runDir, "sandbox", "home");
  if (preDispatch === null) {
    if (unattested !== "derive") return null;
    return gate2702SandboxEnabled(env) ? expected : null;
  }
  const attested = preDispatch?.sandbox?.isolatedHome;
  // No sandbox block means the arm was dispatched unjailed (test mode). The
  // pre-dispatch validator already refuses that combination while the sandbox
  // is enabled, so this is not a silent downgrade path.
  if (attested === undefined) return null;
  if (typeof attested !== "string" || resolve(attested) !== expected) {
    fail("sandbox home is not bound to the registered run");
  }
  return expected;
}

export function assertGate2702SandboxReady(env = process.env) {
  if (!gate2702SandboxEnabled(env)) return null;
  if (process.platform !== "linux") {
    fail(`C5 sandbox is unsupported on ${process.platform}`);
  }
  const packageIdentity = fileIdentity(
    SRT_PACKAGE_JSON,
    "sandbox-runtime package manifest",
  );
  const packageManifest = JSON.parse(readFileSync(SRT_PACKAGE_JSON, "utf8"));
  if (
    packageManifest.name !== "@anthropic-ai/sandbox-runtime" ||
    packageManifest.version !== EXPECTED_SRT_VERSION
  ) {
    fail(`C5 requires @anthropic-ai/sandbox-runtime ${EXPECTED_SRT_VERSION}`);
  }
  const cliIdentity = fileIdentity(SRT_CLI, "sandbox-runtime CLI");
  regularFile(SRT_INDEX, "sandbox-runtime API");
  const tools = ["bwrap", "socat", "rg"].map((name) => commandPath(name, env));
  return {
    enforcer: "srt",
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      root: SRT_PACKAGE_ROOT,
      cliPath: SRT_CLI,
      manifestDigest: packageIdentity.contentDigest,
      cliDigest: cliIdentity.contentDigest,
    },
    cliPath: SRT_CLI,
    packageRoot: SRT_PACKAGE_ROOT,
    tools: tools.map((tool) => ({
      ...tool,
      version: runtimeVersion(tool),
    })),
  };
}

function pluginFiles(root) {
  const files = [];
  let totalBytes = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        fail(`Sidekick plugin snapshot refuses symlink ${path}`);
      }
      if (metadata.isDirectory()) {
        walk(path);
        continue;
      }
      if (!metadata.isFile()) {
        fail(`Sidekick plugin snapshot refuses special file ${path}`);
      }
      totalBytes += metadata.size;
      files.push({ path, relativePath: relative(root, path), metadata });
      if (files.length > MAX_PLUGIN_FILES || totalBytes > MAX_PLUGIN_BYTES) {
        fail("Sidekick plugin snapshot exceeds its fixed bounds");
      }
    }
  };
  for (const relativeRoot of SIDEKICK_SNAPSHOT_ROOTS) {
    const directory = join(root, relativeRoot);
    if (!existsSync(directory)) {
      fail(`Sidekick plugin snapshot is missing ${relativeRoot}`);
    }
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(
        `Sidekick plugin snapshot root is not a real directory: ${directory}`,
      );
    }
    walk(directory);
  }
  return files;
}

function pluginTreeDigest(root) {
  const hash = createHash("sha256");
  for (const file of pluginFiles(root)) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(readFileSync(file.path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function digestGate2702SidekickSnapshot(root) {
  return pluginTreeDigest(resolve(root));
}

function copyPluginTree(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of pluginFiles(source)) {
    const target = join(destination, file.relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(file.path, target, fsConstants.COPYFILE_EXCL);
  }
}

function ensureSidekickSnapshot(trialRoot, installPath) {
  if (typeof installPath !== "string" || !installPath) {
    fail("C5 production sandbox requires the pinned Sidekick install path");
  }
  const source = realpathSync(installPath);
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail("pinned Sidekick install is not a real directory");
  }
  const sourceDigest = pluginTreeDigest(source);
  const runtimeRoot = join(trialRoot, "sandbox-runtime");
  const destination = join(runtimeRoot, SIDEKICK_SNAPSHOT_DIRECTORY);
  if (existsSync(destination)) {
    if (pluginTreeDigest(destination) !== sourceDigest) {
      fail("existing Sidekick runtime snapshot differs from the pinned plugin");
    }
  } else {
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    copyPluginTree(source, temporary);
    if (pluginTreeDigest(temporary) !== sourceDigest) {
      fail("Sidekick runtime snapshot changed while it was copied");
    }
    renameSync(temporary, destination);
  }
  return {
    path: destination,
    contentDigest: sourceDigest,
  };
}

export function prepareGate2702SandboxRuntime({
  trialRoot,
  sidekickInstallPath = null,
  env = process.env,
}) {
  if (!gate2702SandboxEnabled(env)) return null;
  const identity = assertGate2702SandboxReady(env);
  const sidekick =
    env.CHD_EXPERIMENT_2702_TEST_MODE === "1"
      ? null
      : ensureSidekickSnapshot(trialRoot, sidekickInstallPath);
  return { ...identity, sidekick };
}

function readCredentialOnly(source) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(source, flags);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_CREDENTIAL_BYTES) {
      fail("subscription credential is not a bounded regular file");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail("subscription credential changed while read");
      offset += read;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      fail("subscription credential changed while read");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function installCredential(isolatedHome, hostHome) {
  const claudeRoot = join(isolatedHome, ".claude");
  const destination = join(claudeRoot, ".credentials.json");
  mkdirSync(claudeRoot, { recursive: true, mode: 0o700 });
  if (readdirSync(claudeRoot).length !== 0) {
    fail("isolated Claude home was not empty before credential install");
  }
  const source = join(hostHome, ".claude", ".credentials.json");
  const bytes = readCredentialOnly(source);
  try {
    writeFileSync(destination, bytes, {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    bytes.fill(0);
  }
  return destination;
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function sandboxEnvironmentValue({
  registration,
  sidekickEnvironment,
  isolatedHome,
  runtimeExecutables,
}) {
  const tmp = join(isolatedHome, "tmp");
  const xdgConfig = join(isolatedHome, ".config");
  const xdgCache = join(isolatedHome, ".cache");
  const xdgData = join(isolatedHome, ".local", "share");
  const npmCache = join(isolatedHome, ".npm");
  return {
    CHD_EXPERIMENT_2702_ATTEMPT: String(registration.attempt),
    CHD_EXPERIMENT_2702_BASE_SHA: registration.baseSha,
    CHD_EXPERIMENT_2702_RUN_DIR: registration.runDir,
    CHD_EXPERIMENT_2702_SUBJECT: String(registration.subject),
    CHD_EXPERIMENT_2702_TREATMENT: registration.treatmentId,
    CHD_EXPERIMENT_2702_TRIAL_ID: registration.trialId,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_TMPDIR: tmp,
    CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    DISABLE_AUTOUPDATER: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: isolatedHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: join(isolatedHome, ".npmrc"),
    PATH: [
      ...new Set([
        ...runtimeExecutables.map((path) => dirname(path)),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]),
    ].join(":"),
    SHELL: "/bin/bash",
    TERM: "dumb",
    // Keep the enforcer's host-side Unix socket paths below Linux's 108-byte
    // limit. SRT replaces TMPDIR in the sandboxed child with
    // CLAUDE_CODE_TMPDIR, which remains inside the isolated home.
    TMPDIR: "/tmp",
    TZ: "UTC",
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    ...sidekickEnvironment,
  };
}

function sandboxEnvironment({
  registration,
  sidekickEnvironment,
  isolatedHome,
  runtimeExecutables,
}) {
  const tmp = join(isolatedHome, "tmp");
  const xdgConfig = join(isolatedHome, ".config");
  const xdgCache = join(isolatedHome, ".cache");
  const xdgData = join(isolatedHome, ".local", "share");
  const npmCache = join(isolatedHome, ".npm");
  for (const path of [tmp, xdgConfig, xdgCache, xdgData, npmCache]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return sandboxEnvironmentValue({
    registration,
    sidekickEnvironment,
    isolatedHome,
    runtimeExecutables,
  });
}

export async function buildGate2702SandboxLaunch({
  workerArgv,
  registration,
  gitDirectory,
  gitCommonDirectory,
  sandboxRuntime,
  sidekickEnvironment,
  env = process.env,
}) {
  if (!sandboxRuntime) fail("C5 sandbox runtime is missing");
  if (
    !sidekickEnvironment ||
    Array.isArray(sidekickEnvironment) ||
    typeof sidekickEnvironment !== "object" ||
    Object.values(sidekickEnvironment).some(
      (value) => typeof value !== "string",
    ) ||
    Object.keys(sidekickEnvironment).some((key) =>
      GATE_2702_SANDBOX_ENV_KEYS.includes(key),
    )
  ) {
    fail("Sidekick environment cannot override the sandbox environment");
  }
  const hostHome = realpathSync(resolve(env.HOME || homedir()));
  const sandboxRoot = join(registration.runDir, "sandbox");
  const isolatedHome = join(sandboxRoot, "home");
  const settingsPath = join(sandboxRoot, "settings.json");
  mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 });
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  const credentialPath = installCredential(isolatedHome, hostHome);

  try {
    const rg = sandboxRuntime.tools.find((tool) => tool.name === "rg");
    if (!rg) fail("C5 sandbox has no pinned ripgrep runtime");

    let effectiveWorkerArgv = [...workerArgv];
    let claude = null;
    if (env.CHD_EXPERIMENT_2702_TEST_MODE !== "1") {
      claude = commandPath("claude", env);
      effectiveWorkerArgv = [
        claude.resolved,
        ...workerArgv.slice(1),
        "--plugin-dir",
        sandboxRuntime.sidekick.path,
      ];
    }

    const allowedReadRoots = uniqueSorted([
      registration.worktreePath,
      registration.runDir,
      gitDirectory,
      gitCommonDirectory,
      sandboxRuntime.packageRoot,
      rg.resolved,
      ...(claude ? [claude.resolved] : []),
      ...(sandboxRuntime.sidekick ? [sandboxRuntime.sidekick.path] : []),
    ]);
    const allowedWriteRoots = uniqueSorted([
      registration.worktreePath,
      isolatedHome,
      gitDirectory,
    ]);
    const bwrap = sandboxRuntime.tools.find((tool) => tool.name === "bwrap");
    const socat = sandboxRuntime.tools.find((tool) => tool.name === "socat");
    const policy = {
      network: {
        allowedDomains:
          env.CHD_EXPERIMENT_2702_TEST_MODE === "1" ? [] : [MODEL_DOMAIN],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [hostHome],
        allowRead: allowedReadRoots,
        allowWrite: allowedWriteRoots,
        denyWrite: ["/tmp/claude", "/private/tmp/claude"],
      },
      ripgrep: { command: rg.resolved },
      ...(bwrap ? { bwrapPath: bwrap.resolved } : {}),
      ...(socat ? { socatPath: socat.resolved } : {}),
    };
    const { SandboxRuntimeConfigSchema } = await import(
      pathToFileURL(SRT_INDEX).href
    );
    const settings = SandboxRuntimeConfigSchema.parse(policy);
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const environment = sandboxEnvironment({
      registration,
      sidekickEnvironment,
      isolatedHome,
      runtimeExecutables: [
        rg.resolved,
        ...(claude ? [claude.resolved] : [workerArgv[0]]),
      ],
    });
    const inner = [
      `cd ${shellQuote(registration.worktreePath)}`,
      `exec ${effectiveWorkerArgv.map(shellQuote).join(" ")}`,
    ].join(" && ");
    const argv = [
      process.execPath,
      sandboxRuntime.cliPath,
      "-s",
      settingsPath,
      "-c",
      inner,
    ];
    return {
      argv,
      environment,
      workerEnvironmentKeys: [
        ...new Set([
          ...Object.keys(environment),
          ...GATE_2702_SRT_INJECTED_ENV_KEYS,
        ]),
      ].sort(),
      credentialPath,
      isolatedHome,
      attestation: {
        enforcer: sandboxRuntime.enforcer,
        package: sandboxRuntime.package,
        launcherExecutable: process.execPath,
        tools: sandboxRuntime.tools,
        policy: settings,
        policyDigest: sha256(canonicalJson(settings)),
        allowedReadRoots,
        allowedWriteRoots,
        gitDirectory,
        gitCommonDirectory,
        hostHome,
        hostHomeDenied:
          settings.filesystem.denyRead.includes(hostHome) &&
          !settings.filesystem.allowRead.includes(hostHome),
        isolatedHome,
        credentialMode: "isolated-home-credential-only",
        sidekickSnapshot: sandboxRuntime.sidekick,
        workerArgv: effectiveWorkerArgv,
      },
    };
  } catch (error) {
    try {
      unlinkSync(credentialPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "C5 sandbox launch failed and its credential copy could not be removed",
        );
      }
    }
    throw error;
  }
}

export function assertGate2702SandboxPreDispatch({
  preDispatch,
  registration,
  worktreeIdentity,
}) {
  const sandbox = preDispatch?.sandbox;
  if (
    !sandbox ||
    sandbox.enforcer !== "srt" ||
    sandbox.package?.name !== "@anthropic-ai/sandbox-runtime" ||
    sandbox.package?.version !== EXPECTED_SRT_VERSION ||
    !sandbox.package?.root?.endsWith(
      "/node_modules/@anthropic-ai/sandbox-runtime",
    ) ||
    !DIGEST_PATTERN.test(sandbox.package?.manifestDigest ?? "") ||
    !DIGEST_PATTERN.test(sandbox.package?.cliDigest ?? "") ||
    !isAbsolute(sandbox.package?.root ?? "") ||
    sandbox.package?.cliPath !==
      join(sandbox.package?.root ?? "", "dist", "cli.js") ||
    sandbox.launcherExecutable !== preDispatch.argv?.[0] ||
    sandbox.package.cliPath !== preDispatch.argv?.[1] ||
    preDispatch.argv?.[2] !== "-s" ||
    preDispatch.argv?.[3] !==
      join(registration.runDir, "sandbox", "settings.json") ||
    preDispatch.argv?.[4] !== "-c" ||
    typeof preDispatch.argv?.[5] !== "string" ||
    preDispatch.argv.length !== 6 ||
    sandbox.credentialMode !== "isolated-home-credential-only" ||
    sandbox.hostHomeDenied !== true ||
    typeof sandbox.hostHome !== "string" ||
    typeof sandbox.isolatedHome !== "string" ||
    typeof sandbox.gitDirectory !== "string" ||
    typeof sandbox.gitCommonDirectory !== "string"
  ) {
    fail("pre-dispatch receipt has no valid sandbox enforcer attestation");
  }
  if (
    !sandbox.policy ||
    sandbox.policyDigest !== sha256(canonicalJson(sandbox.policy)) ||
    !Array.isArray(sandbox.allowedReadRoots) ||
    !Array.isArray(sandbox.allowedWriteRoots) ||
    sandbox.allowedReadRoots.some((path) => !isAbsolute(path)) ||
    sandbox.allowedWriteRoots.some((path) => !isAbsolute(path)) ||
    !sameValue(
      sandbox.policy.filesystem?.allowRead,
      sandbox.allowedReadRoots,
    ) ||
    !sameValue(sandbox.policy.filesystem?.allowWrite, sandbox.allowedWriteRoots)
  ) {
    fail("pre-dispatch sandbox policy attestation is inconsistent");
  }
  const hostHome = resolve(sandbox.hostHome);
  const isolatedHome = resolve(sandbox.isolatedHome);
  const expectedIsolatedHome = resolve(registration.runDir, "sandbox", "home");
  const expectedSidekickPath = resolve(
    registration.runDir,
    "../../../..",
    "sandbox-runtime",
    SIDEKICK_SNAPSHOT_DIRECTORY,
  );
  if (
    !Array.isArray(sandbox.tools) ||
    sandbox.tools.length !== 3 ||
    sandbox.tools.some(
      (tool) =>
        !tool ||
        typeof tool !== "object" ||
        Array.isArray(tool) ||
        !["bwrap", "socat", "rg"].includes(tool.name) ||
        !isAbsolute(tool.command ?? "") ||
        !isAbsolute(tool.resolved ?? "") ||
        (tool.version !== null && typeof tool.version !== "string"),
    ) ||
    new Set(sandbox.tools.map((tool) => tool.name)).size !== 3
  ) {
    fail("pre-dispatch sandbox tools are not the fixed runtime set");
  }
  const bwrap = sandbox.tools.find((tool) => tool.name === "bwrap");
  const socat = sandbox.tools.find((tool) => tool.name === "socat");
  const rg = sandbox.tools.find((tool) => tool.name === "rg");
  if (
    sandbox.policy.bwrapPath !== bwrap.resolved ||
    sandbox.policy.socatPath !== socat.resolved ||
    sandbox.policy.ripgrep?.command !== rg.resolved
  ) {
    fail("pre-dispatch sandbox policy does not bind its runtime tools");
  }
  if (
    resolve(sandbox.gitDirectory) !==
      resolve(worktreeIdentity.gitDirectory) ||
    resolve(sandbox.gitCommonDirectory) !==
      resolve(worktreeIdentity.gitDirectory, "../..") ||
    !Array.isArray(sandbox.workerArgv) ||
    sandbox.workerArgv.length === 0 ||
    sandbox.workerArgv.some((value) => typeof value !== "string" || !value) ||
    !isAbsolute(sandbox.workerArgv[0])
  ) {
    fail("pre-dispatch sandbox command scope is not the registered scope");
  }
  if (
    (preDispatch.executionMode === "test" &&
      sandbox.sidekickSnapshot !== null) ||
    (preDispatch.executionMode !== "test" &&
      (sandbox.sidekickSnapshot?.path !== expectedSidekickPath ||
        !DIGEST_PATTERN.test(
          sandbox.sidekickSnapshot?.contentDigest ?? "",
        )))
  ) {
    fail("pre-dispatch sandbox has no fixed Sidekick snapshot");
  }
  const expectedAllowedReadRoots = uniqueSorted([
    registration.worktreePath,
    registration.runDir,
    worktreeIdentity.gitDirectory,
    sandbox.gitCommonDirectory,
    sandbox.package.root,
    rg.resolved,
    sandbox.workerArgv[0],
    ...(sandbox.sidekickSnapshot ? [sandbox.sidekickSnapshot.path] : []),
  ]);
  if (
    hostHome === resolve("/") ||
    isolatedHome !== expectedIsolatedHome ||
    !sameValue(sandbox.policy.filesystem.denyRead, [hostHome]) ||
    sandbox.policy.filesystem.allowRead.includes(hostHome) ||
    !sameValue(sandbox.policy.filesystem.denyWrite, [
      "/tmp/claude",
      "/private/tmp/claude",
    ]) ||
    !sameValue(
      sandbox.allowedWriteRoots,
      uniqueSorted([
        registration.worktreePath,
        isolatedHome,
        worktreeIdentity.gitDirectory,
      ]),
    ) ||
    !sameValue(sandbox.allowedReadRoots, expectedAllowedReadRoots) ||
    preDispatch.argv[5] !==
      [
        `cd ${shellQuote(registration.worktreePath)}`,
        `exec ${sandbox.workerArgv.map(shellQuote).join(" ")}`,
      ].join(" && ")
  ) {
    fail("pre-dispatch sandbox filesystem scope is not the registered scope");
  }
  const expectedDomains =
    preDispatch.executionMode === "test" ? [] : [MODEL_DOMAIN];
  if (
    !sameValue(sandbox.policy.network?.allowedDomains, expectedDomains) ||
    !sameValue(sandbox.policy.network?.deniedDomains, [])
  ) {
    fail("pre-dispatch sandbox network scope is not model-only");
  }
  if (
    !preDispatch.environment ||
    Array.isArray(preDispatch.environment) ||
    Object.values(preDispatch.environment).some(
      (value) => typeof value !== "string",
    ) ||
    preDispatch.environmentDigest !==
      sha256(canonicalJson(preDispatch.environment))
  ) {
    fail("pre-dispatch sandbox environment has no valid attestation");
  }
  const expectedEnvironmentKeys = [
    ...new Set([
      ...GATE_2702_SANDBOX_ENV_KEYS,
      ...Object.keys(preDispatch.sidekickEnvironment ?? {}),
    ]),
  ].sort();
  const expectedWorkerEnvironmentKeys = [
    ...new Set([
      ...expectedEnvironmentKeys,
      ...GATE_2702_SRT_INJECTED_ENV_KEYS,
    ]),
  ].sort();
  const expectedEnvironment = sandboxEnvironmentValue({
    registration,
    sidekickEnvironment: preDispatch.sidekickEnvironment,
    isolatedHome,
    runtimeExecutables: [rg.resolved, sandbox.workerArgv[0]],
  });
  if (
    !sameValue(preDispatch.environmentKeys, expectedEnvironmentKeys) ||
    !sameValue(
      Object.keys(preDispatch.environment).sort(),
      expectedEnvironmentKeys,
    ) ||
    !sameValue(
      preDispatch.workerEnvironmentKeys,
      expectedWorkerEnvironmentKeys,
    ) ||
    !sameValue(preDispatch.environment, expectedEnvironment)
  ) {
    fail("pre-dispatch sandbox environment exceeds its fixed allowlist");
  }
  return sandbox;
}

export function removeGate2702SandboxCredential(launch) {
  const path = launch?.credentialPath;
  if (typeof path !== "string" || !path) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function finalizeGate2702SandboxHome(launch) {
  removeGate2702SandboxCredential(launch);
  const isolatedHome = launch?.isolatedHome;
  if (typeof isolatedHome !== "string" || !isAbsolute(isolatedHome)) return;
  for (const name of readdirSync(isolatedHome)) {
    const path = join(isolatedHome, name);
    const metadata = lstatSync(path);
    if (name === ".sidekick") {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        if (metadata.isSymbolicLink() || metadata.isFile()) unlinkSync(path);
        fail("sandbox Sidekick state is not a real directory");
      }
      continue;
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  }
}
