// Live-config assembly for the dashboard dataset (#627 slice 1).
//
// Reads the optional ~/.claude config inputs (settings, CLAUDE.md, plugins, MCP
// servers, skills/agents/commands) into the `liveConfig` bundle. Every section
// degrades to an empty value when a source is missing or malformed, so a partial
// config never sinks the dataset endpoint. The default path set matches the
// original single-user behaviour; enterprise scoped ingest passes explicit paths
// so tenant datasets do not read the server operator's ~/.claude.

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import {
  validateSettingsJson,
  type EffectiveSettingsEnvironment,
} from './config-hygiene';
import type {
  HookReferencedPath,
  SettingsEnvironmentObservation,
  SettingsHealth,
} from '../types';
import { readDirentsBoundedSync } from './bounded-fs';

// Untyped-JSON view: the readers below only ever access fields through
// `typeof` / `Array.isArray` guards, exactly as the original .mjs did. `Obj` is
// the open record those guards run against.
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

export interface LiveConfigPathOptions {
  claudeDir?: string;
  homeDir?: string;
  scoped?: boolean;
  projectRoots?: string[];
  configFileMaxBytes?: number;
  configResourceMaxEntries?: number;
  environment?: SettingsEnvironmentObservation;
  /** Test seam for the synchronous hook-path observation timestamp. */
  now?: () => Date;
}

interface LiveConfigPaths {
  claudeDir: string;
  /** The user's home directory — the target for `~` / `$HOME` expansion. */
  homeDir: string;
  settingsGlobal: string;
  settingsLocal: string;
  claudeMdGlobal: string;
  skillsDir: string;
  agentsDir: string;
  commandsDir: string;
  pluginsRegistry: string;
  claudeJson: string;
  scoped: boolean;
  projectRoots: string[];
  configFileMaxBytes: number;
  configResourceMaxEntries: number;
}

const READ_CHUNK_BYTES = 65_536;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_HOST_ENV_NAMES = 10_000;
const GLOBAL_SETTINGS_DISPLAY_PATH = '~/.claude/settings.json';
const LOCAL_SETTINGS_DISPLAY_PATH = '~/.claude/settings.local.json';

/** Build a names-only host observation without retaining any environment values. */
export function hostEnvironmentObservation(
  env: Readonly<Record<string, string | undefined>>
): SettingsEnvironmentObservation | undefined {
  const serialized = env.CHD_HOST_ENV_NAMES;
  if (serialized !== undefined) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!Array.isArray(parsed) || parsed.length > MAX_HOST_ENV_NAMES) return undefined;
      return {
        source: 'host-launch',
        definedNames: [...new Set(parsed.filter(
          (name): name is string => typeof name === 'string' && ENV_NAME.test(name)
        ))].sort(),
      };
    } catch {
      return undefined;
    }
  }
  if (/^(1|true|yes|on)$/i.test(String(env.CHD_CONTAINERIZED || ''))) return undefined;
  return {
    source: 'host-launch',
    definedNames: Object.keys(env).filter((name) => ENV_NAME.test(name)).sort(),
  };
}

/** Stable, values-free contribution for the persistent dataset cache key. */
export function hostEnvironmentObservationSignature(
  observation: SettingsEnvironmentObservation | undefined,
  scoped: boolean
): string {
  if (scoped) return 'scoped';
  if (!observation) return 'unavailable';
  return `host-launch\0${[...observation.definedNames].sort().join('\0')}`;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function clampConfigFileMaxBytes(maxBytes: number): number {
  return Math.max(1_024, Math.min(16_777_216, Math.floor(maxBytes)));
}

function clampConfigResourceMaxEntries(maxEntries: number): number {
  return Math.max(1, Math.min(1_000_000, Math.floor(maxEntries)));
}

export const CONFIG_FILE_MAX_BYTES = clampConfigFileMaxBytes(
  parseNonNegativeIntEnv('DASHBOARD_CONFIG_FILE_MAX_BYTES', 1_048_576)
);
export const CONFIG_RESOURCE_MAX_ENTRIES = clampConfigResourceMaxEntries(
  parseNonNegativeIntEnv('DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES', 50_000)
);

function normalizedConfigFileMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes == null || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return CONFIG_FILE_MAX_BYTES;
  }
  return clampConfigFileMaxBytes(maxBytes);
}

function normalizedConfigResourceMaxEntries(maxEntries: number | undefined): number {
  if (maxEntries == null || !Number.isFinite(maxEntries) || maxEntries < 0) {
    return CONFIG_RESOURCE_MAX_ENTRIES;
  }
  return clampConfigResourceMaxEntries(maxEntries);
}

type ConfigFileCapError = Error & { code?: string; maxBytes?: number };

