import type { HygieneFinding } from './config-hygiene';
// Always-quote, not the minimal form: every snippet this module emits is a
// delete or an editor-open aimed at a user path, so visible quoting is worth
// more here than a shorter line (#3379).
import { shellQuote } from './shell-quote';

/**
 * Render a path for the copyable `code -g ...` command.
 *
 * A `~` path needs `$HOME` to expand, which single quotes would prevent -- but
 * wrapping the WHOLE path in double quotes (the previous behaviour) also leaves
 * `$(...)`, backticks and other `$VAR` live, so a config path containing
 * command substitution executed on paste. Expand only the `$HOME` prefix, and
 * single-quote the remainder so nothing else in it is interpreted.
 */
function openablePath(path: string): string {
  if (path.startsWith('~')) {
    const rest = path.slice(1);
    return rest ? `"$HOME"${shellQuote(rest)}` : '"$HOME"';
  }
  return shellQuote(path);
}

/**
 * Human-facing name of each recursively-removable resource root. The actual
 * configured root and its canonical-containment verdict arrive as server data.
 */
const RECURSIVE_REMOVAL_ROOTS: Partial<Record<HygieneFinding['resourceType'], string>> = {
  skill: 'skills',
  plugin: 'plugins',
};

/** What to emit for a finding: a runnable command, or an inert human note. */
type RemovalAction =
  | { kind: 'command'; snippet: string }
  | { kind: 'manual'; note: string };

/**
 * Is `path` a safe target for `rm -rf`?
 *
 * `shellQuote` stops injection, but quoting a dangerous path just deletes it
 * accurately: a malformed or poisoned config can hand us `/`, `$HOME`, or the
 * Claude config root, and the user copy-pastes a recursive delete of it. So the
 * SCOPE has to be bounded too, not just the syntax.
 *
 * Canonical containment is decided by the server because only it can see both
 * the configured root and the filesystem (#3377). This browser-safe second
 * check validates the exact lexical strings carried by that verdict. The
 * target must:
 *
 *   1. be absolute, or `~`-anchored (a relative path is cwd-dependent, so what
 *      it resolves to when pasted is not knowable here);
 *   2. contain no upward traversal;
 *   3. be a strict lexical descendant of the configured resource root;
 *   4. carry an affirmative server-side canonical-containment verdict.
 *
 * `/`, `~`, `/home/me` and `~/.claude` all fail without being enumerated.
 */
function isBoundedRemovalPath(
  path: string,
  safety: HygieneFinding['removalSafety']
): boolean {
  if (!safety?.canonicalPathContained) return false;
  const root = safety.configuredRoot;
  // Validate EXACTLY the string the command will carry. An earlier version
  // normalized `\\` to `/` first, which meant the validator and the emitted
  // `rm -rf` disagreed about where the separators were: `/tmp/.claude\\plugins\\victim`
  // looked nested to the validator, while POSIX treats those backslashes as
  // ordinary filename characters, so the command deleted an out-of-root
  // directory. A backslash cannot appear in a legitimate Claude resource path,
  // so refuse it outright rather than trying to interpret it.
  if (path.includes('\\') || root.includes('\\')) return false;
  // Drop any trailing slash so `skills/foo/` is not read as having an empty
  // segment below the root.
  const normalized = path.replace(/\/+$/, '');
  const normalizedRoot = root.replace(/\/+$/, '');
  if (!normalized || !normalizedRoot) return false;

  const anchor = normalized.startsWith('/') ? '/' : /^~\//.test(normalized) ? '~' : null;
  const rootAnchor = normalizedRoot.startsWith('/')
    ? '/'
    : /^~\//.test(normalizedRoot)
      ? '~'
      : null;
  if (!anchor || anchor !== rootAnchor) return false;

  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  const rootSegments = normalizedRoot
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.includes('..') || rootSegments.includes('..')) return false;
  if (rootSegments.length === 0 || segments.length <= rootSegments.length) {
    return false;
  }
  return rootSegments.every((segment, index) => segments[index] === segment);
}

/**
 * Render an untrusted value for inclusion in a `#` comment.
 *
 * A newline in a recorded path or resource id would otherwise terminate the
 * comment and turn whatever follows into live shell — and in the plugin
 * heredoc form a crafted value could close the heredoc early. Collapse all
 * whitespace (newlines included) to single spaces and bound the length, so a
 * poisoned config cannot break out of the comment.
 */
function commentSafe(value: string): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > 200 ? `${flattened.slice(0, 200)}...` : flattened;
}

