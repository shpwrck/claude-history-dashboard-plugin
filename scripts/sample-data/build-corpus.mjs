// Seeded synthetic ~/.claude corpus generator (issue #526).
//
// Emits a realistic-but-fake `history.jsonl` + per-session transcript `.jsonl`
// files in the EXACT on-disk shape the dashboard's `parse-*.ts` modules consume
// (see REFERENCES.md). The marketing SPA loads the zipped output through the
// same unzip -> parse -> store path as a real user upload, so every section
// renders populated sample data without a server or a real ~/.claude dir.
//
// Pure ESM, no Node built-ins beyond `Date` (build-time only), fully
// deterministic (seeded PRNG + fixed base epoch) so the generated zip is
// byte-stable. The Vite plugin (vite.config.ts, spa mode) and the coverage
// test (src/lib/sample-corpus.test.ts) both import `buildSampleCorpus()`.
//
// Coverage is intentional: each archetype below injects the specific signal a
// view needs (a compaction drop, a >200K context peak, a retry storm, dangerous
// commands, native api_error lines, MCP/agent/skill attribution, runtime
// telemetry, tool-manifest deltas). The coverage test asserts each parser comes
// back non-empty, so a UI/parser change that needs a new signal fails loudly.

// --- deterministic PRNG ----------------------------------------------------
const SEED = 0x5eed1234;
let _state = SEED >>> 0;
function rng() {
  // mulberry32
  _state = (_state + 0x6d2b79f5) >>> 0;
  let t = _state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function resetRng() {
  _state = SEED >>> 0;
}
function int(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick(arr) {
  return arr[int(0, arr.length - 1)];
}

// --- time ------------------------------------------------------------------
// Fixed base epoch so timestamps (and therefore the zip) are reproducible.
const BASE_MS = Date.UTC(2026, 4, 12, 9, 0, 0); // 2026-05-12T09:00:00Z
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
function iso(ms) {
  return new Date(ms).toISOString();
}

// --- static catalog --------------------------------------------------------
const PROJECTS = [
  { path: '/home/dev/acme-web', slug: '-home-dev-acme-web' },
  { path: '/home/dev/payments-api', slug: '-home-dev-payments-api' },
  { path: '/home/dev/ml-pipeline', slug: '-home-dev-ml-pipeline' },
  { path: '/home/dev/infra', slug: '-home-dev-infra' },
];

const MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  legacy: 'claude-3-5-sonnet-20241022',
};

const VERSION = '2.1.140';

const USER_PROMPTS = [
  'Add pagination to the orders list endpoint and cover it with tests.',
  'The checkout total is off by one cent on multi-item carts — find the rounding bug.',
  'Refactor the auth middleware so the token check is reusable across routes.',
  'Why is the nightly ETL job timing out? Trace it and propose a fix.',
  'Wire up the new pricing table and migrate the existing rows safely.',
  'Set up a GitHub Action that runs lint + build on every PR.',
  'Investigate the 500s users are seeing on /api/profile and patch the root cause.',
  'Generate a weekly summary of failed background jobs and email it to ops.',
  'Tighten the rate limiter so a single client can’t exhaust the pool.',
  'Port the dashboard charts off the deprecated charting lib.',
  'Add structured logging to the payment webhook handler.',
  'Find and remove the dead feature flags older than 90 days.',
];

const ASSISTANT_TEXTS = [
  'I’ll start by reading the relevant modules to map the current behaviour, then make the change.',
  'Here’s the plan: locate the handler, add the missing guard, and extend the test suite.',
  'I’ve found the issue — the total is summed before rounding each line item. Fixing that now.',
  'Done. I added the migration and a backfill that runs in batches to avoid locking the table.',
  'The job was re-reading the whole table each pass. I added an index and a cursor.',
  'You’re right, that edge case wasn’t covered. I’ve added a regression test for it.',
  'I think the cleanest approach is a small middleware wrapper; let me sketch it.',
];

const THINKING_TEXTS = [
  'The bug is likely in the reducer that accumulates line totals. Let me confirm by reading it before editing.',
  'Two candidate causes: a missing await, or a stale cache. I’ll check the await path first since it’s cheaper to rule out.',
  'This migration touches a hot table, so I should batch the backfill and wrap it in a transaction per batch.',
];

const READ_PATHS = {
  '/home/dev/acme-web': [
    'src/server/orders.ts',
    'src/server/auth-middleware.ts',
    'src/components/OrdersList.tsx',
  ],
  '/home/dev/payments-api': [
    'src/checkout/total.ts',
    'src/checkout/rounding.ts',
    'src/webhooks/payment.ts',
  ],
  '/home/dev/ml-pipeline': [
    'pipelines/nightly_etl.py',
    'pipelines/loaders.py',
    'pipelines/config.py',
  ],
  '/home/dev/infra': [
    '.github/workflows/ci.yml',
    'docker-compose.yml',
    'terraform/main.tf',
  ],
};

// --- line factories (verified field shapes per parse-*.ts) -----------------
function asstUsage(ms, model, usage, opts = {}) {
  const line = {
    type: 'assistant',
    timestamp: iso(ms),
    version: VERSION,
    gitBranch: opts.gitBranch ?? 'main',
    entrypoint: opts.entrypoint ?? 'cli',
    message: {
      id: opts.id,
      model,
      usage: { service_tier: opts.serviceTier ?? 'standard', ...usage },
    },
  };
  if (opts.attributionAgent) line.attributionAgent = opts.attributionAgent;
  if (opts.attributionSkill) line.attributionSkill = opts.attributionSkill;
  if (opts.attributionMcpServer) {
    line.attributionMcpServer = opts.attributionMcpServer;
    line.attributionMcpTool = opts.attributionMcpTool;
  }
  if (opts.permissionMode) line.permissionMode = opts.permissionMode;
  return line;
}

function asstContent(ms, blocks, opts = {}) {
  const line = {
    type: 'assistant',
    timestamp: iso(ms),
    version: VERSION,
    gitBranch: opts.gitBranch ?? 'main',
    entrypoint: opts.entrypoint ?? 'cli',
    message: { id: opts.id, model: opts.model ?? MODELS.opus, content: blocks },
  };
  if (opts.permissionMode) line.permissionMode = opts.permissionMode;
  return line;
}

function userText(ms, text, opts = {}) {
  const line = {
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: text },
  };
  if (opts.permissionMode) line.permissionMode = opts.permissionMode;
  return line;
}

