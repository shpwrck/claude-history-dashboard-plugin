#!/usr/bin/env node
// Keep the two OpenShift dind runner pools capable of exercising Gate 2702's
// real bubblewrap denial proof without granting the runner container every
// privilege held by its Docker sidecar.

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VALUE_FILES = [
  ['spoke', join('deploy', 'arc', 'dind-scale-set-values.yaml')],
  ['hub', join('deploy', 'arc', 'hub', 'dind-scale-set-values.yaml')],
];
const REQUIRED_CAPABILITIES = ['NET_ADMIN', 'SETFCAP', 'SYS_ADMIN'];

function hasExactKeys(value, expected) {
  const actual = Object.keys(value ?? {});
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function exactRunnerSecurityContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return false;
  }
  if (!hasExactKeys(context, ['capabilities', 'seLinuxOptions'])) {
    return false;
  }
  if (
    !context.capabilities ||
    !hasExactKeys(context.capabilities, ['add']) ||
    !Array.isArray(context.capabilities.add) ||
    context.capabilities.add.length !== REQUIRED_CAPABILITIES.length ||
    !context.capabilities.add.every((capability) =>
      REQUIRED_CAPABILITIES.includes(capability),
    ) ||
    !REQUIRED_CAPABILITIES.every((capability) =>
      context.capabilities.add.includes(capability),
    )
  ) {
    return false;
  }
  return (
    context.seLinuxOptions &&
    hasExactKeys(context.seLinuxOptions, ['type']) &&
    context.seLinuxOptions.type === 'spc_t'
  );
}

export function arcDindSandboxReasons(root) {
  const reasons = [];
  for (const [cluster, relativePath] of VALUE_FILES) {
    let values;
    try {
      values = parse(readFileSync(join(root, relativePath), 'utf8'));
    } catch (error) {
      reasons.push(`${cluster}: cannot read and parse ${relativePath}: ${error.message}`);
      continue;
    }

    const podContext = values?.template?.spec?.securityContext;
    if (podContext?.runAsUser !== 0 || podContext?.runAsGroup !== 0) {
      reasons.push(
        `${cluster}: dind runner pod must retain runAsUser: 0 and runAsGroup: 0`,
      );
    }

    const runner = values?.template?.spec?.containers?.find(
      (container) => container?.name === 'runner',
    );
    if (!runner) {
      reasons.push(`${cluster}: dind values must define the runner container`);
      continue;
    }

    if (!exactRunnerSecurityContext(runner.securityContext)) {
      reasons.push(
        `${cluster}: runner must retain the exact security context: capabilities add exactly NET_ADMIN, SETFCAP, and SYS_ADMIN, SELinux type spc_t, and no broad privileged flag`,
      );
    }
  }
  return reasons;
}

function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : REPO_ROOT;
  const reasons = arcDindSandboxReasons(root);
  if (reasons.length > 0) {
    console.error('ARC dind sandbox capability check FAILED (#3470):\n');
    for (const reason of reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }
  console.log(
    'ARC dind sandbox capability check passed: spoke and hub retain the exact live-proven bubblewrap security context.',
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
