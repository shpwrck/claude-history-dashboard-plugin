import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CodingHarness, DataSource } from '../types';

export type { CodingHarness, DataSource } from '../types';

export interface ResolveSourcesOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

const DEFAULT_SOURCE_ID = 'claude-code';
const SUPPORTED_HARNESSES = new Set<CodingHarness>(['claude-code', 'codex']);
const DEFAULT_PUSH_SOURCE_ID = 'probaitio-ingest';
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,126}$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultClaudeDir(
  env: Record<string, string | undefined>,
  homeDir: string
): string {
  return resolve(env.CLAUDE_DIR || join(homeDir, '.claude'));
}

export function defaultDataSource(
  options: ResolveSourcesOptions = {}
): DataSource {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const claudeDir = defaultClaudeDir(env, homeDir);
  const configHome = resolve(env.CLAUDE_HOME_DIR || dirname(claudeDir));

  return {
    id: DEFAULT_SOURCE_ID,
    harness: 'claude-code',
    historyDir: join(claudeDir, 'projects'),
    configFile: join(configHome, '.claude.json'),
  };
}

function normalizeDataSource(raw: unknown): DataSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = nonEmptyString(obj.id);
  const harness = nonEmptyString(obj.harness);
  const historyDir = nonEmptyString(obj.historyDir);
  if (!id || !historyDir || !SUPPORTED_HARNESSES.has(harness as CodingHarness)) {
    return null;
  }
  const configFile = nonEmptyString(obj.configFile);
  return {
    id,
    harness: harness as CodingHarness,
    historyDir: resolve(historyDir),
    ...(configFile ? { configFile: resolve(configFile) } : {}),
  };
}

function pushIngestDataSource(
  env: Record<string, string | undefined>
): DataSource | null {
  const ingestDir = nonEmptyString(env.PROBAITIO_INGEST_DIR);
  if (!ingestDir) return null;
  const id = nonEmptyString(env.PROBAITIO_INGEST_SOURCE_ID) || DEFAULT_PUSH_SOURCE_ID;
  const harness = nonEmptyString(env.PROBAITIO_INGEST_HARNESS) || 'claude-code';
  if (!SOURCE_ID_RE.test(id) || !SUPPORTED_HARNESSES.has(harness as CodingHarness)) {
    return null;
  }
  const root = resolve(ingestDir);
  return {
    id,
    harness: harness as CodingHarness,
    historyDir: join(root, 'projects'),
    configFile: join(root, '.claude.json'),
  };
}

function uniqueSources(sources: DataSource[]): DataSource[] {
  const seenIds = new Set<string>();
  const seenHistoryDirs = new Set<string>();
  const out: DataSource[] = [];
  for (const source of sources) {
    if (seenIds.has(source.id) || seenHistoryDirs.has(source.historyDir)) continue;
    seenIds.add(source.id);
    seenHistoryDirs.add(source.historyDir);
    out.push(source);
  }
  return out;
}

function withAuxiliarySources(
  sources: DataSource[],
  env: Record<string, string | undefined>
): DataSource[] {
  const pushed = pushIngestDataSource(env);
  return uniqueSources(pushed ? [...sources, pushed] : sources);
}

export function resolveSources(
  options: ResolveSourcesOptions = {}
): DataSource[] {
  const env = options.env ?? process.env;
  const raw = env.CODING_AGENT_SOURCES?.trim();
  if (!raw) return withAuxiliarySources([defaultDataSource(options)], env);

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return withAuxiliarySources([defaultDataSource(options)], env);
    }
    const sources = parsed
      .map((item) => normalizeDataSource(item))
      .filter((item): item is DataSource => item != null);
    return withAuxiliarySources(
      sources.length > 0 ? sources : [defaultDataSource(options)],
      env
    );
  } catch {
    return withAuxiliarySources([defaultDataSource(options)], env);
  }
}
