import {
  componentSubtree,
  createRuleTopicDisambiguator,
  ruleTopicSlug,
} from '../../config-rule-naming';
import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import { adherenceClean } from '../../parse-shadow-calls';
import type { AxisAggregate } from '../../parse-shadow-calls';
import type { LiveConfig, LiveSettings } from '../../../types';
import { clearsShadowWinThresholds } from '../workflow/shadow-axis-wins';
import type { Detector, Recommendation } from '../types';

const DETECTOR_ID = 'context.over-scoped-config-section';
const MAX_EVIDENCE_FILES = 5;
const CONFIG_SCOPING_AXIS = 'config-scoping';
const HOOK_COMMAND_MAX_TOKENS = 64;

interface Candidate {
  project: RepoMapProjectJoin;
  section: ConfigSection;
  files: RepoMapFileJoin[];
  subtree: string;
  pathsGlob: string;
  rulePath: string;
  idSuffix: string;
  hookGuardChecked: boolean;
}

type HookCandidate = Pick<Candidate, 'project' | 'section'>;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function stripLeadingDot(path: string): string {
  return path.replace(/^\.\//, '');
}

function toRepoRelative(path: string, root: string): string {
  const normalized = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return stripLeadingDot(normalized.slice(normalizedRoot.length + 1));
  }
  return stripLeadingDot(normalized);
}

function isRootConfigSection(section: ConfigSection, projectRoot: string): boolean {
  const scope = toRepoRelative(section.sourceScope, projectRoot);
  return scope === 'AGENTS.md' || scope === 'CLAUDE.md';
}

/** Browser-safe lexical path normalization for exact hook-command identity checks. */
function normalizeIdentityPath(path: string): string {
  const cleaned = normalizePath(
    path.trim().replace(/^['"`]+/, '').replace(/['"`]+$/, '')
  );
  const windowsAbsolute = /^[A-Za-z]:\//.test(cleaned);
  const absolute = cleaned.startsWith('/') || windowsAbsolute;
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      const rootParts = windowsAbsolute ? 1 : 0;
      if (parts.length <= rootParts) return '';
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (windowsAbsolute && parts[0]) {
    parts[0] = `${parts[0][0].toUpperCase()}:`;
  }
  const normalized = `${absolute && !windowsAbsolute ? '/' : ''}${parts.join('/')}`;
  return windowsAbsolute
    ? `${normalized.slice(0, 2)}${normalized.slice(2).toLowerCase()}`
    : normalized;
}

function isAbsoluteIdentityPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path.trim());
}

function sectionReferencesEvent(section: ConfigSection, event: string): boolean {
  return section.references.some((reference) => {
    if (reference.kind !== 'configKey') return false;
    const parts = reference.target.split('.');
    const hooksIndex = parts.lastIndexOf('hooks');
    const referencedEvent =
      hooksIndex >= 0 ? parts[hooksIndex + 1] : parts.length === 1 ? parts[0] : null;
    return referencedEvent === event || referencedEvent === '*';
  });
}

const PROJECT_IDENTITY = '$PROJECT';
const HOME_IDENTITY = '$HOME';
type HookSettingsScope = 'global' | 'project';
type LeadingShellExpansion = 'home' | 'project' | 'tilde' | null;

interface HookCommandToken {
  value: string;
  leadingExpansion: LeadingShellExpansion;
  hasLiteralBackslash: boolean;
}

function appendIdentity(base: string, suffix: string): string {
  return suffix ? `${base}/${suffix}` : base;
}

function addIdentity(
  identities: Set<string>,
  identity: string,
  caseInsensitive: boolean
): void {
  identities.add(caseInsensitive ? identity.toLowerCase() : identity);
}