/** Inert fallback used when a path fails the containment check. */
function manualRemovalInstruction(finding: HygieneFinding): string {
  const root = RECURSIVE_REMOVAL_ROOTS[finding.resourceType] ?? 'install';
  return (
    `# Refusing to generate an automatic recursive delete for ` +
    `${commentSafe(finding.resourceType)} ${commentSafe(finding.resourceId)}: ` +
    `the server could not verify it as a strict descendant of the configured ${root} directory. ` +
    `Verify ${commentSafe(finding.removalPath ?? 'the install path')} by hand ` +
    `before removing anything.`
  );
}

function directRemovalAction(finding: HygieneFinding): RemovalAction | null {
  if (!finding.removalPath) return null;
  const quoted = shellQuote(finding.removalPath);
  const recursiveRoot = RECURSIVE_REMOVAL_ROOTS[finding.resourceType];
  if (recursiveRoot) {
    if (!isBoundedRemovalPath(finding.removalPath, finding.removalSafety)) {
      return { kind: 'manual', note: manualRemovalInstruction(finding) };
    }
    return { kind: 'command', snippet: `rm -rf -- ${quoted}` };
  }
  if (finding.resourceType === 'subagent' || finding.resourceType === 'command') {
    return { kind: 'command', snippet: `rm -- ${quoted}` };
  }
  return null;
}

function jsonMutationSnippet(args: {
  sourcePath: string;
  body: string;
  after?: string | null;
}): string {
  const after = args.after ? ` && ${args.after}` : '';
  return [
    `node <<'NODE'${after}`,
    "const fs = require('node:fs');",
    `const path = ${JSON.stringify(args.sourcePath)};`,
    "const data = JSON.parse(fs.readFileSync(path, 'utf8'));",
    args.body,
    "fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\\n`);",
    'NODE',
  ].join('\n');
}

export function buildConfigRemovalSnippet(
  finding: HygieneFinding
): string {
  if (finding.resourceType === 'mcpServer' && finding.sourcePath) {
    const project =
      finding.scope.kind === 'project' ? finding.scope.project : null;
    const body = project
      ? [
          `const project = ${JSON.stringify(project)};`,
          `const server = ${JSON.stringify(finding.resourceId)};`,
          'if (data.projects?.[project]?.mcpServers) {',
          '  delete data.projects[project].mcpServers[server];',
          '}',
        ].join('\n')
      : [
          `const server = ${JSON.stringify(finding.resourceId)};`,
          'if (data.mcpServers) delete data.mcpServers[server];',
          'for (const project of Object.values(data.projects ?? {})) {',
          '  if (!Array.isArray(project?.enabledMcpjsonServers)) continue;',
          '  project.enabledMcpjsonServers = project.enabledMcpjsonServers.filter((id) => id !== server);',
          '}',
        ].join('\n');
    return jsonMutationSnippet({ sourcePath: finding.sourcePath, body });
  }

  if (
    finding.resourceType === 'plugin' &&
    finding.sourcePath &&
    finding.removalPath
  ) {
    const body = [
      `const plugin = ${JSON.stringify(finding.resourceId)};`,
      `const installPath = ${JSON.stringify(finding.removalPath)};`,
      'if (Array.isArray(data.plugins?.[plugin])) {',
      '  data.plugins[plugin] = data.plugins[plugin].filter((entry) => entry?.installPath !== installPath);',
      '  if (data.plugins[plugin].length === 0) delete data.plugins[plugin];',
      '}',
    ].join('\n');
    // A manual note must NOT ride the `&&` chain: `node <<'NODE' && # ...`
    // leaves the `&&` without a right-hand command, so bash rejects the whole
    // snippet and the registry entry never gets removed either. Append it as
    // its own line instead.
    const action = directRemovalAction(finding);
    const mutation = jsonMutationSnippet({
      sourcePath: finding.sourcePath,
      body,
      after: action?.kind === 'command' ? action.snippet : null,
    });
    return action?.kind === 'manual' ? `${mutation}\n${action.note}` : mutation;
  }

  const action = directRemovalAction(finding);
  if (action) return action.kind === 'command' ? action.snippet : action.note;
  return (
    `# Open ${commentSafe(finding.sourcePath ?? 'the owning config file')} and ` +
    `remove ${commentSafe(finding.resourceType)} ${commentSafe(finding.resourceId)}.`
  );
}

export function buildConfigRemovalSnippetBlock(
  findings: HygieneFinding[]
): string {
  return findings.map(buildConfigRemovalSnippet).join('\n\n');
}

export function buildConfigOpenCommand(finding: HygieneFinding): string {
  const path = finding.sourcePath ?? finding.removalPath;
  if (!path) {
    return `# Locate ${finding.resourceType} ${finding.resourceId} in your Claude config.`;
  }
  return `code -g ${openablePath(path)}`;
}
