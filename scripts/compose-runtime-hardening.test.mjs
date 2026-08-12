#!/usr/bin/env node
// Base compose runtime hardening contract (#1208): enterprise deployments keep
// least-privilege container settings and an explicit writable-mount allowlist.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const COMPOSE = readFileSync(join(PROJECT_DIR, 'docker-compose.yml'), 'utf8');
const TLS_COMPOSE = readFileSync(join(PROJECT_DIR, 'docker-compose.tls.yml'), 'utf8');
const LINES = COMPOSE.split(/\r?\n/);
const APP_SERVICE = serviceBlock('app');
const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}\}?$/;
const APPROVED_WRITABLE_APP_MOUNTS = new Set([
  '/app/.cache',
  '/app/.adoption-store',
]);

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
  return serviceBlockIn(COMPOSE, name);
}

function serviceBlockIn(compose, name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return [];
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
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

function parseShortVolume(value) {
  // Split at the last `:/` boundary so sources containing colons (including
  // `${VAR:-default}` and absolute host paths) remain intact.
  const destinationBoundary = value.lastIndexOf(':/');
  if (destinationBoundary <= 0) return null;

  const source = value.slice(0, destinationBoundary);
  const destinationAndMode = value.slice(destinationBoundary + 1);
  const modeBoundary = destinationAndMode.indexOf(':');
  const destination = modeBoundary === -1
    ? destinationAndMode
    : destinationAndMode.slice(0, modeBoundary);
  const mode = modeBoundary === -1
    ? ''
    : destinationAndMode.slice(modeBoundary + 1);
  if (!source || !destination.startsWith('/')) return null;
  return { source, destination, mode };
}

function isWritableMount(mount) {
  const modes = new Set(mount.mode.split(',').filter(Boolean));
  return !modes.has('ro') || modes.has('rw');
}

function writableMountViolations(compose) {
  const service = serviceBlockIn(compose, 'app');
  if (service.length === 0) return ['base compose app service is missing'];

  const volumesStart = service.findIndex((line) => line === '    volumes:');
  if (volumesStart === -1) return ['base compose app volumes list is missing'];

  const mounts = [];
  const violations = [];
  for (let i = volumesStart + 1; i < service.length; i += 1) {
    const line = service[i];
    if (/^    \S/.test(line)) break;
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    const item = /^      -\s+(.+?)\s*$/.exec(line);
    const mount = item ? parseShortVolume(item[1]) : null;
    if (!mount) {
      violations.push(`cannot classify app volume entry: ${line.trim()}`);
      continue;
    }
    mounts.push(mount);
  }

  for (const mount of mounts) {
    const modes = new Set(mount.mode.split(',').filter(Boolean));
    if (modes.has('ro') && modes.has('rw')) {
      violations.push(
        `${mount.destination} declares conflicting read-only and writable modes`
      );
      continue;
    }
    if (isWritableMount(mount) && !APPROVED_WRITABLE_APP_MOUNTS.has(mount.destination)) {
      violations.push(`${mount.destination} is an unapproved writable app mount`);
    }
  }

  for (const destination of APPROVED_WRITABLE_APP_MOUNTS) {
    const writableCount = mounts.filter((mount) => {
      if (mount.destination !== destination) return false;
      return isWritableMount(mount);
    }).length;
    if (writableCount !== 1) {
      violations.push(
        `${destination} must appear exactly once as an approved writable app mount`
      );
    }
  }

  return violations;
}

function allImageReferencesAreImmutable(compose) {
  const images = compose
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+image:\s+(\S+)\s*$/)?.[1])
    .filter(Boolean);
  return images.length > 0 && images.every((image) => IMMUTABLE_IMAGE.test(image));
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
const writableMountErrors = writableMountViolations(COMPOSE);
check(
  'base compose writable app mounts are exactly /app/.cache and /app/.adoption-store',
  writableMountErrors.length === 0,
  writableMountErrors.join('; ')
);

const unknownWritableMountErrors = writableMountViolations(
  COMPOSE.replace(
    '      - cache:/app/.cache',
    '      - cache:/app/.cache\n      - /host:/app/extra:rw'
  )
);
check(
  'base compose rejects an unknown writable app mount',
  unknownWritableMountErrors.some((error) => error.includes('/app/extra')),
  unknownWritableMountErrors.join('; ')
);

const unclassifiableMountErrors = writableMountViolations(
  COMPOSE.replace(
    '      - cache:/app/.cache',
    '      - type: volume\n        source: cache\n        target: /app/.cache'
  )
);
check(
  'base compose fails closed on unclassified app volume syntax',
  unclassifiableMountErrors.some((error) => error.includes('cannot classify')),
  unclassifiableMountErrors.join('; ')
);

for (const destination of ['/home/node/.claude', '/home/node/.claude.json']) {
  const writableDataSource = COMPOSE.replace(
    `${destination}:ro`,
    destination
  );
  const errors = writableMountViolations(writableDataSource);
  check(
    `base compose requires ${destination} to remain read-only`,
    errors.some((error) => error.includes(destination)),
    errors.join('; ')
  );
}
check(
  'base compose pins the published app image by digest',
  allImageReferencesAreImmutable(COMPOSE)
);
check(
  'TLS compose pins the reverse-proxy image by digest',
  allImageReferencesAreImmutable(TLS_COMPOSE)
);

if (failures > 0) process.exit(1);
