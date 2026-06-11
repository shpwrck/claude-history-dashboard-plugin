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
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { validateSettingsJson } from './config-hygiene';
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
  configFileMaxBytes?: number;
  configResourceMaxEntries?: number;
}

interface LiveConfigPaths {
  claudeDir: string;
  settingsGlobal: string;
  settingsLocal: string;
  claudeMdGlobal: string;
  skillsDir: string;
  agentsDir: string;
  commandsDir: string;
  pluginsRegistry: string;
  claudeJson: string;
  scoped: boolean;
  configFileMaxBytes: number;
  configResourceMaxEntries: number;
}

const READ_CHUNK_BYTES = 65_536;

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
    configFileMaxBytes: normalizedConfigFileMaxBytes(opts.configFileMaxBytes),
    configResourceMaxEntries: normalizedConfigResourceMaxEntries(
      opts.configResourceMaxEntries
    ),
  };
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

function readLiveSettings(paths: LiveConfigPaths): Obj {
  return (
    mergeLiveSettings(
      readJsonOrNull(paths.settingsGlobal, paths.configFileMaxBytes),
      readJsonOrNull(paths.settingsLocal, paths.configFileMaxBytes)
    ) ?? {}
  );
}

function readTextOrNull(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null;
  try {
    return readTextFileCappedSync(path, maxBytes);
  } catch {
    return null;
  }
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
  scope: 'user';
  path: string;
  description?: string;
}

function listResources(
  root: string,
  kind: 'directory' | 'file',
  maxBytes: number,
  maxEntries: number
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
          ? { id: name, scope: 'user', path: p, description }
          : { id: name, scope: 'user', path: p }
      );
    } else if (kind === 'file' && st.isFile() && name.endsWith('.md')) {
      out.push({
        id: name.replace(/\.md$/, ''),
        scope: 'user',
        path: p,
      });
    }
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
  enabledByProjects: string[];
}

function readMcpServers(paths: LiveConfigPaths): McpServerEntry[] {
  const claudeJson = asObj(readJsonOrNull(paths.claudeJson, paths.configFileMaxBytes));
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
      out.push({ id, scope: 'project', enabledByProjects: [projPath] });
    }
  }
  return out;
}

// Build the full liveConfig bundle. Every section degrades to empty/null on
// missing source so the dataset endpoint stays alive even when ~/.claude is
// partially configured.
export function assembleLiveConfig(opts: LiveConfigPathOptions = {}) {
  const paths = liveConfigPaths(opts);
  const settings = readLiveSettings(paths);
  // Validate the raw ~/.claude/settings.json bytes (#167). Display path uses
  // ~ so the UI shows the canonical location rather than the container path.
  const settingsHealth = validateSettingsJson(
    '~/.claude/settings.json',
    readTextOrNull(paths.settingsGlobal, paths.configFileMaxBytes)
  );
  return {
    settings,
    settingsHealth,
    claudeMd: {
      // Phase 1 ships global only — the container can't reach project roots.
      // perProject is reserved so consumers don't reshape when phase 2 fills it.
      global: readTextOrNull(paths.claudeMdGlobal, paths.configFileMaxBytes),
      perProject: {},
    },
    plugins: readPlugins(paths, asObj(settings.enabledPlugins)),
    mcpServers: readMcpServers(paths),
    skills: listResources(
      paths.skillsDir,
      'directory',
      paths.configFileMaxBytes,
      paths.configResourceMaxEntries
    ),
    subagents: listResources(
      paths.agentsDir,
      'file',
      paths.configFileMaxBytes,
      paths.configResourceMaxEntries
    ),
    commands: listResources(
      paths.commandsDir,
      'file',
      paths.configFileMaxBytes,
      paths.configResourceMaxEntries
    ),
  };
}