function relativeToRoot(path: string, root: string): string | null {
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** Return the suffix of an explicit symbolic-home path. */
function symbolicHomeRelative(
  path: string,
  leadingExpansion: LeadingShellExpansion
): string | null {
  const tildeExpands = leadingExpansion === 'tilde';
  const homeExpands = leadingExpansion === 'home';
  if (tildeExpands && path === '~') return '';
  if (homeExpands && (path === HOME_IDENTITY || path === '${HOME}')) return '';
  if (tildeExpands && path.startsWith('~/')) return path.slice(2);
  if (!homeExpands) return null;
  const symbolic = path.match(/^\$(?:\{HOME\}|HOME)(?:\/(.*))?$/);
  return symbolic ? (symbolic[1] ?? '') : null;
}

function isGlobalClaudeSource(sourceScope: string, projectRoot: string): boolean {
  const source = normalizeIdentityPath(sourceScope);
  const root = normalizeIdentityPath(projectRoot);
  const caseInsensitive = isWindowsAbsolutePath(root);
  const comparableSource = caseInsensitive ? source.toLowerCase() : source;
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  return (
    comparableSource === (caseInsensitive ? 'claude.md' : 'CLAUDE.md') ||
    (comparableRoot.endsWith('/.claude') &&
      comparableSource ===
        `${comparableRoot}/${caseInsensitive ? 'claude.md' : 'CLAUDE.md'}`)
  );
}

function canonicalSectionIdentities(
  referencePath: string,
  projectRoot: string,
  sourceScope: string
): Set<string> {
  const root = normalizeIdentityPath(projectRoot);
  const reference = normalizeIdentityPath(referencePath);
  const identities = new Set<string>();
  const caseInsensitive = isWindowsAbsolutePath(root);
  if (!root || !reference || /[$*?{}]/.test(reference)) return identities;

  if (isAbsoluteIdentityPath(reference)) {
    addIdentity(identities, reference, caseInsensitive);
    const projectRelative = relativeToRoot(reference, root);
    if (projectRelative != null) {
      addIdentity(
        identities,
        appendIdentity(PROJECT_IDENTITY, projectRelative),
        caseInsensitive
      );
    }
    return identities;
  }

  // The only bare CLAUDE.md source produced by ingest is the global
  // ~/.claude/CLAUDE.md. Project config sources are absolute. Resolve its file
  // references symbolically so HOME aliases compare without exposing or
  // guessing the host username.
  if (isGlobalClaudeSource(sourceScope, root)) {
    const homeRelative =
      reference === '.claude' || reference.startsWith('.claude/')
        ? reference
        : `.claude/${reference}`;
    addIdentity(
      identities,
      appendIdentity(HOME_IDENTITY, normalizeIdentityPath(homeRelative)),
      caseInsensitive
    );
    // Global hooks may deliberately use $CLAUDE_PROJECT_DIR. At candidate
    // time the governed project root is known, so retain that exact relative
    // interpretation alongside the ordinary ~/.claude interpretation.
    addIdentity(
      identities,
      appendIdentity(PROJECT_IDENTITY, reference),
      caseInsensitive
    );
    return identities;
  }

  addIdentity(
    identities,
    appendIdentity(PROJECT_IDENTITY, reference),
    caseInsensitive
  );
  return identities;
}

function canonicalCommandIdentities(
  commandPath: string,
  projectRoot: string,
  scope?: HookSettingsScope,
  sourceScope?: string,
  concreteGlobalRoots: readonly string[] = [],
  leadingExpansion: LeadingShellExpansion = null,
  hasLiteralBackslash = false
): Set<string> {
  const root = normalizeIdentityPath(projectRoot);
  const command = normalizeIdentityPath(commandPath);
  const identities = new Set<string>();
  const caseInsensitive = isWindowsAbsolutePath(root);
  if (
    !root ||
    !command ||
    /[*?]/.test(command) ||
    commandPath.includes('\\/') ||
    (hasLiteralBackslash && !isWindowsAbsolutePath(commandPath))
  ) {
    return identities;
  }

  const projectPrefix =
    leadingExpansion === 'project'
      ? command.match(
          /^\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)(?:\/(.*))?$/
        )
      : null;
  if (projectPrefix) {
    addIdentity(
      identities,
      appendIdentity(PROJECT_IDENTITY, projectPrefix[1] ?? ''),
      caseInsensitive
    );
    return identities;
  }

  const homeRelative = symbolicHomeRelative(command, leadingExpansion);
  if (homeRelative != null) {
    addIdentity(
      identities,
      appendIdentity(HOME_IDENTITY, homeRelative),
      caseInsensitive
    );
    return identities;
  }

  // Host ingest never annotates opaque or ordinary relative paths. Treat one
  // in a synthetic/legacy dataset as unprovable rather than guessing.
  if (/[${}]/.test(command) || !isAbsoluteIdentityPath(command)) return identities;
  addIdentity(identities, command, caseInsensitive);
  if (scope === 'global' && sourceScope != null) {
    const normalizedGlobalRoots = [
      ...new Set(
        concreteGlobalRoots
          .map(normalizeIdentityPath)
          .filter((globalRoot) => globalRoot.endsWith('/.claude'))
      ),
    ];
    const matchingGlobalRoot =
      normalizedGlobalRoots.length === 1 &&
      relativeToRoot(command, normalizedGlobalRoots[0]) != null
        ? normalizedGlobalRoots[0]
        : null;
    let claudeHomeRelative = '';
    if (matchingGlobalRoot) {
      const relative = relativeToRoot(command, matchingGlobalRoot) ?? '';
      claudeHomeRelative = appendIdentity('.claude', relative);
    }
    if (
      claudeHomeRelative === '.claude' ||
      claudeHomeRelative.startsWith('.claude/')
    ) {
      addIdentity(
        identities,
        appendIdentity(HOME_IDENTITY, claudeHomeRelative),
        caseInsensitive
      );
    }
  }
  const projectRelative = relativeToRoot(command, root);
  if (projectRelative != null) {
    addIdentity(
      identities,
      appendIdentity(PROJECT_IDENTITY, projectRelative),
      caseInsensitive
    );
  }
  return identities;
}

