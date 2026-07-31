import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { shellQuote } from './lib/shell-quote.mjs';
import { createWorkerOutputCollector } from './proof-worker-output.mjs';
import {
  PROOF_GATE_SANDBOX_CONTRACT,
  buildProofGateArgv,
  buildProofGateEnvironment,
  buildProofGateSettings,
  evaluateProofGateResult,
  proofGateSandboxPreflight,
  runProofGate as runGate,
} from './proof-gate-sandbox.mjs';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'proof-gate-test-'));
const tree = join(fixtureRoot, 'tree');
mkdirSync(tree);
const sandboxPreflight = proofGateSandboxPreflight();

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function sandboxTest(name, fn) {
  test(
    name,
    {
      skip: sandboxPreflight.ok
        ? false
        : `live sandbox unavailable: ${sandboxPreflight.reason}`,
    },
    fn,
  );
}

function nodeEval(source) {
  return `node -e ${shellQuote(source)}`;
}

function objectiveGate(command, expectMatch = null) {
  return {
    command,
    expectExitCode: 0,
    ...(expectMatch ? { expectMatch } : {}),
  };
}

test('production sandbox policy closes host reads, writes, network, and environment', () => {
  const settings = buildProofGateSettings(tree, '/fixture/bin/rg');
  assert.deepEqual(settings.network, {
    allowedDomains: [],
    deniedDomains: [],
  });
  assert.deepEqual(settings.filesystem.denyRead, ['/', '/sys']);
  assert.deepEqual(settings.filesystem.allowWrite, [tree]);
  assert.deepEqual(settings.filesystem.denyWrite, [
    '/tmp/claude',
    '/private/tmp/claude',
  ]);
  assert(settings.filesystem.allowRead.includes(tree));
  assert.equal(settings.filesystem.allowRead.includes(fixtureRoot), false);
  assert.deepEqual(settings.ripgrep, { command: '/fixture/bin/rg' });

  const runtimeRoot = join(tree, '.proof-gate-runtime-structural');
  const environment = buildProofGateEnvironment(runtimeRoot);
  assert.deepEqual(Object.keys(environment).sort(), [
    ...PROOF_GATE_SANDBOX_CONTRACT.environmentKeys,
  ].sort());
  assert.equal(environment.HOME, join(runtimeRoot, 'home'));
  assert.equal(environment.TMPDIR, join(runtimeRoot, 'tmp'));
  assert.equal(environment.PATH, '/usr/bin:/bin');
});

test('production dispatch passes the free-form command as one argument', () => {
  const command = `node -e "process.stdout.write('a b; ! $HOME')"`;
  const argv = buildProofGateArgv(
    '/control/settings.json',
    command,
    'proof-gate-sandboxed:test',
  );
  assert.equal(argv[1], '-s');
  assert.equal(argv[2], '/control/settings.json');
  assert.equal(argv.at(-2), 'proof-gate-sandboxed:test');
  assert.equal(argv.at(-1), command);
  assert.equal(argv.filter((value) => value === command).length, 1);
});

test('a sandbox-launch failure cannot satisfy an expected nonzero gate', () => {
  const gate = { expectExitCode: 1 };
  assert.deepEqual(
    evaluateProofGateResult({
      error: { code: 1 },
      stdout: '',
      stderr: 'sandbox startup failed',
      gate,
      launchMarker: 'proof-gate-sandboxed:test',
    }),
    { pass: false, exitCode: 1, expected: 1 },
  );
  assert.deepEqual(
    evaluateProofGateResult({
      error: { code: 1 },
      stdout: '',
      stderr: 'proof-gate-sandboxed:test\nobjective failed',
      gate,
      launchMarker: 'proof-gate-sandboxed:test',
    }),
    { pass: true, exitCode: 1, expected: 1 },
  );
  assert.deepEqual(
    evaluateProofGateResult({
      error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      stdout: '',
      stderr: 'proof-gate-sandboxed:test\ntruncated',
      gate,
      launchMarker: 'proof-gate-sandboxed:test',
    }),
    { pass: false, exitCode: 1, expected: 1 },
  );
  assert.deepEqual(
    evaluateProofGateResult({
      error: { code: 1, killed: true, signal: 'SIGTERM' },
      stdout: '',
      stderr: 'proof-gate-sandboxed:test\ntimed out',
      gate,
      launchMarker: 'proof-gate-sandboxed:test',
    }),
    { pass: false, exitCode: 1, expected: 1 },
  );
});

