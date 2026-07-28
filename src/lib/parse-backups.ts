/**
 * Parser for timestamped ~/.claude.json backup snapshots.
 *
 * ~/.claude/backups/ holds a series of files named `.claude.json.backup.<ts>`
 * (epoch-ms timestamp as suffix). Each is a full JSON dump of ~/.claude.json at
 * that moment — a free, local, timestamped audit log of MCP/config state.
 *
 * This module:
 *  1. Reads every backup in chronological order (`parseBackupsDir`).
 *  2. Diffs CONSECUTIVE snapshots, project-scoped or account-wide
 *     (`diffConfigDrift`), emitting structured `DriftEvent` records.
 *
 * Design follows P11 Tariq's persona (issue #568):
 *  - Project-scoped events are the headline (trust flips, server disabled, etc.).
 *  - Global mcpServers churn is counted separately and de-emphasised.
 *  - Only STRUCTURAL config keys are diffed — no credential or token values.
 *
 * Pure + text-in: `parseBackupsDir` reads files; `diffConfigDrift` is fully pure.
 * The detector (`reliability/config-drift.ts`) receives pre-computed DriftEvent[]
 * from ingest and stays pure itself.
 */

import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
  readFileInDirBoundedSync,
} from './bounded-fs';
import { CONFIG_FILE_MAX_BYTES } from './config-loader';

// ── Shape of a single ~/.claude.json snapshot (structural fields only) ──────

/**
 * The project-level block we diff. All fields are optional — a missing field
 * is treated as the zero value (false / empty set) for diff purposes.
 */
export interface ProjectConfig {
  hasTrustDialogAccepted?: boolean;
  enableAllProjectMcpServers?: boolean;
  /** Servers the user has explicitly enabled from the repo .mcp.json list. */
  enabledMcpjsonServers?: string[];
  /** Servers the user has explicitly disabled for this project. */
  disabledMcpjsonServers?: string[];
  /** Per-project mcpServers map (repo-local .mcp.json servers declared here). */
  mcpServers?: Record<string, unknown>;
}

/** Thin wrapper over the raw backup JSON — only structural keys kept. */
export interface RawBackupJson {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, ProjectConfig>;
}

// ── Public interfaces ────────────────────────────────────────────────────────

export type DriftKind =
  | 'trust-flip'
  | 'enable-all-flip'
  | 'server-disabled'
  | 'server-enabled'
  | 'repo-server-appeared'
  | 'repo-server-vanished'
  | 'global-churn';

export type DriftSeverity = 'warning' | 'info';

export interface DriftEvent {
  /** Stable type token for the kind of change. */
  kind: DriftKind;
  /** Absolute project path. Absent for global-churn events. */
  project?: string;
  /** MCP server key. Absent for trust/enableAll events. */
  server?: string;
  /** Previous value (string, boolean, or undefined). */
  from: boolean | string | undefined;
  /** New value (string, boolean, or undefined). */
  to: boolean | string | undefined;
  /** Epoch-ms timestamp of the LATER snapshot in the pair. */
  timestamp: number;
  severity: DriftSeverity;
}

/**
 * A parsed, time-ordered snapshot summary. `events` is the drift relative to
 * the previous snapshot (absent on the first snapshot).
 */
export interface ConfigSnapshot {
  /** Epoch-ms, derived from the filename suffix. */
  timestamp: number;
  /** Source filename (basename only). */
  filename: string;
  /** Structural project keys for the named project, if present. */
  projectConfig?: ProjectConfig;
  /** Keys of global mcpServers declared at this point. */
  globalMcpServerKeys: string[];
}

export interface ParseBackupsOptions {
  maxFileBytes?: number;
  maxEntries?: number;
}

// ── parseBackupsDir ──────────────────────────────────────────────────────────

/**
 * Read every `.claude.json.backup.<ts>` file in `dir`, parse each as JSON, and
 * return a time-ordered array of `ConfigSnapshot` objects.
 *
 * Files with a non-numeric suffix or that fail JSON parsing are skipped silently.
 * The `projectPath` argument is optional: when supplied, the snapshot includes
 * the project-scoped view for that path.
 */
export function parseBackupsDir(
  dir: string,
  projectPath?: string,
  opts: ParseBackupsOptions = {}
): ConfigSnapshot[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  const filenames = readDirentsBoundedSync(dir, maxEntries).map((entry) => entry.name);
  const maxFileBytes = opts.maxFileBytes ?? CONFIG_FILE_MAX_BYTES;

  const candidates = filenames
    .filter((f) => f.startsWith('.claude.json.backup.'))
    .map((f) => {
      const suffix = f.slice('.claude.json.backup.'.length);
      const ts = Number(suffix);
      return { f, ts };
    })
    .filter(({ ts }) => Number.isFinite(ts) && ts > 0)
    .sort((a, b) => a.ts - b.ts);

  const snapshots: ConfigSnapshot[] = [];
  for (const { f, ts } of candidates) {
    let raw: RawBackupJson;
    try {
      // readTextFileCappedSync follows symlinks; this refuses them (#3378).
      const read = readFileInDirBoundedSync(dir, f, maxFileBytes);
      if (!read) continue;
      raw = JSON.parse(read.text) as RawBackupJson;
    } catch {
      continue;
    }
    snapshots.push({
      timestamp: ts,
      filename: f,
      projectConfig: projectPath ? (raw.projects?.[projectPath] ?? undefined) : undefined,
      globalMcpServerKeys: Object.keys(raw.mcpServers ?? {}),
    });
  }
  return snapshots;
}