/** Compare complete canonical paths; a shared basename can never match. */
function commandPathMatchesReference(
  referencePath: string,
  commandPath: HookCommandToken,
  projectRoot: string,
  sourceScope: string,
  scope: HookSettingsScope,
  concreteGlobalRoots: readonly string[]
): boolean {
  const sectionIdentities = canonicalSectionIdentities(
    referencePath,
    projectRoot,
    sourceScope
  );
  const commandIdentities = canonicalCommandIdentities(
    commandPath.value,
    projectRoot,
    scope,
    sourceScope,
    concreteGlobalRoots,
    commandPath.leadingExpansion,
    commandPath.hasLiteralBackslash
  );
  return [...sectionIdentities].some((identity) => commandIdentities.has(identity));
}

function leadingVariableExpansionAt(
  command: string,
  index: number
): Exclude<LeadingShellExpansion, 'tilde'> {
  if (command.startsWith('${HOME}', index)) return 'home';
  if (command.startsWith('${CLAUDE_PROJECT_DIR}', index)) return 'project';
  for (const [name, expansion] of [
    ['HOME', 'home'],
    ['CLAUDE_PROJECT_DIR', 'project'],
  ] as const) {
    const prefix = `$${name}`;
    if (!command.startsWith(prefix, index)) continue;
    const next = command[index + prefix.length];
    if (next == null || !/[A-Za-z0-9_]/.test(next)) return expansion;
  }
  return null;
}

/**
 * Tokenize the small, direct-command shell subset accepted as hook proof.
 * Quoted/escaped whitespace is preserved, while command substitution, control
 * flow, redirection, malformed quoting, and overlong commands fail open.
 */