function configFileTooLargeError(maxBytes: number): ConfigFileCapError {
  const err = new Error(`Config file exceeds ${maxBytes} byte limit`) as ConfigFileCapError;
  err.code = 'ERR_DASHBOARD_CONFIG_FILE_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

export function readTextFileCappedSync(path: string, maxBytes = CONFIG_FILE_MAX_BYTES): string {
  const limit = clampConfigFileMaxBytes(maxBytes);
  const fd = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1));
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) throw configFileTooLargeError(limit);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function liveConfigPaths(opts: LiveConfigPathOptions = {}): LiveConfigPaths {
  const claudeDir = opts.claudeDir || join(homedir(), '.claude');
  const homeDir = opts.homeDir || dirname(claudeDir);
  return {
    claudeDir,
    homeDir,
    settingsGlobal: join(claudeDir, 'settings.json'),
    settingsLocal: join(claudeDir, 'settings.local.json'),
    claudeMdGlobal: join(claudeDir, 'CLAUDE.md'),
    skillsDir: join(claudeDir, 'skills'),
    agentsDir: join(claudeDir, 'agents'),
    commandsDir: join(claudeDir, 'commands'),
    pluginsRegistry: join(claudeDir, 'plugins', 'installed_plugins.json'),
    // Top-level Claude Code config — carries mcpServers (global) plus a
    // `projects` map keyed by absolute project path with per-project mcpServers
    // and enabledMcpjsonServers.
    claudeJson: join(homeDir, '.claude.json'),
    scoped: opts.scoped === true,
    projectRoots: normalizeProjectRoots(opts.projectRoots ?? []),
    configFileMaxBytes: normalizedConfigFileMaxBytes(opts.configFileMaxBytes),
    configResourceMaxEntries: normalizedConfigResourceMaxEntries(
      opts.configResourceMaxEntries
    ),
  };
}

function normalizeProjectRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !isAbsolute(root)) continue;
    const normalized = resolve(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort();
}

function projectRootsFromClaudeJson(claudeJson: Obj): string[] {
  const projects =
    claudeJson && typeof claudeJson.projects === 'object'
      ? (claudeJson.projects as Obj)
      : {};
  return normalizeProjectRoots(Object.keys(projects));
}

function withinClaudeDir(paths: LiveConfigPaths, path: string): boolean {
  return path === paths.claudeDir || path.startsWith(`${paths.claudeDir}${sep}`);
}

// Tolerant settings reader. Returns `null` if the file is missing, unreadable,
// or doesn't parse as strict JSON — the dashboard treats "can't tell what's in
// settings" as "filter nothing" rather than crashing. Known field names are
// passed through verbatim; we don't validate the shape because Claude Code's
// own loader is the authority and our consumers (`isApplied()` checks) defend
// against malformed sub-values themselves.
function readJsonOrNull(path: string, maxBytes: number): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readTextFileCappedSync(path, maxBytes));
  } catch {
    return null;
  }
}

// Merge global + local settings the way Claude Code's loader does for the
// fields we care about: scalar fields take the deeper value, `permissions.*`
// arrays union together, `hooks.*` arrays concat. Anything else is left alone
// because rules only check the keys above.
function hookEntriesWithSource(
  entries: unknown,
  source: 'global' | 'local'
): Obj[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((h) => h && typeof h === 'object')
    .map((h) => ({ ...(h as Obj), source }));
}

function mergeLiveSettings(global: unknown, local: unknown): Obj | null {
  if (!global && !local) return null;
  const g = asObj(global);
  const l = asObj(local);
  const out: Obj = {};
  if (typeof l.model === 'string') out.model = l.model;
  else if (typeof g.model === 'string') out.model = g.model;
  const days = l.cleanupPeriodDays ?? g.cleanupPeriodDays;
  if (typeof days === 'number') out.cleanupPeriodDays = days;
  const perm: Obj = {};
  const gPerm = asObj(g.permissions);
  const lPerm = asObj(l.permissions);
  for (const key of ['allow', 'ask', 'deny']) {
    const merged = [
      ...(Array.isArray(gPerm[key]) ? (gPerm[key] as unknown[]) : []),
      ...(Array.isArray(lPerm[key]) ? (lPerm[key] as unknown[]) : []),
    ].filter((r) => typeof r === 'string');
    if (merged.length > 0) perm[key] = Array.from(new Set(merged));
  }
  if (Object.keys(perm).length > 0) out.permissions = perm;
  const hooks: Obj = {};
  const gHooks = g.hooks && typeof g.hooks === 'object' ? (g.hooks as Obj) : {};
  const lHooks = l.hooks && typeof l.hooks === 'object' ? (l.hooks as Obj) : {};
  for (const event of new Set([...Object.keys(gHooks), ...Object.keys(lHooks)])) {
    const merged = [
      ...hookEntriesWithSource(gHooks[event], 'global'),
      ...hookEntriesWithSource(lHooks[event], 'local'),
    ];
    if (merged.length > 0) hooks[event] = merged;
  }
  if (Object.keys(hooks).length > 0) out.hooks = hooks;
  // `enabledPlugins` is shallow-merged (local plugin keys override global).
  // It feeds phase-2 plugin attribution rollup — only enabled plugins get
  // their bundled artifacts enumerated.
  const enabled = {
    ...(g.enabledPlugins && typeof g.enabledPlugins === 'object'
      ? (g.enabledPlugins as Obj)
      : {}),
    ...(l.enabledPlugins && typeof l.enabledPlugins === 'object'
      ? (l.enabledPlugins as Obj)
      : {}),
  };
  if (Object.keys(enabled).length > 0) out.enabledPlugins = enabled;
  return out;
}

