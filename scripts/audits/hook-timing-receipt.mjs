#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HOOK_TIMING_RECEIPT_SCHEMA_VERSION = 1;
export const HOOK_TIMING_RECEIPT_REVISION =
  'hook-timing-spike/2026-05-31/redacted-r1';

const RECEIPT_KIND = 'hook-timing-redacted-receipt';
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_ATOMIC_ROWS = 100_000;

const SYSTEM_SUBTYPE_CODES = Object.freeze({
  S: 'stop_hook_summary',
  T: 'turn_duration',
  E: 'api_error',
  A: 'away_summary',
  L: 'local_command',
  I: 'informational',
  B: 'bridge_status',
  F: 'scheduled_task_fire',
});

const SEARCH_TYPE_CODES = Object.freeze({
  u: 'type:user -> message/toolUseResult',
  a: 'type:attachment -> attachment',
  s: 'type:assistant -> message',
  q: 'type:queue-operation -> content',
});

const HOOK_MASK_BITS = Object.freeze({
  PreToolUse: 1,
  PostToolUse: 2,
  hook_response: 4,
  hook_started: 8,
});

// perf-index-contract: timing-subtype-membership always-consumed: every successful analysis filters all observed subtype counts through this fixed membership set
const PERSISTED_PER_TOOL_TIMING_SUBTYPES = new Set([
  'hook_started',
  'hook_progress',
  'hook_response',
  'pre_tool_use',
  'post_tool_use',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function expectBoundedString(value, label, max = MAX_ATOMIC_ROWS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string no longer than ${max}`);
  }
  return value;
}

function expectExactDictionary(actual, expected, label) {
  const normalized = expectRecord(actual, label);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the reviewed receipt revision`);
  }
}

function countCodes(codes, dictionary, label) {
  const counts = Object.fromEntries(
    Object.values(dictionary).map((name) => [name, 0])
  );
  for (const code of codes) {
    const name = dictionary[code];
    if (!name) throw new Error(`${label} contains unknown code ${JSON.stringify(code)}`);
    counts[name] += 1;
  }
  return counts;
}

/**
 * Recompute the hook-timing spike's published numbers from the receipt's
 * atomic, redacted vectors. The receipt intentionally carries no totals: this
 * function counts every file id, system-row code, search-row mask, and
 * stop-hook-info tuple under the one reviewed schema/revision.
 */
