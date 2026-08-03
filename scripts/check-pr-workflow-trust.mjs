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
const CANONICAL_HOSTED_PR_WORKFLOWS = new Set([
  'agent-cross-review.yml',
  'browser-compat.yml',
  'ci.yml',
  'cold-load.yml',
  'pr-nonempty.yml',
  'server-scale.yml',
  'test.yml',
]);
// perf-index-contract: pr-workflow-temp-membership always-consumed: every repository audit queries and inventories the complete temporary workflow membership
const TEMP_TARGET_ARC_WORKFLOWS = new Set([
  'stage-b-target-agent-cross-review.yml',
  'stage-b-target-browser-compat.yml',
  'stage-b-target-ci.yml',
  'stage-b-target-cold-load.yml',
  'stage-b-target-pr-nonempty.yml',
  'stage-b-target-server-scale.yml',
  'stage-b-target-test.yml',
]);
const MILESTONE_GUARD_WORKFLOW = 'milestone-guard.yml';
const TEMP_CHECK_NAME_PREFIX = 'TEMP ARC ';
const HEAD_REPOSITORY_EXPRESSION =
  '${{ github.event.pull_request.head.repo.full_name }}';
const TRUSTED_EXPRESSION =
  "needs.authorize.outputs.trusted == 'true' && github.event.pull_request.merge_commit_sha != null";
const PR_CONCURRENCY_GROUP =
  '${{ github.workflow }}-${{ github.event.pull_request.number }}';
const MERGE_SHA_EXPRESSION =
  '${{ github.event.pull_request.merge_commit_sha }}';
const BROKER_WORKFLOW_OUTPUT = '${{ jobs.authorize.outputs.trusted }}';
const BROKER_JOB_OUTPUT = '${{ steps.same-repo.outputs.trusted }}';
const BROKER_TRUST_EXPRESSION =
  '${{ inputs.head-repository == github.repository }}';
