import { describe, expect, it } from 'vitest';
import type { LiveConfig } from '../../../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import { deriveBashCommandSignals } from '../../parse-tools';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import { classifyGhostSession, detector } from './ghost-session';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const ts = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function call(toolName: string, id: string, options: Partial<ToolCall> = {}): ToolCall {
  return {
    timestamp: ts(60), toolName, toolUseId: id, isError: false, resultBytes: 1,
    input: toolName === 'Read' ? { file_path: `/repo/${id}.ts` } : {},
    ...options,
  };
}

function tools(sessionId = 'abcdefgh-session', calls?: ToolCall[]): ToolUsageData {
  return {
    sessionId,
    calls: calls ?? Array.from({ length: 5 }, (_, index) => call('Read', `file-${index}`)),
  };
}

function timeline(
  sessionId = 'abcdefgh-session',
  prompt = 'Please implement the cache fix',
  entries?: TimelineEntry[]
): SessionTimeline {
  return {
    sessionId,
    startTime: ts(70),
    endTime: ts(50),
    firstPromptPreview: prompt,
    entries: entries ?? [
      { timestamp: ts(70), kind: 'user', summary: prompt },
      { timestamp: ts(50), kind: 'assistant', summary: 'I inspected the files.' },
    ],
  };
}

function input(toolData = [tools()], timelines = [timeline()], liveConfig: LiveConfig | null = null): RecommendationInput {
  return {
    tokenData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
    toolData, timelines, liveConfig,
  };
}