sandboxTest('objective gates cannot read a marker outside the materialized tree', async () => {
  const marker = join(fixtureRoot, 'outside-read-marker.txt');
  writeFileSync(marker, 'host secret marker');

  const result = await runGate(
    tree,
    objectiveGate(
      nodeEval(
        `const { readFileSync } = require('node:fs'); ` +
          `process.stdout.write(readFileSync(${JSON.stringify(marker)}, 'utf8'));`,
      ),
      'host secret marker',
    ),
  );

  assert.equal(result.pass, false);
});

sandboxTest('objective gate writes outside the tree do not reach the host', async () => {
  const escaped = join(fixtureRoot, 'outside-write-marker.txt');
  assert.equal(existsSync(escaped), false, 'host marker must not pre-exist');

  const result = await runGate(
    tree,
    objectiveGate(
      nodeEval(
        `require('node:fs').writeFileSync(${JSON.stringify(escaped)}, 'escaped');`,
      ),
    ),
  );

  // The denied host path is masked by the sandbox's private tmpfs. The command
  // may observe an ephemeral write as successful, but no host side effect lands.
  assert.equal(result.pass, true);
  assert.equal(existsSync(escaped), false);
});

sandboxTest('objective gates cannot access even an inert loopback endpoint', async () => {
  const server = createServer((_request, response) => {
    response.end('inert fixture response');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const result = await runGate(
      tree,
      objectiveGate(
        nodeEval(
          `fetch('http://127.0.0.1:${address.port}')` +
            `.then((response) => response.text())` +
            `.then((text) => process.stdout.write(text))` +
            `.catch(() => process.exit(23));`,
        ),
        'inert fixture response',
      ),
    );

    assert.equal(result.pass, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

sandboxTest('objective gates cannot create Unix sockets', async () => {
  const result = await runGate(
    tree,
    objectiveGate(
      nodeEval(
        `const { createServer } = require('node:net'); ` +
          `try { ` +
          `const server = createServer(); ` +
          `server.once('error', () => process.exit(23)); ` +
          `server.listen('/tmp/proof-gate.sock', () => server.close(() => process.exit(0))); ` +
          `} catch { process.exit(23); }`,
      ),
    ),
  );

  assert.equal(result.pass, false);
});

sandboxTest('objective gates cannot see or signal a host process', async () => {
  const result = await runGate(
    tree,
    objectiveGate(
      nodeEval(
        `try { process.kill(${process.pid}, 0); process.exit(0); } ` +
          `catch { process.exit(23); }`,
      ),
    ),
  );

  assert.equal(result.pass, false);
});

sandboxTest('objective gates receive a minimal environment', async () => {
  process.env.PROOF_BATCH_TEST_SECRET = 'must-not-cross';
  try {
    const result = await runGate(
      tree,
      objectiveGate(
        nodeEval(
          `if (process.env.PROOF_BATCH_TEST_SECRET) process.exit(21); ` +
            `if ((process.env.HOME?.startsWith(${JSON.stringify(join(tree, '.proof-gate-runtime-'))}) ?? false) === false) process.exit(22); ` +
            `if ((process.env.TMPDIR?.startsWith(${JSON.stringify(join(tree, '.proof-gate-runtime-'))}) ?? false) === false) process.exit(23); ` +
            `process.stdout.write('minimal environment');`,
        ),
        'minimal environment',
      ),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.pass, true);
  } finally {
    delete process.env.PROOF_BATCH_TEST_SECRET;
  }
});

sandboxTest('existing deterministic node gates still run successfully', async () => {
  writeFileSync(
    join(tree, 'deterministic-gate.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `assert.equal(2 + 2, 4);\n` +
      `console.log('deterministic gate passed');\n`,
  );

  const result = await runGate(
    tree,
    objectiveGate('node deterministic-gate.mjs', 'deterministic gate passed'),
  );
  writeFileSync(
    join(tree, 'deterministic-test.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `import test from 'node:test';\n` +
      `test('deterministic', () => assert.equal(2 + 2, 4));\n`,
  );
  const testResult = await runGate(
    tree,
    objectiveGate('node --test deterministic-test.mjs'),
  );

  assert.deepEqual(result, {
    pass: true,
    exitCode: 0,
    expected: 0,
  });
  assert.deepEqual(testResult, {
    pass: true,
    exitCode: 0,
    expected: 0,
  });
});

// -------------------------------------------------------- #3098 output budgets
// createWorkerOutputCollector: incremental NDJSON parse, bounded retention, an
// over-budget stop, and a bounded stderr tail — the memory-safe replacement for
// runWorker's old "append everything then re-split" handling.

function ndjson(...objs) {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

test('#3098 collector parses NDJSON incrementally and yields the same cost + stable-read values', () => {
  const stablePath = '/tree/STABLE.md';
  const collector = createWorkerOutputCollector({ stablePaths: [stablePath] });
  const stream = ndjson(
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: stablePath } }],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: `cat ${stablePath}` } }],
      },
    },
    { type: 'result', subtype: 'success', total_cost_usd: 0.0123, usage: { input_tokens: 10 } }
  );
  // Feed it in awkward 7-byte slices to prove chunk boundaries are handled.
  for (let i = 0; i < stream.length; i += 7) {
    collector.pushStdout(stream.slice(i, i + 7));
  }
  const final = collector.finalize();
  assert.equal(final.overBudget, false);
  assert.equal(final.cj.type, 'result');
  assert.equal(final.cj.total_cost_usd, 0.0123);
  // Two tool_use blocks referenced the stable path.
  assert.equal(final.stableReads, 2);
});