function tokenizeHookCommand(command: string): HookCommandToken[] | null {
  const tokens: HookCommandToken[] = [];
  let token = '';
  let tokenStarted = false;
  let leadingExpansion: LeadingShellExpansion = null;
  let hasLiteralBackslash = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push({ value: token, leadingExpansion, hasLiteralBackslash });
    token = '';
    tokenStarted = false;
    leadingExpansion = null;
    hasLiteralBackslash = false;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\n' || char === '\r') return null;
    if (quote === "'") {
      if (char === "'") quote = null;
      else {
        token += char;
        if (char === '\\') hasLiteralBackslash = true;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (char === '`' || (char === '$' && command[index + 1] === '(')) {
        return null;
      }
      if (char === '\\') {
        const next = command[index + 1];
        if (next == null || next === '\n' || next === '\r') return null;
        if ('"$`\\'.includes(next)) {
          token += next;
          if (next === '\\') hasLiteralBackslash = true;
          index++;
        } else {
          token += char;
          hasLiteralBackslash = true;
        }
        tokenStarted = true;
        continue;
      }
      if (char === '$' && token.length === 0) {
        leadingExpansion = leadingVariableExpansionAt(command, index);
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      if (tokens.length > HOOK_COMMAND_MAX_TOKENS) return null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) {
      return null;
    }
    if (/[;&|<>()]/.test(char)) return null;
    if (char === '\\') {
      const next = command[index + 1];
      if (next == null || next === '\n' || next === '\r') return null;
      // Backslashes in drive-letter paths are separators, not POSIX escapes.
      if (/^[A-Za-z]:/.test(token)) {
        token += char;
      } else {
        token += next;
        if (next === '\\') hasLiteralBackslash = true;
        index++;
      }
      tokenStarted = true;
      continue;
    }
    if (token.length === 0) {
      if (char === '$') {
        leadingExpansion = leadingVariableExpansionAt(command, index);
      } else if (
        char === '~' &&
        !tokenStarted &&
        (command[index + 1] == null || command[index + 1] === '/')
      ) {
        leadingExpansion = 'tilde';
      }
    }
    token += char;
    tokenStarted = true;
  }

  if (quote != null) return null;
  pushToken();
  return tokens.length <= HOOK_COMMAND_MAX_TOKENS ? tokens : null;
}

function isScriptInterpreter(command: string): boolean {
  const basename = normalizeIdentityPath(command).split('/').pop()?.toLowerCase();
  return basename != null && (
    /^(?:node|nodejs|bun|tsx|bash|sh|zsh|ruby|perl)$/.test(basename) ||
    /^python(?:\d+(?:\.\d+)*)?$/.test(basename)
  );
}

function isShellInterpreter(command: string): boolean {
  const basename = normalizeIdentityPath(command).split('/').pop()?.toLowerCase();
  return basename != null && /^(?:bash|sh|zsh)$/.test(basename);
}

/**
 * Options known to consume no following token. Keep this deliberately narrow:
 * skipping an option with a separate value could mistake that value for the
 * script and turn a mere flag argument into companion proof.
 */
function isValuelessInterpreterOption(
  interpreter: string,
  option: string
): boolean {
  const basename = normalizeIdentityPath(interpreter)
    .split('/')
    .pop()
    ?.toLowerCase();
  return (
    basename != null &&
    /^(?:node|nodejs|bun|tsx)$/.test(basename) &&
    option === '--no-warnings'
  );
}

function identitiesOverlap(
  leftPath: HookCommandToken,
  rightPath: HookCommandToken,
  projectRoot: string
): boolean {
  const left = canonicalCommandIdentities(
    leftPath.value,
    projectRoot,
    undefined,
    undefined,
    [],
    leftPath.leadingExpansion,
    leftPath.hasLiteralBackslash
  );
  const right = canonicalCommandIdentities(
    rightPath.value,
    projectRoot,
    undefined,
    undefined,
    [],
    rightPath.leadingExpansion,
    rightPath.hasLiteralBackslash
  );
  return [...left].some((identity) => right.has(identity));
}

function parseSingleHookToken(raw: string): HookCommandToken | null {
  const tokens = tokenizeHookCommand(raw);
  return tokens?.length === 1 ? tokens[0] : null;
}

/** Prove the repository's pinned `[ -f path ] || exit 0; shell path` shape. */
function guardedScriptIdentityPath(
  command: string,
  projectRoot: string
): HookCommandToken | null {
  const match = command.match(
    /^\s*\[\s+-f\s+("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|<>()]+)\s+\]\s*\|\|\s*exit\s+0\s*;\s*([^\s;&|<>()]+)\s+("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|<>()]+)\s*$/
  );
  if (!match) return null;

  const guardPath = parseSingleHookToken(match[1]);
  const interpreter = parseSingleHookToken(match[2]);
  const scriptPath = parseSingleHookToken(match[3]);
  if (!guardPath || !interpreter || !scriptPath) return null;
  if (!isShellInterpreter(interpreter.value)) return null;
  if (!identitiesOverlap(guardPath, scriptPath, projectRoot)) return null;
  return canonicalCommandIdentities(
    scriptPath.value,
    projectRoot,
    undefined,
    undefined,
    [],
    scriptPath.leadingExpansion,
    scriptPath.hasLiteralBackslash
  ).size > 0
    ? scriptPath
    : null;
}

function isUnambiguousEnvAssignment(token: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false;
  const value = token.slice(token.indexOf('=') + 1);
  // The lightweight tokenizer cannot distinguish quoted/escaped operators
  // from real shell control flow. Fail open unless the assignment is a plain
  // shell word, so `FOO=1;echo <hook-path>` cannot make the path look like the
  // executable while common prefixes such as `NODE_OPTIONS=--no-warnings`
  // remain provable.
  return !/[;&|<>()'"`\\]/.test(value);
}

function isEnvExecutable(command: string): boolean {
  return normalizeIdentityPath(command).split('/').pop()?.toLowerCase() === 'env';
}

/** Return the command index after a conservative `env` invocation. */
function unwrapEnvCommand(
  tokens: readonly HookCommandToken[],
  envIndex: number
): number | null {
  if (!isEnvExecutable(tokens[envIndex]?.value ?? '')) return envIndex;
  let index = envIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index].value;
    if (token === '--') return index + 1 < tokens.length ? index + 1 : null;
    if (isUnambiguousEnvAssignment(token)) {
      index++;
      continue;
    }
    if (
      token === '-i' ||
      token === '--ignore-environment' ||
      token === '-0' ||
      token === '--null'
    ) {
      index++;
      continue;
    }
    if (/^--(?:unset|chdir)=.+/.test(token)) {
      index++;
      continue;
    }
    if (
      token === '-u' ||
      token === '--unset' ||
      token === '-C' ||
      token === '--chdir'
    ) {
      if (index + 1 >= tokens.length || tokens[index + 1].value === '') return null;
      index += 2;
      continue;
    }
    if (token.startsWith('-')) return null;
    return index;
  }
  return null;
}