function settingsEnvironment(settings: unknown): Obj {
  const env = asObj(settings).env;
  return env && typeof env === 'object' && !Array.isArray(env)
    ? env as Obj
    : {};
}

function mergeSettingsEnvironment(
  global: unknown,
  local: unknown
): EffectiveSettingsEnvironment {
  const globalEnvironment = settingsEnvironment(global);
  const localEnvironment = settingsEnvironment(local);
  return {
    // Claude Code applies local settings at the deeper precedence, so local
    // env keys replace global keys while unrelated global definitions remain.
    // These values stay transient and never enter the liveConfig dataset.
    definitions: { ...globalEnvironment, ...localEnvironment },
    localOverrides: Object.keys(localEnvironment).sort(),
    localSourcePath: LOCAL_SETTINGS_DISPLAY_PATH,
  };
}

function readLiveSettings(paths: LiveConfigPaths): {
  settings: Obj;
  environment: EffectiveSettingsEnvironment;
} {
  const global = readJsonOrNull(paths.settingsGlobal, paths.configFileMaxBytes);
  const local = readJsonOrNull(paths.settingsLocal, paths.configFileMaxBytes);
  return {
    settings: mergeLiveSettings(global, local) ?? {},
    environment: mergeSettingsEnvironment(global, local),
  };
}

