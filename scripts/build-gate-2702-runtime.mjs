#!/usr/bin/env node
// Bundle the full #2702 seal/evaluation verifier and its npm dependencies into
// one ESM file for the production server's zero-node_modules runtime.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "vite";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, "..");
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export async function buildGate2702Runtime({
  projectDir = PROJECT_DIR,
  outputFile,
} = {}) {
  if (!outputFile) throw new Error("buildGate2702Runtime requires outputFile");

  const result = await build({
    root: projectDir,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    plugins: [
      {
        name: "gate-2702-runtime-no-register-hook",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith("register-ts.mjs")) {
            return "\0gate-2702-runtime-register-noop";
          }
          return null;
        },
        load(id) {
          return id === "\0gate-2702-runtime-register-noop"
            ? "export {};"
            : null;
        },
      },
    ],
    build: {
      ssr: join(
        projectDir,
        "scripts",
        "gate-2702",
        "runtime-verifier-entry.mjs",
      ),
      target: "node22",
      write: false,
      copyPublicDir: false,
      minify: false,
      rollupOptions: {
        output: {
          format: "es",
          entryFileNames: "runtime-verifier.bundle.mjs",
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
    output.output.filter((entry) => entry.type === "chunk"),
  );
  if (chunks.length !== 1) {
    throw new Error(`Expected one #2702 runtime chunk, got ${chunks.length}`);
  }

  const unresolved = [...chunks[0].imports, ...chunks[0].dynamicImports].filter(
    (specifier) => specifier !== chunks[0].fileName && !BUILTINS.has(specifier),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Bundled #2702 verifier still has non-builtin imports: ${unresolved.join(", ")}`,
    );
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, chunks[0].code, "utf8");
  await chmod(outputFile, 0o755);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  const outputFile = process.argv[2];
  if (!outputFile) {
    process.stderr.write(
      "Usage: node scripts/build-gate-2702-runtime.mjs <output-file>\n",
    );
    process.exit(2);
  }
  await buildGate2702Runtime({ outputFile: resolve(outputFile) });
  process.stdout.write(
    `Bundled #2702 runtime verifier: ${resolve(outputFile)}\n`,
  );
}
