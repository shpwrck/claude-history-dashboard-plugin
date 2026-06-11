// Byte-identical parity harness for the #524 signal-descriptor refactor (slice 1).
//
// Run under the ts-resolver loader so the descriptor's .ts module resolves:
//   node --import ./scripts/register-ts.mjs --test scripts/signal-descriptor-parity.test.mjs
//
// STRATEGY (per the #524 slice-1 brief, STEP 0). `ingestOne`/`assembleDataset`
// are not exported and bind a hard-coded SQLite path, so a clean temp-DB harness
// that drives them directly would mean exporting internals / redirecting the
// production DB — out of scope and risky. Instead this harness proves the
// descriptor reproduces the ORIGINAL inline logic byte-for-byte by re-deriving
// BOTH the content_hash and the assembleDataset read-back two ways over fixed,
// deterministic inputs:
//
//   (a) ORIGINAL: a verbatim transcription of the pre-refactor inline code from
//       `ingestOne` (the parse/stringify/hash sequence) and `assembleDataset`
//       (the per-column read-back). This is the GOLDEN — the pre-refactor
//       behaviour, frozen here. It is NEVER edited to make a test pass; a
//       mismatch means the descriptor drifted and the *descriptor* gets fixed.
//   (b) DESCRIPTOR: drive `makeSessionSignals(...)` (the new single source of
//       truth) over the identical inputs.
//
// We assert (a) === (b) for the SHA-1 content_hash (including the exact part
// ORDER: project, title, then the 13 signals) and for the assembled dataset
// (with the non-deterministic time fields — generatedAt/windowStart/windowEnd —
// normalized out, since they derive from Date.now()). Because the inputs are
// fixed parsed-value maps, the parsers themselves are stubbed to return those
// maps verbatim — the harness is testing the descriptor's plumbing (order,
// `?? empty` defaults, stringify, hash-part order, read-back truthiness/spread/
// fan-out), which is exactly what slice 1 changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeSessionSignals } from '../src/lib/signals/index.ts';