function mergeSettingsHealth(
  globalHealth: SettingsHealth,
  localHealth: SettingsHealth,
  environment: SettingsEnvironmentObservation | undefined
): SettingsHealth {
  const findings = [];
  const seen = new Set<string>();
  for (const finding of [...globalHealth.findings, ...localHealth.findings]) {
    const key = JSON.stringify(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  const primary = globalHealth.present
    ? globalHealth
    : localHealth.present
      ? localHealth
      : globalHealth;
  return {
    filePath: primary.filePath,
    present: globalHealth.present || localHealth.present,
    ok: globalHealth.ok && localHealth.ok,
    findings,
    ...(environment ? { environment } : {}),
  };
}

function readTextOrNull(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null;
  try {
    return readTextFileCappedSync(path, maxBytes);
  } catch {
    return null;
  }
}

export type StopHookConfigState = 'configured' | 'inactive';

/**
 * Read the merged user and allowlisted project settings files, then return the
 * current-state bit that gates `speed.hook-overhead`. The recommendations
 * response cache calls this cheap seam before serving stale JSON, so removing
 * or invalidating the current Stop hook cannot leak one last false
 * present-tense finding. It mirrors assembleLiveConfig's settings merge +
 * readability rules without scanning skills, plugins, or other resources.
 */
export function readStopHookConfigState(
  opts: LiveConfigPathOptions = {}
): StopHookConfigState {
  const paths = liveConfigPaths(opts);
  const { settings, environment: effectiveSettingsEnvironment } =
    readLiveSettings(paths);
  const globalHealth = validateSettingsJson(
    GLOBAL_SETTINGS_DISPLAY_PATH,
    readTextOrNull(paths.settingsGlobal, paths.configFileMaxBytes),
    opts.environment,
    effectiveSettingsEnvironment
  );
  const localHealth = validateSettingsJson(
    LOCAL_SETTINGS_DISPLAY_PATH,
    readTextOrNull(paths.settingsLocal, paths.configFileMaxBytes),
    opts.environment,
    { ...effectiveSettingsEnvironment, localOverrides: [] }
  );
  const health = mergeSettingsHealth(
    globalHealth,
    localHealth,
    opts.environment
  );
  // A present-but-invalid user settings source makes the effective config
  // unknowable, even when a project file happens to contain a Stop hook.
  if (health.present && !health.ok) return 'inactive';

  const userHooks = asObj(settings.hooks);
  const userConfigured =
    health.present && Array.isArray(userHooks.Stop) && userHooks.Stop.length > 0;
  const claudeJson = asObj(
    readJsonOrNull(paths.claudeJson, paths.configFileMaxBytes)
  );
  const projectSettings = readProjectSettings(
    readableProjectRoots(paths, claudeJson),
    paths.configFileMaxBytes
  );
  const projectConfigured = Object.values(projectSettings).some((project) => {
    const hooks = asObj(project.hooks);
    return Array.isArray(hooks.Stop) && hooks.Stop.length > 0;
  });
  return userConfigured || projectConfigured
    ? 'configured'
    : 'inactive';
}

// Enumerate one of the resource directories under ~/.claude (skills, agents,
// commands). `kind` switches between dir-as-resource (skills hold a
// `<id>/SKILL.md`) and file-as-resource (agents/commands are typically a flat
// `<id>.md`). Symlinks are followed via statSync so installs that link into a
// shared dotfiles tree still enumerate. Tolerant throughout: missing dir
// returns []; unreadable entries are skipped.
// Extract the `description` from a skill's `<dir>/SKILL.md` YAML frontmatter so
// the discovery-failure detector (#136) has trigger keywords to match against.
// Tolerant: returns '' when the manifest, frontmatter, or field is missing or
// unreadable. Handles both inline (`description: text`) and folded/literal block
// scalars (`description: >-` / `|` followed by indented continuation lines).
function readSkillDescription(dirPath: string, maxBytes: number): string {
  let text;
  try {
    text = readTextFileCappedSync(join(dirPath, 'SKILL.md'), maxBytes);
  } catch {
    return '';
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    // Block scalar indicator (>, >-, |, |-, >+, |+) or empty → gather the
    // following indented continuation lines into one space-joined string.
    if (inline === '' || /^[>|][+-]?$/.test(inline)) {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) buf.push(lines[j].trim());
        else if (lines[j].trim() === '') continue;
        else break;
      }
      return buf.join(' ').replace(/\s+/g, ' ').trim();
    }
    // Inline value, possibly quoted.
    return inline.replace(/^["']|["']$/g, '').trim();
  }
  return '';
}

interface Resource {
  id: string;
  scope: 'user' | 'project';
  path: string;
  projectPath?: string;
  description?: string;
}

function listResources(
  root: string,
  kind: 'directory' | 'file',
  maxBytes: number,
  maxEntries: number,
  scope: Resource['scope'] = 'user',
  projectPath?: string
): Resource[] {
  if (!existsSync(root)) return [];
  const entries = readDirentsBoundedSync(root, maxEntries)
    .map((entry) => entry.name)
    .sort();
  const out: Resource[] = [];
  for (const name of entries) {
    if (out.length >= maxEntries) break;
    const p = join(root, name);
    let st;
    try {
      st = statSync(p); // follows symlinks; isDirectory()/isFile() reflect target
    } catch {
      continue;
    }
    if (kind === 'directory' && st.isDirectory()) {
      const description = readSkillDescription(p, maxBytes);
      out.push(
        description
          ? { id: name, scope, path: p, ...(projectPath ? { projectPath } : {}), description }
          : { id: name, scope, path: p, ...(projectPath ? { projectPath } : {}) }
      );
    } else if (kind === 'file' && st.isFile() && name.endsWith('.md')) {
      out.push({
        id: name.replace(/\.md$/, ''),
        scope,
        path: p,
        ...(projectPath ? { projectPath } : {}),
      });
    }
  }
  return out;
}

function listProjectResources(
  projectRoots: string[],
  dirName: 'skills' | 'agents' | 'commands',
  kind: 'directory' | 'file',
  maxBytes: number,
  maxEntries: number
): Resource[] {
  const out: Resource[] = [];
  for (const projectRoot of projectRoots) {
    if (out.length >= maxEntries) break;
    const remaining = maxEntries - out.length;
    out.push(
      ...listResources(
        join(projectRoot, '.claude', dirName),
        kind,
        maxBytes,
        remaining,
        'project',
        projectRoot
      )
    );
  }
  return out;
}

interface PluginBundle {
  skills?: string[];
  commands?: string[];
  agents?: string[];
}

// Best-effort enumeration of a plugin's bundled skills/commands/agents. We
// scan the install dir for the same subfolders Claude Code uses globally. When
// the dir doesn't exist (or layout doesn't match), we just skip — phase 2's
// P/I/U rollup treats an absent bundle list as "can't tell, attribute via any
// usage" rather than failing the plugin entry.
function enumeratePluginBundle(
  installPath: string,
  maxBytes: number,
  maxEntries: number
): PluginBundle | undefined {
  if (!installPath || !existsSync(installPath)) return undefined;
  const bundle: PluginBundle = {};
  const skills = listResources(
    join(installPath, 'skills'),
    'directory',
    maxBytes,
    maxEntries
  );
  if (skills.length > 0) bundle.skills = skills.map((s) => s.id);
  const commands = listResources(
    join(installPath, 'commands'),
    'file',
    maxBytes,
    maxEntries
  );
  if (commands.length > 0) bundle.commands = commands.map((c) => c.id);
  const agents = listResources(
    join(installPath, 'agents'),
    'file',
    maxBytes,
    maxEntries
  );
  if (agents.length > 0) bundle.agents = agents.map((a) => a.id);
  return Object.keys(bundle).length > 0 ? bundle : undefined;
}

interface PluginEntry {
  id: string;
  scope: 'project' | 'user';
  version: string;
  sourcePath: string;
  installPath: string;
  installedAt: string;
  bundled: PluginBundle | undefined;
}

function readPlugins(paths: LiveConfigPaths, enabled: Obj | undefined): PluginEntry[] {
  const reg = asObj(readJsonOrNull(paths.pluginsRegistry, paths.configFileMaxBytes));
  const map = reg && typeof reg.plugins === 'object' ? (reg.plugins as Obj) : {};
  const out: PluginEntry[] = [];
  for (const [id, installs] of Object.entries(map)) {
    if (out.length >= paths.configResourceMaxEntries) break;
    if (!Array.isArray(installs)) continue;
    for (const raw of installs) {
      if (out.length >= paths.configResourceMaxEntries) break;
      if (!raw || typeof raw !== 'object') continue;
      const inst = raw as Obj;
      const installPath = typeof inst.installPath === 'string' ? inst.installPath : '';
      out.push({
        id,
        scope: inst.scope === 'project' ? 'project' : 'user',
        version: typeof inst.version === 'string' ? inst.version : 'unknown',
        sourcePath: paths.pluginsRegistry,
        installPath,
        installedAt: typeof inst.installedAt === 'string' ? inst.installedAt : '',
        // Only enumerate bundles when the plugin is enabled — saves IO on
        // disabled plugins. Phase 2 needs the bundle to roll up usage.
        bundled:
          enabled?.[id] && (!paths.scoped || withinClaudeDir(paths, installPath))
            ? enumeratePluginBundle(
                installPath,
                paths.configFileMaxBytes,
                paths.configResourceMaxEntries
              )
            : undefined,
      });
    }
  }
  return out;
}

interface McpServerEntry {
  id: string;
  scope: 'global' | 'project';
  sourcePath: string;
  enabledByProjects: string[];
}

function readMcpServers(paths: LiveConfigPaths, claudeJson: Obj): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  const globalServers =
    claudeJson && typeof claudeJson.mcpServers === 'object'
      ? (claudeJson.mcpServers as Obj)
      : {};
  // Build the project enablement index first so each global server entry can
  // list "the project paths that opt me in" without an N×M scan downstream.
  const projects =
    claudeJson && typeof claudeJson.projects === 'object'
      ? (claudeJson.projects as Obj)
      : {};
  const globalEnabledBy = new Map<string, string[]>(); // server id → [project paths]
  for (const [projPath, rawCfg] of Object.entries(projects)) {
    if (!rawCfg || typeof rawCfg !== 'object') continue;
    const projCfg = rawCfg as Obj;
    const enabled = Array.isArray(projCfg.enabledMcpjsonServers)
      ? (projCfg.enabledMcpjsonServers as unknown[])
      : [];
    for (const srv of enabled) {
      if (typeof srv !== 'string') continue;
      const list = globalEnabledBy.get(srv) ?? [];
      list.push(projPath);
      globalEnabledBy.set(srv, list);
    }
  }
  for (const id of Object.keys(globalServers)) {
    if (out.length >= paths.configResourceMaxEntries) break;
    out.push({
      id,
      scope: 'global',
      sourcePath: paths.claudeJson,
      enabledByProjects: globalEnabledBy.get(id) ?? [],
    });
  }
  // Project-scoped MCP servers — keyed by project path in ~/.claude.json.
  for (const [projPath, rawCfg] of Object.entries(projects)) {
    if (out.length >= paths.configResourceMaxEntries) break;
    if (!rawCfg || typeof rawCfg !== 'object') continue;
    const projCfg = rawCfg as Obj;
    const projServers =
      projCfg.mcpServers && typeof projCfg.mcpServers === 'object'
        ? (projCfg.mcpServers as Obj)
        : {};
    for (const id of Object.keys(projServers)) {
      if (out.length >= paths.configResourceMaxEntries) break;
      out.push({
        id,
        scope: 'project',
        sourcePath: paths.claudeJson,
        enabledByProjects: [projPath],
      });
    }
  }
  return out;
}

function readableProjectRoots(paths: LiveConfigPaths, claudeJson: Obj): string[] {
  if (paths.scoped) return [];
  return normalizeProjectRoots([
    ...paths.projectRoots,
    ...projectRootsFromClaudeJson(claudeJson),
  ]).slice(0, paths.configResourceMaxEntries);
}

function readPerProjectClaudeMd(
  projectRoots: string[],
  maxBytes: number
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const projectRoot of projectRoots) {
    const text = readTextOrNull(join(projectRoot, 'CLAUDE.md'), maxBytes);
    if (text !== null) out[projectRoot] = text;
  }
  return out;
}