test('#3098 collector keeps memory bounded and returns unresolved past the output budget', () => {
  const budget = 4096;
  const collector = createWorkerOutputCollector({ stdoutBudgetBytes: budget });
  // Emit far more than the budget as valid NDJSON lines.
  const bigLine = JSON.stringify({ type: 'assistant', pad: 'x'.repeat(500) }) + '\n';
  let emitted = 0;
  for (let i = 0; i < 1000 && !collector.isOverBudget(); i++) {
    collector.pushStdout(bigLine);
    emitted += bigLine.length;
  }
  assert.ok(collector.isOverBudget(), 'budget should trip');
  assert.ok(emitted > budget, 'we fed more than the budget');
  // Retained memory never tracked the full emitted volume.
  assert.ok(
    collector.retainedStdoutBytes() <= budget,
    `retained ${collector.retainedStdoutBytes()} > budget ${budget}`
  );
  assert.deepEqual(collector.finalize(), { overBudget: true });
});

test('#3098 collector bounds the stderr tail', () => {
  const tail = 256;
  const collector = createWorkerOutputCollector({ stderrTailBytes: tail });
  for (let i = 0; i < 100; i++) collector.pushStderr('E'.repeat(100));
  assert.ok(collector.stderrTail().length <= tail);
  assert.ok(collector.stderrTail().endsWith('E'));
});

test('#3098 collector falls back to a single-object json build', () => {
  const collector = createWorkerOutputCollector({ stablePaths: [] });
  // No trailing newline; whole stdout is one object (--output-format json).
  collector.pushStdout(JSON.stringify({ type: 'result', total_cost_usd: 0.5 }));
  const final = collector.finalize();
  assert.equal(final.overBudget, false);
  assert.equal(final.cj.type, 'result');
  assert.equal(final.cj.total_cost_usd, 0.5);
});
