// Resolve hook: let Node import the project's extensionless .ts parser modules.
// Node ESM requires explicit extensions; TS source omits them. For relative
// specifiers without a JS/TS extension, try .ts / .tsx / dir index.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, sep } from 'node:path';

const RUNTIME_IMPORT_GUARD = /^(1|true|yes|on)$/i.test(
  String(process.env.DASHBOARD_RUNTIME_IMPORT_GUARD || '')
);
const PROJECT_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_SCRIPT_DIR = resolvePath(PROJECT_DIR, 'scripts');
const RUNTIME_SRC_LIB_DIR = resolvePath(PROJECT_DIR, 'src', 'lib');

function isBarePackageSpecifier(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('data:') &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)
  );
}

function isServerRuntimeParent(parentURL) {
  if (!parentURL?.startsWith('file:')) return false;
  const parentPath = fileURLToPath(parentURL);
  if (
    parentPath.endsWith(`${sep}scripts${sep}register-ts.mjs`) ||
    parentPath.endsWith(`${sep}scripts${sep}ts-resolver.mjs`) ||
    // mcp-shim.mjs is an isolated stdio process declared in .mcp.json; it
    // intentionally imports @modelcontextprotocol/sdk as a separate process
    // and must NEVER be imported by server.mjs. Exclude it from the guard so
    // running it standalone with DASHBOARD_RUNTIME_IMPORT_GUARD=1 doesn't
    // produce a confusing false-positive error.
    parentPath.endsWith(`${sep}scripts${sep}mcp-shim.mjs`) ||
    parentPath.endsWith('.test.mjs')
  ) {
    return false;
  }
  return (
    isPathInside(parentPath, RUNTIME_SCRIPT_DIR) ||
    isPathInside(parentPath, RUNTIME_SRC_LIB_DIR)
  );
}

function isPathInside(filePath, dirPath) {
  return filePath === dirPath || filePath.startsWith(`${dirPath}${sep}`);
}

export async function resolve(specifier, context, next) {
  if (
    RUNTIME_IMPORT_GUARD &&
    isBarePackageSpecifier(specifier) &&
    isServerRuntimeParent(context.parentURL)
  ) {
    throw new Error(
      `Server runtime import guard blocked bare package "${specifier}" from ` +
        `${fileURLToPath(context.parentURL)}. The runtime image ships no ` +
        'node_modules; use node: builtins or local runtime files.'
    );
  }

  if (
    specifier.startsWith('.') &&
    !/\.([mc]?jsx?|[mc]?tsx?|json)$/.test(specifier) &&
    context.parentURL?.startsWith('file:')
  ) {
    const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    for (const cand of [base + '.ts', base + '.tsx', base + '/index.ts']) {
      if (existsSync(cand)) return next(pathToFileURL(cand).href, context);
    }
  }
  return next(specifier, context);
}