describe('reliability.ghost-session (#2506)', () => {
  it('fires at five distinct successful reads with edit intent', () => {
    const rec = detector.rule(input(), NOW);
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence?.[0]).toContain('abcdefgh');
    expect(rec?.evidence?.[0]).toContain('5 distinct');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.claimClass).toBe('accounting');
    expect(rec?.proofTier).toBe('auditable');
    expect(rec?.fix?.fixKind).toBe('validated');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
    const shellEvidenceField = rec?.provenance?.observations.find(
      (observation) => observation.claim.includes('no Bash calls')
    )?.field;
    expect(shellEvidenceField).toContain('input.command');
    expect(shellEvidenceField).toContain('commandPreview');
    expect(shellEvidenceField).toContain('commandFingerprint');
    expect(rec?.detail).toContain('delegated or unknown tool attempt');
    expect(rec?.evidence?.[0]).toContain('0 delegated/unknown tool attempts');
    expect(rec?.provenance?.inference).toContain(
      'every Bash and unknown tool attempt is excluded as ambiguous'
    );
    const timingEvidence = rec?.provenance?.observations.find(
      (observation) => observation.claim.includes('30 minutes')
    );
    expect(timingEvidence?.source).toContain('parse-tools');
    expect(timingEvidence?.source).toContain('parse-timeline');
    expect(timingEvidence?.field).toContain('calls[].timestamp');
    expect(timingEvidence?.field).toContain('startTime');
    expect(timingEvidence?.field).toContain('endTime');
    expect(timingEvidence?.field).toContain('entries[].timestamp');
    const turnEvidence = rec?.provenance?.observations.find(
      (observation) => observation.claim.includes('one distinct user turn')
    );
    expect(turnEvidence?.field).toContain('entries[].kind');
    expect(turnEvidence?.field).toContain('entries[].timestamp');
  });

  it('requires distinct successful paths at the threshold', () => {
    expect(detector.rule(input([tools('s', Array.from({ length: 4 }, (_, i) => call('Read', `f${i}`)))], [timeline('s')]), NOW)).toBeNull();
    const duplicate = Array.from({ length: 6 }, (_, i) => call('Read', `r${i}`, { input: { file_path: '/same.ts' } }));
    expect(detector.rule(input([tools('s', duplicate)], [timeline('s')]), NOW)).toBeNull();
    const oneFailed = tools('s').calls.map((entry, index) => index === 4 ? { ...entry, isError: true } : entry);
    expect(detector.rule(input([tools('s', oneFailed)], [timeline('s')]), NOW)).toBeNull();
  });

  it.each(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])('suppresses a successful %s mutation', (toolName) => {
    const session = tools('s', [...tools().calls, call(toolName, 'edit')]);
    expect(detector.rule(input([session], [timeline('s')]), NOW)).toBeNull();
  });

  it('uses a failed native edit as intent but suppresses unresolved/active calls', () => {
    const failedEdit = tools('s', [...tools().calls, call('Edit', 'edit', { isError: true })]);
    expect(detector.rule(input([failedEdit], [timeline('s', 'Please inspect what happened')]), NOW)).not.toBeNull();
    const unresolved = tools('s', [...tools().calls, call('Bash', 'pending', { isError: null })]);
    expect(detector.rule(input([unresolved], [timeline('s')]), NOW)).toBeNull();
    for (const toolName of ['Agent', 'Task', 'Workflow']) {
      for (const isError of [false, true]) {
        const delegated = tools('s', [
          ...tools().calls,
          call(toolName, 'delegate', { isError }),
        ]);
        expect(detector.rule(input([delegated], [timeline('s')]), NOW)).toBeNull();
      }
    }
  });

  it('suppresses every unknown tool attempt because failures may have partial side effects', () => {
    for (const isError of [false, true]) {
      const unknownTool = tools('s', [
        ...tools().calls,
        call('mcp__fs__write_file', 'unknown-write', { isError }),
      ]);
      expect(detector.rule(input([unknownTool], [timeline('s')]), NOW)).toBeNull();
    }

    const failedNativeReadOnly = tools('s', [
      ...tools().calls,
      call('Grep', 'failed-grep', { isError: true }),
    ]);
    expect(detector.rule(input([failedNativeReadOnly], [timeline('s')]), NOW)).not.toBeNull();
  });

  it('suppresses canonical interruption, missing timeline, and detected Bash mutation', () => {
    const interrupted = timeline('s', 'Please fix this', [
      { timestamp: ts(70), kind: 'user', summary: 'Please fix this' },
      { timestamp: ts(55), kind: 'user', interrupted: true },
    ]);
    expect(detector.rule(input([tools('s')], [interrupted]), NOW)).toBeNull();
    expect(detector.rule(input([tools('s')], []), NOW)).toBeNull();
    for (const command of [
      'apply_patch < fix.diff',
      "sed -i 's/old/new/' src/app.ts",
      'printf changed > src/app.ts',
    ]) {
      const bashEdit = tools('s', [
        ...tools().calls,
        call('Bash', 'patch', { input: { command } }),
      ]);
      expect(detector.rule(input([bashEdit], [timeline('s')]), NOW)).toBeNull();
    }
    const readOnlyBash = tools('s', [
      ...tools().calls,
      call('Bash', 'status', { input: { command: 'git status --short' } }),
    ]);
    expect(detector.rule(input([readOnlyBash], [timeline('s')]), NOW)).toBeNull();
    const multilineCommand = 'git status --short\npython scripts/generate.py';
    const multilineSignals = deriveBashCommandSignals(multilineCommand);
    expect(multilineSignals.commandPreview).toBe(
      'git status --short python scripts/generate.py'
    );
    expect(multilineSignals.commandPreview).toHaveLength(multilineCommand.length);
    const strippedMultilineBash = tools('s', [
      ...tools().calls,
      call('Bash', 'stripped-multiline', {
        input: {},
        ...multilineSignals,
      }),
    ]);
    expect(detector.rule(input([strippedMultilineBash], [timeline('s')]), NOW)).toBeNull();
    const multilineBash = tools('s', [
      ...tools().calls,
      call('Bash', 'multiline', { input: { command: 'git status --short\npython scripts/generate.py' } }),
    ]);
    expect(detector.rule(input([multilineBash], [timeline('s')]), NOW)).toBeNull();
    const withLs = tools('s', [
      ...tools().calls,
      call('LS', 'list', { input: { path: '/repo' } }),
    ]);
    expect(detector.rule(input([withLs], [timeline('s')]), NOW)).not.toBeNull();
    const truncatedBash = tools('s', [
      ...tools().calls,
      call('Bash', 'truncated', {
        input: {},
        ...deriveBashCommandSignals(`git status ${'x'.repeat(240)}`),
      }),
    ]);
    expect(detector.rule(input([truncatedBash], [timeline('s')]), NOW)).toBeNull();
    for (const command of [
      'find src -delete',
      'find src -exec rm {} +',
      'git diff --output=report.patch',
    ]) {
      const ambiguousMutation = tools('s', [
        ...tools().calls,
        call('Bash', 'ambiguous', { input: { command } }),
      ]);
      expect(detector.rule(input([ambiguousMutation], [timeline('s')]), NOW)).toBeNull();
    }
  });

  it('treats fingerprint-exact Bash previews as ambiguous because host config can execute helpers', () => {
    for (const command of [
      'git status --short',
      'git diff --no-ext-diff --no-textconv',
      'git log --no-ext-diff --no-textconv -1',
      'git show --no-ext-diff --no-textconv HEAD',
    ]) {
      const strippedReadOnly = tools('s', [
        ...tools().calls,
        call('Bash', 'stripped-read-only', {
          input: {},
          ...deriveBashCommandSignals(command),
        }),
      ]);
      expect(detector.rule(input([strippedReadOnly], [timeline('s')]), NOW)).toBeNull();
    }
  });

  it('rejects quoting, escaping, and commands outside the conservative Bash allowlist', () => {
    for (const command of [
      "git diff --no-ext-diff --no-textconv '--output=report.patch'",
      'git diff --no-ext-diff --no-textconv --output\\=report.patch',
      "rg '--pre=cat' needle src",
      'rg --pre\\=cat needle src',
      "git diff --no-ext-diff --no-textconv '--ext-diff'",
      'git diff --no-ext-diff --no-textconv --ext\\-diff',
      'git show --no-ext-diff --no-textconv "--textconv"',
      'git show --no-ext-diff --no-textconv --text\\conv',
      "git status '--short'",
      'git diff --no-ext-diff --no-textconv HEAD\\^',
      'rg needle src',
      'grep needle src/file.ts',
      'find src -type f',
    ]) {
      for (const bashCall of [
        call('Bash', 'raw-unsafe', { input: { command } }),
        call('Bash', 'stripped-unsafe', {
          input: {},
          ...deriveBashCommandSignals(command),
        }),
      ]) {
        const unsafe = tools('s', [...tools().calls, bashCall]);
        expect(detector.rule(input([unsafe], [timeline('s')]), NOW)).toBeNull();
      }
    }
  });

  it('does not certify Git commands even when command-line helper flags are disabled', () => {
    for (const command of [
      'git diff',
      'git diff --no-ext-diff',
      'git log -1',
      'git log --no-textconv -1',
      'git show HEAD',
      'git show --no-ext-diff HEAD',
    ]) {
      const unsafe = tools('s', [...tools().calls, call('Bash', 'helper-default', {
        input: { command },
      })]);
      expect(detector.rule(input([unsafe], [timeline('s')]), NOW)).toBeNull();
    }

    for (const command of [
      'git diff --no-ext-diff --no-textconv',
      'git log --no-ext-diff --no-textconv -1',
      'git show --no-ext-diff --no-textconv HEAD',
    ]) {
      const safe = tools('s', [...tools().calls, call('Bash', 'safe-option', {
        input: { command },
      })]);
      expect(detector.rule(input([safe], [timeline('s')]), NOW)).toBeNull();
    }
  });

  it('suppresses failed Bash calls unless the full command is provably read-only', () => {
    for (const command of [
      'printf changed > src/app.ts',
      'python scripts/generate.py',
    ]) {
      const failedBash = tools('s', [
        ...tools().calls,
        call('Bash', 'failed', { input: { command }, isError: true }),
      ]);
      expect(detector.rule(input([failedBash], [timeline('s')]), NOW)).toBeNull();
    }

    const failedReadOnly = tools('s', [
      ...tools().calls,
      call('Bash', 'failed-status', { input: { command: 'git status --short' }, isError: true }),
    ]);
    expect(detector.rule(input([failedReadOnly], [timeline('s')]), NOW)).toBeNull();

    const strippedFailedReadOnly = tools('s', [
      ...tools().calls,
      call('Bash', 'stripped-failed-status', {
        input: {},
        isError: true,
        ...deriveBashCommandSignals('git status --short'),
      }),
      call('Grep', 'failed-grep', { isError: true }),
    ]);
    expect(detector.rule(input([strippedFailedReadOnly], [timeline('s')]), NOW)).toBeNull();

    const failedNativeReadOnly = tools('s', [
      ...tools().calls,
      call('Grep', 'failed-grep', { isError: true }),
    ]);
    expect(detector.rule(input([failedNativeReadOnly], [timeline('s')]), NOW)).not.toBeNull();
  });

  it('excludes non-edit intent but keeps explicit diagnose-and-fix intent', () => {
    for (const prompt of [
      'Review these files',
      'Research the parser',
      'Plan only; do not edit',
      'Do not modify files; inspect the parser',
      "Don't update docs; tell me what is stale",
      'Don’t update docs; tell me what is stale',
      'Write a summary after reviewing these files',
      'Write a summary of the code',
      'Can you update me on the code?',
      'Create a plan for the parser',
      'Research how to implement this parser',
      'Review the implementation and explain what to fix',
      'Plan how to fix the parser',
      'Research the bug and propose a fix',
      'Investigate and tell me what to change',
      'Plan the update to the parser',
      'Review the update to the documentation',
      'Research the update to the workflow',
      'Explain the edit',
      'Review this edit',
      'Write a summary of the code in this file',
      'Create a plan for the documentation',
      'Explain what is wrong and how to fix it',
      'Tell me what to change and how to implement it',
      'Plan a fix for the parser',
      'Review the patch to the workflow',
      'Explain the refactor of this module',
      'Do not modify and delete files',
      'Explain how to change and update configuration',
      'Plan how to fix and update documentation',
      'Research ways to patch and update the workflow',
      'Explain the edit and the fix',
      'Review the patch and the update to documentation',
      'Should we delete the old parser?',
      'Can we remove this dependency?',
      'Should we delete the old parser, and update the docs?',
      'Can we remove this dependency, then update documentation?',
      'What should I update in the docs?',
      'Which files should we change?',
      'How could I fix the parser?',
      'Do not, under any circumstances, modify files',
      'Should we, after checking compatibility, delete the old parser?',
      'Investigate why the parser fix failed',
      'Debug why the previous patch broke',
      'Why does this fix fail?',
      'Inspect this patch',
      'Investigate parser fix failure',
      'Debug parser patch regression',
      'Parser fix postmortem',
      'Research why delete failed',
      'Diagnose why parser change failed',
      'Debug parser refactor',
      'Analyze why config rename broke',
      'Explain why module change regressed',
      'Review whether to write a plan to docs/plan.md',
      'Patch review for the parser regression',
      'Patch review of the parser regression',
      'Change failure analysis',
      'Change failure postmortem',
      'Update on the parser status',
      'Update regarding the parser status',
      'Delete failure postmortem',
    ]) {
      expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).toBeNull();
    }
    expect(detector.rule(input([tools('s')], [timeline('s', 'Diagnose and fix the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Review and fix the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Please patch the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Please delete the old parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Fix the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Could you change the config?')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Refactor the module')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Rename the config file')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Inspect the module and update documentation')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Please edit the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Fix the parser and update me on the code')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Implement the cache and write a summary')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Create a summary file for the architecture')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Write a plan to docs/plan.md')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Review the update to the parser and fix the tests')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Do not modify the public API; fix the parser internals')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', "Don't update docs, but fix the tests")]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Do not modify tests; update documentation')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Should we delete the old parser? Could you update the docs?')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Do not hesitate to update documentation')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', "Don't forget to update the docs")]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'No changes to the public API; update the docs')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'No changes to the public API, please update the docs')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'No changes to the public API and update the docs')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Explain what broke and fix the parser')]), NOW)).not.toBeNull();
    expect(detector.rule(input([tools('s')], [timeline('s', 'Review the code and explain the issue and patch the test')]), NOW)).not.toBeNull();
    for (const prompt of ['Edit README', 'Edit Dockerfile', 'Edit Makefile', 'Edit src/Dockerfile']) {
      expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).not.toBeNull();
    }
    for (const prompt of ['Update docs', 'Add tests', 'Update README']) {
      expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).not.toBeNull();
    }
  });

  it.each([
    'Write a poem about the codebase',
    'Please write a haiku about the parser',
    'Create a checklist for PR review',
    'Could you create a PR review checklist?',
    'Create recommendations',
    'Create advice for the parser refactor',
    'Add up the token counts',
    'Add together the input and output token counts',
    'Change my mind',
    'Change my opinion about this patch',
    'Remove ambiguity',
    'Remove uncertainty from the explanation',
    'Update your answer',
    'Update the response with more detail',
    'Write pseudocode',
    'Write sample pseudocode for the parser',
    'Create a table for parser options',
    'Write a page for the architecture review',
    'Create a template for PR review',
    'Write a policy for code review',
    'Review the implementation, explain what to fix, then implement it',
  ])('does not treat a non-workspace output request as edit intent: %s', (prompt) => {
    expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).toBeNull();
  });

  it.each([
    'Fix the parser',
    'Please update the stale docs',
    'Could you refactor the legacy module?',
    'Rename the config file',
    'Add tests',
    'Update README',
    'Edit src/parser.ts',
    'Edit vite.config.ts',
    'Update .github/workflows/ci.yml',
    'Write the migration to db/migrations/001.sql',
    'Create a new component file',
    'Remove the stale test fixture',
    'Change package.json',
    'Rename Dockerfile',
    'Implement the fix',
    'Change the code',
    'Edit the code',
    'Update the implementation',
    'Please make the requested changes',
    'Write code',
    'Update the UI',
    'Research the change in the module, then implement the fix',
    'Research how the cache works and implement the fix',
    'Update the code for the response parser',
    'Write code for the response handler',
    'Implement the fix in the response parser',
    'Update the code for the output parser',
    'Write code for the message handler',
    'Update the code for the analysis pipeline',
    'Update the code for the chat service',
    'Update the code for the conversation parser',
    'Update the code for the explanation module',
  ])('keeps direct workspace artifact intent: %s', (prompt) => {
    expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).not.toBeNull();
  });

  it.each([
    'Create a pros/cons table',
    'Write input/output analysis',
    'Write a before/after comparison',
    'Create a yes/no checklist',
    'Add README.md to your answer',
    'Remove package.json from the review checklist',
    'Write src/parser.ts in your response',
    'Create docs/plan.md in the explanation',
    'Do not plan only, implement the fix in your answer',
    'Implement the fix in your answer',
    'Write code in the response',
    'Update the UI in your explanation',
    'Write code in your response code block',
    'Write code in the answer code block',
    'Implement the fix in your response code example',
    'Update the UI in your explanation code block',
    'Write code in your response code blocks',
    'Write code in the answer code examples',
    'Implement the fix in your response code samples',
    'Update the UI in your explanation code snippets',
    'Write code in your response code fence',
    'Write code in the answer code fences',
    'Implement the fix in your response code listing',
    'Update the UI in your explanation code listings',
  ])('rejects response-shaped output complements without a filesystem edit signal: %s', (prompt) => {
    expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).toBeNull();
  });

  it.each([
    'Do not modify tests, update documentation',
    'You must update the docs',
    'Do not plan only, implement the fix',
    'Do not plan only; implement the fix',
    'Apply this diff',
    'Write a plan in docs/plan.md',
    'Task: update docs',
  ])('keeps explicit affirmative edit intent: %s', (prompt) => {
    expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).not.toBeNull();
  });

  it.each([
    'Write input/output analysis to docs/io.md',
    'Add README.md to the workspace root',
    'Create docs/plan.md in the workspace',
  ])('keeps output-like requests when they contain a genuine filesystem edit signal: %s', (prompt) => {
    expect(detector.rule(input([tools('s')], [timeline('s', prompt)]), NOW)).not.toBeNull();
  });

  it('suppresses sessions with later user turns whose final intent is not preserved', () => {
    const revokedIntent = timeline('s', 'Please implement the parser fix', [
      { timestamp: ts(70), kind: 'user', summary: 'Please implement the parser fix' },
      { timestamp: ts(60), kind: 'assistant', summary: 'I am inspecting it.' },
      { timestamp: ts(55), kind: 'user', summary: 'Stop; do not change anything.' },
      { timestamp: ts(50), kind: 'assistant', summary: 'Understood.' },
    ]);
    expect(detector.rule(input([tools('s')], [revokedIntent]), NOW)).toBeNull();

    const changedIntent = timeline('s', 'Please implement the parser fix', [
      { timestamp: ts(70), kind: 'user', summaryLen: 31 },
      { timestamp: ts(60), kind: 'assistant' },
      { timestamp: ts(55), kind: 'user', summaryLen: 28 },
      { timestamp: ts(50), kind: 'assistant' },
    ]);
    changedIntent.slim = true;

    expect(detector.rule(input([tools('s')], [changedIntent]), NOW)).toBeNull();
  });

  it('counts user turns rather than same-message text blocks', () => {
    const splitFirstTurn = timeline('s', 'Please implement the parser fix', [
      { timestamp: ts(70), kind: 'user', summary: 'Please implement the parser fix' },
      { timestamp: ts(70), kind: 'user', summary: 'Keep the public API stable.' },
      { timestamp: ts(50), kind: 'assistant', summary: 'I inspected the files.' },
    ]);

    expect(detector.rule(input([tools('s')], [splitFirstTurn]), NOW)).not.toBeNull();
  });

  it('does not infer edit intent from a potentially truncated prompt preview', () => {
    const preview = `Please fix the parser. ${'context '.repeat(40)}`.slice(0, 200);
    expect(preview).toHaveLength(200);
    expect(detector.rule(input([tools('s')], [timeline('s', preview)]), NOW)).toBeNull();
  });

  it('describes TodoWrite as non-workspace-mutating without claiming it is read-only', () => {
    const withTodo = tools('s', [...tools().calls, call('TodoWrite', 'todo')]);
    const rec = detector.rule(input([withTodo], [timeline('s')]), NOW);
    expect(rec).not.toBeNull();
    expect(rec?.provenance?.observations[0]?.claim).toContain('workspace-mutating tool');
    expect(rec?.provenance?.observations[0]?.claim).toContain('unknown tool attempt');
    expect(rec?.provenance?.observations[0]?.claim).not.toContain('other potentially mutating tool');
  });

  it('waits for the whole session to be quiet, including after an assistant entry', () => {
    const recentReads = tools('s', tools().calls.map((entry) => ({ ...entry, timestamp: ts(10) })));
    const unfinished = timeline('s', 'Please implement the parser', [
      { timestamp: ts(15), kind: 'user', summary: 'Please implement the parser' },
    ]);
    expect(classifyGhostSession(recentReads, unfinished, NOW)).toBeNull();
    const recentAssistant = timeline('s', 'Please implement the parser', [
      { timestamp: ts(15), kind: 'user', summary: 'Please implement the parser' },
      { timestamp: ts(5), kind: 'assistant', summary: "I'll edit next." },
    ]);
    expect(classifyGhostSession(recentReads, recentAssistant, NOW)).toBeNull();
    const oldReads = tools('s', tools().calls.map((entry) => ({ ...entry, timestamp: ts(60) })));
    const quiet = timeline('s', 'Please implement the parser', [
      { timestamp: ts(70), kind: 'user', summary: 'Please implement the parser' },
    ]);
    expect(classifyGhostSession(oldReads, quiet, NOW)).not.toBeNull();
  });

  it('suppresses mixed-validity tool and timeline timestamps as ambiguous', () => {
    const invalidReadTimestamp = tools('s', tools().calls.map((entry, index) => (
      index === 0 ? { ...entry, timestamp: '' } : entry
    )));
    expect(detector.rule(input([invalidReadTimestamp], [timeline('s')]), NOW)).toBeNull();

    const invalidNonReadTimestamp = tools('s', [
      ...tools().calls,
      call('Grep', 'undated-grep', { timestamp: 'unknown' }),
    ]);
    expect(detector.rule(input([invalidNonReadTimestamp], [timeline('s')]), NOW)).toBeNull();

    const invalidTimelineTimestamp = timeline('s', 'Please implement the cache fix', [
      { timestamp: ts(70), kind: 'user', summary: 'Please implement the cache fix' },
      { timestamp: 'unknown', kind: 'assistant', summary: 'I inspected the files.' },
    ]);
    expect(detector.rule(input([tools('s')], [invalidTimelineTimestamp]), NOW)).toBeNull();

    const invalidTimelineBounds = { ...timeline('s'), endTime: '' };
    expect(detector.rule(input([tools('s')], [invalidTimelineBounds]), NOW)).toBeNull();

    const overflowDate = tools('s', tools().calls.map((entry, index) => (
      index === 0 ? { ...entry, timestamp: '2026-02-31T00:00:00Z' } : entry
    )));
    expect(detector.rule(input([overflowDate], [timeline('s')]), NOW)).toBeNull();

    const invalidLeapDay = {
      ...timeline('s'),
      startTime: '2026-02-29',
      entries: [
        { timestamp: '2026-02-29', kind: 'user' as const },
        { timestamp: ts(50), kind: 'assistant' as const },
      ],
    };
    expect(detector.rule(input([tools('s')], [invalidLeapDay]), NOW)).toBeNull();

    expect(detector.rule(input([tools('s')], [timeline('s')]), NOW)).not.toBeNull();
  });

  it('accepts old date-only and RFC3339-offset timestamps', () => {
    const datedCalls = tools('s', tools().calls.map((entry) => ({
      ...entry,
      timestamp: '2026-07-10T05:00:00-04:00',
    })));
    const datedTimeline = timeline('s', 'Implement the fix', [
      { timestamp: '2026-07-09', kind: 'user' },
      { timestamp: '2026-07-10T05:30:00-04:00', kind: 'assistant' },
    ]);
    datedTimeline.startTime = '2026-07-09';
    datedTimeline.endTime = '2026-07-10T05:30:00-04:00';

    expect(detector.rule(input([datedCalls], [datedTimeline]), NOW)).not.toBeNull();
  });

  it('treats current-day date-only timestamps as ambiguous until that day ends', () => {
    const now = Date.parse('2026-07-10T00:31:00Z');
    const datedCalls = tools('s', tools().calls.map((entry) => ({
      ...entry,
      timestamp: '2026-07-10',
    })));
    const datedTimeline = timeline('s', 'Implement the fix', [
      { timestamp: '2026-07-10', kind: 'user' },
      { timestamp: '2026-07-10', kind: 'assistant' },
    ]);
    datedTimeline.startTime = '2026-07-10';
    datedTimeline.endTime = '2026-07-10';

    expect(classifyGhostSession(datedCalls, datedTimeline, now)).toBeNull();
  });

  it('normalizes lexical path aliases before counting distinct reads', () => {
    const aliases = [
      call('Read', 'a', { input: { file_path: '/repo/a.ts' } }),
      call('Read', 'a-dot', { input: { file_path: '/repo/./a.ts' } }),
      call('Read', 'a-parent', { input: { file_path: '/repo/src/../a.ts' } }),
      call('Read', 'b', { input: { file_path: '/repo/b.ts' } }),
      call('Read', 'c', { input: { file_path: '/repo/c.ts' } }),
      call('Read', 'd', { input: { file_path: '/repo/d.ts' } }),
    ];
    expect(detector.rule(input([tools('s', aliases)], [timeline('s')]), NOW)).toBeNull();
  });

  it('demotes and dates stale evidence while suppressing undated ambiguity', () => {
    const old = tools('s', tools().calls.map((entry) => ({ ...entry, timestamp: '2026-01-01T00:00:00Z' })));
    const oldTimeline = timeline('s', 'Please implement the parser', [
      { timestamp: '2026-01-01T00:00:00Z', kind: 'user' },
      { timestamp: '2026-01-01T00:01:00Z', kind: 'assistant' },
    ]);
    const stale = detector.rule(input([old], [oldTimeline]), NOW)!;
    expect(stale.title).toContain('as of 2026-01-01');
    expect(stale.provenance?.stale).toBe(true);

    const invalid = tools('u', tools().calls.map((entry) => ({ ...entry, timestamp: 'unknown' })));
    const invalidTimeline = timeline('u', 'Please implement the parser', [
      { timestamp: 'unknown', kind: 'user' },
      { timestamp: 'unknown', kind: 'assistant' },
    ]);
    expect(detector.rule(input([invalid], [invalidTimeline]), NOW)).toBeNull();
  });

  it('describes mixed-age evidence historically instead of calling the whole set recent', () => {
    const fresh = tools('fresh');
    const old = tools('old', tools().calls.map((entry) => ({
      ...entry,
      timestamp: '2026-01-01T00:00:00Z',
    })));
    const rec = detector.rule(input(
      [fresh, old],
      [
        timeline('fresh'),
        timeline('old', 'Please implement the parser', [
          { timestamp: '2026-01-01T00:00:00Z', kind: 'user' },
          { timestamp: '2026-01-01T00:01:00Z', kind: 'assistant' },
        ]),
      ]
    ), NOW)!;
    expect(rec.affected).toBe(2);
    expect(rec.detail).toContain('Transcript history through 2026-07-10 contained 2');
    expect(rec.detail).not.toContain('Recent transcript history');
  });

  it('suppresses only when all applied markers are present', () => {
    const liveConfig = (global: string): LiveConfig => ({
      settings: {}, settingsHealth: null,
      claudeMd: { global, perProject: {} }, projectSettings: {}, plugins: [], mcpServers: [],
      skills: [], subagents: [], commands: [],
    });
    expect(detector.rule(input(undefined, undefined, liveConfig('## Edit-session completion\nDo not stop after discovery.')), NOW)).not.toBeNull();
    expect(detector.rule(input(undefined, undefined, liveConfig('## Edit-session completion\nDo not stop after discovery; state the concrete blocker explicitly.')), NOW)).toBeNull();
    expect(detector.rule(input(), NOW)?.fix?.snippet).toContain('workspace changes');
  });
});
