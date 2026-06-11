import type { Detector } from '../types';
import type { ChurnGeometryFile } from '../../parse-churn-geometry';
import { basename, short } from '../shared';

const MIN_GROSS_LINES = 20;
const MIN_REWORK_DISTANCE = 8;
const MIN_POST_STOP_GROSS_LINES = 8;

function rowScore(file: ChurnGeometryFile): number {
  return (
    file.postStopReeditRanges * 100 +
    file.reeditRanges * 20 +
    file.reworkDistance +
    file.grossLines / 100
  );
}

function isFinding(file: ChurnGeometryFile): boolean {
  if (
    file.postStopReeditRanges > 0 &&
    file.grossLines >= MIN_POST_STOP_GROSS_LINES
  ) {
    return true;
  }
  return file.grossLines >= MIN_GROSS_LINES && file.reworkDistance >= MIN_REWORK_DISTANCE;
}

function formatEvidence(file: ChurnGeometryFile): string {
  return (
    `${short(file.sessionId)} ${basename(file.filePath)}: ` +
    `${file.grossLines} gross lines / ${file.netLines} net, ` +
    `${file.reeditRanges} re-edit range(s), ` +
    `${file.postStopReeditRanges} after stop boundary`
  );
}

export const detector: Detector = {
  id: 'workflow.churn-geometry',
  category: 'workflow',
  dataDeps: ['churnGeometry'],
  rule(input) {
    const sessions = input.churnGeometry ?? [];
    const files = sessions.flatMap((session) => session.files).filter(isFinding);
    if (files.length === 0) return null;

    const ranked = [...files].sort((a, b) => rowScore(b) - rowScore(a));
    const top = ranked[0];
    const severity =
      top.postStopReeditRanges > 0 || top.reworkDistance >= 20 ? 'warning' : 'info';

    return {
      id: 'workflow.churn-geometry',
      category: 'workflow',
      severity,
      title: 'Line-level edit churn points to refactor seams',
      detail:
        `${ranked.length} file(s) show high gross-low-net churn or repeated edits to the same line range after a stop boundary. ` +
        `${basename(top.filePath)} touched ${top.grossLines} gross line(s) for ${top.netLines} net line(s), ` +
        `with ${top.reeditRanges} re-edited range(s) and ${top.postStopReeditRanges} crossing a task boundary.`,
      action:
        'Use these files as refactor-seam candidates: stop earlier after the first working patch, run a focused verification, then extract or simplify the hot range before continuing.',
      affected: ranked.length,
      evidence: ranked.slice(0, 5).map(formatEvidence),
      view: 'files',
    };
  },
};