const BROKER_COMMAND = 'echo "trusted=$TRUSTED" >> "$GITHUB_OUTPUT"';
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
    const canonicalHostedWorkflow =
      CANONICAL_HOSTED_PR_WORKFLOWS.has(entry.name);
    const temporaryTargetWorkflow = TEMP_TARGET_ARC_WORKFLOWS.has(entry.name);
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
    if (canonicalHostedWorkflow) {
      if (
        triggers.length !== 1 ||
        !triggers.includes('pull_request')
      ) {
        reasons.push(
          `${entry.name}: canonical hosted workflow must retain only pull_request during Stage B`
        );
      }
      for (const [jobName, job] of Object.entries(jobs)) {
        if (job?.['runs-on'] !== 'ubuntu-latest') {
          reasons.push(
            `${entry.name}: canonical job ${jobName} must remain on the GitHub-hosted ubuntu-latest runner during Stage B`
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
      temporaryTargetWorkflow ||
      (triggers.includes('pull_request_target') &&
        entry.name !== MILESTONE_GUARD_WORKFLOW);
    if (protectedPrWorkflow) {
      protectedWorkflowCount += 1;
      if (!triggers.includes('pull_request_target')) {
        reasons.push(
          `${entry.name}: protected workflow must use pull_request_target`
        );
      }
      if (
        temporaryTargetWorkflow &&
        (triggers.length !== 1 ||
          !triggers.includes('pull_request_target'))
      ) {
        reasons.push(
          `${entry.name}: temporary target workflow must use only pull_request_target`
        );
      }
      if (temporaryTargetWorkflow && !arcJobs) {
        reasons.push(
          `${entry.name}: temporary target workflow must retain an ARC job`
        );
      }
      if (
        temporaryTargetWorkflow &&
        !String(workflow?.name ?? '').startsWith(TEMP_CHECK_NAME_PREFIX)
      ) {
        reasons.push(
          `${entry.name}: temporary workflow name must start with ${TEMP_CHECK_NAME_PREFIX.trim()}`
        );
      }
      if (temporaryTargetWorkflow) {
        for (const [jobName, job] of Object.entries(jobs)) {
          if (!String(job?.name ?? '').startsWith(TEMP_CHECK_NAME_PREFIX)) {
            reasons.push(
              `${entry.name}: job ${jobName} name must start with ${TEMP_CHECK_NAME_PREFIX.trim()}`
            );
          }
        }
      }
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
      for (const [jobName, job] of Object.entries(jobs)) {
        if (jobName === 'authorize') continue;
        const jobKind = usesArc(job) ? 'ARC job' : 'job';
        const directDependencies = dependencyNames(job);
        if (!reachesJob(jobs, jobName, 'authorize')) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must depend transitively on authorize`
          );
        } else if (
          directDependencies.includes('authorize') &&
          job.if !== TRUSTED_EXPRESSION
        ) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} directly after authorize must require trusted ownership and a non-null merge_commit_sha`
          );
        }
        if (
          !directDependencies.includes('authorize') &&
          /\b(?:always|cancelled|failure|success)\s*\(/iu.test(job?.if ?? '')
        ) {
          reasons.push(
            `${entry.name}: ${jobKind} ${jobName} must not use a status function that can override skipped authorization`
          );
        }
        for (const step of job?.steps ?? []) {
          if (
            typeof step?.uses === 'string' &&
            step.uses.toLowerCase().startsWith('actions/checkout@') &&
            step?.with?.ref !== MERGE_SHA_EXPRESSION
          ) {
            reasons.push(
              `${entry.name}: ${jobKind} ${jobName} checkout ref must use github.event.pull_request.merge_commit_sha`
            );
          }
        }
      }
      if (entry.name === 'stage-b-target-test.yml') {
        const proof = jobs['gate-2702-sandbox-proof'];
        const proofPermissions = proof?.permissions;
        if (
          proof?.['runs-on'] !== 'arc-dind' ||
          !proofPermissions ||
          Object.keys(proofPermissions).join(',') !== 'contents' ||
          proofPermissions.contents !== 'read'
        ) {
          reasons.push(
            'stage-b-target-test.yml: sandbox proof must use arc-dind with only contents: read permission'
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
            'stage-b-target-test.yml: sandbox proof must set CHD_REQUIRE_GATE_2702_SANDBOX_PROBE=1'
          );
        }
        if (commandStep?.run?.trim() !== SANDBOX_PROOF_COMMAND) {
          reasons.push(
            'stage-b-target-test.yml: sandbox proof must use the exact hostile-canary --test-name-pattern command'
          );
        }
        if (
          proof?.['continue-on-error'] !== undefined ||
          proofSteps.some((step) => step?.['continue-on-error'] !== undefined)
        ) {
          reasons.push(
            'stage-b-target-test.yml: sandbox proof must not use continue-on-error'
          );
        }
        const proofCheckout = proofSteps.find((step) =>
          String(step?.uses ?? '').startsWith('actions/checkout@')
        );
        if (proofCheckout?.with?.ref !== MERGE_SHA_EXPRESSION) {
          reasons.push(
            'stage-b-target-test.yml: sandbox proof checkout must use github.event.pull_request.merge_commit_sha'
          );
        }
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
    for (const workflowName of CANONICAL_HOSTED_PR_WORKFLOWS) {
      if (!workflows.has(workflowName)) {
        reasons.push(`missing canonical hosted workflow ${workflowName}`);
      }
    }
    for (const workflowName of TEMP_TARGET_ARC_WORKFLOWS) {
      if (!workflows.has(workflowName)) {
        reasons.push(`missing temporary target workflow ${workflowName}`);
      }
    }
    if (!workflows.has(MILESTONE_GUARD_WORKFLOW)) {
      reasons.push(`missing base-only workflow ${MILESTONE_GUARD_WORKFLOW}`);
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
    `PR workflow trust check passed: ${CANONICAL_HOSTED_PR_WORKFLOWS.size} hosted workflows remain active and ${TEMP_TARGET_ARC_WORKFLOWS.size} temporary target workflows are base-controlled and fork-gated.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
