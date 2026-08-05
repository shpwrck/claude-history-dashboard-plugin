#!/usr/bin/env node
// Fail-closed trust ceiling for PR workflows that schedule self-hosted ARC jobs.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// perf-index-contract: pr-workflow-policy-membership always-consumed: every workflow scan queries these fixed runner and canonical-file memberships
const ARC_RUNNERS = new Set([
  'arc-runner-set',
  'arc-dind',
  'arc-runner-set-hub',
  'arc-dind-hub',
]);
// perf-index-contract: pr-workflow-canonical-membership always-consumed: every repository audit queries and inventories the complete canonical workflow membership
const CANONICAL_TARGET_ARC_WORKFLOWS = new Set([
  'agent-cross-review.yml',
  'browser-compat.yml',
  'ci.yml',
  'cold-load.yml',
  'pr-nonempty.yml',
  'server-scale.yml',
  'test.yml',
]);
// perf-index-contract: pr-workflow-retired-temp-membership always-consumed: every workflow scan rejects any retired Stage B bootstrap filename
const RETIRED_TEMP_TARGET_WORKFLOWS = new Set([
  'stage-b-target-agent-cross-review.yml',
  'stage-b-target-browser-compat.yml',
  'stage-b-target-ci.yml',
  'stage-b-target-cold-load.yml',
  'stage-b-target-pr-nonempty.yml',
  'stage-b-target-server-scale.yml',
  'stage-b-target-test.yml',
]);
const MILESTONE_GUARD_WORKFLOW = 'milestone-guard.yml';
const MERGE_RESOLVER_WORKFLOW = 'pr-merge-sha.yml';
const HEAD_REPOSITORY_EXPRESSION =
  '${{ github.event.pull_request.head.repo.full_name }}';
const TRUSTED_EXPRESSION = "needs.authorize.outputs.trusted == 'true'";
const MERGE_AVAILABLE_EXPRESSION =
  "needs.resolve-merge.outputs.merge-sha != ''";
const PR_CONCURRENCY_GROUP =
  '${{ github.workflow }}-${{ github.event.pull_request.number }}';
const MERGE_SHA_EXPRESSION =
  '${{ needs.resolve-merge.outputs.merge-sha }}';
const PR_NUMBER_EXPRESSION = '${{ github.event.pull_request.number }}';
const HEAD_SHA_EXPRESSION = '${{ github.event.pull_request.head.sha }}';
const BASE_SHA_EXPRESSION = '${{ github.event.pull_request.base.sha }}';
const BASE_REF_EXPRESSION = '${{ github.event.pull_request.base.ref }}';
const BROKER_WORKFLOW_OUTPUT = '${{ jobs.authorize.outputs.trusted }}';
const BROKER_JOB_OUTPUT = '${{ steps.same-repo.outputs.trusted }}';
const BROKER_TRUST_EXPRESSION =
  '${{ inputs.head-repository == github.repository }}';
const BROKER_COMMAND = 'echo "trusted=$TRUSTED" >> "$GITHUB_OUTPUT"';
const RESOLVER_WORKFLOW_OUTPUT = '${{ jobs.resolve.outputs.merge-sha }}';
const RESOLVER_JOB_OUTPUT = '${{ steps.resolve.outputs.merge-sha }}';
const RESOLVER_BASE_CHECKOUT = '${{ inputs.expected-base-sha }}';
const RESOLVER_TOKEN_EXPRESSION = '${{ github.token }}';
const RESOLVER_PR_INPUT = '${{ inputs.pr-number }}';
const RESOLVER_HEAD_INPUT = '${{ inputs.expected-head-sha }}';
const RESOLVER_BASE_REF_INPUT = '${{ inputs.expected-base-ref }}';
const RESOLVER_COMMAND = 'node scripts/resolve-pr-merge-sha.mjs';
const CHECKOUT_ACTION =
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SANDBOX_PROOF_COMMAND =
  "node --test --test-name-pattern='arm dispatch denies a hostile ~/.claude canary and passes only the documented environment' scripts/gate-2702/run.test.mjs";

function triggerNames(workflow) {
  if (typeof workflow?.on === 'string') return [workflow.on];
  if (Array.isArray(workflow?.on)) return workflow.on;
  if (workflow?.on && typeof workflow.on === 'object') {
    return Object.keys(workflow.on);
  }
  return [];
}

