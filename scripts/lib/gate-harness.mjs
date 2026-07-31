// Shared gate-test harness (#3478, epic #1930).
//
// Every "gate can fail" suite drives the real gate script as a SUBPROCESS and
// asserts on EXIT CODES, because the exit code is the only thing CI actually
// consumes — a gate whose failure path is only unit-tested can still ship a
// wrapper that swallows the non-zero exit. This is the one place that spawn
// shape lives (generalized from scripts/repo-map-gate.test.mjs), so each new
// gate suite is a handful of runGate() calls rather than another private
// spawnSync copy.
//
// Dependency-free on purpose: node builtins only, so any scripts/*.test.mjs
// can use it without entering the runtime container's boot graph or vitest.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');

/**
 * Run a gate script as a subprocess and return its verdict.
 *
 * @param {string} scriptPath  absolute (or cwd-relative) path to the gate
 * @param {string[]} [args]    CLI arguments for the gate
 * @param {object} [opts]
 * @param {string}  [opts.cwd]        working directory (default: repo root)
 * @param {object}  [opts.env]        env overrides, merged over process.env
 *                                    (set a key to '' to neutralize an
 *                                    inherited value, e.g. CI's GITHUB_* vars)
 * @param {boolean} [opts.registerTs] load the TS register hook
 *                                    (`--import ./scripts/register-ts.mjs`),
 *                                    for gates that import .ts modules
 * @param {string[]} [opts.nodeArgs]  extra node flags (e.g. '--expose-gc')
 * @returns {{ code: number|null, out: string }} exit code + merged stdout/stderr
 */
export function runGate(scriptPath, args = [], opts = {}) {
  const { cwd = PROJECT_DIR, env = {}, registerTs = false, nodeArgs = [] } = opts;
  const loaderArgs = registerTs ? ['--import', REGISTER_TS] : [];
  const r = spawnSync(
    process.execPath,
    [...nodeArgs, ...loaderArgs, scriptPath, ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...env } }
  );
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
