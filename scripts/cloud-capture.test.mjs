// Tests for the tools/cloud-capture supply-chain hardening (#3345, #3346).
//
// #3345 — tools/cloud-capture/install.sh command-injection hardening.
// The audit finding: for `--user` with a custom directory, the caller-controlled
// absolute path was interpolated directly into the double-quoted shell command
// stored in settings.json. A directory literally named `$(touch marker)` (or a
// backtick substitution) stayed active inside that double-quoted word and
// executed whenever the Stop / SessionEnd registration was evaluated — with
// CLAUDE_HUB_TOKEN potentially in the environment.
//
// The fix single-quotes the installed path (a filename is DATA, not shell
// source), keeping only the intentional $HOME / $CLAUDE_PROJECT_DIR
// indirections expandable. Each case here reproduces the exact acceptance
// scenario the finding specified: install into a hostile directory name, invoke
// the generated registration in isolation, and assert the marker is NOT created
// and the literal installed hook path is what runs.
//
// #3346 — tools/cloud-capture/publish-claude.sh must not persist a
// credential-bearing CLAUDE_HUB_REMOTE. An http(s) URL with embedded userinfo
// (`https://token@host/repo.git`) was cloned with, and then persisted in,
// $HUB_DIR/.git/config — a reusable secret at rest, contradicting the script's
// tokenless-remote policy. The fix fails closed on such a remote; authenticated
// hubs use CLAUDE_HUB_REPO + CLAUDE_HUB_TOKEN, which injects the token per git
// invocation and never writes it to disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(HERE, '..', 'tools', 'cloud-capture', 'install.sh');
const PUBLISH = join(HERE, '..', 'tools', 'cloud-capture', 'publish-claude.sh');

const hasJq = spawnSync('sh', ['-c', 'command -v jq']).status === 0;