/**
 * Prove the configured command's executable script path. Ingest annotations
 * are useful for filesystem existence checks, but are not command identity:
 * older datasets omit them and malformed settings may contain stale values.
 * Only a direct path command or an interpreter's immediate script argument is
 * accepted. Paths mentioned by tests, flags, redirects, or wrapper arguments
 * therefore cannot suppress a recommendation.
 */
function commandIdentityPath(
  command: string,
  projectRoot: string
): HookCommandToken | null {
  const guardedScript = guardedScriptIdentityPath(command, projectRoot);
  if (guardedScript) return guardedScript;

  const tokens = tokenizeHookCommand(command);
  if (!tokens || tokens.length === 0) return null;

  let commandIndex = 0;
  while (
    commandIndex < tokens.length &&
    isUnambiguousEnvAssignment(tokens[commandIndex].value)
  ) {
    commandIndex++;
  }
  if (commandIndex >= tokens.length) return null;

  commandIndex = unwrapEnvCommand(tokens, commandIndex) ?? -1;
  if (commandIndex < 0 || commandIndex >= tokens.length) return null;

  const executable = tokens[commandIndex];
  if (isScriptInterpreter(executable.value)) {
    let scriptIndex = commandIndex + 1;
    while (
      scriptIndex < tokens.length &&
      isValuelessInterpreterOption(executable.value, tokens[scriptIndex].value)
    ) {
      scriptIndex++;
    }
    const script = tokens[scriptIndex];
    if (!script || script.value === '' || script.value.startsWith('-')) return null;
    return canonicalCommandIdentities(
      script.value,
      projectRoot,
      undefined,
      undefined,
      [],
      script.leadingExpansion,
      script.hasLiteralBackslash
    ).size > 0
      ? script
      : null;
  }

  return canonicalCommandIdentities(
    executable.value,
    projectRoot,
    undefined,
    undefined,
    [],
    executable.leadingExpansion,
    executable.hasLiteralBackslash
  ).size > 0
    ? executable
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface HookCompanionMatch {
  event: string;
  commandPath: string;
  scope: HookSettingsScope;
}

function findSettingsCompanion(
  candidate: HookCandidate,
  settings: LiveSettings | undefined,
  scope: HookCompanionMatch['scope'],
  concreteGlobalRoots: readonly string[]
): HookCompanionMatch | null {
  const hooks: unknown = settings?.hooks;
  if (!isRecord(hooks)) return null;
  const fileReferences = candidate.section.references.filter(
    (reference) => reference.kind === 'file'
  );
  if (fileReferences.length === 0) return null;

  for (const [event, groups] of Object.entries(hooks)) {
    if (!sectionReferencesEvent(candidate.section, event) || !Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const innerHooks = group.hooks;
      if (!Array.isArray(innerHooks)) continue;
      for (const hook of innerHooks) {
        if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string') {
          continue;
        }
        const commandPath = commandIdentityPath(
          hook.command,
          candidate.project.root
        );
        if (
          commandPath &&
          fileReferences.some((sectionReference) =>
            commandPathMatchesReference(
              sectionReference.target,
              commandPath,
              candidate.project.root,
              candidate.section.sourceScope,
              scope,
              concreteGlobalRoots
            )
          )
        ) {
          return { event, commandPath: commandPath.value, scope };
        }
      }
    }
  }
  return null;
}

