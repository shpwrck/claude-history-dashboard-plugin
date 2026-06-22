import type { Detector, RecommendationInput } from '../types';
import { short } from '../shared';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import {
  computeSafetyScores,
  detectDangerousCommands,
  type DangerousCommand,
} from '../../parse-permissions';

interface UnattendedRiskSession {
  sessionId: string;
  entrypoint: string;
  dangerousCount: number;
  modes: string[];
  patterns: string[];
}

function unattendedEntrypoints(input: RecommendationInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const session of input.tokenData) {
    const entrypoint = session.entrypoint;
    if (typeof entrypoint === 'string' && isUnattendedEntrypoint(entrypoint)) {
      out.set(session.sessionId, entrypoint);
    }
  }
  for (const timeline of input.timelines ?? []) {
    const entrypoint = timeline.entrypoint;
    if (
      !out.has(timeline.sessionId) &&
      typeof entrypoint === 'string' &&
      isUnattendedEntrypoint(entrypoint)
    ) {
      out.set(timeline.sessionId, entrypoint);
    }
  }
  return out;
}

function patternsForSession(commands: DangerousCommand[], sessionId: string): string[] {
  return [
    ...new Set(
      commands
        .filter((command) => command.sessionId === sessionId)
        .map((command) => command.pattern)
    ),
  ].sort();
}

export function unattendedRiskSessions(
  input: RecommendationInput
): UnattendedRiskSession[] {
  const unattended = unattendedEntrypoints(input);
  if (unattended.size === 0) return [];

  const dangerous = detectDangerousCommands(input.toolData);
  if (dangerous.length === 0) return [];

  return computeSafetyScores(dangerous, input.permissionRows)
    .filter(
      (score) =>
        score.bypassMode &&
        score.dangerousCount > 0 &&
        unattended.has(score.sessionId)
    )
    .map((score) => ({
      sessionId: score.sessionId,
      entrypoint: unattended.get(score.sessionId) ?? 'sdk-*',
      dangerousCount: score.dangerousCount,
      modes: score.modes,
      patterns: patternsForSession(dangerous, score.sessionId),
    }))
    .sort(
      (a, b) =>
        b.dangerousCount - a.dangerousCount ||
        a.sessionId.localeCompare(b.sessionId)
    );
}

function evidenceRow(session: UnattendedRiskSession): string {
  const patterns = session.patterns.length ? ` (${session.patterns.join(', ')})` : '';
  return `${short(session.sessionId)}, ${session.entrypoint}: ${session.dangerousCount} dangerous bypassed command(s)${patterns}`;
}

export const detector: Detector = {
  id: 'safety.unattended-sessions',
  category: 'safety',
  dataDeps: ['toolData', 'tokenData', 'permissionRows', 'timelines'],
  rule(input) {
    const sessions = unattendedRiskSessions(input);
    if (sessions.length === 0) return null;

    const dangerousCount = sessions.reduce(
      (sum, session) => sum + session.dangerousCount,
      0
    );

    return {
      id: 'safety.unattended-sessions',
      category: 'safety',
      severity: 'critical',
      unattended: true,
      title: 'Unattended sessions ran dangerous bypassed commands',
      detail: `${dangerousCount} dangerous command(s) ran under bypassPermissions across ${sessions.length} unattended sdk-* session(s).`,
      action:
        'Review the unattended sessions before treating them as low-risk. Move recurring destructive patterns behind deny or ask policy, and reserve unattended bypassPermissions for trusted, reversible work.',
      affected: dangerousCount,
      evidence: sessions.slice(0, 5).map(evidenceRow),
      view: 'permissions',
      provenance: {
        observations: [
          {
            claim: `${sessions.length} unattended sdk-* session(s) used bypassPermissions and dangerous Bash commands`,
            source: 'parse-sessions + parse-permissions',
            field: 'tokenData.entrypoint + permissionRows.mode + detectDangerousCommands',
            value: sessions.length,
          },
          {
            claim: `${dangerousCount} dangerous command(s) contributed to unattended risk`,
            source: 'parse-permissions',
            field: 'detectDangerousCommands',
            value: dangerousCount,
          },
        ],
        inference:
          'Dangerous commands are higher-risk when permission prompts are bypassed in unattended SDK sessions because nobody is watching to interrupt the run.',
      },
    };
  },
};
