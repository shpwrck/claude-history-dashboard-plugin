// Pin the Node-side twin (scripts/lib/shell-quote.mjs) to the canonical
// TypeScript leaf (src/lib/shell-quote.ts) — #3379.
//
// #3379 removed five hand-typed copies of the POSIX escape idiom precisely
// because copies drift (one had already grown a leading-dash guard the others
// lacked). The twin exists only because plain `scripts/**/*.mjs` entry points
// run under bare node with no TypeScript loader. This suite is the price of
// that exemption: every exported function is run through both implementations
// over the same hostile corpus plus deterministic fuzz, and any divergent byte
// fails CI. Without it the twin would be exactly the drift the issue removed.
//
// Run under `node --import ./scripts/register-ts.mjs` so the .ts leaf loads.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/lib/shell-quote.ts';
import * as mjs from './lib/shell-quote.mjs';

const CORPUS = [
  '',
  'plain',
  'github',
  '/home/me/.claude/skills/some-skill',
  'a_b-c.d@e%f+g=h:i,j',
  "it's",
  "''",
  "'; rm -rf ~ #",
  'two words',
  '\ttab',
  'trailing ',
  'a;b',
  'a|b',
  'a&b',
  'a&&b',
  'a||b',
  'a>b',
  'a<b',
  'a(b)c',
  'a#b',
  '`id`',
  '$(id)',
  '${HOME}',
  '$HOME',
  '~',
  '~/.claude/skills/x',
  '*',
  'a?b',
  'a[b]c',
  'a{b,c}d',
  '!!',
  'line1\nline2',
  'line1\r\nline2',
  '-rf',
  '--help',
  '-',
  'a'.repeat(200),
  'ünïcødé',
  '\u0000nul',
];

/**
 * Deterministic pseudo-random corpus (no Math.random, so a CI failure is
 * reproducible from the source alone). Draws from the metacharacter alphabet
 * that actually distinguishes the two branches of the quoter.
 */
function fuzzCorpus(count) {
  const alphabet = [
    ...`abcXYZ019_@%+=:,./-`,
    ...`'"\`$();&|<>*?[]{}!#~`,
    ' ',
    '\t',
    '\n',
    '\\',
  ];
  const values = [];
  let seed = 0x2f6e2b1;
  const next = () => {
    // xorshift32 — small, deterministic, good enough to shuffle a corpus.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  for (let i = 0; i < count; i += 1) {
    const length = 1 + Math.floor(next() * 12);
    let value = '';
    for (let j = 0; j < length; j += 1) {
      value += alphabet[Math.floor(next() * alphabet.length)];
    }
    values.push(value);
  }
  return values;
}

const ALL = [...CORPUS, ...fuzzCorpus(500)];

test('the twin exports exactly the same surface as the leaf', () => {
  const exported = (mod) => Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
  assert.deepEqual(exported(mjs), exported(ts));
});

for (const name of ['shellQuote', 'isInertShellWord', 'shellQuoteMinimal', 'shellQuotePathWithHome']) {
  test(`${name} is byte-identical across both implementations`, () => {
    assert.equal(typeof ts[name], 'function', `${name} missing from the .ts leaf`);
    assert.equal(typeof mjs[name], 'function', `${name} missing from the .mjs twin`);
    for (const value of ALL) {
      assert.deepEqual(
        mjs[name](value),
        ts[name](value),
        `${name} diverged on ${JSON.stringify(value)} — the twin and the leaf must stay identical (#3379)`
      );
    }
  });
}