function readProjectSettings(
  projectRoots: string[],
  maxBytes: number
): Record<string, Obj> {
  const out: Record<string, Obj> = {};
  for (const projectRoot of projectRoots) {
    const globalPath = join(projectRoot, '.claude', 'settings.json');
    const localPath = join(projectRoot, '.claude', 'settings.local.json');
    const global = readJsonOrNull(globalPath, maxBytes);
    const local = readJsonOrNull(localPath, maxBytes);
    // Never project a partial effective config when either present source could
    // not be read or parsed. Project settings schema validation remains a
    // follow-up; this is only the fail-closed readability boundary needed by
    // current-state recommendation claims.
    if (
      (existsSync(globalPath) && global === null) ||
      (existsSync(localPath) && local === null)
    ) {
      continue;
    }
    const merged = mergeLiveSettings(
      global,
      local
    );
    if (merged) out[projectRoot] = merged;
  }
  return out;
}

// ── Reference integrity (#2500) ────────────────────────────────────────────
// The state of a hook's referenced script and the existence of a skill's bundled
// resources MUST be evaluated host-side at ingest — detectors are pure and
// cannot stat. These helpers annotate the assembled bundle with per-hook
// `referencedPaths` and per-skill `danglingRefs` so
// `maintenance.skill-hook-integrity` can flag only reproducible missing paths.