// ---------------------------------------------------------------------------
// Deterministic fixtures: three sessions exercising every read-back branch.
//   - S1: every signal populated with a distinct value.
//   - S2: the `?? empty` defaults all fire (parsers return null) — exercises the
//         empty-array / {perModeEntries,changes} / null fallbacks and the
//         guarded vs unconditional read-back truthiness.
//   - S3: mixed — some empty arrays, a perm with only `changes`, an entries with
//         two rows.
// Each FIXTURE provides the per-signal PARSED value (post `?? empty`), keyed by
// the signal id, exactly as `ingestOne` would have after its inline parse calls.
// ---------------------------------------------------------------------------
const FIXTURES = [
  {
    sessionId: 'sess-1',
    project: '/home/u/proj-a',
    title: 'First Session',
    // Raw parser RETURN values (pre-`?? empty`). `null` => the inline default
    // fires. These feed stub parsers below so the descriptor's own `?? empty`
    // and the golden's `?? empty` both run against identical raw inputs.
    raw: {
      token: { sessionId: 'sess-1', totalTokens: 1234 },
      tool: { sessionId: 'sess-1', tools: { Read: 5, Bash: 2 } },
      timeline: { sessionId: 'sess-1', turns: 9 },
      apiErrors: [{ kind: 'overloaded' }, { kind: 'rate_limit' }],
      perm: {
        perModeEntries: [{ mode: 'acceptEdits', count: 3 }],
        changes: [{ from: 'default', to: 'acceptEdits' }],
      },
      agents: [{ type: 'general-purpose', uses: 4 }],
      entries: [
        {
          display: 'do the thing',
          pastedContents: {},
          timestamp: 1717000000000,
          project: '/home/u/proj-a',
          sessionId: 'sess-1',
          title: 'First Session',
        },
      ],
      attribution: { co_authored: true, model: 'opus' },
      runtime: { idleMs: 4200, events: 3 },
      inventory: { mcp: ['github'], builtin: ['Read'] },
      assistantFeatures: { sessionId: 'sess-1', thinkingTurns: 2 },
      deceit: { sessionId: 'sess-1', unbackedClaimCount: 1 },
      churnGeometry: {
        sessionId: 'sess-1',
        files: [{ filePath: 'src/a.ts', grossLines: 42, netLines: 0 }],
      },
    },
  },
  {
    sessionId: 'sess-2',
    project: null, // exercises `project ?? ''`
    title: null, // exercises `title ?? ''`
    raw: {
      token: null,
      tool: null,
      timeline: null,
      apiErrors: null, // ?? []
      perm: null, // ?? { perModeEntries: [], changes: [] }
      agents: null, // ?? []
      entries: [], // deriveEntries → [] (no spread, no union effect here)
      attribution: null, // ?? null
      runtime: null, // ?? null
      inventory: null,
      assistantFeatures: null,
      deceit: null,
      churnGeometry: null,
    },
  },
  {
    sessionId: 'sess-3',
    project: '/home/u/proj-b',
    title: 'Third',
    raw: {
      token: { sessionId: 'sess-3', totalTokens: 0 },
      tool: { sessionId: 'sess-3', tools: {} },
      timeline: { sessionId: 'sess-3', turns: 1 },
      apiErrors: [], // empty spread
      perm: { perModeEntries: [], changes: [{ from: 'plan', to: 'default' }] },
      agents: [{ type: 'explorer', uses: 1 }],
      entries: [
        {
          display: 'a',
          pastedContents: {},
          timestamp: 1717000500000,
          project: '/home/u/proj-b',
          sessionId: 'sess-3',
          title: 'Third',
        },
        {
          display: 'b',
          pastedContents: {},
          timestamp: 1717000600000,
          project: '/home/u/proj-b',
          sessionId: 'sess-3',
          title: 'Third',
        },
      ],
      attribution: null,
      runtime: { idleMs: 0, events: 0 },
      inventory: null,
      assistantFeatures: { sessionId: 'sess-3', thinkingTurns: 0 },
      deceit: { sessionId: 'sess-3', unbackedClaimCount: 0 },
      churnGeometry: { sessionId: 'sess-3', files: [] },
    },
  },
];

// Stub parsers that return the fixture's RAW value for the session under
// `ctx.sessionId`. The descriptor applies its own `?? empty` on top, mirroring
// what the real parsers + inline defaults did.
function stubParsersFor(fx) {
  const r = fx.raw;
  return {
    parseSessionJsonl: () => r.token,
    parseToolUsage: () => r.tool,
    parseSessionTimeline: () => r.timeline,
    parseApiErrors: () => r.apiErrors,
    parsePermissionData: () => r.perm,
    parseAgentSettings: () => r.agents,
    parseAttribution: () => r.attribution,
    parseRuntimeEvents: () => r.runtime,
    parseToolInventory: () => r.inventory,
    parseAssistantFeatures: () => r.assistantFeatures,
    parseDeceitSignals: () => r.deceit,
    parseChurnGeometry: () => r.churnGeometry,
    deriveEntries: () => r.entries,
  };
}

