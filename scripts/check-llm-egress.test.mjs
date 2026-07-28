// Unit tests for the LLM egress governance gate (#932).
//
// Run:
//   node scripts/check-llm-egress.test.mjs

import assert from 'node:assert/strict';

import {
  collectLlmWrapperCalls,
  isRuntimeSource,
  parsePublicExposureDeployment,
  validateLlmPrePublicExposure,
  validateLlmWrapperCallSites,
} from './check-llm-egress.mjs';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}: ${err.message}`);
  }
}

const entries = [
  {
    id: 'server.fake',
    surface: 'server',
    callSite: { file: 'scripts/server.mjs', symbol: 'handleFake' },
    egressScrub: 'stub',
  },
  {
    id: 'server.probe',
    surface: 'server',
    callSite: { file: 'scripts/server.mjs', symbol: 'handleProbe' },
    egressScrub: 'none',
  },
  {
    id: 'browser.fake',
    surface: 'browser',
    callSite: { file: 'src/lib/claude-api.ts', symbol: 'callFake' },
    egressScrub: 'none',
  },
];

const caps = {
  callBudget: ['one call per request'],
  inputBounds: ['bounded input rows'],
  spendControls: ['operator spend limit'],
};

const APPROVED_EGRESS_IMPORT =
  "const { egressScrub } = await import('../src/lib/anthropic-egress.ts');";

function publicEntry(overrides = {}) {
  return {
    id: 'server.public',
    egressScrub: 'local-model',
    caps,
    exposure: {
      whoPays: 'operator',
      authRequired: true,
      tenancyBoundary: 'single',
      publiclyReachable: true,
    },
    ...overrides,
  };
}

check('runtime-source classifier includes src and scripts, excludes tests', () => {
  assert.equal(isRuntimeSource('src/components/AskClaude.tsx'), true);
  assert.equal(isRuntimeSource('src/lib/anthropic-egress.test.ts'), false);
  assert.equal(isRuntimeSource('scripts/server.mjs'), true);
  assert.equal(isRuntimeSource('scripts/check-llm-egress.test.mjs'), false);
  assert.equal(isRuntimeSource('docs/enterprise-readiness.md'), false);
});

check('collector finds literal wrapper ids and line numbers', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      "callAnthropic('server.probe', {});",
      '',
      "egressScrub('server.fake', {}, options);",
      "callAnthropicMessages('server.fake', {});",
    ].join('\n')
  );
  assert.deepEqual(calls, [
    {
      file: 'scripts/server.mjs',
      line: 1,
      callee: 'callAnthropic',
      registryId: 'server.probe',
      payloadScrubRegistryId: null,
    },
    {
      file: 'scripts/server.mjs',
      line: 3,
      callee: 'egressScrub',
      registryId: 'server.fake',
    },
    {
      file: 'scripts/server.mjs',
      line: 4,
      callee: 'callAnthropicMessages',
      registryId: 'server.fake',
      payloadScrubRegistryId: null,
    },
  ]);
});

check('validator rejects dynamic or unregistered wrapper ids', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      "const dynamicId = 'server.fake';",
      'callAnthropic(dynamicId, {});',
      "callAnthropic('server.missing', {});",
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, entries);
  assert.match(errors.join('\n'), /must pass a literal LLM registry id/);
  assert.match(errors.join('\n'), /unregistered LLM registry id server\.missing/);
});

check('validator requires registered server egress and scrub call-sites', () => {
  const errors = validateLlmWrapperCallSites(
    [
      {
        file: 'scripts/server.mjs',
        line: 1,
        callee: 'callAnthropic',
        registryId: 'server.probe',
      },
    ],
    entries
  );
  assert.match(errors.join('\n'), /server\.fake: registered server egress/);
  assert.match(errors.join('\n'), /server\.fake: registry requires egressScrub=stub/);
});

check('validator rejects wrapper calls outside the registered file', () => {
  const errors = validateLlmWrapperCallSites(
    [
      {
        file: 'src/lib/other.ts',
        line: 12,
        callee: 'callAnthropic',
        registryId: 'server.probe',
      },
    ],
    entries
  );
  assert.match(
    errors.join('\n'),
    /server\.probe is registered for scripts\/server\.mjs/
  );
});

check('validator rejects a protected send whose scrub result is discarded', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "egressScrub('server.fake', safeValue, options);",
      "callAnthropicMessages('server.fake', sensitiveValue);",
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator accepts a protected send of the captured same-id scrub result', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  assert.deepEqual(validateLlmWrapperCallSites(calls, [entries[0]]), []);
});

check('validator rejects an unsanitized override of scrubbed message content', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  messages: sensitiveValue,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator rejects intervening mutation of a captured scrub result', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      'Object.assign(scrubbed.content, { messages: sensitiveValue });',
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator rejects a helper method spoofing egressScrub', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "const scrubbed = helper.egressScrub('server.fake', sensitiveValue, options);",
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator rejects a conditional import that can select a spoofed scrubber', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      "const { egressScrub } = await import(useEvil ? './evil.mjs' : '../src/lib/anthropic-egress.ts');",
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator rejects a reassignable approved scrubber binding', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      "let { egressScrub } = await import('../src/lib/anthropic-egress.ts');",
      'egressScrub = helper.egressScrub;',
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      "callAnthropicMessages('server.fake', {",
      '  apiKey,',
      '  scrubbedBody: scrubbed,',
      '  capChecked: true,',
      '  capReceipt,',
      '});',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('validator does not capture a scrub binding across a concise function boundary', () => {
  const calls = collectLlmWrapperCalls(
    'scripts/server.mjs',
    [
      APPROVED_EGRESS_IMPORT,
      "const scrubbed = egressScrub('server.fake', sensitiveValue, options);",
      'const send = () =>',
      "  callAnthropicMessages('server.fake', {",
      '    apiKey,',
      '    scrubbedBody: scrubbed,',
      '    capChecked: true,',
      '    capReceipt,',
      '  });',
    ].join('\n')
  );
  const errors = validateLlmWrapperCallSites(calls, [entries[0]]);
  assert.match(
    errors.join('\n'),
    /callAnthropicMessages must send payload derived from a captured same-id egressScrub result/
  );
});

check('pre-public exposure gate rejects unauthenticated public entries', () => {
  const errors = validateLlmPrePublicExposure([
    publicEntry({
      exposure: {
        whoPays: 'operator',
        authRequired: false,
        tenancyBoundary: 'single',
        publiclyReachable: true,
      },
    }),
  ]);
  assert.match(errors.join('\n'), /public exposure requires authRequired=true/);
});

check('pre-public exposure gate rejects public entries without caps', () => {
  const errors = validateLlmPrePublicExposure([
    publicEntry({ caps: { callBudget: [], inputBounds: [], spendControls: [] } }),
  ]);
  assert.match(
    errors.join('\n'),
    /public exposure requires call, input, and spend caps/
  );
});

check('pre-public exposure gate rejects stub scrub for reachable entries', () => {
  const errors = validateLlmPrePublicExposure([
    publicEntry({ egressScrub: 'stub' }),
  ]);
  assert.match(
    errors.join('\n'),
    /public exposure requires egressScrub other than stub/
  );
});

check('pre-public exposure gate requires per-tenant boundary in multi-tenant mode', () => {
  const errors = validateLlmPrePublicExposure([publicEntry()], {
    deployment: 'multi-tenant',
  });
  assert.match(
    errors.join('\n'),
    /multi-tenant public exposure requires tenancyBoundary=per-tenant/
  );
});

check('pre-public exposure gate accepts public entries with required controls', () => {
  const errors = validateLlmPrePublicExposure([
    publicEntry({
      exposure: {
        whoPays: 'operator',
        authRequired: true,
        tenancyBoundary: 'per-tenant',
        publiclyReachable: true,
      },
    }),
  ], {
    deployment: 'multi-tenant',
  });
  assert.deepEqual(errors, []);
});

check('public exposure deployment parser rejects invalid modes', () => {
  assert.deepEqual(parsePublicExposureDeployment('multi-tenant'), {
    deployment: 'multi-tenant',
    errors: [],
  });
  const invalid = parsePublicExposureDeployment('shared-world');
  assert.equal(invalid.deployment, 'single-tenant');
  assert.match(
    invalid.errors.join('\n'),
    /DASHBOARD_LLM_PUBLIC_EXPOSURE_MODE must be single-tenant or multi-tenant/
  );
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll LLM egress gate checks passed.');
