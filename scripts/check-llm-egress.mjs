#!/usr/bin/env node
// Enforce the enterprise Anthropic egress contract.
//
// The gate has three layers:
// 1. raw origin literals may only appear in approved chokepoint/UI-copy files;
// 2. server egress wrapper calls must pass literal ids registered in
//    src/lib/llm-registry.ts; and
// 3. publicly reachable entries must satisfy the pre-public exposure contract;
//    and
// 4. docs/llm-usage-registry.md must be freshly generated from the registry.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { checkLlmUsageRegistryDocFresh } from './generate-llm-usage-registry-doc.mjs';

await import('./register-ts.mjs');

const {
  LLM_USAGE_REGISTRY,
  validateLlmPrePublicExposure,
  validateLlmUsageRegistry,
} = await import('../src/lib/llm-registry.ts');

const ANTHROPIC_ORIGIN = 'api.anthropic.com';

const ALLOWED_ORIGIN_FILES = new Set([
  'scripts/check-llm-egress.mjs',
  'src/lib/anthropic-egress.ts',
  'src/lib/claude-api.ts',
]);

const ALLOWED_ORIGIN_LINE_PATTERNS = new Map([
  [
    'scripts/server.mjs',
    [
      /connectSrc\.push\('https:\/\/api\.anthropic\.com'\)/,
      /Browser-side Ask Claude calls to api\.anthropic\.com/,
      /Enterprise CSP blocks browser-side calls to api\.anthropic\.com/,
    ],
  ],
  ['src/components/AskClaude.tsx', [/^\s*api\.anthropic\.com\s*$/]],
  [
    'src/components/Settings.tsx',
    [
      /Connected to api\.anthropic\.com/,
      /directly to <code>api\.anthropic\.com<\/code>/,
      /direct calls to <code>api\.anthropic\.com<\/code>/,
    ],
  ],
]);

const CALLSITE_SCAN_EXCLUDED_FILES = new Set(['src/lib/anthropic-egress.ts']);
const LLM_WRAPPER_CALLEES = new Set([
  'callAnthropic',
  'callAnthropicMessages',
  'egressScrub',
]);

const PUBLIC_EXPOSURE_MODE_ENV = 'DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE';
const PUBLIC_EXPOSURE_MODES = new Set(['single-tenant', 'multi-tenant']);

export function isRuntimeSource(file) {
  if (file.endsWith('.test.ts')) return false;
  if (file.endsWith('.test.tsx')) return false;
  if (file.endsWith('.test.mjs')) return false;
  if (file.endsWith('.test.js')) return false;
  if (file.startsWith('src/') && /\.(ts|tsx)$/.test(file)) return true;
  if (file.startsWith('scripts/') && /\.(mjs|js)$/.test(file)) return true;
  return false;
}

export function findAnthropicOriginOffenders(files, root) {
  const offenders = [];
  for (const file of files) {
    if (ALLOWED_ORIGIN_FILES.has(file)) continue;
    const allowedLines = ALLOWED_ORIGIN_LINE_PATTERNS.get(file) ?? [];
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes(ANTHROPIC_ORIGIN)) continue;
      if (allowedLines.some((pattern) => pattern.test(line))) continue;
      offenders.push(`${file}:${i + 1}`);
    }
  }
  return offenders;
}