// ===========================================================================
// GOLDEN (a): verbatim copy of the PRE-refactor ingestOne hash/stringify logic.
// Do NOT edit this to make a test pass.
// ===========================================================================
function goldenIngest(fx) {
  const r = fx.raw;
  // Verbatim inline parse + `?? empty` defaults (pre-refactor ingestOne).
  const token = r.token;
  const tool = r.tool;
  const inventory = r.inventory;
  const timeline = r.timeline;
  const apiErrors = r.apiErrors ?? [];
  const perm = r.perm ?? { perModeEntries: [], changes: [] };
  const agents = r.agents ?? [];
  const attribution = r.attribution ?? null;
  const runtime = r.runtime ?? null;
  const assistantFeatures = r.assistantFeatures;
  const deceit = r.deceit;
  const churnGeometry = r.churnGeometry ?? null;
  const title = fx.title;
  const entries = r.entries;

  const tokenJson = JSON.stringify(token);
  const toolJson = JSON.stringify(tool);
  const timelineJson = JSON.stringify(timeline);
  const apiErrorsJson = JSON.stringify(apiErrors);
  const permJson = JSON.stringify(perm);
  const agentsJson = JSON.stringify(agents);
  const entriesJson = JSON.stringify(entries);
  const attributionJson = JSON.stringify(attribution);
  const runtimeJson = JSON.stringify(runtime);
  const inventoryJson = JSON.stringify(inventory);
  const assistantFeaturesJson = JSON.stringify(assistantFeatures);
  const deceitJson = JSON.stringify(deceit);
  const churnGeometryJson = JSON.stringify(churnGeometry);

  const ch = createHash('sha1');
  ch.update(fx.project ?? '');
  ch.update('\0');
  ch.update(title ?? '');
  ch.update('\0');
  for (const part of [
    tokenJson,
    toolJson,
    timelineJson,
    apiErrorsJson,
    permJson,
    agentsJson,
    entriesJson,
    attributionJson,
    runtimeJson,
    inventoryJson,
    assistantFeaturesJson,
    deceitJson,
    churnGeometryJson,
  ]) {
    ch.update(part);
    ch.update('\0');
  }
  const contentHash = ch.digest('hex');

  // The persisted row (the upsert's `_json`/title/content_hash positional args),
  // keyed by column so the read-back goldens/descriptor can read them back.
  return {
    contentHash,
    row: {
      session_id: fx.sessionId,
      project: fx.project,
      token_json: tokenJson,
      tool_json: toolJson,
      timeline_json: timelineJson,
      apierrors_json: apiErrorsJson,
      perm_json: permJson,
      agents_json: agentsJson,
      entries_json: entriesJson,
      attribution_json: attributionJson,
      runtime_json: runtimeJson,
      title,
      inventory_json: inventoryJson,
      content_hash: contentHash,
      assistant_features_json: assistantFeaturesJson,
      deceit_signals_json: deceitJson,
      churn_geometry_json: churnGeometryJson,
    },
  };
}

// DESCRIPTOR (b): drive ingestOne's hash/stringify from makeSessionSignals.
function descriptorIngest(fx) {
  const SIGNALS = makeSessionSignals(stubParsersFor(fx));
  const ctx = {
    merged: '',
    topText: '',
    name: `${fx.sessionId}.jsonl`,
    sessionId: fx.sessionId,
    project: fx.project,
    title: fx.title,
  };
  const values = {};
  const json = {};
  for (const s of SIGNALS) {
    values[s.id] = s.parse(ctx);
    json[s.id] = JSON.stringify(values[s.id]);
  }
  const ch = createHash('sha1');
  ch.update(fx.project ?? '');
  ch.update('\0');
  ch.update(fx.title ?? '');
  ch.update('\0');
  for (const s of SIGNALS) {
    ch.update(json[s.id]);
    ch.update('\0');
  }
  const contentHash = ch.digest('hex');
  // Persisted row sourced from the json map (mirrors the rewired upsert).
  const row = {
    session_id: fx.sessionId,
    project: fx.project,
    token_json: json.token,
    tool_json: json.tool,
    timeline_json: json.timeline,
    apierrors_json: json.apiErrors,
    perm_json: json.perm,
    agents_json: json.agents,
    entries_json: json.entries,
    attribution_json: json.attribution,
    runtime_json: json.runtime,
    title: fx.title,
    inventory_json: json.inventory,
    content_hash: contentHash,
    assistant_features_json: json.assistantFeatures,
    deceit_signals_json: json.deceitSignals,
    churn_geometry_json: json.churnGeometry,
  };
  return { contentHash, row };
}

