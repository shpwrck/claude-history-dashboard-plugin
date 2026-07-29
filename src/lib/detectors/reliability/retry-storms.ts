import type { Detector } from '../types';
import { newestIsoDate, short, MIN_RETRY_GROUP_COUNT } from '../shared';
import { detectRetryGroups } from '../../parse-errors';

/** Long back-to-back same-tool runs that hit errors — a retry storm. */
export const detector: Detector = {
  id: 'reliability.retry-storms',
  category: 'reliability',
  dataDeps: ['toolData'],
  rule(input) {
    const groups = detectRetryGroups(input.toolData).filter(
      (g) => g.hasErrors && g.count >= MIN_RETRY_GROUP_COUNT
    );
    if (groups.length === 0) return null;
    const evidence = groups
      .slice(0, 5)
      .map((g) => `${short(g.sessionId)}, ${g.toolName} ×${g.count}`);
    const asOf = newestIsoDate(groups.map((g) => g.endTimestamp));
    return {
      id: 'reliability.retry-storms',
      category: 'reliability',
      severity: 'info',
      title: 'Consecutive same-tool runs include errors',
      detail: `${groups.length} run(s) of ${MIN_RETRY_GROUP_COUNT}+ consecutive same-tool calls included at least one error.`,
      action: 'Check whether a different approach (or fixing the root error once) avoids the retry loop.',
      affected: groups.length,
      evidence,
      view: 'errors',
      provenance: {
        observations: [
          {
            claim: `${groups.length} consecutive same-tool run(s) met the length floor and included an error`,
            source: 'parse-errors (detectRetryGroups over parse-tools)',
            field: 'detectRetryGroups().{count,hasErrors}',
            value: groups.length,
          },
          {
            claim: `the minimum qualifying same-tool run length is ${MIN_RETRY_GROUP_COUNT}`,
            source: 'detectors/shared',
            field: 'MIN_RETRY_GROUP_COUNT',
            value: MIN_RETRY_GROUP_COUNT,
          },
          {
            claim: 'displayed evidence rows identify each session, tool, and run length',
            source: 'parse-errors (detectRetryGroups over parse-tools)',
            field: 'detectRetryGroups().{sessionId,toolName,count}',
          },
        ],
        inference:
          'Consecutive calls to one tool around an error are consistent with retry behavior, ' +
          'but call arguments are not compared, so this does not prove the same operation was repeated.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
