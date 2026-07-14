import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RUNTIME_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../'
);

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function localSchemaRefs(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => localSchemaRefs(child, `${path}/${index}`));
  }
  if (value === null || typeof value !== 'object') return [];
  const refs: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && !child.startsWith('#/')) {
      refs.push(`${path}/$ref=${child}`);
    }
    refs.push(...localSchemaRefs(child, `${path}/${key}`));
  }
  return refs;
}

describe('experiment runtime contract import boundary', () => {
  it('depends only on its package, node:crypto, and Ajv', () => {
    const violations: string[] = [];
    const runtimeFiles = filesBelow(RUNTIME_ROOT).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.test.ts')
    );
    const importPattern = /(?:from\s+|import\s*\()(['"])([^'"]+)\1/g;

    for (const path of runtimeFiles) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[2];
        if (specifier === 'node:crypto' || specifier === 'ajv/dist/2020.js') {
          continue;
        }
        if (!specifier.startsWith('.')) {
          violations.push(`${relative(RUNTIME_ROOT, path)} imports ${specifier}`);
          continue;
        }
        const target = resolve(dirname(path), specifier);
        if (
          target !== RUNTIME_ROOT &&
          !target.startsWith(`${RUNTIME_ROOT}/`)
        ) {
          violations.push(
            `${relative(RUNTIME_ROOT, path)} escapes to ${specifier}`
          );
        }
      }
      const forbidden = [
        /~\/\.(?:claude|codex)/i,
        /(?:claude-code|codex)/i,
        /parse-(?:sessions|timeline|history|transcript)/i,
        /child_process/,
        /\bfetch\s*\(/,
        /\bprocess\./,
        /\bmcp__\w+/,
      ];
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${relative(RUNTIME_ROOT, path)} matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every published schema reference self-contained', () => {
    const violations = filesBelow(resolve(RUNTIME_ROOT, 'schemas'))
      .filter((path) => path.endsWith('.json'))
      .flatMap((path) => {
        const schema = JSON.parse(readFileSync(path, 'utf8'));
        return localSchemaRefs(schema).map(
          (violation) => `${relative(RUNTIME_ROOT, path)}:${violation}`
        );
      });
    expect(violations).toEqual([]);
  });
});