export function analyzeHookTimingReceipt(value) {
  const receipt = expectRecord(value, 'receipt');
  if (receipt.schemaVersion !== HOOK_TIMING_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported receipt schemaVersion ${receipt.schemaVersion}`);
  }
  if (receipt.kind !== RECEIPT_KIND) {
    throw new Error(`unsupported receipt kind ${JSON.stringify(receipt.kind)}`);
  }
  if (receipt.receiptRevision !== HOOK_TIMING_RECEIPT_REVISION) {
    throw new Error(`unsupported receipt revision ${JSON.stringify(receipt.receiptRevision)}`);
  }

  const sourceSnapshot = expectRecord(receipt.sourceSnapshot, 'sourceSnapshot');
  const sourceSnapshotId = expectBoundedString(
    sourceSnapshot.id,
    'sourceSnapshot.id',
    200
  );
  const transcriptFileIds = sourceSnapshot.transcriptFileIds;
  if (
    !Array.isArray(transcriptFileIds) ||
    transcriptFileIds.length === 0 ||
    transcriptFileIds.length > MAX_ATOMIC_ROWS
  ) {
    throw new Error('sourceSnapshot.transcriptFileIds must be a bounded non-empty array');
  }
  const fileIds = transcriptFileIds.map((id, index) =>
    expectBoundedString(id, `sourceSnapshot.transcriptFileIds[${index}]`, 80)
  );
  // perf-index-contract: receipt-file-identity always-consumed: every successful analysis compares unique file identities before publishing the file count
  if (new Set(fileIds).size !== fileIds.length) {
    throw new Error('sourceSnapshot.transcriptFileIds must be unique');
  }

  const dictionary = expectRecord(receipt.fieldDictionary, 'fieldDictionary');
  expectExactDictionary(
    dictionary.systemSubtypeCodes,
    SYSTEM_SUBTYPE_CODES,
    'fieldDictionary.systemSubtypeCodes'
  );
  expectExactDictionary(
    dictionary.searchTypeCodes,
    SEARCH_TYPE_CODES,
    'fieldDictionary.searchTypeCodes'
  );
  expectExactDictionary(
    dictionary.hookMaskBits,
    HOOK_MASK_BITS,
    'fieldDictionary.hookMaskBits'
  );
  if (
    JSON.stringify(dictionary.stopHookInfoTuple) !==
    JSON.stringify(['eventIndex', 'durationMs?', 'name?', 'id?'])
  ) {
    throw new Error('fieldDictionary.stopHookInfoTuple does not match the reviewed receipt revision');
  }

  const observations = expectRecord(receipt.observations, 'observations');
  const systemSubtypeCodes = expectBoundedString(
    observations.systemSubtypeCodes,
    'observations.systemSubtypeCodes'
  );
  const hookSearchTypeCodes = expectBoundedString(
    observations.hookSearchTypeCodes,
    'observations.hookSearchTypeCodes'
  );
  const hookSearchMasks = expectBoundedString(
    observations.hookSearchMasks,
    'observations.hookSearchMasks'
  );
  if (hookSearchTypeCodes.length !== hookSearchMasks.length) {
    throw new Error('search vectors must have equal lengths');
  }

  const systemSubtypes = countCodes(
    systemSubtypeCodes,
    SYSTEM_SUBTYPE_CODES,
    'observations.systemSubtypeCodes'
  );
  const hookStringClassifications = countCodes(
    hookSearchTypeCodes,
    SEARCH_TYPE_CODES,
    'observations.hookSearchTypeCodes'
  );
  const hookStringHits = Object.fromEntries(
    Object.keys(HOOK_MASK_BITS).map((name) => [name, 0])
  );
  for (const encoded of hookSearchMasks) {
    const mask = Number.parseInt(encoded, 16);
    if (!Number.isInteger(mask) || mask <= 0 || (mask & ~0xf) !== 0) {
      throw new Error(`observations.hookSearchMasks contains invalid mask ${encoded}`);
    }
    for (const [name, bit] of Object.entries(HOOK_MASK_BITS)) {
      if ((mask & bit) !== 0) hookStringHits[name] += 1;
    }
  }

  const stopHookInfos = observations.stopHookInfos;
  if (
    !Array.isArray(stopHookInfos) ||
    stopHookInfos.length === 0 ||
    stopHookInfos.length > MAX_ATOMIC_ROWS
  ) {
    throw new Error('observations.stopHookInfos must be a bounded non-empty array');
  }
  // perf-index-contract: stop-event-identity always-consumed: every successful analysis indexes every tuple and publishes the unique Stop-event denominator
  const eventIndexes = new Set();
  let hookInfosWithDurationMs = 0;
  let hookInfosWithNameOrId = 0;
  for (let index = 0; index < stopHookInfos.length; index += 1) {
    const tuple = stopHookInfos[index];
    if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 4) {
      throw new Error(`observations.stopHookInfos[${index}] must be a 1-4 item tuple`);
    }
    const [eventIndex, durationMs, name, id] = tuple;
    if (!Number.isInteger(eventIndex) || eventIndex < 0) {
      throw new Error(`observations.stopHookInfos[${index}][0] must be a non-negative integer`);
    }
    eventIndexes.add(eventIndex);
    if (durationMs !== undefined) {
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`observations.stopHookInfos[${index}][1] must be finite durationMs`);
      }
      hookInfosWithDurationMs += 1;
    }
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      throw new Error(`observations.stopHookInfos[${index}][2] must be a non-empty name`);
    }
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      throw new Error(`observations.stopHookInfos[${index}][3] must be a non-empty id`);
    }
    if (name !== undefined || id !== undefined) hookInfosWithNameOrId += 1;
  }
  // perf-index-contract: stop-event-order always-consumed: every successful analysis checks the complete sorted event-index set for contiguous receipt identity
  const sortedEventIndexes = [...eventIndexes].sort((a, b) => a - b);
  for (let index = 0; index < sortedEventIndexes.length; index += 1) {
    if (sortedEventIndexes[index] !== index) {
      throw new Error('stopHookInfo event indexes must form a contiguous redacted event set');
    }
  }

  const persistedPerToolHookTimingEvents = Object.entries(systemSubtypes)
    .filter(([subtype]) => PERSISTED_PER_TOOL_TIMING_SUBTYPES.has(subtype))
    .reduce((total, [, count]) => total + count, 0);
  const pct = (count, total) => Math.round((count / total) * 100);

  return {
    schemaVersion: HOOK_TIMING_RECEIPT_SCHEMA_VERSION,
    receiptRevision: HOOK_TIMING_RECEIPT_REVISION,
    sourceSnapshotId,
    transcriptFiles: fileIds.length,
    systemLines: systemSubtypeCodes.length,
    systemSubtypes,
    hookStringHits,
    hookStringClassifications,
    persistedPerToolHookTimingEvents,
    stopHookEvents: eventIndexes.size,
    hookInfos: stopHookInfos.length,
    hookInfosWithDurationMs,
    hookInfosWithDurationPct: pct(
      hookInfosWithDurationMs,
      stopHookInfos.length
    ),
    hookInfosWithNameOrId,
    hookInfosWithNameOrIdPct: pct(
      hookInfosWithNameOrId,
      stopHookInfos.length
    ),
  };
}

function runCli() {
  const path = process.argv[2];
  if (!path) {
    throw new Error('usage: node scripts/audits/hook-timing-receipt.mjs <receipt.json>');
  }
  const size = statSync(path).size;
  if (size > MAX_RECEIPT_BYTES) {
    throw new Error(`receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(`${JSON.stringify(analyzeHookTimingReceipt(receipt), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
