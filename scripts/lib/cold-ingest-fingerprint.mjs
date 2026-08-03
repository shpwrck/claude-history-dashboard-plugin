import { createHash } from 'node:crypto';

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function updateFramed(hash, value) {
  const json = JSON.stringify(value);
  hash.update(String(Buffer.byteLength(json, 'utf8')));
  hash.update(':');
  hash.update(json);
}

function datasetKeys(sessionSignals) {
  const keys = [];
  const seen = Object.create(null);
  for (const signal of sessionSignals) {
    if (signal.datasetKey && !seen[signal.datasetKey]) {
      seen[signal.datasetKey] = true;
      keys.push(signal.datasetKey);
    }
  }
  for (const key of ['permissionRows', 'permissionChanges', 'entries']) {
    if (!seen[key]) keys.push(key);
  }
  return keys;
}

/**
 * Incrementally fingerprints the exact row and transcript-dataset values for
 * one deterministic worker shard. Only the current row and one hash state per
 * dataset key stay live, so memory does not scale with the shard corpus.
 */
export function createColdIngestFingerprint(sessionSignals) {
  const rowHash = createHash('sha1');
  const datasetStates = Object.fromEntries(
    datasetKeys(sessionSignals).map((key) => [
      key,
      { count: 0, hash: createHash('sha1') },
    ])
  );
  let rows = 0;

  function append(key, value) {
    const state = datasetStates[key];
    if (!state) {
      throw new Error(
        `cold ingest bench: missing dataset fingerprint state for '${key}'`
      );
    }
    updateFramed(state.hash, value);
    state.count += 1;
  }

  return {
    addRow(row) {
      updateFramed(rowHash, { ...row, sig: '<file-signature>' });
      rows += 1;

      for (const signal of sessionSignals) {
        if (signal.aggregate === 'push-truthy') {
          const value =
            signal.parseGuard === 'guarded'
              ? row[signal.column]
                ? JSON.parse(row[signal.column])
                : null
              : JSON.parse(row[signal.column]);
          if (value) append(signal.datasetKey, value);
        } else if (signal.aggregate === 'spread') {
          for (const value of JSON.parse(row[signal.column]) || []) {
            append(signal.datasetKey, value);
          }
        } else if (signal.id === 'perm') {
          const perm = JSON.parse(row[signal.column]) || {
            perModeEntries: [],
            changes: [],
          };
          for (const value of perm.perModeEntries || []) {
            append('permissionRows', value);
          }
          for (const value of perm.changes || []) {
            append('permissionChanges', value);
          }
        } else if (signal.id === 'entries') {
          for (const value of JSON.parse(row[signal.column]) || []) {
            append('entries', value);
          }
        } else {
          throw new Error(
            `cold ingest bench: unhandled session signal '${signal.id}' (aggregate '${signal.aggregate}') — teach createColdIngestFingerprint about it`
          );
        }
      }
    },

    finish() {
      const datasets = Object.entries(datasetStates).map(
        ([key, state]) => ({
          key,
          count: state.count,
          hash: state.hash.digest('hex'),
        })
      );
      return {
        rows,
        rowHash: rowHash.digest('hex'),
        transcriptDatasetHash: sha1(JSON.stringify(datasets)),
      };
    },
  };
}

export function combineColdIngestFingerprints(fingerprints) {
  return {
    rows: fingerprints.reduce((total, fingerprint) => total + fingerprint.rows, 0),
    rowHash: sha1(
      JSON.stringify(
        fingerprints.map(({ rows, rowHash }) => ({ rows, rowHash }))
      )
    ),
    transcriptDatasetHash: sha1(
      JSON.stringify(
        fingerprints.map(({ rows, transcriptDatasetHash }) => ({
          rows,
          transcriptDatasetHash,
        }))
      )
    ),
  };
}