function userToolResult(ms, toolUseId, isError, content, opts = {}) {
  const line = {
    type: 'user',
    timestamp: iso(ms),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content },
      ],
    },
  };
  if (opts.toolUseResult) {
    line.toolUseResult = { toolUseId, ...opts.toolUseResult };
  }
  return line;
}

function toolUseBlock(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

function sysApiError(ms, status, innerType, innerMsg, opts = {}) {
  return {
    type: 'system',
    subtype: 'api_error',
    timestamp: iso(ms),
    level: opts.level ?? 'error',
    error: {
      status,
      error: { error: { type: innerType, message: innerMsg } },
    },
    retryInMs: opts.retryInMs ?? 2000,
    retryAttempt: opts.retryAttempt ?? 1,
    maxRetries: opts.maxRetries ?? 5,
  };
}

function sysTurnDuration(ms, durationMs, messageCount) {
  return {
    type: 'system',
    subtype: 'turn_duration',
    timestamp: iso(ms),
    durationMs,
    messageCount,
  };
}

function sysStopHook(ms, opts = {}) {
  return {
    type: 'system',
    subtype: 'stop_hook_summary',
    timestamp: iso(ms),
    hookCount: opts.hookCount ?? 2,
    hookInfos: opts.hookInfos ?? [
      { command: 'prettier --write', durationMs: 180 },
      { command: 'eslint --fix' },
    ],
    hookErrors: opts.hookErrors ?? [],
    preventedContinuation: opts.preventedContinuation ?? false,
  };
}

function sysAway(ms, content) {
  return { type: 'system', subtype: 'away_summary', timestamp: iso(ms), content };
}
function sysScheduled(ms, content) {
  return {
    type: 'system',
    subtype: 'scheduled_task_fire',
    timestamp: iso(ms),
    content,
  };
}

function agentSettingLine(ms, name, value) {
  return { type: 'agent-setting', timestamp: iso(ms), name, value };
}

function attachmentTools(ms, addedNames) {
  return {
    type: 'attachment',
    timestamp: iso(ms),
    attachment: { type: 'deferred_tools_delta', addedNames },
  };
}
function attachmentSkills(ms, names) {
  return {
    type: 'attachment',
    timestamp: iso(ms),
    attachment: { type: 'skill_listing', names },
  };
}

function aiTitleLine(sessionId, aiTitle) {
  return { type: 'ai-title', sessionId, aiTitle };
}
function customTitleLine(sessionId, customTitle) {
  return { type: 'custom-title', sessionId, customTitle };
}

// --- session archetypes ----------------------------------------------------
// Each builder returns { lines: object[], prompts: {ms,text}[] } where prompts
// seed the global history.jsonl. `id()` yields unique message ids so the token
// de-dup (max-merge by message.id) never collapses distinct usage lines.

function makeSession(project, sessionId, startMs, build) {
  const lines = [];
  const prompts = [];
  let mid = 0;
  const ctx = {
    project,
    sessionId,
    id: () => `${sessionId}-m${mid++}`,
    push: (line) => lines.push(line),
    prompt: (ms, text) => prompts.push({ ms, text }),
  };
  build(ctx, startMs);
  return {
    project: project.path,
    slug: project.slug,
    sessionId,
    jsonl: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    prompts,
  };
}

// A: feature work — text + thinking, reads (one file read 3x => re-read),
// edits, a bash, tool_results (one error), usage lines, turn_duration, native
// agent+skill attribution, tool/skill manifests with unused tools, ai-title.
// Runs in `default` mode the whole time => prompt-eligible (drives the
// permission-friction ranking).
function buildFeatureSession(ctx, t0) {
  const paths = READ_PATHS[ctx.project.path];
  const timeMotionSample = ctx.sessionId === '20260512-1000-feat-sample';
  let t = t0;
  const churnGeometrySample = ctx.sessionId === '20260512-1000-feat-sample';
  ctx.push(attachmentTools(t, ['mcp__github__list_pull_requests', 'mcp__github__get_file_contents', 'mcp__playwright__browser_navigate']));
  ctx.push(attachmentSkills(t + 100, ['code-review', 'diagnose', 'ship']));

  const p0 = pick(USER_PROMPTS);
  ctx.prompt(t, p0);
  ctx.push(userText(t, p0, { permissionMode: 'default' }));
  t += 20 * 1000;

  ctx.push(
    asstContent(t, [
      { type: 'thinking', thinking: pick(THINKING_TEXTS) },
      { type: 'text', text: pick(ASSISTANT_TEXTS) },
    ], { permissionMode: 'default' })
  );
  t += 5 * 1000;

  // Re-read the same file 3x (file-reread signal) plus two other reads.
  const hotFile = paths[0];
  for (let i = 0; i < 3; i++) {
    const id = `${ctx.sessionId}-r${i}`;
    const resultDelay = timeMotionSample ? [9, 8, 7][i] * MIN : 1000;
    ctx.push(asstContent(t, [toolUseBlock(id, 'Read', { file_path: hotFile })]));
    ctx.push(userToolResult(t + resultDelay, id, false, 'x'.repeat(int(1800, 4200))));
    t += timeMotionSample ? resultDelay + 30 * 1000 : 30 * 1000;
  }
  for (const fp of paths.slice(1)) {
    const id = `${ctx.sessionId}-r-${fp.replace(/\W/g, '')}`;
    ctx.push(asstContent(t, [toolUseBlock(id, 'Read', { file_path: fp })]));
    ctx.push(userToolResult(t + 800, id, false, 'y'.repeat(int(900, 2600))));
    t += 20 * 1000;
  }

  // An edit + a bash (one tool_result errors, exercising the tool error rate).
  const eid = `${ctx.sessionId}-e0`;
  ctx.push(asstContent(t, [toolUseBlock(eid, 'Edit', { file_path: hotFile })]));
  ctx.push(userToolResult(t + 1200, eid, false, 'Applied 1 edit.', churnGeometrySample ? {
    toolUseResult: {
      filePath: hotFile,
      structuredPatch: {
        oldStart: 40,
        oldLines: 25,
        newStart: 40,
        newLines: 26,
        lines: 26,
      },
    },
  } : {}));
  t += 25 * 1000;

  if (churnGeometrySample) {
    ctx.push(sysStopHook(t, { hookCount: 1, hookInfos: [] }));
    t += 2 * MIN;

    const eid2 = `${ctx.sessionId}-e1`;
    ctx.push(asstContent(t, [toolUseBlock(eid2, 'Edit', { file_path: hotFile })]));
    ctx.push(userToolResult(t + 1200, eid2, false, 'Applied follow-up edit.', {
      toolUseResult: {
        filePath: hotFile,
        userModified: true,
        structuredPatch: [
          {
            oldStart: 40,
            oldLines: 26,
            newStart: 40,
            newLines: 25,
            lines: 26,
          },
        ],
      },
    }));
    t += 25 * 1000;
  }

  const bid = `${ctx.sessionId}-b0`;
  ctx.push(asstContent(t, [toolUseBlock(bid, 'Bash', { command: 'npm test -- orders' })]));
  ctx.push(userToolResult(t + 4000, bid, true, 'FAIL src/server/orders.test.ts\n  expected 200 received 500'));
  t += 30 * 1000;

  const bid2 = `${ctx.sessionId}-b1`;
  ctx.push(asstContent(t, [toolUseBlock(bid2, 'Bash', { command: 'npm test -- orders' })]));
  ctx.push(userToolResult(t + 4000, bid2, false, 'PASS src/server/orders.test.ts'));
  t += 20 * 1000;

  if (timeMotionSample) {
    ctx.push(sysTurnDuration(t + 1000, 18 * MIN, 1));
    ctx.push(sysAway(t + 2000, 'AFK recap: the long read sweep finished while the user was away.'));
    t += 18 * MIN;
  }

  // A skill + an agent spawn, with native attribution + token usage.
  const skid = `${ctx.sessionId}-sk`;
  ctx.push(asstContent(t, [toolUseBlock(skid, 'Skill', { skill: 'code-review' })]));
  ctx.push(asstUsage(t + 500, MODELS.opus, {
    input_tokens: int(800, 1500),
    output_tokens: int(1200, 2600),
    cache_creation_input_tokens: int(4000, 9000),
    cache_read_input_tokens: int(20000, 60000),
  }, { id: ctx.id(), attributionSkill: 'code-review' }));
  t += 40 * 1000;

  const agid = `${ctx.sessionId}-ag`;
  ctx.push(asstContent(t, [toolUseBlock(agid, 'Agent', { subagent_type: 'code-explorer' })]));
  ctx.push(asstUsage(t + 500, MODELS.sonnet, {
    input_tokens: int(600, 1200),
    output_tokens: int(900, 1800),
    cache_creation_input_tokens: int(2000, 5000),
    cache_read_input_tokens: int(15000, 40000),
  }, { id: ctx.id(), attributionAgent: 'code-explorer' }));
  t += 30 * 1000;

  // A follow-up user prompt mid-session (enriches Search / Stats / Activity).
  const p1 = pick([
    'Also add a changelog entry for this fix.',
    'Can you double-check the edge case where the cart is empty?',
    'Now write a short PR description summarising the change.',
    'Add a metric so we can alert if this regresses.',
  ]);
  ctx.prompt(t, p1);
  ctx.push(userText(t, p1, { permissionMode: 'default' }));
  t += 8 * 1000;
  ctx.push(asstContent(t, [{ type: 'text', text: 'On it — small, scoped follow-up.' }], { permissionMode: 'default' }));
  t += 12 * 1000;

  // Plain usage turns to give Tokens/Cost/Context something to chew on.
  for (let i = 0; i < int(3, 6); i++) {
    ctx.push(asstUsage(t, MODELS.opus, {
      input_tokens: int(500, 2000),
      output_tokens: int(800, 3000),
      cache_creation_input_tokens: int(3000, 12000),
      cache_read_input_tokens: int(25000, 95000),
    }, { id: ctx.id() }));
    ctx.push(sysTurnDuration(t + 1000, int(8000, 90000), int(2, 8)));
    t += int(2, 9) * MIN;
  }

  ctx.push(sysStopHook(t, { hookCount: 2 }));
  ctx.push(aiTitleLine(ctx.sessionId, `Fix and test: ${p0.slice(0, 40)}`));
}

// B: context-heavy — context ramps past 200K (over-window) then a compaction
// drop (<70% within 5 min); web search/fetch + 1h-cache usage; mixed models.
function buildContextHeavySession(ctx, t0) {
  let t = t0;
  const p0 = 'Audit the whole service for N+1 queries and propose fixes across every module.';
  ctx.prompt(t, p0);
  ctx.push(userText(t, p0));
  t += 30 * 1000;

  ctx.push(asstContent(t, [{ type: 'text', text: 'Large codebase — I’ll sweep module by module and keep a running list.' }]));
  t += 60 * 1000;

  // Rising context (cache_read is the dominant component the parser sums).
  const ramp = [55000, 95000, 150000, 210000, 245000];
  for (const cr of ramp) {
    ctx.push(asstUsage(t, MODELS.sonnet, {
      input_tokens: int(1500, 4000),
      output_tokens: int(1500, 4000),
      cache_creation_input_tokens: int(8000, 20000),
      cache_read_input_tokens: cr,
      server_tool_use: { web_search_requests: int(1, 3), web_fetch_requests: int(0, 2) },
    }, { id: ctx.id() }));
    t += int(2, 4) * MIN;
  }
  // Compaction: next turn's context collapses well below 70% of the ~270K peak.
  ctx.push(asstUsage(t + 2 * MIN, MODELS.sonnet, {
    input_tokens: 1200,
    output_tokens: 1800,
    cache_creation_input_tokens: 6000,
    cache_read_input_tokens: 42000,
    cache_creation: { ephemeral_1h_input_tokens: 3000 },
  }, { id: ctx.id() }));
  t += 6 * MIN;

  // A couple more post-compaction turns + a web-search heavy haiku turn.
  for (let i = 0; i < 3; i++) {
    ctx.push(asstUsage(t, i === 0 ? MODELS.haiku : MODELS.sonnet, {
      input_tokens: int(800, 2200),
      output_tokens: int(900, 2400),
      cache_creation_input_tokens: int(3000, 8000),
      cache_read_input_tokens: int(30000, 70000),
      server_tool_use: { web_search_requests: int(0, 4), web_fetch_requests: int(0, 1) },
    }, { id: ctx.id() }));
    ctx.push(sysTurnDuration(t + 1000, int(20000, 180000), int(3, 10)));
    t += int(3, 7) * MIN;
  }
  ctx.push(customTitleLine(ctx.sessionId, 'Service-wide N+1 audit'));
}

// C: rough session — native api_error (429 + 529 + 500) with retry telemetry,
// a Bash retry storm (5 back-to-back, some errored), dangerous commands under
// bypassPermissions, and a default->acceptEdits->bypassPermissions escalation.
function buildRoughSession(ctx, t0) {
  let t = t0;
  const p0 = 'Production is down — restart the workers and clear the stuck queue, fast.';
  ctx.prompt(t, p0);
  ctx.push(userText(t, p0, { permissionMode: 'default' }));
  t += 15 * 1000;

  ctx.push(sysApiError(t, 429, 'rate_limit_error', 'Number of requests has exceeded your rate limit', { retryAttempt: 1, retryInMs: 2000 }));
  t += 3 * 1000;
  ctx.push(sysApiError(t, 529, 'overloaded_error', 'Overloaded', { retryAttempt: 2, retryInMs: 8000, level: 'warning' }));
  t += 9 * 1000;

  ctx.push(asstContent(t, [{ type: 'text', text: 'Escalating permissions so I can act without prompts during the incident.' }], { permissionMode: 'acceptEdits' }));
  t += 10 * 1000;

  // Retry storm: same Bash 5x within 60s gaps, first three error.
  for (let i = 0; i < 5; i++) {
    const id = `${ctx.sessionId}-storm${i}`;
    ctx.push(asstContent(t, [toolUseBlock(id, 'Bash', { command: 'kubectl rollout restart deploy/worker' })], { permissionMode: 'bypassPermissions' }));
    ctx.push(userToolResult(t + 2000, id, i < 3, i < 3 ? 'error: timed out waiting for condition' : 'deployment.apps/worker restarted'));
    t += 18 * 1000;
  }

  ctx.push(sysApiError(t, 500, 'api_error', 'Internal server error', { retryAttempt: 1, retryInMs: 1000 }));
  t += 5 * 1000;

  // Dangerous commands under bypass (drives the dangerous-command + bypass view).
  const d0 = `${ctx.sessionId}-d0`;
  ctx.push(asstContent(t, [toolUseBlock(d0, 'Bash', { command: 'rm -rf /tmp/stuck-queue/*' })], { permissionMode: 'bypassPermissions' }));
  ctx.push(userToolResult(t + 1500, d0, false, ''));
  t += 20 * 1000;
  const d1 = `${ctx.sessionId}-d1`;
  ctx.push(asstContent(t, [toolUseBlock(d1, 'Bash', { command: 'git push --force origin hotfix/queue' })], { permissionMode: 'bypassPermissions' }));
  ctx.push(userToolResult(t + 1500, d1, false, 'forced update'));
  t += 30 * 1000;

  ctx.push(asstUsage(t, MODELS.opus, {
    input_tokens: int(900, 2000),
    output_tokens: int(1500, 3500),
    cache_creation_input_tokens: int(4000, 9000),
    cache_read_input_tokens: int(20000, 50000),
  }, { id: ctx.id(), permissionMode: 'bypassPermissions' }));
  ctx.push(aiTitleLine(ctx.sessionId, 'Incident: restart workers, clear queue'));
}

// D: automation — unattended entrypoint, scheduled wakeup + AFK recap, a
// stop-hook summary that errored and prevented continuation, agent-setting
// events, an MCP-attributed turn, a Task spawn.
function buildAutomationSession(ctx, t0) {
  let t = t0;
  ctx.push(agentSettingLine(t, 'autoCompactEnabled', 'true'));
  ctx.push(agentSettingLine(t + 1000, 'outputStyle', 'concise'));

  ctx.push(sysScheduled(t + 2000, 'Scheduled run: nightly backlog groomer fired at 02:00.'));
  t += 5 * 1000;

  const p0 = 'Groom the backlog: label stale issues and post a summary comment.';
  ctx.prompt(t, p0);
  ctx.push(userText(t, p0));
  t += 20 * 1000;

  // Model-pin before/after signal (#885): sample automation starts on a premium
  // model, then the rest of the scheduled run is Haiku-priced. The
  // recommendation engine derives this into observed savings without needing a
  // hand-authored modelPinSavings fixture.
  ctx.push(asstUsage(t, MODELS.opus, {
    input_tokens: int(60000, 70000),
    output_tokens: int(12000, 14000),
    cache_creation_input_tokens: int(2000, 4000),
    cache_read_input_tokens: int(6000, 10000),
  }, { id: ctx.id(), entrypoint: 'sdk-cli' }));
  t += 12 * MIN;

  ctx.push(asstUsage(t, MODELS.sonnet, {
    input_tokens: int(20000, 30000),
    output_tokens: int(4000, 6000),
    cache_creation_input_tokens: int(1000, 2000),
    cache_read_input_tokens: int(4000, 8000),
  }, { id: ctx.id(), entrypoint: 'sdk-cli' }));
  t += 12 * MIN;

  const tid = `${ctx.sessionId}-task`;
  ctx.push(asstContent(t, [toolUseBlock(tid, 'Agent', { subagent_type: 'general-purpose' })], { entrypoint: 'sdk-cli' }));
  ctx.push(asstUsage(t + 500, MODELS.haiku, {
    input_tokens: int(400, 1000),
    output_tokens: int(600, 1500),
    cache_creation_input_tokens: int(1000, 3000),
    cache_read_input_tokens: int(8000, 20000),
  }, { id: ctx.id(), entrypoint: 'sdk-cli', attributionAgent: 'general-purpose' }));
  t += 30 * 1000;

  // MCP-attributed turn (drives the MCP server/tool rollup).
  const gid = `${ctx.sessionId}-mcp`;
  ctx.push(asstContent(t, [toolUseBlock(gid, 'mcp__github__list_issues', { state: 'open' })], { entrypoint: 'sdk-cli' }));
  ctx.push(asstUsage(t + 500, MODELS.haiku, {
    input_tokens: int(300, 800),
    output_tokens: int(500, 1200),
    cache_creation_input_tokens: int(800, 2000),
    cache_read_input_tokens: int(6000, 15000),
  }, { id: ctx.id(), entrypoint: 'sdk-cli', attributionMcpServer: 'github', attributionMcpTool: 'list_issues' }));
  t += 40 * 1000;

  ctx.push(sysStopHook(t, {
    hookCount: 3,
    hookInfos: [
      { command: 'notify-slack.sh', durationMs: 240 },
      { command: 'update-status.mjs', durationMs: 120 },
      { command: 'guard-continue.sh' },
    ],
    hookErrors: ['guard-continue.sh exited 1'],
    preventedContinuation: true,
  }));
  t += 2 * MIN;

  ctx.push(sysAway(t, 'AFK recap: groomed 12 issues, labelled 4 stale, posted 1 summary. No blockers.'));
  ctx.push(customTitleLine(ctx.sessionId, 'Nightly backlog groomer'));
}

// --- corpus assembly -------------------------------------------------------
export function buildSampleCorpus() {
  resetRng();
  const sessions = [];
  const history = [];
  let day = 0;
  let n = 0;

  const plan = [
    ['feature', 'feature', 'context', 'rough'],
    ['feature', 'automation', 'feature', 'context'],
    ['rough', 'feature', 'automation', 'feature'],
    ['context', 'feature', 'rough', 'automation'],
    ['feature', 'feature'],
  ];

  for (const wave of plan) {
    for (const kind of wave) {
      const project = PROJECTS[n % PROJECTS.length];
      const sessionId = `2026051${(2 + day) % 10}-${String(1000 + n)}-${kind.slice(0, 4)}-sample`;
      const startMs = BASE_MS + day * DAY + (n % 4) * 3 * HOUR + int(0, 40) * MIN;
      const builder =
        kind === 'feature'
          ? buildFeatureSession
          : kind === 'context'
            ? buildContextHeavySession
            : kind === 'rough'
              ? buildRoughSession
              : buildAutomationSession;
      const s = makeSession(project, sessionId, startMs, builder);
      sessions.push(s);
      for (const p of s.prompts) {
        history.push({
          display: p.text,
          pastedContents: {},
          timestamp: p.ms,
          project: project.path,
          sessionId,
        });
      }
      n++;
    }
    day++;
  }

  // history.jsonl is time-ordered, one HistoryEntry per line.
  history.sort((a, b) => a.timestamp - b.timestamp);
  const historyJsonl = history.map((h) => JSON.stringify(h)).join('\n') + '\n';

  return {
    historyJsonl,
    sessions: sessions.map(({ project, slug, sessionId, jsonl }) => ({
      project,
      slug,
      sessionId,
      jsonl,
    })),
  };
}

/**
 * Map the corpus to the `{ path: Uint8Array }` entry table fflate's `zipSync`
 * wants. `history.jsonl` lands at the zip root; each transcript at
 * `projects/<slug>/<sessionId>.jsonl` so `extractProjectName()` recovers the
 * project on upload, mirroring a real `~/.claude` export.
 */
export function corpusZipEntries(corpus) {
  const enc = new TextEncoder();
  const entries = {};
  entries['history.jsonl'] = enc.encode(corpus.historyJsonl);
  for (const s of corpus.sessions) {
    entries[`projects/${s.slug}/${s.sessionId}.jsonl`] = enc.encode(s.jsonl);
  }
  return entries;
}

// --- adoption lifecycle seed (issue #578, epic #573, ADR 0005) --------------
// The Adoption Scorecard (#577) joins append-only SURFACED + SUPPRESSED receipts
// (#575) on finding id and renders the matching CLAUDE.md hunk LIVE from
// liveConfig. Those receipts are server-only (they live in the dashboard data
// dir, never in the upload zip), so without a seed the marketing SPA's Adoption
// Card shows only its "needs a server" empty state. This emits ONE fully-
// populated lifecycle for one finding so the demo renders the artifact end to
// end: the finding is surfaced, the recommended CLAUDE.md section lands (the
// `claudeMdHunk` below, which the SPA folds into liveConfig so the live join
// lights ADOPTED), and the engine then goes quiet (SUPPRESSED).
//
// Deterministic (fixed timestamps off BASE_MS, no PRNG) so the drift guard in
// src/lib/sample-adoption.test.ts can assert the exact derived shape. The
// markerHeading matches the heading inside `claudeMdHunk` so liveClaudeMdHunk()
// resolves the section. `daysToAdopt` is 5 whole days by construction.
const SAMPLE_ADOPTION_FINDING = 'reliability.rate-limit-retry-storms';
const SAMPLE_ADOPTION_HEADING = 'Rate-limit hygiene';
const SAMPLE_ADOPTION_SESSION_HASH = 'a1b2c3d4e5f60718';

/**
 * The CLAUDE.md section the recommended fix injects. The SPA folds this into the
 * sample liveConfig (`claudeMd.global`) so the Adoption Card's ADOPTED row, which
 * extracts the hunk live by `markerHeading`, renders it. Heading text matches
 * SAMPLE_ADOPTION_HEADING.
 */
export const SAMPLE_ADOPTION_CLAUDE_MD_HUNK = [
  `## ${SAMPLE_ADOPTION_HEADING}`,
  '',
  'When a `429 rate_limit_error` arrives, back off on the retry the API asks for',
  'instead of re-firing immediately — repeated instant retries only deepen the',
  'rate-limit window and stall the session. Batch independent calls and prefer a',
  'single larger request over a burst of small ones.',
].join('\n');

/**
 * One synthetic finding's full adoption lifecycle as append-only receipts:
 * a SURFACED entry, then a SUPPRESSED entry 5 days later. Pair them with
 * SAMPLE_ADOPTION_CLAUDE_MD_HUNK (injected into the sample liveConfig) and the
 * Adoption Scorecard derives SURFACED -> ADOPTED (live hunk present) ->
 * SUPPRESSED. Timestamps are fixed (off BASE_MS) for a byte-stable demo.
 */
export function buildSampleAdoptionReceipts() {
  const surfacedMs = BASE_MS + 2 * DAY + 3 * HOUR;
  const suppressedMs = surfacedMs + 5 * DAY;
  return [
    {
      schemaVersion: '1',
      kind: 'SURFACED',
      ts: iso(surfacedMs),
      sessionHash: SAMPLE_ADOPTION_SESSION_HASH,
      findingIds: [SAMPLE_ADOPTION_FINDING],
    },
    {
      schemaVersion: '1',
      kind: 'SUPPRESSED',
      ts: iso(suppressedMs),
      findingId: SAMPLE_ADOPTION_FINDING,
      markerHeading: SAMPLE_ADOPTION_HEADING,
      contentFingerprint: 'sha256:7f3a9c2e1d8b4506',
    },
  ];
}