function findActiveHookCompanion(
  candidate: HookCandidate,
  liveConfig: LiveConfig,
  concreteGlobalRoots: readonly string[]
): HookCompanionMatch | null {
  const globalMatch = findSettingsCompanion(
    candidate,
    liveConfig.settings,
    'global',
    concreteGlobalRoots
  );
  if (globalMatch) return globalMatch;

  for (const [root, settings] of Object.entries(liveConfig.projectSettings ?? {})) {
    if (normalizeIdentityPath(root) !== normalizeIdentityPath(candidate.project.root)) {
      continue;
    }
    const projectMatch = findSettingsCompanion(
      candidate,
      settings,
      'project',
      concreteGlobalRoots
    );
    if (projectMatch) return projectMatch;
  }
  return null;
}

// Rule-file naming (topic slug, component subtree) is shared with the atomizer
// codemod via ../../config-rule-naming so the prescribed rulePath and the file
// the codemod writes can never diverge (#1427).

function governedFiles(
  project: RepoMapProjectJoin,
  section: ConfigSection
): RepoMapFileJoin[] {
  return project.files.filter((file) => file.configSections.includes(section.id));
}

function overScopedCandidates(input: Parameters<Detector['rule']>[0]): Candidate[] {
  const repoMap = input.repoMap;
  if (!repoMap || repoMap.projects.length === 0) return [];

  const concreteGlobalRoots = repoMap.projects
    .map((project) => normalizeIdentityPath(project.root))
    .filter((root) => root.endsWith('/.claude'));
  const out: Candidate[] = [];
  for (const project of repoMap.projects) {
    const topicForSource = new Map<string, (heading: string) => string>();
    for (const section of project.configSections) {
      if (section.level === 0 || section.heading.trim().length === 0) continue;
      if (!isRootConfigSection(section, project.root)) continue;

      const files = governedFiles(project, section);
      if (files.length === 0) continue;

      const subtrees = new Set<string>();
      for (const file of files) {
        const subtree = componentSubtree(file.path);
        if (!subtree) {
          subtrees.add('');
          continue;
        }
        subtrees.add(subtree);
      }
      if (subtrees.size !== 1 || subtrees.has('')) continue;

      const subtree = [...subtrees][0];
      const pathsGlob = `${subtree}/**`;
      if (
        input.liveConfig &&
        findActiveHookCompanion(
          { project, section },
          input.liveConfig,
          concreteGlobalRoots
        )
      ) {
        continue;
      }
      let nextTopic = topicForSource.get(section.sourceScope);
      if (!nextTopic) {
        nextTopic = createRuleTopicDisambiguator();
        topicForSource.set(section.sourceScope, nextTopic);
      }
      const topic = nextTopic(section.heading);
      out.push({
        project,
        section,
        files,
        subtree,
        pathsGlob,
        rulePath: `.claude/rules/${topic}.md`,
        idSuffix: ruleTopicSlug(`${project.root}-${section.id}`),
        hookGuardChecked: input.liveConfig != null,
      });
    }
  }

  return out.sort(
    (a, b) =>
      a.project.root.localeCompare(b.project.root) ||
      a.section.sourceScope.localeCompare(b.section.sourceScope) ||
      a.section.heading.localeCompare(b.section.heading)
  );
}

