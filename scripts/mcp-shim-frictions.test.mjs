#!/usr/bin/env node
// Unit tests for the MCP shim's top_frictions selection logic (#2948).
//
// The original inline filter matched `category === 'friction'`, but the
// engine's RecCategory vocabulary has no such value, so the tool ALWAYS fell
// through to its top-5-overall fallback. These tests pin the fixed filter
// against the REAL RecCategory union parsed from src/lib/detectors/rec-enums.ts
// (a type-only union — there is nothing to import at runtime), so a future
// category rename breaks this suite loudly instead of silently reviving the
// always-fallback bug.
//
// Run with: node --test scripts/mcp-shim-frictions.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractRecommendations,
  FRICTION_CATEGORIES,
  selectTopFrictions,
} from './mcp-shim-frictions.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REC_ENUMS_PATH = join(
  SCRIPTS_DIR,
  '..',
  'src',
  'lib',
  'detectors',
  'rec-enums.ts'
);

/** Parse the RecCategory string-literal union members from rec-enums.ts. */
async function readRecCategoryValues() {
  const src = await readFile(REC_ENUMS_PATH, 'utf8');
  const match = src.match(/export type RecCategory\s*=([\s\S]*?);/);
  assert(match, `Could not find "export type RecCategory" in ${REC_ENUMS_PATH}`);
  const values = [...match[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert(values.length > 0, 'RecCategory union parsed to zero members');
  return values;
}

const rec = (id, category) => ({ id, category, title: `rec ${id}` });

test('FRICTION_CATEGORIES are real RecCategory values (rename breaks here)', async () => {
  const recCategories = await readRecCategoryValues();
  for (const cat of FRICTION_CATEGORIES) {
    assert(
      recCategories.includes(cat),
      `FRICTION_CATEGORIES entry "${cat}" is not a RecCategory value ` +
        `(${recCategories.join(', ')}) — update mcp-shim-frictions.mjs to match ` +
        'the renamed category'
    );
  }
});

test('RecCategory has no literal "friction" value (the original bug)', async () => {
  const recCategories = await readRecCategoryValues();
  assert(
    !recCategories.includes('friction'),
    'RecCategory now contains a literal "friction" category — top_frictions ' +
      'should probably filter on it directly instead of the friction-shaped set'
  );
});

test('friction-shaped set is exactly workflow/reliability/context', () => {
  assert.deepEqual(
    [...FRICTION_CATEGORIES].sort(),
    ['context', 'reliability', 'workflow']
  );
});

test('filters to friction-shaped categories, preserving payload order', () => {
  const recs = [
    rec(1, 'cost'),
    rec(2, 'workflow'),
    rec(3, 'security'),
    rec(4, 'reliability'),
    rec(5, 'context'),
    rec(6, 'speed'),
  ];
  const result = selectTopFrictions({ recommendations: recs });
  assert.equal(result.total_recommendations, 6);
  assert.deepEqual(
    result.top_frictions.map((r) => r.id),
    [2, 4, 5]
  );
  assert.equal(result.note, undefined);
});

test('caps at top 5 friction findings', () => {
  const recs = [
    rec(1, 'workflow'),
    rec(2, 'reliability'),
    rec(3, 'context'),
    rec(4, 'workflow'),
    rec(5, 'reliability'),
    rec(6, 'context'),
  ];
  const result = selectTopFrictions(recs);
  assert.deepEqual(
    result.top_frictions.map((r) => r.id),
    [1, 2, 3, 4, 5]
  );
});

test('falls back to top 5 overall with a note when nothing matches', () => {
  const recs = [
    rec(1, 'cost'),
    rec(2, 'safety'),
    rec(3, 'security'),
    rec(4, 'speed'),
    rec(5, 'activity'),
    rec(6, 'maintenance'),
  ];
  const result = selectTopFrictions({ recommendations: recs });
  assert.equal(result.total_recommendations, 6);
  assert.deepEqual(
    result.top_frictions.map((r) => r.id),
    [1, 2, 3, 4, 5]
  );
  assert.match(result.note, /No workflow\/reliability\/context recommendations/);
});

test('never matches a literal "friction" category (fallback would hide it)', () => {
  // A rec claiming category "friction" is not a RecCategory value; the filter
  // must not resurrect the old string-match behaviour.
  const recs = [rec(1, 'friction'), rec(2, 'workflow')];
  const result = selectTopFrictions(recs);
  assert.deepEqual(
    result.top_frictions.map((r) => r.id),
    [2]
  );
});

test('empty and malformed payloads keep the tool result shape', () => {
  for (const payload of [[], {}, null, undefined, { recommendations: [] }]) {
    const result = selectTopFrictions(payload);
    assert.deepEqual(result, {
      total_recommendations: 0,
      top_frictions: [],
      note: 'No workflow/reliability/context recommendations found; showing top 5 recommendations instead.',
    });
  }
  // Recs without a category object shape are skipped, not crashed on.
  const result = selectTopFrictions([null, { id: 1 }, rec(2, 'context')]);
  assert.deepEqual(
    result.top_frictions.map((r) => r.id),
    [2]
  );
});

test('extractRecommendations handles both payload shapes', () => {
  const arr = [rec(1, 'workflow')];
  assert.equal(extractRecommendations(arr), arr);
  assert.equal(extractRecommendations({ recommendations: arr }), arr);
  assert.deepEqual(extractRecommendations({ recommendations: 'nope' }), []);
});

test('mcp-shim.mjs delegates top_frictions to the shared helper', async () => {
  const shimSrc = await readFile(join(SCRIPTS_DIR, 'mcp-shim.mjs'), 'utf8');
  assert(
    shimSrc.includes("from './mcp-shim-frictions.mjs'") &&
      shimSrc.includes('selectTopFrictions('),
    'mcp-shim.mjs must use selectTopFrictions from mcp-shim-frictions.mjs — ' +
      'an inline filter drifts away from this pinned suite'
  );
});
