/**
 * reliability.agent-report-card (#572) — the consolidated finding for the
 * Agent Report Card surface. Joins sessions/ (attribution), telemetry/ (retry
 * storms + wasted wall-clock), and debug/ (TTFB + fast-mode-lost) into ONE
 * blended KEEP/FLAG/MOVE verdict per project, then surfaces the projects that
 * are NOT a clean KEEP.
 *
 * This supersedes three would-be standalone findings (sessions, telemetry,
 * debug): the demotion of a committed-but-unreliable project from KEEP to
 * FLAG/MOVE can only fire when attribution and reliability are evaluated in the
 * same row — which is exactly why #561/#562/#569 consolidate here.
 */
import type { Detector } from '../types';
import { basename } from '../shared';
import {
  buildReportCard,
  buildReportCardSessionContext,
} from '../../report-card';

export const detector: Detector = {
  id: 'reliability.agent-report-card',
  category: 'reliability',
  dataDeps: ['sessionRegistry', 'telemetry', 'debugLogs', 'sessions', 'tokenData'],
  rule(input) {
    const card = buildReportCard(
      input.sessionRegistry,
      input.telemetry,
      input.debugLogs,
      buildReportCardSessionContext(input.sessions, input.tokenData)
    );
    if (!card.projects.length) return null;

    const move = card.projects.filter((p) => p.verdict === 'MOVE');
    const flag = card.projects.filter((p) => p.verdict === 'FLAG');
    if (!move.length && !flag.length) return null; // every project is a clean KEEP

    // MOVE is overloaded (#1103): a project is MOVE either because it is
    // committed-with-HEAVY-drag, OR because it is low-signal (<=2 sessions) —
    // which carries NO drag (dragScore 0 / bucket OK). Splitting them keeps the
    // detail honest: a low-signal MOVE must NOT be described as "heavy
    // reliability drag". `low-signal` MOVE rows are classified by attribution;
    // the rest are the committed-HEAVY ones blend() routes to MOVE.
    const moveLowSignal = move.filter((p) => p.attributionBucket === 'low-signal');
    const moveHeavy = move.filter((p) => p.attributionBucket !== 'low-signal');
    const flagNoSignal = flag.filter((p) => p.sessionsWithSignal === 0);

    const severity = move.length ? 'warning' : 'info';
    const flagged = [...move, ...flag];
    const evidence = flagged
      .slice(0, 6)
      .map(
        (p) =>
          `${basename(p.cwd) || p.cwd}: ${p.verdict} — ${p.dominantEntrypoint} ${p.dominantShare}% / drag ${p.dragScore} (${p.dragBucket}); reliability ${p.sessionsWithSignal}/${p.sessionCount} sessions`
      );

    return {
      id: 'reliability.agent-report-card',
      category: 'reliability',
      severity,
      title: 'Agent Report Card: some projects aren’t a clean KEEP',
      detail:
        `Joined attribution (sessions) with reliability (telemetry + debug) across ${card.totalProjects} project(s): ` +
        `${card.tally.KEEP} KEEP, ${card.tally.FLAG} FLAG, ${card.tally.MOVE} MOVE. ` +
        `Fleet retry-storm rate ${card.fleetRetryStormPct}%, ${Math.round(card.fleetWastedMs / 1000)}s dead wall-clock. ` +
        (move.length
          ? [
              moveHeavy.length
                ? `${moveHeavy.length} project(s) carry heavy reliability drag despite committed attribution`
                : '',
              moveLowSignal.length
                ? `${moveLowSignal.length} project(s) have too little evidence (<=2 sessions) to trust — pilot elsewhere`
                : '',
            ]
              .filter(Boolean)
              .join('; ') + '.'
          : [
              flagNoSignal.length
                ? `${flagNoSignal.length} project(s) have committed attribution but no joined reliability samples`
                : '',
              flag.length - flagNoSignal.length > 0
                ? `${flag.length - flagNoSignal.length} project(s) need a reliability fix or a CLI decision before trusting their cost`
                : '',
            ]
              .filter(Boolean)
              .join('; ') + '.'),
      action:
        'Open the Agent Report Card. For MOVE projects the CLI is actively expensive here; for FLAG, fix the reliability tax (or pick one entrypoint) before trusting per-task cost.',
      affected: flagged.length,
      view: 'report-card',
      evidence,
    };
  },
};
