import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeHookTimingReceipt,
  HOOK_TIMING_RECEIPT_REVISION,
} from './hook-timing-receipt.mjs';

const receiptPath = fileURLToPath(
  new URL('../../fixtures/hook-timing-spike/receipt.json', import.meta.url)
);
const docPath = fileURLToPath(
  new URL('../../docs/hook-timing-spike.md', import.meta.url)
);

function committedReceipt() {
  return JSON.parse(readFileSync(receiptPath, 'utf8'));
}

test('recomputes every published hook-timing number from atomic redacted rows', () => {
  const result = analyzeHookTimingReceipt(committedReceipt());

  assert.equal(result.receiptRevision, HOOK_TIMING_RECEIPT_REVISION);
  assert.equal(result.sourceSnapshotId, 'claude-projects-2026-05-31-redacted-r1');
  assert.equal(result.transcriptFiles, 363);
  assert.equal(result.systemLines, 475);
  assert.deepEqual(result.systemSubtypes, {
    stop_hook_summary: 286,
    turn_duration: 85,
    api_error: 56,
    away_summary: 20,
    local_command: 16,
    informational: 6,
    bridge_status: 3,
    scheduled_task_fire: 3,
  });
  assert.deepEqual(result.hookStringHits, {
    PreToolUse: 65,
    PostToolUse: 163,
    hook_response: 78,
    hook_started: 4,
  });
  assert.deepEqual(result.hookStringClassifications, {
    'type:user -> message/toolUseResult': 161,
    'type:attachment -> attachment': 87,
    'type:assistant -> message': 49,
    'type:queue-operation -> content': 7,
  });
  assert.equal(result.persistedPerToolHookTimingEvents, 0);
  assert.equal(result.stopHookEvents, 286);
  assert.equal(result.hookInfos, 287);
  assert.equal(result.hookInfosWithDurationMs, 17);
  assert.equal(result.hookInfosWithDurationPct, 6);
  assert.equal(result.hookInfosWithNameOrId, 0);
  assert.equal(result.hookInfosWithNameOrIdPct, 0);
});

test('rejects a receipt whose schema revision is not the reviewed one', () => {
  const receipt = committedReceipt();
  receipt.receiptRevision = 'hook-timing-spike/unknown';
  assert.throws(
    () => analyzeHookTimingReceipt(receipt),
    /unsupported receipt revision/
  );
});

test('keeps the documented canonical output equal to a fresh recomputation', () => {
  const result = analyzeHookTimingReceipt(committedReceipt());
  const doc = readFileSync(docPath, 'utf8');
  const match = doc.match(
    /<!-- hook-timing-receipt-output:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- hook-timing-receipt-output:end -->/
  );
  assert.ok(match, 'docs/hook-timing-spike.md must carry the canonical output block');
  assert.deepEqual(JSON.parse(match[1]), result);
});

test('rejects mismatched atomic search vectors instead of truncating them', () => {
  const receipt = committedReceipt();
  receipt.observations.hookSearchMasks = receipt.observations.hookSearchMasks.slice(1);
  assert.throws(
    () => analyzeHookTimingReceipt(receipt),
    /search vectors must have equal lengths/
  );
});
