import type { Detector } from '../types';
import { basename, HIGH_CHURN } from '../shared';
import { topChurnFiles } from '../../parse-files';

/** Files mutated over and over — possible design smell. */
export const detector: Detector = {
  id: 'workflow.file-churn',
  category: 'workflow',
  dataDeps: ['toolData'],
  rule(input) {
    const churn = topChurnFiles(input.toolData).filter((c) => c.churn >= HIGH_CHURN);
    if (churn.length === 0) return null;
    return {
      id: 'workflow.file-churn',
      category: 'workflow',
      severity: 'info',
      title: 'High-churn files',
      detail: `${churn.length} file(s) were edited/written ${HIGH_CHURN}+ times. Heavy churn can signal an unclear interface or repeated trial-and-error.`,
      action: 'Review whether these files need refactoring or clearer up-front specs to reduce rework.',
      affected: churn.length,
      evidence: churn
        .slice(0, 5)
        .map((c) => `${basename(c.filePath)}, ${c.churn} edits / ${c.sessions} sessions`),
      view: 'files',
    };
  },
};
