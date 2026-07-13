#!/usr/bin/env node
// Bundle the isolated MCP process and all npm dependencies into one ESM file.
// The dashboard server remains zero-dependency; only this separate artifact is
// vendored into the published Claude Code plugin payload.

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'vite';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export async function buildPluginMcp({
  projectDir = PROJECT_DIR,
  outputFile,
} = {}) {
  if (!outputFile) throw new Error('buildPluginMcp requires outputFile');

  const result = await build({
    root: projectDir,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      ssr: join(projectDir, 'scripts', 'mcp-shim.mjs'),
      target: 'node22',
      write: false,
      copyPublicDir: false,
      minify: false,
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: 'mcp-shim.mjs',
          codeSplitting: false,
        },
      },
    },
    ssr: {
      noExternal: true,
    },
  });

  const buildOutputs = Array.isArray(result) ? result : [result];
  const chunks = buildOutputs.flatMap((output) =>
    output.output.filter((entry) => entry.type === 'chunk')
  );
  if (chunks.length !== 1) {
    throw new Error(`Expected one bundled MCP chunk, got ${chunks.length}`);
  }

  const unresolved = chunks[0].imports.filter((specifier) => !BUILTINS.has(specifier));
  if (unresolved.length > 0) {
    throw new Error(
      `Bundled MCP still has non-builtin imports: ${unresolved.join(', ')}`
    );
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, chunks[0].code, 'utf8');
  await chmod(outputFile, 0o755);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const outputFile = process.argv[2];
  if (!outputFile) {
    process.stderr.write('Usage: node scripts/build-plugin-mcp.mjs <output-file>\n');
    process.exit(2);
  }
  await buildPluginMcp({ outputFile: resolve(outputFile) });
  process.stdout.write(`Bundled plugin MCP: ${resolve(outputFile)}\n`);
}