function usesArc(job) {
  const runner = job?.['runs-on'];
  if (typeof runner === 'string') return ARC_RUNNERS.has(runner);
  if (Array.isArray(runner)) return runner.some((label) => ARC_RUNNERS.has(label));
  return false;
}

function usesDynamicRunner(job) {
  const runner = job?.['runs-on'];
  if (typeof runner === 'string') return runner.includes('${{');
  if (Array.isArray(runner)) {
    return runner.some(
      (label) => typeof label !== 'string' || label.includes('${{')
    );
  }
  return runner !== undefined;
}

function usesApprovedHostedRunner(job) {
  return job?.['runs-on'] === 'ubuntu-latest';
}

function dependencyNames(job) {
  if (typeof job?.needs === 'string') return [job.needs];
  return Array.isArray(job?.needs) ? job.needs : [];
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value ?? {}).every((key) => allowed.includes(key));
}

function hasExactReadPermissions(value) {
  return (
    value?.contents === 'read' &&
    value?.['pull-requests'] === 'read' &&
    Object.keys(value).length === 2
  );
}

function hasVerifiedMergeGuard(expression) {
  if (typeof expression !== 'string' || expression.includes('||')) return false;
  return expression
    .split('&&')
    .map((part) => part.trim())
    .includes(MERGE_AVAILABLE_EXPRESSION);
}

// perf-index-contract: pr-workflow-dependency-cycle-guard always-consumed: every recursive dependency visit checks and records its current job identity
function reachesJob(jobs, from, target, seen = new Set()) {
  if (seen.has(from)) return false;
  seen.add(from);
  for (const dependency of dependencyNames(jobs[from])) {
    if (dependency === target || reachesJob(jobs, dependency, target, seen)) {
      return true;
    }
  }
  return false;
}

