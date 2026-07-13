#!/usr/bin/env node
// Single source of truth for the marketplace mirror payload. The publish
// workflow and the clean-runtime test both call this implementation.

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPluginMcp } from './build-plugin-mcp.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function containsPath(parent, candidate) {
  const rel = relative(parent, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export async function assemblePluginPayload({
  projectDir = PROJECT_DIR,
  outputDir,
  distDir = join(projectDir, 'dist'),
} = {}) {
  if (!outputDir) throw new Error('assemblePluginPayload requires outputDir');

  const projectRoot = resolve(projectDir);
  const payloadRoot = resolve(outputDir);
  const resolvedDistDir = resolve(distDir);
  if (containsPath(payloadRoot, projectRoot)) {
    throw new Error(
      'Refusing to remove an output path that contains the project root'
    );
  }

  const sourcePaths = [
    resolvedDistDir,
    join(projectRoot, 'scripts'),
    join(projectRoot, 'src'),
    join(projectRoot, '.claude-plugin'),
    join(projectRoot, 'commands'),
    join(projectRoot, 'docs'),
  ];
  if (
    sourcePaths.some(
      (source) =>
        containsPath(payloadRoot, source) || containsPath(source, payloadRoot)
    )
  ) {
    throw new Error('Refusing to remove a plugin payload source path');
  }

  await rm(payloadRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });

  await copy(resolvedDistDir, join(payloadRoot, 'dist'));
  await copy(join(projectRoot, 'scripts'), join(payloadRoot, 'scripts'));
  await copy(join(projectRoot, 'src', 'lib'), join(payloadRoot, 'src', 'lib'));
  await copy(
    join(projectRoot, 'src', 'types.ts'),
    join(payloadRoot, 'src', 'types.ts')
  );
  await copy(
    join(projectRoot, '.claude-plugin'),
    join(payloadRoot, '.claude-plugin')
  );
  await copy(join(projectRoot, 'commands'), join(payloadRoot, 'commands'));
  await copy(
    join(projectRoot, 'docs', 'plugin-mirror-README.md'),
    join(payloadRoot, 'README.md')
  );

  // Overwrite the source shim copied above with the self-contained artifact.
  await buildPluginMcp({
    projectDir: projectRoot,
    outputFile: join(payloadRoot, 'scripts', 'mcp-shim.mjs'),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const outputDir = resolve(process.argv[2] || '_plugin_payload');
  await assemblePluginPayload({ outputDir });
  process.stdout.write(`Plugin payload assembled: ${outputDir}\n`);
}
