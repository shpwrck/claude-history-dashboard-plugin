import type { Detector } from '../types';
import { short, MIN_RETRY_GROUP_COUNT } from '../shared';
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
    return {
      id: 'reliability.retry-storms',
      category: 'reliability',
      severity: 'info',
      title: 'Retry storms on failing tools',
      detail: `${groups.length} run(s) of ${MIN_RETRY_GROUP_COUNT}+ back-to-back same-tool calls included errors — the same operation retried repeatedly.`,
      action: 'Check whether a different approach (or fixing the root error once) avoids the retry loop.',
      affected: groups.length,
      evidence: groups
        .slice(0, 5)
        .map((g) => `${short(g.sessionId)}, ${g.toolName} ×${g.count}`),
      view: 'errors',
    };
  },
};