export function prWorkflowTrustReasons(root) {
  const directory = join(root, '.github', 'workflows');
  const reasons = [];
  // perf-index-contract: pr-workflow-file-inventory always-consumed: every successful repository audit queries the populated workflow inventory for required policy files
  const workflows = new Map();
  let protectedWorkflowCount = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    let workflow;
    try {
      workflow = parse(readFileSync(join(directory, entry.name), 'utf8'));
    } catch (error) {
      reasons.push(`${entry.name}: failed to parse YAML: ${error.message}`);
      continue;
    }
    workflows.set(entry.name, workflow);
    const triggers = triggerNames(workflow);
    const jobs = workflow?.jobs ?? {};
    const arcJobs = Object.values(jobs).some(usesArc);
    const dynamicRunnerJobs = Object.values(jobs).some(usesDynamicRunner);
    const canonicalTargetWorkflow =
      CANONICAL_TARGET_ARC_WORKFLOWS.has(entry.name);
    const retiredTemporaryWorkflow =
      RETIRED_TEMP_TARGET_WORKFLOWS.has(entry.name);
    if (retiredTemporaryWorkflow) {
      reasons.push(
        `${entry.name}: retired Stage B bootstrap workflow must be removed after cutover`
      );
    }
    if (triggers.includes('pull_request')) {
      for (const [jobName, job] of Object.entries(jobs)) {
        if (!usesApprovedHostedRunner(job)) {
          reasons.push(
            `${entry.name}: pull_request job ${jobName} must use GitHub-hosted ubuntu-latest directly`
          );
        }
      }
    }
    if (
      triggers.includes('pull_request') &&
      arcJobs
    ) {
      reasons.push(`${entry.name}: pull_request may not schedule an ARC job`);
    }
    if (triggers.includes('pull_request') && dynamicRunnerJobs) {
      reasons.push(
        `${entry.name}: pull_request dynamic runs-on selection cannot prove a hosted runner; use the trust ceiling`
      );
    }
    if (canonicalTargetWorkflow) {
      if (
        triggers.length !== 1 ||
        !triggers.includes('pull_request_target')
      ) {
        reasons.push(
          `${entry.name}: canonical workflow must retain only pull_request_target after cutover`
        );
      }
      if (!arcJobs) {
        reasons.push(
          `${entry.name}: canonical workflow must retain ARC execution after cutover`
        );
      }
      for (const [jobName, job] of Object.entries(jobs)) {
        if (
          jobName !== 'authorize' &&
          jobName !== 'resolve-merge' &&
          !usesArc(job)
        ) {
          reasons.push(
            `${entry.name}: canonical job ${jobName} must use an approved ARC scale set after cutover`
          );
        }
      }
    }
    if (entry.name === MILESTONE_GUARD_WORKFLOW) {
      if (
        triggers.length !== 1 ||
        !triggers.includes('pull_request_target')
      ) {
        reasons.push(
          `${entry.name}: base-only guard must retain only pull_request_target`
        );
      }
      for (const [jobName, job] of Object.entries(jobs)) {
        if (job?.['runs-on'] !== 'ubuntu-latest') {
          reasons.push(
            `${entry.name}: job ${jobName} must remain permanently on the GitHub-hosted ubuntu-latest runner`
          );
        }
      }
    }
    const protectedPrWorkflow =
      triggers.includes('pull_request_target') &&
      entry.name !== MILESTONE_GUARD_WORKFLOW;
    if (protectedPrWorkflow) {
      protectedWorkflowCount += 1;
      if (workflow?.concurrency?.group !== PR_CONCURRENCY_GROUP) {
        reasons.push(
          `${entry.name}: concurrency group must use github.event.pull_request.number`
        );
      }
      const authorize = workflow?.jobs?.authorize;
      if (authorize?.uses !== './.github/workflows/pr-trust.yml') {
        reasons.push(
          `${entry.name}: ARC jobs require an authorize job using ./.github/workflows/pr-trust.yml`
        );
      } else {
        if (
          !authorize.permissions ||
          Object.keys(authorize.permissions).length !== 0
        ) {
          reasons.push(`${entry.name}: authorize permissions must be {}`);
        }
        if (authorize?.with?.['head-repository'] !== HEAD_REPOSITORY_EXPRESSION) {
          reasons.push(
            `${entry.name}: authorize head-repository must use github.event.pull_request.head.repo.full_name`
          );
        }
        if ('secrets' in authorize) {
          reasons.push(`${entry.name}: authorize must not receive secrets`);
        }
      }
      const resolver = workflow?.jobs?.['resolve-merge'];
      if (resolver?.uses !== './.github/workflows/pr-merge-sha.yml') {
        reasons.push(
          `${entry.name}: protected jobs require a resolve-merge job using ./.github/workflows/pr-merge-sha.yml`
        );
      } else {
        if (
          dependencyNames(resolver).length !== 1 ||
          dependencyNames(resolver)[0] !== 'authorize' ||
          resolver.if !== TRUSTED_EXPRESSION
        ) {
          reasons.push(
            `${entry.name}: resolve-merge must run only after trusted same-repository authorization`
          );
        }
        if (!hasExactReadPermissions(resolver.permissions)) {
          reasons.push(
            `${entry.name}: resolve-merge permissions must be only contents: read and pull-requests: read`
          );
        }
        if (
          !hasOnlyKeys(resolver.with, [
            'pr-number',
            'expected-head-sha',
            'expected-base-sha',
            'expected-base-ref',
          ]) ||
          Object.keys(resolver.with ?? {}).length !== 4 ||
          resolver?.with?.['pr-number'] !== PR_NUMBER_EXPRESSION ||
          resolver?.with?.['expected-head-sha'] !== HEAD_SHA_EXPRESSION ||
          resolver?.with?.['expected-base-sha'] !== BASE_SHA_EXPRESSION ||
          resolver?.with?.['expected-base-ref'] !== BASE_REF_EXPRESSION
        ) {
          reasons.push(
            `${entry.name}: resolve-merge must receive only the event PR number, head SHA, base SHA, and base ref`
          );
        }
        if ('secrets' in resolver) {
          reasons.push(`${entry.name}: resolve-merge must not receive secrets`);
        }
      }
      for (const [jobName, job] of Object.entries(jobs)) {
        if (jobName === 'authorize' || jobName === 'resolve-merge') continue;
        const jobKind = usesArc(job) ? 'ARC job' : 'job';
        const directDependencies = dependencyNames(job);
        if (!reachesJob(jobs, jobName, 'authorize')) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must depend transitively on authorize`
          );
        }
        if (!directDependencies.includes('resolve-merge')) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must depend directly on resolve-merge`
          );
        }
        if (!hasVerifiedMergeGuard(job.if)) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must use the verified merge output guard without an OR bypass`
          );
        }
        if (
          /\b(?:always|cancelled|failure|success)\s*\(/iu.test(job?.if ?? '')
        ) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must not use a status function that can override skipped authorization or merge resolution`
          );
        }
        for (const step of job?.steps ?? []) {
          if (
            typeof step?.uses === 'string' &&
            step.uses.toLowerCase().startsWith('actions/checkout@') &&
            step?.with?.ref !== MERGE_SHA_EXPRESSION
          ) {
            reasons.push(
              `${entry.name}: ${jobKind} ${jobName} checkout ref must use needs.resolve-merge.outputs.merge-sha`
            );
          }
        }
      }
      if (entry.name === 'test.yml') {
        const proof = jobs['gate-2702-sandbox-proof'];
        const proofPermissions = proof?.permissions;
        if (
          proof?.['runs-on'] !== 'arc-dind' ||
          !proofPermissions ||
          Object.keys(proofPermissions).join(',') !== 'contents' ||
          proofPermissions.contents !== 'read'
        ) {
          reasons.push(
            'test.yml: sandbox proof must use arc-dind with only contents: read permission'
          );
        }
        const proofSteps = proof?.steps ?? [];
        const commandStep = proofSteps.find((step) =>
          String(step?.run ?? '').includes('scripts/gate-2702/run.test.mjs')
        );
        if (
          commandStep?.env?.CHD_REQUIRE_GATE_2702_SANDBOX_PROBE !== '1'
        ) {
          reasons.push(
            'test.yml: sandbox proof must set CHD_REQUIRE_GATE_2702_SANDBOX_PROBE=1'
          );
        }
        if (commandStep?.run?.trim() !== SANDBOX_PROOF_COMMAND) {
          reasons.push(
            'test.yml: sandbox proof must use the exact hostile-canary --test-name-pattern command'
          );
        }
        if (
          proof?.['continue-on-error'] !== undefined ||
          proofSteps.some((step) => step?.['continue-on-error'] !== undefined)
        ) {
          reasons.push(
            'test.yml: sandbox proof must not use continue-on-error'
          );
        }
        const proofCheckout = proofSteps.find((step) =>
          String(step?.uses ?? '').startsWith('actions/checkout@')
        );
        if (proofCheckout?.with?.ref !== MERGE_SHA_EXPRESSION) {
          reasons.push(
            'test.yml: sandbox proof checkout must use needs.resolve-merge.outputs.merge-sha'
          );
        }
      }
    }

    if (entry.name === MERGE_RESOLVER_WORKFLOW) {
      const mergeResolver = workflow;
      if (
        !hasOnlyKeys(mergeResolver, ['name', 'on', 'permissions', 'jobs'])
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: workflow may contain only canonical keys (name, on, permissions, jobs)`
        );
      }
      const workflowCall = mergeResolver?.on?.workflow_call;
      const inputs = workflowCall?.inputs ?? {};
      const outputs = workflowCall?.outputs ?? {};
      const expectedInputs = [
        ['pr-number', 'number'],
        ['expected-head-sha', 'string'],
        ['expected-base-sha', 'string'],
        ['expected-base-ref', 'string'],
      ];
      const inputsValid =
        Object.keys(inputs).join(',') ===
          expectedInputs.map(([name]) => name).join(',') &&
        expectedInputs.every(
          ([name, type]) =>
            hasOnlyKeys(inputs[name], ['description', 'required', 'type']) &&
            inputs[name]?.required === true &&
            inputs[name]?.type === type
        );
      if (
        !workflowCall ||
        Object.keys(mergeResolver.on).length !== 1 ||
        !hasOnlyKeys(workflowCall, ['inputs', 'outputs']) ||
        !inputsValid ||
        Object.keys(outputs).join(',') !== 'merge-sha' ||
        !hasOnlyKeys(outputs['merge-sha'], ['description', 'value']) ||
        outputs['merge-sha']?.value !== RESOLVER_WORKFLOW_OUTPUT
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: workflow_call must expose only required PR number/head/base inputs and one merge-sha output`
        );
      }
      if (
        !mergeResolver.permissions ||
        Object.keys(mergeResolver.permissions).length !== 0
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: workflow permissions must be {}`
        );
      }
      const resolverJobs = Object.keys(mergeResolver?.jobs ?? {});
      const resolverJob = mergeResolver?.jobs?.resolve;
      if (resolverJobs.length !== 1 || resolverJobs[0] !== 'resolve') {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolver must contain exactly one resolve job`
        );
      }
      if (resolverJob?.['runs-on'] !== 'ubuntu-latest') {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolve must use the GitHub-hosted ubuntu-latest runner`
        );
      }
      if (resolverJob?.['timeout-minutes'] !== 2) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolve timeout-minutes must remain 2`
        );
      }
      if (!hasExactReadPermissions(resolverJob?.permissions)) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolve permissions must be only contents: read and pull-requests: read`
        );
      }
      if (
        !hasOnlyKeys(resolverJob, [
          'runs-on',
          'timeout-minutes',
          'permissions',
          'outputs',
          'steps',
        ]) ||
        resolverJob?.outputs?.['merge-sha'] !== RESOLVER_JOB_OUTPUT ||
        Object.keys(resolverJob?.outputs ?? {}).length !== 1
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolve job keys and merge-sha output must remain canonical`
        );
      }
      const resolverSteps = resolverJob?.steps ?? [];
      const checkoutStep = resolverSteps[0];
      if (
        resolverSteps.length !== 2 ||
        !hasOnlyKeys(checkoutStep, ['name', 'uses', 'with']) ||
        checkoutStep?.uses !== CHECKOUT_ACTION ||
        !hasOnlyKeys(checkoutStep?.with, ['ref', 'persist-credentials']) ||
        Object.keys(checkoutStep?.with ?? {}).length !== 2 ||
        checkoutStep?.with?.ref !== RESOLVER_BASE_CHECKOUT ||
        checkoutStep?.with?.['persist-credentials'] !== false
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolver checkout must pin the exact event base SHA without persisted credentials`
        );
      }
      const resolveStep = resolverSteps[1];
      const resolverEnv = resolveStep?.env ?? {};
      if (
        !hasOnlyKeys(resolveStep, ['name', 'id', 'env', 'run']) ||
        resolveStep?.id !== 'resolve' ||
        resolveStep?.run?.trim() !== RESOLVER_COMMAND ||
        !hasOnlyKeys(resolverEnv, [
          'GITHUB_TOKEN',
          'PR_NUMBER',
          'EXPECTED_HEAD_SHA',
          'EXPECTED_BASE_REF',
        ]) ||
        Object.keys(resolverEnv).length !== 4 ||
        resolverEnv.GITHUB_TOKEN !== RESOLVER_TOKEN_EXPRESSION ||
        resolverEnv.PR_NUMBER !== RESOLVER_PR_INPUT ||
        resolverEnv.EXPECTED_HEAD_SHA !== RESOLVER_HEAD_INPUT ||
        resolverEnv.EXPECTED_BASE_REF !== RESOLVER_BASE_REF_INPUT
      ) {
        reasons.push(
          `${MERGE_RESOLVER_WORKFLOW}: resolve step must run only the canonical merge resolver with bound inputs`
        );
      }
    }
  }

  const repositoryFixture = existsSync(join(root, 'package.json'));
  if (protectedWorkflowCount > 0 || repositoryFixture) {
    const broker = workflows.get('pr-trust.yml');
    if (!broker) {
      reasons.push('pr-trust.yml: canonical trust broker is missing');
    } else {
      // perf-index-contract: pr-workflow-broker-keys always-consumed: every broker audit immediately checks every declared workflow key against this policy set
      const brokerWorkflowAllowedKeys = new Set([
        'name',
        'on',
        'permissions',
        'jobs',
      ]);
      if (
        Object.keys(broker).some((key) => !brokerWorkflowAllowedKeys.has(key))
      ) {
        reasons.push(
          'pr-trust.yml: workflow may contain only canonical keys (name, on, permissions, jobs)'
        );
      }
      const workflowCall = broker?.on?.workflow_call;
      const brokerInput = workflowCall?.inputs?.['head-repository'];
      // perf-index-contract: pr-workflow-broker-input-keys always-consumed: every broker audit immediately checks every input key against this policy set
      const brokerInputAllowedKeys = new Set([
        'description',
        'required',
        'type',
      ]);
      const brokerOutput = workflowCall?.outputs?.trusted;
      // perf-index-contract: pr-workflow-broker-output-keys always-consumed: every broker audit immediately checks every output key against this policy set
      const brokerOutputAllowedKeys = new Set(['description', 'value']);
      if (
        !workflowCall ||
        Object.keys(broker.on).length !== 1 ||
        Object.keys(workflowCall).some(
          (key) => key !== 'inputs' && key !== 'outputs'
        ) ||
        Object.keys(workflowCall.inputs ?? {}).join(',') !== 'head-repository' ||
        Object.keys(brokerInput ?? {}).some(
          (key) => !brokerInputAllowedKeys.has(key)
        ) ||
        brokerInput?.required !== true ||
        brokerInput?.type !== 'string' ||
        Object.keys(workflowCall.outputs ?? {}).join(',') !== 'trusted' ||
        Object.keys(brokerOutput ?? {}).some(
          (key) => !brokerOutputAllowedKeys.has(key)
        ) ||
        brokerOutput?.value !== BROKER_WORKFLOW_OUTPUT
      ) {
        reasons.push(
          'pr-trust.yml: workflow_call must expose only required string head-repository and trusted output'
        );
      }
      if (!broker.permissions || Object.keys(broker.permissions).length !== 0) {
        reasons.push('pr-trust.yml: workflow permissions must be {}');
      }
      const brokerJobs = Object.keys(broker?.jobs ?? {});
      if (brokerJobs.length !== 1 || brokerJobs[0] !== 'authorize') {
        reasons.push(
          'pr-trust.yml: broker must contain exactly one authorize job'
        );
      }
      const brokerJob = broker?.jobs?.authorize;
      if (brokerJob?.['runs-on'] !== 'ubuntu-latest') {
        reasons.push(
          'pr-trust.yml: authorize must use the GitHub-hosted ubuntu-latest runner'
        );
      }
      const brokerJobKeys = Object.keys(brokerJob ?? {});
      // perf-index-contract: pr-workflow-broker-job-keys always-consumed: every broker audit immediately checks every authorize-job key against this policy set
      const brokerJobAllowedKeys = new Set([
        'runs-on',
        'permissions',
        'outputs',
        'steps',
      ]);
      if (brokerJobKeys.some((key) => !brokerJobAllowedKeys.has(key))) {
        reasons.push(
          'pr-trust.yml: authorize may contain only canonical keys (runs-on, permissions, outputs, steps)'
        );
      }
      if (
        !brokerJob?.permissions ||
        Object.keys(brokerJob.permissions).length !== 0
      ) {
        reasons.push('pr-trust.yml: authorize permissions must be {}');
      }
      const brokerSteps = brokerJob?.steps ?? [];
      // perf-index-contract: pr-workflow-broker-step-keys always-consumed: every broker audit immediately checks every classification-step key against this policy set
      const brokerStepAllowedKeys = new Set(['name', 'id', 'env', 'run']);
      if (
        brokerJob?.outputs?.trusted !== BROKER_JOB_OUTPUT ||
        brokerSteps.length !== 1 ||
        brokerSteps[0]?.id !== 'same-repo' ||
        brokerSteps[0]?.env?.TRUSTED !== BROKER_TRUST_EXPRESSION ||
        brokerSteps[0]?.run?.trim() !== BROKER_COMMAND ||
        Object.keys(brokerSteps[0] ?? {}).some(
          (key) => !brokerStepAllowedKeys.has(key)
        )
      ) {
        reasons.push(
          'pr-trust.yml: authorize must compare head-repository only with github.repository and publish that trusted result'
        );
      }
    }
  }
  if (repositoryFixture) {
    for (const workflowName of CANONICAL_TARGET_ARC_WORKFLOWS) {
      if (!workflows.has(workflowName)) {
        reasons.push(`missing canonical target workflow ${workflowName}`);
      }
    }
    if (!workflows.has(MILESTONE_GUARD_WORKFLOW)) {
      reasons.push(`missing base-only workflow ${MILESTONE_GUARD_WORKFLOW}`);
    }
    if (!workflows.has(MERGE_RESOLVER_WORKFLOW)) {
      reasons.push(`missing hosted merge resolver ${MERGE_RESOLVER_WORKFLOW}`);
    }
  }

  return reasons;
}

function main() {
  const reasons = prWorkflowTrustReasons(REPO_ROOT);
  if (reasons.length > 0) {
    console.error('PR workflow trust check FAILED (#3313):\n');
    for (const reason of reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }
  console.log(
    `PR workflow trust check passed: ${CANONICAL_TARGET_ARC_WORKFLOWS.size} canonical target workflows are base-controlled, ARC-backed, and fork-gated.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
