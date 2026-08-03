#!/usr/bin/env node
// Gate: tracked publishable source must not disclose a developer's absolute
// host home path (#3448).
//
// The package is intended to become public. An absolute home path embeds a
// contributor identity and often reveals private directory structure even
// when the referenced file is harmless. This gate scans the Git index rather
// than a hand-picked source tree, so adding a new tracked directory cannot
// silently move it outside the inspection boundary.
//
// The allowlist is deliberately a closed set of reviewed portable identities:
// container/service accounts plus conventional fixture names used throughout
// tests and sample data. An unknown identity fails. Adding an identity is a
// policy diff; adding a new directory is not an implicit exemption.

import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Portable identities already present in container paths, CI paths, tests, and
 * sample data. `node`, `runner`, and `user` are the mandatory infrastructure /
 * generic identities from #3448; the others are reviewed fixture aliases.
 */
export const PORTABLE_HOME_USERS = Object.freeze([
  'alice',
  'bob',
  'dashboard',
  'dev',
  'host-secret',
  'me',
  'node',
  'runner',
  'shelltest',
  'someone',
  'u',
  'user',
  'youruser',
]);

let portableUserSet;

function portableUsers() {
  if (portableUserSet) return portableUserSet;
  // perf-index-contract: personal-path-portable-users non-querying
  portableUserSet = new Set(PORTABLE_HOME_USERS);
  return portableUserSet;
}

// Require an absolute-path boundary so a relative source path such as
// `src/home/index.ts` is not treated as a host home. `file://` is explicit
// because the slash immediately before an absolute path is otherwise excluded.
const UNIX_HOME_RE =
  /(?:^|file:\/\/|[^A-Za-z0-9._/-])(\/home\/([A-Za-z0-9][A-Za-z0-9._-]*))/g;
const WINDOWS_HOME_RE =
  /(?:^|[^A-Za-z0-9._\\/-])([A-Za-z]:\\+Users\\+([A-Za-z0-9][A-Za-z0-9._-]*))/gi;

function matchesInLine(line, regex, style, file, lineNumber, resolveAllowedUsers) {
  const offenders = [];
  regex.lastIndex = 0;
  for (const match of line.matchAll(regex)) {
    const path = match[1];
    const user = match[2];
    if (resolveAllowedUsers().has(user.toLowerCase())) continue;
    const pathOffset = match[0].lastIndexOf(path);
    offenders.push({
      file,
      line: lineNumber,
      column: (match.index ?? 0) + pathOffset + 1,
      style,
      user,
      path,
    });
  }
  return offenders;
}

/** Return every unapproved absolute host-home path in one tracked file. */
export function findPersonalPathsInText(
  source,
  file,
  { allowedUsers } = {}
) {
  const offenders = [];
  const resolveAllowedUsers = () => allowedUsers ?? portableUsers();
  const lines = String(source).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    offenders.push(
      ...matchesInLine(
        lines[index],
        UNIX_HOME_RE,
        'unix',
        file,
        lineNumber,
        resolveAllowedUsers
      ),
      ...matchesInLine(
        lines[index],
        WINDOWS_HOME_RE,
        'windows',
        file,
        lineNumber,
        resolveAllowedUsers
      )
    );
  }
  return offenders;
}

/** Enumerate the Git index; untracked build output and local files are absent. */
export function listTrackedFiles(root) {
  let output;
  try {
    output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err?.stderr?.toString('utf8').trim();
    throw new Error(
      `could not enumerate tracked files under ${root}${detail ? `: ${detail}` : ''}`
    );
  }
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function trackedFileText(root, file) {
  const absolute = resolve(root, file);
  const back = relative(root, absolute);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`tracked path escapes repository root: ${file}`);
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return readlinkSync(absolute, 'utf8');
    if (!stat.isFile()) throw new Error('not a regular file or symlink');
    return readFileSync(absolute).toString('utf8');
  } catch (err) {
    throw new Error(
      `could not inspect tracked file ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Scan every tracked path. Any unreadable/missing index entry is a hard error. */
export function scanTrackedFiles(root = REPO_ROOT) {
  const offenders = [];
  for (const file of listTrackedFiles(root)) {
    offenders.push(...findPersonalPathsInText(trackedFileText(root, file), file));
  }
  return offenders;
}

function main() {
  const rootArg = process.argv[2];
  let root;
  let offenders;
  try {
    root = realpathSync(rootArg ? resolve(rootArg) : REPO_ROOT);
    offenders = scanTrackedFiles(root);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  for (const offender of offenders) {
    console.error(
      `::error file=${offender.file},line=${offender.line},col=${offender.column}::` +
        `${offender.file}:${offender.line}:${offender.column} contains an unapproved ` +
        `${offender.style} host-home identity "${offender.user}". Replace the personal ` +
        `absolute path with a portable placeholder or explicitly review the identity in ` +
        `PORTABLE_HOME_USERS.`
    );
  }
  if (offenders.length > 0) process.exit(1);
  console.log(
    `Portable-host-path gate passed: ${listTrackedFiles(root).length} tracked files inspected; ` +
      `no unapproved absolute home identities.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