/** Cap on tokens scanned per hook command — a bound, not a semantic limit. */
const HOOK_COMMAND_MAX_TOKENS = 64;

/**
 * Resolve a shell token to a verifiable ABSOLUTE path, or `null` when it is not
 * a verifiable path reference. Only `~`, `$HOME`/`${HOME}`, a resolvable
 * `$CLAUDE_PROJECT_DIR`/`${CLAUDE_PROJECT_DIR}` (when `projectDir` is known), and
 * a leading `/` are verifiable. Any remaining `$VAR`, glob (`*`/`?`), or brace
 * expansion leaves the target unknowable → `null` (skipped, never flagged).
 */
function resolveVerifiablePath(
  tok: string,
  homeDir: string,
  projectDir: string | undefined
): string | null {
  let resolved: string;
  let m: RegExpMatchArray | null;
  if (tok === '~') {
    resolved = homeDir;
  } else if (tok.startsWith('~/')) {
    resolved = join(homeDir, tok.slice(2));
  } else if ((m = tok.match(/^\$\{?HOME\}?(?=\/|$)/))) {
    resolved = homeDir + tok.slice(m[0].length);
  } else if ((m = tok.match(/^\$\{?CLAUDE_PROJECT_DIR\}?(?=\/|$)/))) {
    if (!projectDir) return null; // no known project root → unverifiable
    resolved = projectDir + tok.slice(m[0].length);
  } else if (tok.startsWith('/')) {
    resolved = tok;
  } else {
    return null; // not a path token
  }
  // Any unresolved var / glob / brace expansion makes the target unknowable.
  if (/[$*?{}]/.test(resolved)) return null;
  if (!isAbsolute(resolved)) return null;
  return resolved;
}

/**
 * Extract the verifiable filesystem path tokens a hook `command` references,
 * each with its timestamped ingest-time state. Conservative: whitespace-tokenized,
 * redirect targets (`> file`) are ignored (they are outputs, not references),
 * and only tokens `resolveVerifiablePath` accepts are recorded. `path` is the
 * token exactly as written for display/provenance.
 */