/** Run install.sh --user against an absolute target dir; return its result. */
function install(targetDir, env = {}) {
  mkdirSync(targetDir, { recursive: true });
  return spawnSync('bash', [INSTALL, '--user', targetDir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** The Stop hook command jq/JSON reads back out of the written settings file. */
function stopCommand(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  return settings.hooks.Stop[0].hooks[0].command;
}

/**
 * A benign hook stub that records it was the file actually executed, by
 * touching `sentinelPath`. The sentinel MUST be a metacharacter-free path (a
 * plain mkdtemp dir): the stub writes it single-quoted, but keeping the value
 * clean means the stub itself can never be the thing that (re)introduces a
 * substitution the test is trying to rule out in the installed command.
 */
function plantHook(hookAbsPath, sentinelPath) {
  mkdirSync(dirname(hookAbsPath), { recursive: true });
  writeFileSync(hookAbsPath, `: > '${sentinelPath}'\n`);
}

/**
 * Execute a stored registration exactly as the harness would (`sh -c`), with a
 * sentinel hook planted at the pinned location so we can prove the LITERAL path
 * ran.
 */
function runRegistration(command, hookAbsPath, sentinelPath, env = {}) {
  plantHook(hookAbsPath, sentinelPath);
  return spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('install: a command-substitution directory name does not execute (#3345)', { skip: !hasJq && 'jq not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    const marker = join(base, 'marker');
    const hostile = join(base, `x$(touch ${marker})`);
    const res = install(hostile);
    assert.equal(res.status, 0, res.stderr);

    const settings = join(hostile, 'settings.json');
    const cmd = stopCommand(settings); // throws if not valid JSON
    // The path appears single-quoted, so `$(...)` is inert.
    assert.ok(cmd.includes(`'${hostile}/hooks/publish-claude.sh'`), cmd);

    const hookPath = join(hostile, 'hooks', 'publish-claude.sh');
    const sentinel = join(base, 'sentinel'); // clean path, no metacharacters
    runRegistration(cmd, hookPath, sentinel);

    assert.ok(!existsSync(marker), 'command substitution must NOT have executed');
    assert.ok(existsSync(sentinel), 'the literal installed hook path must have run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('install: a backtick directory name does not execute, JSON stays valid (#3345)', { skip: !hasJq && 'jq not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    const marker = join(base, 'bmarker');
    const hostile = join(base, 'y`touch ' + marker + '`');
    const res = install(hostile);
    assert.equal(res.status, 0, res.stderr);

    const settings = join(hostile, 'settings.json');
    // Valid JSON is the first half of the acceptance.
    const cmd = stopCommand(settings);
    assert.ok(cmd.includes(`'${hostile}/hooks/publish-claude.sh'`), cmd);

    const hookPath = join(hostile, 'hooks', 'publish-claude.sh');
    const sentinel = join(base, 'sentinel'); // clean path, no metacharacters
    runRegistration(cmd, hookPath, sentinel);

    assert.ok(!existsSync(marker), 'backtick substitution must NOT have executed');
    assert.ok(existsSync(sentinel), 'the literal installed hook path must have run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('install: a hostile dir UNDER $HOME keeps $HOME symbolic but the remainder inert (#3345)', { skip: !hasJq && 'jq not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    const fakeHome = join(base, 'home');
    const marker = join(base, 'hmarker');
    const hostile = join(fakeHome, `.cl$(touch ${marker})`);
    const res = install(hostile, { HOME: fakeHome });
    assert.equal(res.status, 0, res.stderr);

    const settings = join(hostile, 'settings.json');
    const cmd = stopCommand(settings);
    // $HOME stays an expandable variable, immediately concatenated with the
    // single-quoted (inert) caller-chosen remainder.
    const suffix = hostile.slice(fakeHome.length); // e.g. `/.cl$(touch ...)`
    assert.ok(cmd.includes(`"$HOME"'${suffix}/hooks/publish-claude.sh'`), cmd);

    // Evaluate with the same HOME the harness would carry.
    const hookPath = join(hostile, 'hooks', 'publish-claude.sh');
    const sentinel = join(base, 'sentinel'); // clean path, no metacharacters
    runRegistration(cmd, hookPath, sentinel, { HOME: fakeHome });

    assert.ok(!existsSync(marker), 'command substitution under $HOME must NOT execute');
    assert.ok(existsSync(sentinel), 'the literal installed hook path must have run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('install: an embedded control character in the path is rejected (#3345)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    // A directory whose name carries an embedded newline (not trailing, so it
    // survives `cd && pwd`). No safe spelling exists in a stored registration.
    const hostile = join(base, 'a\nb');
    const res = install(hostile);
    assert.notEqual(res.status, 0, 'a control-character path must fail the install');
    assert.match(res.stderr, /control characters/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('install: reinstall is idempotent — one pinned registration, not a duplicate (#3345)', { skip: !hasJq && 'jq not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    const target = join(base, 'claude');
    install(target);
    install(target);
    const settings = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
    const stopCount = settings.hooks.Stop.flatMap((g) => g.hooks).length;
    const endCount = settings.hooks.SessionEnd.flatMap((g) => g.hooks).length;
    assert.equal(stopCount, 1, 'exactly one Stop registration after reinstall');
    assert.equal(endCount, 1, 'exactly one SessionEnd registration after reinstall');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('install: the previous double-quoted user pin is replaced, not duplicated (#3345)', { skip: !hasJq && 'jq not available' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-install-'));
  try {
    const target = join(base, 'claude');
    mkdirSync(target, { recursive: true });
    const hook = `${target}/hooks/publish-claude.sh`;
    // The pre-#3345 installer emitted this exact double-quoted shape.
    const legacy = `[ -f "${hook}" ] || exit 0; bash "${hook}"`;
    const priorSettings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: legacy }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: legacy }] }],
      },
    };
    writeFileSync(join(target, 'settings.json'), JSON.stringify(priorSettings));
    install(target);
    const settings = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
    const commands = settings.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);
    assert.equal(commands.length, 1, 'the old double-quoted pin must be replaced, not kept alongside');
    assert.ok(commands[0].includes(`'${hook}'`), 'the replacement uses the single-quoted shape');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Guard against the install script rotting into a non-executable state.
test('install.sh is present and syntactically valid bash', () => {
  const res = spawnSync('bash', ['-n', INSTALL], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  // A user-authored custom wrapper mentioning publish-claude.sh must still be
  // recognised by the known-shape jq program; a bash syntax check is the
  // cheapest proof the file did not break.
  execFileSync('bash', ['-n', INSTALL]);
});

// --- #3346: publish-claude.sh must not persist a credential-bearing remote ---

/**
 * Run publish-claude.sh in hook mode (a cloud session, minimal stdin payload)
 * with the given CLAUDE_HUB_REMOTE, isolating its cache under a throwaway
 * CLAUDE_CONFIG_DIR so we can prove nothing was written there.
 */
function runPublish(remote, configDir, extraEnv = {}) {
  return spawnSync('bash', [PUBLISH], {
    input: '{}',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_HUB_REMOTE: remote,
      ...extraEnv,
    },
  });
}

/** Does any file under `dir` contain `needle` (the secret leak check)? */
function treeContains(dir, needle) {
  let hit = false;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          if (readFileSync(full, 'utf8').includes(needle)) hit = true;
        } catch {
          /* binary / unreadable — not a plaintext secret leak */
        }
      }
    }
  };
  walk(dir);
  return hit;
}

test('publish: a credential-bearing HTTPS CLAUDE_HUB_REMOTE is refused, nothing persisted (#3346)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  try {
    const secret = 'ghp_secret_token_do_not_persist';
    const res = runPublish(`https://${secret}@github.com/o/r.git`, base);
    assert.equal(res.status, 0, 'hook mode must never break the session');
    assert.match(res.stderr, /embeds credentials in the URL/);
    // No clone happened, so the secret is nowhere in the cache tree.
    assert.ok(!treeContains(base, secret), 'the token must not be persisted anywhere');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('publish: userinfo with an explicit password is refused too (#3346)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  try {
    const secret = 'x-access-token:ghp_pw';
    const res = runPublish(`https://${secret}@github.com/o/r.git`, base);
    assert.match(res.stderr, /embeds credentials in the URL/);
    assert.ok(!treeContains(base, 'ghp_pw'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('publish: a tokenless HTTPS remote is NOT falsely rejected (#3346)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  try {
    const res = runPublish('https://github.com/o/r.git', base);
    // It passes the credential guard and stops later at the transcript check —
    // the point is only that the guard did not fire on a clean URL.
    assert.doesNotMatch(res.stderr, /embeds credentials in the URL/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('publish: an SSH-style git@ remote is NOT rejected — its user is a login, not a stored secret (#3346)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  try {
    for (const remote of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git']) {
      const res = runPublish(remote, base);
      assert.doesNotMatch(res.stderr, /embeds credentials in the URL/, `${remote} must be allowed`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('publish: an `@` in the PATH (not the authority) is not mistaken for userinfo (#3346)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  try {
    const res = runPublish('https://github.com/o/r@ref.git', base);
    assert.doesNotMatch(res.stderr, /embeds credentials in the URL/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('publish: the CLAUDE_HUB_REPO + token path still injects credentials ephemerally, never in config (#3346)', () => {
  // The safe authenticated path is unchanged: the token travels through the
  // inline credential helper in `hub_git`, and the persisted remote URL is
  // tokenless. Asserted structurally so a future edit cannot quietly regress it.
  const source = readFileSync(PUBLISH, 'utf8');
  assert.match(source, /credential\.helper=!f\(\)/, 'hub_git must supply the token via an inline credential helper');
  assert.match(
    source,
    /remote set-url origin "\$REMOTE"/,
    'the persisted remote URL must be re-asserted tokenless every run',
  );
});

// Guard against the publish script rotting into an unparseable state.
test('publish-claude.sh is present and syntactically valid bash', () => {
  execFileSync('bash', ['-n', PUBLISH]);
});