// ── diffConfigDrift ──────────────────────────────────────────────────────────

/**
 * Diff consecutive snapshot pairs and emit `DriftEvent` records.
 *
 * When `projectPath` is given only project-scoped events for that path are
 * emitted (plus global-churn summary events). When omitted, only global-churn
 * events are emitted (useful for the account-wide P12 Gabriela lens).
 *
 * The function is pure: same input always produces the same output.
 */
export function diffConfigDrift(
  snapshots: ConfigSnapshot[],
  projectPath?: string
): DriftEvent[] {
  if (snapshots.length < 2) return [];

  const events: DriftEvent[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    const ts = cur.timestamp;

    if (projectPath) {
      const a = prev.projectConfig ?? {};
      const b = cur.projectConfig ?? {};
      diffProjectConfig(a, b, ts, projectPath, events);
    }

    // Global mcpServers churn (de-emphasised — always info, no project attached)
    const aGlobal = new Set(prev.globalMcpServerKeys);
    const bGlobal = new Set(cur.globalMcpServerKeys);
    const addedGlobal = [...bGlobal].filter((k) => !aGlobal.has(k));
    const removedGlobal = [...aGlobal].filter((k) => !bGlobal.has(k));
    const churn = addedGlobal.length + removedGlobal.length;
    if (churn > 0) {
      events.push({
        kind: 'global-churn',
        from: String(aGlobal.size),
        to: String(bGlobal.size),
        timestamp: ts,
        severity: 'info',
      });
    }
  }

  return events;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function diffProjectConfig(
  a: ProjectConfig,
  b: ProjectConfig,
  ts: number,
  project: string,
  events: DriftEvent[]
): void {
  // 1. Trust dialog flip
  const aTrust = a.hasTrustDialogAccepted;
  const bTrust = b.hasTrustDialogAccepted;
  if (aTrust !== bTrust) {
    events.push({
      kind: 'trust-flip',
      project,
      from: aTrust,
      to: bTrust,
      timestamp: ts,
      severity: 'warning',
    });
  }

  // 2. enableAllProjectMcpServers flip
  const aAll = !!a.enableAllProjectMcpServers;
  const bAll = !!b.enableAllProjectMcpServers;
  if (aAll !== bAll) {
    events.push({
      kind: 'enable-all-flip',
      project,
      from: aAll,
      to: bAll,
      timestamp: ts,
      // Enabling blanket-access is riskier than disabling it
      severity: bAll ? 'warning' : 'info',
    });
  }

  // 3. Repo .mcp.json servers (declared in per-project mcpServers map)
  const aDeclared = new Set(Object.keys(a.mcpServers ?? {}));
  const bDeclared = new Set(Object.keys(b.mcpServers ?? {}));
  for (const s of [...bDeclared].filter((k) => !aDeclared.has(k))) {
    events.push({
      kind: 'repo-server-appeared',
      project,
      server: s,
      from: undefined,
      to: s,
      timestamp: ts,
      severity: 'info',
    });
  }
  for (const s of [...aDeclared].filter((k) => !bDeclared.has(k))) {
    events.push({
      kind: 'repo-server-vanished',
      project,
      server: s,
      from: s,
      to: undefined,
      timestamp: ts,
      severity: 'info',
    });
  }

  // 4. Enable/disable transitions
  //    A server moving from enabledMcpjsonServers to disabledMcpjsonServers is
  //    the silent "tool stopped working" cause — flag as warning.
  const aEnabled = new Set(a.enabledMcpjsonServers ?? []);
  const bEnabled = new Set(b.enabledMcpjsonServers ?? []);
  const aDisabled = new Set(a.disabledMcpjsonServers ?? []);
  const bDisabled = new Set(b.disabledMcpjsonServers ?? []);

  // Servers that moved into disabledMcpjsonServers (were enabled, now disabled)
  for (const s of [...bDisabled].filter((k) => !aDisabled.has(k))) {
    events.push({
      kind: 'server-disabled',
      project,
      server: s,
      from: 'enabled',
      to: 'disabled',
      timestamp: ts,
      severity: 'warning',
    });
  }

  // Servers that moved into enabledMcpjsonServers (not previously enabled,
  // and not just a newly-declared repo server — those are covered above)
  for (const s of [...bEnabled].filter((k) => !aEnabled.has(k) && !(!aDeclared.has(k) && bDeclared.has(k)))) {
    events.push({
      kind: 'server-enabled',
      project,
      server: s,
      from: 'disabled',
      to: 'enabled',
      timestamp: ts,
      severity: 'info',
    });
  }
}
