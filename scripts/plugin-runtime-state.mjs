// Shared runtime state for the zero-dependency plugin supervisor and the
// separately bundled MCP process. Keep this module on Node built-ins only.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DASHBOARD_PORT = 5173;

function validPort(value) {
  if (value == null || String(value).trim() === '') return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function pluginCacheDir(env = process.env) {
  return env.CHD_CACHE_DIR || join(homedir(), '.claude', '.cache', 'chd');
}

export function pluginPortFile(env = process.env) {
  return join(pluginCacheDir(env), 'plugin-ctl.port');
}

export function preferredDashboardPort(env = process.env) {
  return validPort(env.PORT) ?? DEFAULT_DASHBOARD_PORT;
}

export function configuredMcpPort(env = process.env) {
  return (
    validPort(env.CHD_PORT) ??
    validPort(env.PORT) ??
    DEFAULT_DASHBOARD_PORT
  );
}

export async function readActiveDashboardPort(env = process.env) {
  try {
    const statePort = validPort(await readFile(pluginPortFile(env), 'utf8'));
    if (statePort !== null) return statePort;
  } catch {
    // The dashboard may not have started yet. Use the declared fallback so the
    // MCP tool returns a useful unreachable URL instead of a state-file error.
  }
  return configuredMcpPort(env);
}