function extractHookReferencedPaths(
  command: string,
  homeDir: string,
  projectDir: string | undefined,
  checkedAt: string
): HookReferencedPath[] {
  const out: HookReferencedPath[] = [];
  const seen = new Set<string>();
  const tokens = command.split(/\s+/).slice(0, HOOK_COMMAND_MAX_TOKENS);
  let expectRedirectTarget = false;
  for (const raw of tokens) {
    if (raw === '') continue;
    const redir = raw.match(/^[0-9]*&?[<>]+/);
    if (redir) {
      // A bare redirect operator makes the NEXT token an output target; an
      // operator with an attached target (`>/tmp/x`) consumes it inline.
      if (raw.slice(redir[0].length) === '') expectRedirectTarget = true;
      continue;
    }
    if (expectRedirectTarget) {
      expectRedirectTarget = false;
      continue;
    }
    const tok = raw
      .replace(/^['"`]+/, '')
      .replace(/['"`]+$/, '')
      .replace(/^\(+/, '')
      .replace(/[;,)]+$/, '');
    if (tok === '' || seen.has(tok)) continue;
    const resolved = resolveVerifiablePath(tok, homeDir, projectDir);
    if (resolved === null) continue;
    seen.add(tok);
    out.push({ path: tok, state: probeHookReferencedPath(resolved), checkedAt });
  }
  return out;
}

type HookPathState = 'present' | 'missing' | 'unverifiable';

const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR']);

function fsErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/**
 * Classify one absolute hook path without pretending an inaccessible symlink
 * target is absent. Prefixes are walked lexically because `realpath` cannot
 * recover a target outside the visible namespace (#2553).
 */
function probeHookReferencedPath(target: string): HookPathState {
  try {
    statSync(target);
    return 'present';
  } catch {
    // Inspect below: a failed full stat can mean a normal missing component OR
    // an ancestor symlink whose target is outside this process's namespace.
  }

  const absolute = resolve(target);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const reachableSymlinks: string[] = [];
  let prefix = root;

  for (const part of parts) {
    prefix = join(prefix, part);
    let entry;
    try {
      entry = lstatSync(prefix);
    } catch (err) {
      if (!MISSING_PATH_CODES.has(fsErrorCode(err) ?? '')) return 'unverifiable';
      // A previously reachable symlink may have disappeared after its first
      // check. Recheck before making the stronger `missing` claim.
      for (const symlink of reachableSymlinks) {
        try {
          statSync(symlink);
        } catch {
          return 'unverifiable';
        }
      }
      return 'missing';
    }

    if (entry.isSymbolicLink()) {
      try {
        statSync(prefix);
      } catch {
        return 'unverifiable';
      }
      reachableSymlinks.push(prefix);
    }
  }

  // The lexical entries existed but the initial target stat failed: retry once
  // for races, then retain the honest ambiguous result.
  try {
    statSync(absolute);
    return 'present';
  } catch {
    return 'unverifiable';
  }
}

/** Annotate every hook command in a merged settings object with its
 *  ingest-time `referencedPaths` (only when it references a verifiable path). */
function annotateHookReferencedPaths(
  settings: Obj,
  homeDir: string,
  projectDir: string | undefined,
  checkedAt: string
): void {
  const hooks = settings && typeof settings.hooks === 'object' ? (settings.hooks as Obj) : null;
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const inner = (group as Obj).hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (!h || typeof h !== 'object') continue;
        const cmd = (h as Obj).command;
        if (typeof cmd !== 'string') continue;
        const refs = extractHookReferencedPaths(cmd, homeDir, projectDir, checkedAt);
        if (refs.length > 0) (h as Obj).referencedPaths = refs;
      }
    }
  }
}

/** A markdown-link target that is a checkable relative bundled-resource ref, or
 *  `null`. Relative + no scheme/anchor + no `$VAR`/glob + a file extension. */
function checkableMdLinkRef(raw: string): string | null {
  let t = raw.trim().replace(/^<+/, '').replace(/>+$/, '');
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  const q = t.indexOf('?');
  if (q >= 0) t = t.slice(0, q);
  if (t === '') return null;
  if (t.startsWith('/') || t.startsWith('~') || t.startsWith('#')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return null; // scheme (http:, mailto:, …)
  if (/[$*?\s]/.test(t)) return null;
  const last = t.split('/').pop() ?? '';
  if (!/\.[A-Za-z0-9]+$/.test(last)) return null; // must name a file
  return t;
}

/** A backtick inline-code token that is a checkable relative bundled-resource
 *  path (≥1 `/`, path-safe chars, a file extension), or `null`. Stricter than
 *  markdown links to avoid treating prose/commands as file refs. */
function checkableBacktickRef(raw: string): string | null {
  const t = raw.trim();
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(t)) return null;
  const last = t.split('/').pop() ?? '';
  if (!/\.[A-Za-z0-9]+$/.test(last)) return null;
  return t;
}

/** Relative refs in a skill's `SKILL.md` that don't resolve inside the skill
 *  dir. A `../`-escaping ref (e.g. a shared helper) is intentional → skipped. */
function skillDanglingRefs(skillDir: string, maxBytes: number): string[] {
  let text: string;
  try {
    text = readTextFileCappedSync(join(skillDir, 'SKILL.md'), maxBytes);
  } catch {
    return [];
  }
  const candidates = new Set<string>();
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const c = checkableMdLinkRef(m[1]);
    if (c) candidates.add(c);
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const c = checkableBacktickRef(m[1]);
    if (c) candidates.add(c);
  }
  const dangling: string[] = [];
  for (const ref of candidates) {
    const resolved = resolve(skillDir, ref);
    // Must stay inside the skill dir; an escaping ref points elsewhere and
    // cannot be judged a broken bundled reference.
    if (resolved !== skillDir && !resolved.startsWith(skillDir + sep)) continue;
    if (!existsSync(resolved)) dangling.push(ref);
  }
  return dangling;
}

