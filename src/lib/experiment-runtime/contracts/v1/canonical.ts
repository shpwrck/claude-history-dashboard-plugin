import { createHash } from 'node:crypto';
import type {
  BehaviorFingerprint,
  ExperimentDocument,
  JsonObject,
  JsonValue,
  Sha256Digest,
} from './types';

export class CanonicalizationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(
    code: string,
    path: string,
    message: string
  ) {
    super(message);
    this.name = 'CanonicalizationError';
    this.code = code;
    this.path = path;
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return `${path}.${key}`;
}

function cloneJson(
  value: unknown,
  path: string,
  ancestors: Set<object>
): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new CanonicalizationError(
        'json.lone-surrogate',
        path,
        'strings must contain valid Unicode scalar sequences'
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        'json.non-finite-number',
        path,
        'numbers must be finite'
      );
    }
    if (Object.is(value, -0)) {
      throw new CanonicalizationError(
        'json.negative-zero',
        path,
        'negative zero is not a canonical JSON number'
      );
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        'json.unsafe-integer',
        path,
        'integer values must be exactly representable'
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError(
      'json.unsupported-value',
      path,
      `unsupported JSON value: ${typeof value}`
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalizationError(
      'json.cycle',
      path,
      'cyclic values are not JSON'
    );
  }
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError(
        'json.symbol-key',
        path,
        'symbol-keyed properties are not JSON'
      );
    }
    if (Array.isArray(value)) {
      const extraKey = Object.keys(value).find(
        (key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length
      );
      if (extraKey !== undefined) {
        throw new CanonicalizationError(
          'json.array-property',
          childPath(path, extraKey),
          'arrays cannot carry named JSON properties'
        );
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) {
          throw new CanonicalizationError(
            'json.sparse-array',
            childPath(path, index),
            'sparse arrays are not canonical JSON'
          );
        }
        result.push(cloneJson(value[index], childPath(path, index), ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        'json.non-plain-object',
        path,
        'only plain JSON objects are supported'
      );
    }
    const result = Object.create(null) as JsonObject;
    for (const key of Object.keys(value)) {
      if (hasLoneSurrogate(key)) {
        throw new CanonicalizationError(
          'json.lone-surrogate',
          childPath(path, key),
          'object keys must contain valid Unicode scalar sequences'
        );
      }
      result[key] = cloneJson(
        (value as Record<string, unknown>)[key],
        childPath(path, key),
        ancestors
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Validate and clone an input into the strict JSON domain used by the wire contract. */
export function toJsonValue(value: unknown): JsonValue {
  return cloneJson(value, '$', new Set());
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(',')}]`;
  }
  const members = Object.keys(value)
    .sort(compareUtf16)
    .map(
      (key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`
    );
  return `{${members.join(',')}}`;
}

/** RFC 8785/JCS serialization for values that pass the contract JSON preflight. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(toJsonValue(value));
}

function asRecord(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function sortArray(
  parent: JsonObject | null,
  key: string,
  identity: (value: JsonValue) => string
): void {
  const value = parent?.[key];
  if (!Array.isArray(value)) return;
  value.sort((left, right) => compareUtf16(identity(left), identity(right)));
}

function stringAt(value: JsonValue, key: string): string {
  const record = asRecord(value);
  return typeof record?.[key] === 'string' ? record[key] : canonicalJson(value);
}

function semanticsIdentity(value: JsonValue): string {
  const record = asRecord(value);
  const semantics = asRecord(record?.semanticsRef ?? value);
  if (!semantics) return canonicalJson(value);
  return `${String(semantics.id)}\u0000${String(semantics.version)}\u0000${String(semantics.contentDigest)}`;
}

function evidenceIdentity(value: JsonValue): string {
  const record = asRecord(value);
  if (!record) return canonicalJson(value);
  if (record.kind === 'session') {
    const session = asRecord(record.sessionRef);
    return `session\u0000${String(session?.harness)}\u0000${String(session?.sourceId)}\u0000${String(session?.sessionId)}\u0000${String(record.contentDigest)}`;
  }
  const artifact = asRecord(record.artifactRef);
  return `artifact\u0000${String(artifact?.harness)}\u0000${String(artifact?.sourceId)}\u0000${String(artifact?.artifactId)}\u0000${String(artifact?.contentDigest)}\u0000${String(artifact?.mediaType ?? '')}`;
}

function normalizeEvidenceArrays(values: JsonValue | undefined): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    const record = asRecord(value);
    sortArray(record, 'evidenceRefs', evidenceIdentity);
  }
}

function normalizeDefinition(root: JsonObject): void {
  const portability = asRecord(root.portability);
  sortArray(portability, 'allowedHarnesses', (value) => String(value));
  sortArray(root, 'requiredCapabilities', semanticsIdentity);
  sortArray(root, 'treatments', (value) => stringAt(value, 'id'));
  if (Array.isArray(root.treatments)) {
    for (const treatment of root.treatments) {
      sortArray(asRecord(treatment), 'interventions', (value) => {
        const record = asRecord(value);
        return `${semanticsIdentity(record?.capability ?? value)}\u0000${String(record?.operation)}\u0000${canonicalJson(record?.value)}`;
      });
    }
  }
  sortArray(root, 'metrics', (value) => stringAt(value, 'id'));
  sortArray(root, 'checks', (value) => stringAt(value, 'id'));
  sortArray(
    asRecord(root.safeguards),
    'relaxationRequests',
    (value) => stringAt(value, 'requestId')
  );
}

function normalizeFingerprint(fingerprint: JsonObject | null): void {
  sortArray(fingerprint, 'factors', (value) => stringAt(value, 'id'));
}

function normalizeRun(root: JsonObject): void {
  normalizeFingerprint(asRecord(root.behaviorFingerprint));
  sortArray(root, 'capabilitySnapshot', semanticsIdentity);
  sortArray(
    root,
    'safeguardAuthorizations',
    (value) => stringAt(value, 'requestId')
  );
  sortArray(root, 'observations', (value) => stringAt(value, 'metricId'));
  normalizeEvidenceArrays(root.observations);
  sortArray(root, 'checkResults', (value) => stringAt(value, 'checkId'));
  normalizeEvidenceArrays(root.checkResults);
  const error = asRecord(root.error);
  sortArray(error, 'evidenceRefs', evidenceIdentity);
}

function normalizeVerdict(root: JsonObject): void {
  const evidence = asRecord(root.evidence);
  sortArray(evidence, 'includedRuns', (value) => stringAt(value, 'runId'));
  sortArray(evidence, 'excludedRuns', (value) => {
    const entry = asRecord(value);
    const run = entry ? asRecord(entry.run) : null;
    return `${String(run?.runId)}\u0000${String(entry?.reason)}`;
  });
  sortArray(
    asRecord(root.evidenceBasis),
    'satisfiedCapabilitySemantics',
    semanticsIdentity
  );
  sortArray(
    asRecord(root.primaryEffect),
    'sampleCounts',
    (value) => stringAt(value, 'treatmentId')
  );
}

/**
 * Normalize only arrays whose order has no contract meaning. Assignment- and
 * extension-owned arrays remain untouched.
 */
export function normalizeDocument(document: unknown): ExperimentDocument {
  const cloned = toJsonValue(document);
  const root = asRecord(cloned);
  if (!root) {
    throw new CanonicalizationError(
      'document.not-object',
      '$',
      'an experiment document must be a JSON object'
    );
  }
  if (root.kind === 'ExperimentDefinition') normalizeDefinition(root);
  else if (root.kind === 'ExperimentRun') normalizeRun(root);
  else if (root.kind === 'ExperimentVerdict') normalizeVerdict(root);
  return root as unknown as ExperimentDocument;
}

export function canonicalDocumentJson(document: unknown): string {
  return serializeCanonical(normalizeDocument(document) as unknown as JsonValue);
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Digest a complete authoritative document after omitting its own digest. */
export function computeDocumentDigest(document: unknown): Sha256Digest {
  const normalized = normalizeDocument(document) as unknown as JsonObject;
  delete normalized.contentDigest;
  return sha256(serializeCanonical(normalized));
}

/** Return a normalized immutable-document candidate with its digest populated. */
export function withDocumentDigest<T extends ExperimentDocument>(document: T): T {
  const normalized = normalizeDocument(document) as T;
  normalized.contentDigest = computeDocumentDigest(normalized);
  return normalized;
}

/** Hash the complete behavior manifest, omitting only its self digest (#2609). */
export function computeBehaviorFingerprintDigest(
  fingerprint: BehaviorFingerprint
): Sha256Digest {
  const cloned = toJsonValue(fingerprint) as JsonObject;
  delete cloned.digest;
  normalizeFingerprint(cloned);
  return sha256(serializeCanonical(cloned));
}

export function withBehaviorFingerprintDigest(
  fingerprint: BehaviorFingerprint
): BehaviorFingerprint {
  const cloned = toJsonValue(fingerprint) as unknown as BehaviorFingerprint;
  cloned.digest = computeBehaviorFingerprintDigest(cloned);
  return cloned;
}
