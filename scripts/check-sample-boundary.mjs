#!/usr/bin/env node
// Public sample-bundle boundary (#3735, retaining #324).
//
// The upload-only build was retired, but the sample showcase is still a public
// browser-only artifact. Its emitted bytes must not carry server routes or
// server-only clients. Run immediately after `npm run build:sample`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ONLY_MARKERS = [
  '/api/',
  'csrf-token',
  'policy/write',
  'EventSource',
];

const SAME_ORIGIN_CONNECT_SRC = "connect-src 'self'";

function attributeValue(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'),
  );
  return match ? (match[1] ?? match[2]) : null;
}

export function inspectSampleCsp(html) {
  const cspTags = (html.match(/<meta\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      attributeValue(tag, 'http-equiv')?.toLowerCase() ===
      'content-security-policy',
  );
  if (cspTags.length !== 1) {
    return [`expected exactly one emitted CSP meta tag; found ${cspTags.length}`];
  }

  const content = attributeValue(cspTags[0], 'content');
  if (content === null) return ['emitted CSP meta tag has no content attribute'];

  const connectDirectives = content
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => /^connect-src(?:\s|$)/i.test(directive));
  if (connectDirectives.length !== 1) {
    return [
      `expected exactly one explicit same-origin connect-src directive; found ${connectDirectives.length}`,
    ];
  }
  const tokens = connectDirectives[0].split(/\s+/);
  if (
    tokens.length !== 2 ||
    tokens[0].toLowerCase() !== 'connect-src' ||
    tokens[1] !== "'self'"
  ) {
    return [
      `expected same-origin connect-src "${SAME_ORIGIN_CONNECT_SRC}"; found "${connectDirectives[0]}"`,
    ];
  }
  return [];
}

function filesUnder(path) {
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

export function inspectSampleBoundary(dist = 'dist') {
  const index = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  const missing = [];
  const files = [];
  let cspProblems = [];

  try {
    if (!statSync(index).isFile()) missing.push(index);
    else {
      files.push(index);
      cspProblems = inspectSampleCsp(readFileSync(index, 'utf8'));
    }
  } catch {
    missing.push(index);
  }
  try {
    if (!statSync(assets).isDirectory()) missing.push(assets);
    else files.push(...filesUnder(assets));
  } catch {
    missing.push(assets);
  }

  const offenders = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const marker of SERVER_ONLY_MARKERS) {
      if (bytes.includes(marker)) offenders.push({ file, marker });
    }
  }
  return { files, missing, offenders, cspProblems };
}

function die(message, code) {
  console.error(`\n✗ Sample boundary gate ERROR — ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { dist: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--dist') die(`unknown argument "${argv[i]}".`, 2);
    const value = argv[++i];
    if (value === undefined) die('--dist requires a directory path.', 2);
    out.dist = value;
  }
  return out;
}

function main() {
  const { dist } = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = inspectSampleBoundary(dist);
  } catch (error) {
    die(`could not inspect ${dist} (${error && error.message}).`, 2);
  }
  if (result.missing.length > 0) {
    die(
      `missing ${result.missing.join(', ')} — nothing was published, so this gate verified NOTHING. Run npm run build:sample first.`,
      2,
    );
  }
  if (result.files.length === 0) {
    die(`no emitted files under ${dist}; this gate verified NOTHING.`, 2);
  }
  if (result.cspProblems.length > 0) {
    console.error('\n✗ Sample boundary gate BLOCKED:');
    for (const problem of result.cspProblems) console.error(`  - ${problem}`);
    console.error(
      '\nThe public sample must emit an explicit same-origin connect-src policy.\n',
    );
    process.exit(1);
  }
  if (result.offenders.length > 0) {
    console.error('\n✗ Sample boundary gate BLOCKED:');
    for (const { file, marker } of result.offenders) {
      console.error(`  - ${file} contains server-only marker "${marker}"`);
    }
    console.error(
      '\nRoute server calls through the aliased client seam so the public sample bundle cannot contain them.\n',
    );
    process.exit(1);
  }
  console.log(
    `✓ Sample boundary clean: ${result.files.length} emitted files contain no server-only markers.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