/** Annotate each skill resource with its `danglingRefs` (only when non-empty). */
function annotateSkillDanglingRefs(skills: Resource[], maxBytes: number): void {
  for (const skill of skills) {
    if (!skill || typeof skill.path !== 'string') continue;
    const refs = skillDanglingRefs(skill.path, maxBytes);
    if (refs.length > 0) (skill as Resource & { danglingRefs?: string[] }).danglingRefs = refs;
  }
}

// Build the full liveConfig bundle. Every section degrades to empty/null on
// missing source so the dataset endpoint stays alive even when ~/.claude is
// partially configured.
export function assembleLiveConfig(opts: LiveConfigPathOptions = {}) {
  const paths = liveConfigPaths(opts);
  const claudeJson = asObj(readJsonOrNull(paths.claudeJson, paths.configFileMaxBytes));
  const projectRoots = readableProjectRoots(paths, claudeJson);
  const {
    settings,
    environment: effectiveSettingsEnvironment,
  } = readLiveSettings(paths);
  const hookPathsCheckedAt = (opts.now?.() ?? new Date(Date.now())).toISOString();
  // #2500/#2553: capture each hook command's conservative referenced-path state.
  annotateHookReferencedPaths(settings, paths.homeDir, undefined, hookPathsCheckedAt);
  // Validate BOTH raw files before mergeLiveSettings projects their effective
  // subset. Local syntax/type/unknown/rule/interpolation failures matter even
  // when settings.json exists, and every finding retains its owning source.
  const globalHealth = validateSettingsJson(
    GLOBAL_SETTINGS_DISPLAY_PATH,
    readTextOrNull(paths.settingsGlobal, paths.configFileMaxBytes),
    opts.environment,
    effectiveSettingsEnvironment
  );
  // The global pass already scans effective local env overrides so global
  // references resolve correctly. The local pass traverses its own env values
  // directly; clear localOverrides to avoid skipping them, then dedupe the
  // equivalent env findings when the two source verdicts are combined.
  const localHealth = validateSettingsJson(
    LOCAL_SETTINGS_DISPLAY_PATH,
    readTextOrNull(paths.settingsLocal, paths.configFileMaxBytes),
    opts.environment,
    { ...effectiveSettingsEnvironment, localOverrides: [] }
  );
  const settingsHealth = mergeSettingsHealth(
    globalHealth,
    localHealth,
    opts.environment
  );
  // #2500: project-scoped hooks resolve `$CLAUDE_PROJECT_DIR` against their root.
  const projectSettings = readProjectSettings(projectRoots, paths.configFileMaxBytes);
  for (const [root, ps] of Object.entries(projectSettings)) {
    annotateHookReferencedPaths(ps, paths.homeDir, root, hookPathsCheckedAt);
  }
  const skills = [
    ...listResources(
      paths.skillsDir,
      'directory',
      paths.configFileMaxBytes,
      paths.configResourceMaxEntries
    ),
    ...listProjectResources(
      projectRoots,
      'skills',
      'directory',
      paths.configFileMaxBytes,
      paths.configResourceMaxEntries
    ),
  ].slice(0, paths.configResourceMaxEntries);
  // #2500: flag SKILL.md references to bundled resources no longer on disk.
  annotateSkillDanglingRefs(skills, paths.configFileMaxBytes);
  return {
    settings,
    settingsHealth,
    claudeMd: {
      global: readTextOrNull(paths.claudeMdGlobal, paths.configFileMaxBytes),
      perProject: readPerProjectClaudeMd(projectRoots, paths.configFileMaxBytes),
    },
    projectSettings,
    plugins: readPlugins(paths, asObj(settings.enabledPlugins)),
    mcpServers: readMcpServers(paths, claudeJson),
    skills,
    subagents: [
      ...listResources(
        paths.agentsDir,
        'file',
        paths.configFileMaxBytes,
        paths.configResourceMaxEntries
      ),
      ...listProjectResources(
        projectRoots,
        'agents',
        'file',
        paths.configFileMaxBytes,
        paths.configResourceMaxEntries
      ),
    ].slice(0, paths.configResourceMaxEntries),
    commands: [
      ...listResources(
        paths.commandsDir,
        'file',
        paths.configFileMaxBytes,
        paths.configResourceMaxEntries
      ),
      ...listProjectResources(
        projectRoots,
        'commands',
        'file',
        paths.configFileMaxBytes,
        paths.configResourceMaxEntries
      ),
    ].slice(0, paths.configResourceMaxEntries),
  };
}
