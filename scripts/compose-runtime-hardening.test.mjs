#!/usr/bin/env node
// Base compose runtime hardening contract (#1208): enterprise deployments keep
// least-privilege container settings and an explicit writable cache exception.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const COMPOSE = readFileSync(join(PROJECT_DIR, 'docker-compose.yml'), 'utf8');
const LINES = COMPOSE.split(/\r?\n/);
const APP_SERVICE = serviceBlock('app');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function serviceBlock(name) {
  const start = LINES.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return [];
  const block = [];
  for (let i = start + 1; i < LINES.length; i += 1) {
    const line = LINES[i];
    if (/^\S/.test(line)) break;
    if (/^  \S[^:]*:$/.test(line)) break;
    block.push(line);
  }
  return block;
}

function appHasLine(pattern) {
  return APP_SERVICE.some((line) => pattern.test(line));
}

function appHasOrderedLines(patterns) {
  let cursor = 0;
  for (const pattern of patterns) {
    const index = APP_SERVICE.findIndex((line, i) => i >= cursor && pattern.test(line));
    if (index === -1) return false;
    cursor = index + 1;
  }
  return true;
}

check('base compose defines an app service', APP_SERVICE.length > 0);
check('base compose makes the app root filesystem read-only', appHasLine(/^    read_only: true$/));
check(
  'base compose drops all ambient Linux capabilities',
  appHasOrderedLines([/^    cap_drop:$/, /^      - ALL$/])
);
check(
  'base compose denies container privilege escalation',
  appHasOrderedLines([/^    security_opt:$/, /^      - no-new-privileges:true$/])
);
check(
  'base compose provides bounded scratch tmpfs',
  appHasOrderedLines([/^    tmpfs:$/, /^      - \/tmp:rw,noexec,nosuid,nodev,size=64m$/])
);
check(
  'base compose keeps the app cache as the only writable app mount',
  appHasLine(/^      - cache:\/app\/\.cache$/)
);
check(
  'base compose does not accidentally mark the cache volume read-only',
  !appHasLine(/^      - cache:\/app\/\.cache:ro$/)
);

if (failures > 0) process.exit(1);