// ===========================================================================
// GOLDEN (a): verbatim copy of the PRE-refactor assembleDataset read-back.
// ===========================================================================
function goldenAssemble(rows) {
  const tokenData = [];
  const toolData = [];
  const toolInventories = [];
  const timelines = [];
  const apiErrors = [];
  const permissionRows = [];
  const permissionChanges = [];
  const agentSettings = [];
  const attribution = [];
  const runtimeEvents = [];
  const assistantFeatures = [];
  const deceitSignals = [];
  const churnGeometry = [];
  const entries = [];
  for (const r of rows) {
    const token = JSON.parse(r.token_json);
    if (token) tokenData.push(token);
    const tool = JSON.parse(r.tool_json);
    if (tool) toolData.push(tool);
    const inv = r.inventory_json ? JSON.parse(r.inventory_json) : null;
    if (inv) toolInventories.push(inv);
    const tl = JSON.parse(r.timeline_json);
    if (tl) timelines.push(tl);
    for (const e of JSON.parse(r.apierrors_json) || []) apiErrors.push(e);
    const perm = JSON.parse(r.perm_json) || { perModeEntries: [], changes: [] };
    for (const p of perm.perModeEntries || []) permissionRows.push(p);
    for (const c of perm.changes || []) permissionChanges.push(c);
    for (const a of JSON.parse(r.agents_json) || []) agentSettings.push(a);
    const attr = r.attribution_json ? JSON.parse(r.attribution_json) : null;
    if (attr) attribution.push(attr);
    const rt = r.runtime_json ? JSON.parse(r.runtime_json) : null;
    if (rt) runtimeEvents.push(rt);
    const af = r.assistant_features_json
      ? JSON.parse(r.assistant_features_json)
      : null;
    if (af) assistantFeatures.push(af);
    const ds = r.deceit_signals_json
      ? JSON.parse(r.deceit_signals_json)
      : null;
    if (ds) deceitSignals.push(ds);
    const cg = r.churn_geometry_json
      ? JSON.parse(r.churn_geometry_json)
      : null;
    if (cg) churnGeometry.push(cg);
    for (const en of JSON.parse(r.entries_json) || []) entries.push(en);
  }
  return {
    entries,
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    permissionRows,
    permissionChanges,
    agentSettings,
    attribution,
    runtimeEvents,
    assistantFeatures,
    deceitSignals,
    churnGeometry,
  };
}

// DESCRIPTOR (b): drive assembleDataset's read-back from makeSessionSignals.
// Mirrors the rewired loop in ingest.mjs exactly.
function descriptorAssemble(rows) {
  // Parsers are irrelevant to read-back; pass identity stubs.
  const SIGNALS = makeSessionSignals(stubParsersFor(FIXTURES[0]));
  const tokenData = [];
  const toolData = [];
  const toolInventories = [];
  const timelines = [];
  const apiErrors = [];
  const permissionRows = [];
  const permissionChanges = [];
  const agentSettings = [];
  const attribution = [];
  const runtimeEvents = [];
  const assistantFeatures = [];
  const deceitSignals = [];
  const churnGeometry = [];
  const entries = [];
  const out = {
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    agentSettings,
    attribution,
    runtimeEvents,
    assistantFeatures,
    deceitSignals,
    churnGeometry,
  };
  for (const r of rows) {
    for (const s of SIGNALS) {
      if (s.aggregate === 'push-truthy') {
        const v =
          s.parseGuard === 'guarded'
            ? r[s.column]
              ? JSON.parse(r[s.column])
              : null
            : JSON.parse(r[s.column]);
        if (v) out[s.datasetKey].push(v);
      } else if (s.aggregate === 'spread') {
        for (const e of JSON.parse(r[s.column]) || []) out[s.datasetKey].push(e);
      } else if (s.id === 'perm') {
        const perm = JSON.parse(r[s.column]) || {
          perModeEntries: [],
          changes: [],
        };
        for (const p of perm.perModeEntries || []) permissionRows.push(p);
        for (const c of perm.changes || []) permissionChanges.push(c);
      } else if (s.id === 'entries') {
        for (const en of JSON.parse(r[s.column]) || []) entries.push(en);
      }
    }
  }
  return {
    entries,
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    permissionRows,
    permissionChanges,
    agentSettings,
    attribution,
    runtimeEvents,
    assistantFeatures,
    deceitSignals,
    churnGeometry,
  };
}