/** Exact active-hook companions were excluded before topic naming. */
function atomizableCandidates(input: Parameters<Detector['rule']>[0]): Candidate[] {
  return overScopedCandidates(input);
}

/**
 * The asymmetric graduation gate (#1270, epic #1264). The S1 rec graduates from advisory
 * to recommended ONLY when the `config-scoping` shadow axis (#1269) BOTH clears the
 * standard shadow-axis-wins evidence bar (≥5 samples, ≥3 decided, ≥60% win-rate) AND
 * certifies ZERO adherence regression with full coverage. The gate is asymmetric on
 * purpose: a cost/speed win that silently dropped even one rule must NOT graduate, and
 * absent/partial adherence data fails closed.
 */
function configScopingProof(
  input: Parameters<Detector['rule']>[0]
): AxisAggregate | null {
  const axis = input.shadowCalls?.byAxis.find((a) => a.axis === CONFIG_SCOPING_AXIS);
  if (!axis) return null;
  if (!clearsShadowWinThresholds(axis)) return null; // below the evidence bar -> advisory
  if (adherenceClean(axis) !== true) return null; // any/unknown regression -> advisory (hard gate)
  return axis;
}

function toRecommendation(
  candidate: Candidate,
  id: string,
  proof: AxisAggregate | null
): Recommendation {
  const { section, files, subtree, pathsGlob, rulePath, idSuffix } = candidate;
  const heading = section.heading;
  const evidenceFiles = files
    .slice(0, MAX_EVIDENCE_FILES)
    .map((file) => file.path)
    .join(', ');
  const proofDecided = proof ? proof.shadowWins + proof.mainWins : 0;

  return {
    id,
    category: 'context',
    severity: proof ? 'warning' : 'info',
    title: `Move "${heading}" into a ${subtree} rule`,
    detail:
      `Root ${section.sourceScope} section "${heading}" governs ${files.length} repo-map ` +
      `file(s), all under ${subtree}. Keeping it in always-loaded root config makes ` +
      'every session pay for guidance scoped to one component subtree.' +
      (proof
        ? ` Shadow experiments on the "${CONFIG_SCOPING_AXIS}" axis PROVED the atomized ` +
          `variation: it won ${proof.shadowWins}/${proofDecided} decided comparisons over ` +
          `${proof.samples} sample(s) with zero adherence regressions, so this is now a ` +
          'measured recommendation, not an estimate.'
        : ''),
    action:
      `Move this section into ${rulePath} with \`paths: ["${pathsGlob}"]\`, then remove ` +
      `the always-loaded root copy from ${section.sourceScope}.`,
    affected: files.length,
    view: 'context',
    evidence: [
      `${section.id} -> ${subtree}: ${evidenceFiles}${files.length > MAX_EVIDENCE_FILES ? ', ...' : ''}`,
      ...(proof
        ? [
            `${CONFIG_SCOPING_AXIS} axis: shadow ${proof.shadowWins} / main ${proof.mainWins} / ` +
              `tie ${proof.ties} over ${proof.samples} (${proof.live} live + ${proof.replay} replay); ` +
              `adherence regressions: 0 across ${proof.adherenceRegressionCount}/${proof.samples} judged`,
          ]
        : []),
    ],
    savingsAttribution: {
      interventionKey: `${DETECTOR_ID}:${idSuffix}`,
      signatureId: 'repo-map-config-section-single-subtree',
      tier: proof ? 'tier-1-before-after' : 'tier-0-estimate',
      confidence: proof ? 'high' : 'medium',
    },
    fix: {
      target: 'CLAUDE.md',
      fixKind: 'illustrative',
      label: 'Scaffold path-scoped rule',
      note:
        `Move the existing ${section.sourceScope} section body into ${rulePath}, then ` +
        'delete the root copy so it loads only for matching paths.',
      snippet: `## Split "${heading}" into a path-scoped rule

Create \`${rulePath}\`:

\`\`\`markdown
---
paths: ["${pathsGlob}"]
---
# ${heading}

[move the existing ${section.sourceScope} section body here]
\`\`\`

Then remove the always-loaded root section from \`${section.sourceScope}\`.`,
    },
    provenance: {
      observations: [
        {
          claim: `Root config section ${section.id} governs ${files.length} repo-map file(s)`,
          source: 'repoMap',
          field: 'projects[].files[].configSections',
          value: files.length,
        },
        {
          claim: `All governed files sit under ${subtree}`,
          source: 'repoMap',
          field: 'projects[].files[].path',
          value: subtree,
        },
        ...(candidate.hookGuardChecked
          ? [
              {
                claim:
                  `Stale-state guard checked current global and matching-project hook ` +
                  `configuration; no exact event-and-command-path companion was provable for ` +
                  `${section.id}`,
                source: 'liveConfig',
                field:
                  `settings.hooks + projectSettings["${candidate.project.root}"].hooks`,
                value: 'no exact companion',
              },
            ]
          : []),
        ...(proof
          ? [
              {
                claim:
                  `The "${CONFIG_SCOPING_AXIS}" shadow axis won ${proof.shadowWins} of ` +
                  `${proofDecided} decided comparisons with zero adherence regressions ` +
                  `across all ${proof.samples} sample(s)`,
                source: 'shadowCalls',
                field: 'byAxis[config-scoping]',
                value: proof.shadowWins,
              },
            ]
          : []),
      ],
      inference:
        'A root AGENTS.md/CLAUDE.md section whose governed files all live under one ' +
        'component subtree is over-scoped relative to path-scoped .claude/rules loading.' +
        (proof
          ? ' The config-scoping axis cleared the shadow-axis-wins evidence bar AND the ' +
            'zero-adherence-regression hard gate, so the recommendation graduates from ' +
            'a tier-0 estimate to a tier-1 before/after measurement (#1270).'
          : ''),
    },
  };
}

function emitAll(input: Parameters<Detector['rule']>[0]): Recommendation[] {
  const candidates = atomizableCandidates(input);
  if (candidates.length === 0) return [];
  const proof = configScopingProof(input);
  return candidates.map((candidate) =>
    toRecommendation(candidate, `${DETECTOR_ID}:${candidate.idSuffix}`, proof)
  );
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'context',
  dataDeps: ['repoMap', 'shadowCalls', 'liveConfig'],
  // Hidden detector->detector edge made explicit (#2080): the graduation gate
  // reuses `clearsShadowWinThresholds()` from workflow.shadow-axis-wins.
  dependsOn: ['workflow.shadow-axis-wins'],
  rule(input) {
    const first = atomizableCandidates(input)[0];
    return first ? toRecommendation(first, DETECTOR_ID, configScopingProof(input)) : null;
  },
  emitAll,
};
