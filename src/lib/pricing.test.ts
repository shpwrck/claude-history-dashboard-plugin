import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenEntry } from '../types';
import {
  entryCostAtModel,
  entryCostBreakdown,
  getModelPricing,
  type ModelPricing,
} from './pricing';

const entry: TokenEntry = {
  timestamp: '2026-08-11T12:00:00.000Z',
  model: 'worked-example',
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
  cacheCreationTokens: 4_000_000,
  cacheCreation1hTokens: 1_500_000,
  cacheReadTokens: 3_000_000,
  webSearchRequests: 2,
  webFetchRequests: 7,
};

const pricing: ModelPricing = {
  input: 2,
  output: 3,
  cacheWrite5m: 4,
  cacheWrite1h: 5,
  cacheRead: 0.5,
};

const srcRoot = fileURLToPath(new URL('..', import.meta.url));

function typescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(path));
    else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('entry cost breakdown', () => {
  it('prices every billed term independently from one worked entry', () => {
    expect(entryCostBreakdown(entry, pricing)).toEqual({
      input: 2,
      output: 6,
      cacheWrite5m: 10,
      cacheWrite1h: 7.5,
      cacheRead: 1.5,
      serverTools: 0.02,
    });
  });

  it('excludes model-independent server-tool fees from model swaps', () => {
    const model = 'claude-opus-4-8';
    const terms = entryCostBreakdown(entry, getModelPricing(model));
    const tokenTerms =
      terms.input +
      terms.output +
      terms.cacheWrite5m +
      terms.cacheWrite1h +
      terms.cacheRead;

    expect(terms.serverTools).toBe(0.02);
    expect(entryCostAtModel(entry, model)).toBe(tokenTerms);
  });

  it('keeps cache-write rate multiplication in one non-test source file', () => {
    const owners = typescriptFiles(srcRoot)
      .filter((path) => readFileSync(path, 'utf8').includes('pricing.cacheWrite5m'))
      .map((path) => relative(srcRoot, path))
      .sort();

    expect(owners).toEqual(['lib/pricing.ts']);
  });
});