test('content_hash: descriptor === pre-refactor inline, per row', () => {
  for (const fx of FIXTURES) {
    const golden = goldenIngest(fx);
    const desc = descriptorIngest(fx);
    assert.equal(
      desc.contentHash,
      golden.contentHash,
      `content_hash drift for ${fx.sessionId}`,
    );
    // The persisted row (every _json column + title) must also be identical.
    assert.deepEqual(
      desc.row,
      golden.row,
      `persisted row drift for ${fx.sessionId}`,
    );
  }
});

test('content_hash part order is project, title, then the 13 signals', () => {
  const ids = makeSessionSignals(stubParsersFor(FIXTURES[0])).map((s) => s.id);
  assert.deepEqual(ids, [
    'token',
    'tool',
    'timeline',
    'apiErrors',
    'perm',
    'agents',
    'entries',
    'attribution',
    'runtime',
    'inventory',
    'assistantFeatures',
    'deceitSignals',
    'churnGeometry',
  ]);
});

test('assembleDataset read-back: descriptor === pre-refactor inline', () => {
  const rows = FIXTURES.map((fx) => descriptorIngest(fx).row);
  const golden = goldenAssemble(rows);
  const desc = descriptorAssemble(rows);
  // Normalize: no non-deterministic time fields are involved in the read-back
  // arrays (generatedAt/windowStart/windowEnd are added later in
  // assembleDataset and are excluded from this comparison by construction).
  assert.deepEqual(desc, golden);
});

// Frozen golden snapshot of the assembled read-back over the three fixtures, so
// a future edit that changes BOTH the descriptor and the in-test golden copy in
// the same wrong way still trips here. Generated from the pre-refactor inline
// logic; do not regenerate to pass.
test('assembleDataset read-back matches frozen golden snapshot', () => {
  const rows = FIXTURES.map((fx) => descriptorIngest(fx).row);
  const desc = descriptorAssemble(rows);
  assert.deepEqual(desc, {
    entries: [
      {
        display: 'do the thing',
        pastedContents: {},
        timestamp: 1717000000000,
        project: '/home/u/proj-a',
        sessionId: 'sess-1',
        title: 'First Session',
      },
      {
        display: 'a',
        pastedContents: {},
        timestamp: 1717000500000,
        project: '/home/u/proj-b',
        sessionId: 'sess-3',
        title: 'Third',
      },
      {
        display: 'b',
        pastedContents: {},
        timestamp: 1717000600000,
        project: '/home/u/proj-b',
        sessionId: 'sess-3',
        title: 'Third',
      },
    ],
    tokenData: [
      { sessionId: 'sess-1', totalTokens: 1234 },
      { sessionId: 'sess-3', totalTokens: 0 },
    ],
    toolData: [
      { sessionId: 'sess-1', tools: { Read: 5, Bash: 2 } },
      { sessionId: 'sess-3', tools: {} },
    ],
    toolInventories: [{ mcp: ['github'], builtin: ['Read'] }],
    timelines: [
      { sessionId: 'sess-1', turns: 9 },
      { sessionId: 'sess-3', turns: 1 },
    ],
    apiErrors: [{ kind: 'overloaded' }, { kind: 'rate_limit' }],
    permissionRows: [{ mode: 'acceptEdits', count: 3 }],
    permissionChanges: [
      { from: 'default', to: 'acceptEdits' },
      { from: 'plan', to: 'default' },
    ],
    agentSettings: [
      { type: 'general-purpose', uses: 4 },
      { type: 'explorer', uses: 1 },
    ],
    attribution: [{ co_authored: true, model: 'opus' }],
    runtimeEvents: [
      { idleMs: 4200, events: 3 },
      { idleMs: 0, events: 0 },
    ],
    assistantFeatures: [
      { sessionId: 'sess-1', thinkingTurns: 2 },
      { sessionId: 'sess-3', thinkingTurns: 0 },
    ],
    deceitSignals: [
      { sessionId: 'sess-1', unbackedClaimCount: 1 },
      { sessionId: 'sess-3', unbackedClaimCount: 0 },
    ],
    churnGeometry: [
      {
        sessionId: 'sess-1',
        files: [{ filePath: 'src/a.ts', grossLines: 42, netLines: 0 }],
      },
      { sessionId: 'sess-3', files: [] },
    ],
  });
});
