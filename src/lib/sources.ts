import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CodingHarness, DataSource } from '../types';

export type { CodingHarness, DataSource } from '../types';

export interface ResolveSourcesOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

const DEFAULT_SOURCE_ID = 'claude-code';
const SUPPORTED_HARNESSES = new Set<CodingHarness>(['claude-code']);

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

export function resolveSources(
  options: ResolveSourcesOptions = {}
): DataSource[] {
  const env = options.env ?? process.env;
  const raw = env.CODING_AGENT_SOURCES?.trim();
  if (!raw) return [defaultDataSource(options)];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [defaultDataSource(options)];
    const sources = parsed
      .map((item) => normalizeDataSource(item))
      .filter((item): item is DataSource => item != null);
    return sources.length > 0 ? sources : [defaultDataSource(options)];
  } catch {
    return [defaultDataSource(options)];
  }
}