export function collectLlmWrapperCalls(file, sourceText) {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(file)
  );
  const calls = [];

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (LLM_WRAPPER_CALLEES.has(callee)) {
        const position = source.getLineAndCharacterOfPosition(
          node.getStart(source)
        );
        const registryId = literalText(node.arguments[0]);
        calls.push({
          file,
          line: position.line + 1,
          callee,
          registryId,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return calls;
}

export function validateLlmWrapperCallSites(calls, entries = LLM_USAGE_REGISTRY) {
  const errors = [];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const serverEgressRefs = new Set();
  const scrubRefs = new Set();

  for (const call of calls) {
    const location = `${call.file}:${call.line}`;
    if (!call.registryId) {
      errors.push(
        `${location}: ${call.callee} must pass a literal LLM registry id as its first argument`
      );
      continue;
    }

    const entry = entriesById.get(call.registryId);
    if (!entry) {
      errors.push(
        `${location}: ${call.callee} uses unregistered LLM registry id ${call.registryId}`
      );
      continue;
    }

    if (entry.callSite.file && entry.callSite.file !== call.file) {
      errors.push(
        `${location}: ${call.registryId} is registered for ${entry.callSite.file}, not ${call.file}`
      );
    }

    if (call.callee === 'egressScrub') scrubRefs.add(call.registryId);
    else serverEgressRefs.add(call.registryId);
  }

  for (const entry of entries) {
    if (entry.surface !== 'server') continue;
    if (!serverEgressRefs.has(entry.id)) {
      errors.push(
        `${entry.id}: registered server egress has no callAnthropic/callAnthropicMessages runtime call-site`
      );
    }
    if (entry.egressScrub !== 'none' && !scrubRefs.has(entry.id)) {
      errors.push(
        `${entry.id}: registry requires egressScrub=${entry.egressScrub} but no runtime egressScrub call-site was found`
      );
    }
  }

  return errors;
}

export { validateLlmPrePublicExposure };

export function parsePublicExposureDeployment(value) {
  const deployment = String(value ?? '').trim() || 'single-tenant';
  if (PUBLIC_EXPOSURE_MODES.has(deployment)) {
    return { deployment, errors: [] };
  }
  return {
    deployment: 'single-tenant',
    errors: [
      `${PUBLIC_EXPOSURE_MODE_ENV} must be single-tenant or multi-tenant, got ${JSON.stringify(deployment)}`,
    ],
  };
}

export function collectLlmWrapperCallsFromFiles(files, root) {
  return files
    .filter((file) => !CALLSITE_SCAN_EXCLUDED_FILES.has(file))
    .flatMap((file) =>
      collectLlmWrapperCalls(file, readFileSync(join(root, file), 'utf8'))
    );
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim();
}

function trackedRuntimeFiles(root) {
  return git(['-C', root, 'ls-files'])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isRuntimeSource);
}

function scriptKindForFile(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return literalText(node.expression);
  }
  return null;
}

function reportSection(title, errors) {
  if (errors.length === 0) return;
  console.error(`\n${title}`);
  for (const error of errors) console.error(`- ${error}`);
}

function main() {
  const root = repoRoot();
  const files = trackedRuntimeFiles(root);
  const exposureDeployment = parsePublicExposureDeployment(
    process.env[PUBLIC_EXPOSURE_MODE_ENV]
  );
  const registryErrors = uniqueErrors([
    ...exposureDeployment.errors,
    ...validateLlmUsageRegistry(),
    ...validateLlmPrePublicExposure(LLM_USAGE_REGISTRY, {
      deployment: exposureDeployment.deployment,
    }),
  ]);
  const originOffenders = findAnthropicOriginOffenders(files, root);
  const callSiteErrors = validateLlmWrapperCallSites(
    collectLlmWrapperCallsFromFiles(files, root)
  );
  const docErrors = checkLlmUsageRegistryDocFresh();

  const failed =
    registryErrors.length > 0 ||
    originOffenders.length > 0 ||
    callSiteErrors.length > 0 ||
    docErrors.length > 0;

  if (failed) {
    console.error('LLM egress governance gate failed.');
    reportSection('Registry errors:', registryErrors);
    reportSection('Raw Anthropic origin offenders:', originOffenders);
    reportSection('Wrapper call-site errors:', callSiteErrors);
    reportSection('Generated registry doc errors:', docErrors);
    process.exit(1);
  }

  console.log('LLM egress governance gate passed.');
}

function uniqueErrors(errors) {
  return Array.from(new Set(errors));
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
