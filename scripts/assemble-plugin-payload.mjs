#!/usr/bin/env node
// Single source of truth for the marketplace mirror payload. The publish
// workflow and the clean-runtime test both call this implementation.

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPluginMcp } from './build-plugin-mcp.mjs';
import { buildGate2702Runtime } from './build-gate-2702-runtime.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

/**
 * Return `manifestText` (a plugin.json string) with its `version` set to
 * `version`, preserving key order and 2-space formatting. package.json is the
 * single source of truth for the plugin version, so the assembler stamps it
 * into the payload manifest — the published plugin can never skew from the
 * engine it ships (#2950). Exported for the version-sync test.
 */
export function stampedPluginManifest(manifestText, version) {
  const manifest = JSON.parse(manifestText);
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
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
  // Stamp the payload manifest version from package.json (the single source of
  // truth), so the published plugin can never report a version that skews from
  // the engine it ships (#2950).
  const manifestPath = join(payloadRoot, '.claude-plugin', 'plugin.json');
  const pkg = JSON.parse(
    await readFile(join(projectRoot, 'package.json'), 'utf8')
  );
  await writeFile(
    manifestPath,
    stampedPluginManifest(await readFile(manifestPath, 'utf8'), pkg.version),
    'utf8'
  );
  await copy(join(projectRoot, 'commands'), join(payloadRoot, 'commands'));
  // The plugin launches the same server from the payload root. Repo docs are
  // therefore runtime data, not publishing-only prose: preserve the complete
  // root *.md + docs/** surface consumed by buildDocGraph(). The marketplace
  // README is deliberately the plugin-specific mirror below, so the graph
  // describes the exact deployed payload rather than the source checkout.
  for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      await copy(join(projectRoot, entry.name), join(payloadRoot, entry.name));
    }
  }
  await copy(join(projectRoot, 'docs'), join(payloadRoot, 'docs'));
  // Keep this replacement after the root-doc copy. The marketplace landing
  // page has plugin installation instructions that the repository README does
  // not, and is intentionally the payload's canonical README node.
  await copy(
    join(projectRoot, 'docs', 'plugin-mirror-README.md'),
    join(payloadRoot, 'README.md')
  );

  // Overwrite the source shim copied above with the self-contained artifact.
  await buildPluginMcp({
    projectDir: projectRoot,
    outputFile: join(payloadRoot, 'scripts', 'mcp-shim.mjs'),
  });
  // The plugin server shares the container's zero-node_modules contract. Ship
  // the same self-contained verifier used by the production image.
  await buildGate2702Runtime({
    projectDir: projectRoot,
    outputFile: join(
      payloadRoot,
      'scripts',
      'gate-2702',
      'runtime-verifier.bundle.mjs'
    ),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  const outputDir = resolve(process.argv[2] || '_plugin_payload');
  await assemblePluginPayload({ outputDir });
  process.stdout.write(`Plugin payload assembled: ${outputDir}\n`);
}
