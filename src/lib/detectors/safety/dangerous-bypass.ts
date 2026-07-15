import type {
  Detector,
  RecFix,
  RecObservation,
  RecProvenance,
  RecSeverity,
} from '../types';
import {
  allowShadowedByDeny,
  bumpSeverity,
  short,
  STALE_WEEKS,
} from '../shared';
import { isAsOfStale } from '../provenance';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import {
  computeSafetyScores,
  DANGEROUS_PATTERN_RULES,
  detectDangerousCommands,
} from '../../parse-permissions';
import type { DangerousCommand } from '../../parse-permissions';
import type { LiveConfig } from '../../../types';

const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type ProtectionMode = 'bypass' | 'warning';

interface ProtectionContext {
  rules: string[];
  unmappablePatterns: string[];
  unknownObservedPatterns: string[];
  coveredByWholeTool: boolean;
  unmatchedObservedPatterns: string[];
  settingsAvailable: boolean;
  settingsUnavailableReason?: 'absent' | 'unhealthy';
  coveredRules: string[];
  missingRules: string[];
}

interface ParserContext {
  totalCount: number;
  highCertaintyCount: number;
}

interface TemporalContext {
  asOf?: string;
  stale: boolean;
  plausibleTimestampCount: number;
  historyLead: string;
}

function plausibleRfc3339Ms(
  timestamp: string,
  now: number,
  hasUsableNow: boolean
): number | null {
  if (!RFC3339.test(timestamp)) return null;
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(5, 7));
  const day = Number(timestamp.slice(8, 10));
  const hour = Number(timestamp.slice(11, 13));
  const minute = Number(timestamp.slice(14, 16));
  const second = Number(timestamp.slice(17, 19));
  const daysInMonth =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  if (hasUsableNow && ms > now + MAX_FUTURE_SKEW_MS) return null;
  return ms;
}

function dangerousEvidence(d: DangerousCommand): string {
  return `${short(d.sessionId)}, ${d.pattern}: ${d.command}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function configuredRulesCover(
  settings: LiveConfig['settings'] | null | undefined,
  bucket: 'ask' | 'deny',
  requiredRule: string
): boolean {
  const configured = settings?.permissions?.[bucket];
  if (!Array.isArray(configured)) return false;
  return configured.some(
    (candidate) =>
      typeof candidate === 'string' &&
      // `allowShadowedByDeny(required, configured)` answers the same set
      // containment question we need here: every command matched by the
      // required rule is also matched by the configured one. That includes a
      // broader Bash prefix and a bare Bash rule, not just string equality.
      allowShadowedByDeny(requiredRule, candidate)
  );
}

function observedMappedRules(
  command: DangerousCommand
): { mapped: boolean; rules: string[] | null } {
  const mapped = Object.hasOwn(DANGEROUS_PATTERN_RULES, command.pattern)
    ? DANGEROUS_PATTERN_RULES[command.pattern]
    : undefined;
  if (!Array.isArray(mapped) || mapped.length === 0) {
    return { mapped: false, rules: [] };
  }

  return {
    mapped: true,
    // Parser-owned truth is derived from the full raw invocation before bulk
    // ingest strips it. `null` is legacy/invalid unknown truth; an empty array
    // is a positive non-match. Neither can fabricate coverage from a preview,
    // but downstream copy must preserve the distinction for auditability.
    rules: command.matchingRules,
  };
}

function patternSummary(commands: DangerousCommand[]): string {
  const counts = new Map<string, number>();
  for (const command of commands) {
    counts.set(command.pattern, (counts.get(command.pattern) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => `${pattern}=${count}`)
    .join(', ');
}

/**
 * Reconcile only the settings rules mapped from patterns that contributed to
 * this branch. A bypassed command is covered only by deny; a prompted command
 * is covered by ask or the stronger deny. An absent live snapshot means
 * coverage is unknown, not missing.
 */
function protectionContext(
  commands: DangerousCommand[],
  mode: ProtectionMode,
  liveConfig: LiveConfig | null | undefined
): ProtectionContext {
  const rules: string[] = [];
  const unmappablePatterns: string[] = [];
  const unknownObservedPatterns: string[] = [];
  const unmatchedObservedPatterns: string[] = [];
  for (const command of commands) {
    const observed = observedMappedRules(command);
    if (!observed.mapped) {
      unmappablePatterns.push(command.pattern);
      continue;
    }
    if (observed.rules === null) {
      unknownObservedPatterns.push(command.pattern);
      continue;
    }
    if (observed.rules.length === 0) {
      unmatchedObservedPatterns.push(command.pattern);
      continue;
    }
    rules.push(...observed.rules);
  }

  const dedupedRules = unique(rules);
  const settingsUnavailableReason =
    liveConfig == null
      ? 'absent'
      : liveConfig.settingsHealth?.ok === false
        ? 'unhealthy'
        : undefined;
  const settingsAvailable = settingsUnavailableReason === undefined;
  const settings = liveConfig?.settings;
  const coveredByWholeTool =
    settingsAvailable &&
    (configuredRulesCover(settings, 'deny', 'Bash') ||
      (mode === 'warning' && configuredRulesCover(settings, 'ask', 'Bash')));
  const coveredRules = settingsAvailable
    ? dedupedRules.filter(
        (rule) =>
          configuredRulesCover(settings, 'deny', rule) ||
          (mode === 'warning' &&
            configuredRulesCover(settings, 'ask', rule))
      )
    : [];
  const covered = new Set(coveredRules);
  const missingRules = settingsAvailable
    ? dedupedRules.filter((rule) => !covered.has(rule))
    : [];

  return {
    rules: dedupedRules,
    unmappablePatterns: unique(unmappablePatterns),
    unknownObservedPatterns: unique(unknownObservedPatterns),
    coveredByWholeTool,
    unmatchedObservedPatterns: unique(unmatchedObservedPatterns),
    settingsAvailable,
    ...(settingsUnavailableReason ? { settingsUnavailableReason } : {}),
    coveredRules,
    missingRules,
  };
}

function protectionFullyCovered(protection: ProtectionContext): boolean {
  return (
    protection.settingsAvailable &&
    protection.missingRules.length === 0 &&
    (protection.coveredByWholeTool ||
      (protection.unmappablePatterns.length === 0 &&
        protection.unknownObservedPatterns.length === 0 &&
        protection.unmatchedObservedPatterns.length === 0))
  );
}

function hasUncoveredNonPrefixableEvidence(
  protection: ProtectionContext
): boolean {
  return (
    !protection.coveredByWholeTool &&
    (protection.unmappablePatterns.length > 0 ||
      protection.unknownObservedPatterns.length > 0 ||
      protection.unmatchedObservedPatterns.length > 0)
  );
}

function temporalContext(
  commands: DangerousCommand[],
  now: number
): TemporalContext {
  const hasUsableNow = Number.isFinite(now) && now > 0;
  const plausible = commands
    .map((command) =>
      plausibleRfc3339Ms(command.timestamp, now, hasUsableNow)
    )
    .filter((ms): ms is number => ms !== null);

  if (plausible.length !== commands.length || plausible.length === 0) {
    return {
      stale: false,
      plausibleTimestampCount: plausible.length,
      historyLead: 'The available command history recorded',
    };
  }

  const newest = Math.max(...plausible);
  const asOf = new Date(newest).toISOString().slice(0, 10);
  const stale = hasUsableNow
    ? isAsOfStale(asOf, now, STALE_WEEKS * 7)
    : false;
  return {
    asOf,
    stale,
    plausibleTimestampCount: plausible.length,
    historyLead: stale
      ? `As of ${asOf}, the available command history contained`
      : `Through ${asOf}, the available command history recorded`,
  };
}

function coverageDetail(
  protection: ProtectionContext,
  mode: ProtectionMode
): string {
  if (!protection.settingsAvailable) {
    return (
      (protection.settingsUnavailableReason === 'unhealthy'
        ? 'Current settings coverage was unavailable because settings validation was unhealthy at ingest, so this finding '
        : 'Current settings coverage was unavailable at ingest, so this finding ') +
      'does not assert which protections are missing and emits no settings snippet.'
    );
  }

  const coverageKind = mode === 'bypass' ? 'deny' : 'ask-or-deny';
  const mapped = protection.coveredByWholeTool
    ? `Current merged settings include a whole-tool Bash ${coverageKind} rule, which covers every contributing Bash invocation.`
    : protection.rules.length
      ? `Current merged settings cover ${protection.coveredRules.length} of ${protection.rules.length} relevant mapped ${coverageKind} rule(s); ${protection.missingRules.length} remain missing.`
      : protection.unknownObservedPatterns.length
        ? 'Current settings coverage could not be fully evaluated because contributing invocations lack usable permission-prefix truth.'
        : protection.unmatchedObservedPatterns.length
          ? 'No contributing observed Bash invocation has a safely applicable canonical prefix rule.'
          : 'No contributing pattern has a safe Bash prefix-rule mapping.';
  const unmappable = protection.unmappablePatterns.length
    ? ` No safe prefix rule is known for: ${protection.unmappablePatterns.join(', ')}.`
    : '';
  const unknown = protection.unknownObservedPatterns.length
    ? protection.coveredByWholeTool
      ? ` Permission-prefix truth was unavailable for: ${protection.unknownObservedPatterns.join(', ')}, but a current whole-tool Bash ${coverageKind} rule covers every Bash invocation.`
      : ` Permission-prefix truth was unavailable for: ${protection.unknownObservedPatterns.join(', ')}; legacy or malformed persisted data was not treated as a proven non-match.`
    : '';
  const unmatched = protection.unmatchedObservedPatterns.length
    ? ` No canonical mapped prefix rule matched the observed Bash invocation for: ${protection.unmatchedObservedPatterns.join(', ')}.`
    : '';
  return `${mapped}${unmappable}${unknown}${unmatched}`;
}

function settingsFix(
  protection: ProtectionContext,
  mode: ProtectionMode
): RecFix | undefined {
  if (!protection.settingsAvailable || protection.missingRules.length === 0) {
    return undefined;
  }

  const bucket = mode === 'bypass' ? 'deny' : 'ask';
  const coveredNote = protection.coveredRules.length
    ? ` Current settings already cover: ${protection.coveredRules.join(', ')}.`
    : '';
  const broadNotes: string[] = [];
  if (
    protection.missingRules.some(
      (rule) => rule === 'Bash(curl:*)' || rule === 'Bash(wget:*)'
    )
  ) {
    broadNotes.push(
      'Bash(curl:*) and Bash(wget:*) apply to every invocation, not only pipe-to-shell commands'
    );
  }
  if (protection.missingRules.includes('Bash(chmod:*)')) {
    broadNotes.push(
      'Bash(chmod:*) applies to every chmod invocation, not only chmod 777'
    );
  }
  const broadNote = broadNotes.length
    ? ` These command-prefix rules are broader than the cited evidence: ${broadNotes.join('; ')}. Review them before merging.`
    : '';
  const unmappableNote = protection.unmappablePatterns.length
    ? ` No safe prefix rule exists for ${protection.unmappablePatterns.join(', ')}; this snippet does not claim to protect those observations.`
    : '';
  const unknownNote =
    protection.unknownObservedPatterns.length &&
    !protection.coveredByWholeTool
    ? ` Permission-prefix truth is unavailable for ${protection.unknownObservedPatterns.join(', ')}; this snippet does not claim to protect those observations.`
    : '';
  const unmatchedNote = protection.unmatchedObservedPatterns.length
    ? ` No canonical mapped prefix rule matches the observed Bash invocation for ${protection.unmatchedObservedPatterns.join(', ')}; this snippet does not claim to protect those observations.`
    : '';

  return {
    target: 'settings.json',
    label:
      mode === 'bypass'
        ? 'Add missing observed-pattern deny rules'
        : 'Confirm missing observed dangerous patterns',
    note:
      `Manually deep-merge only the listed "${bucket}" rules into the "permissions" object in ~/.claude/settings.json.` +
      coveredNote +
      broadNote +
      unmappableNote +
      unknownNote +
      unmatchedNote,
    snippet: JSON.stringify(
      { permissions: { [bucket]: protection.missingRules } },
      null,
      2
    ),
    fixKind: 'manual',
  };
}

function provenance(
  commands: DangerousCommand[],
  protection: ProtectionContext,
  temporal: TemporalContext,
  mode: ProtectionMode,
  parser: ParserContext,
  riskySessionCount = 0
): RecProvenance {
  const patterns = patternSummary(commands);
  const observations: RecObservation[] = [
    {
      claim: `detectDangerousCommands returned ${parser.totalCount} total record(s); ${parser.highCertaintyCount} passed the certainty=high gate`,
      source: 'parse-permissions.detectDangerousCommands(toolData)',
      field:
        'toolData[].calls[].commandDangerousPattern / commandDangerousCertainty, or input.command classifier fallback',
      value: `${parser.highCertaintyCount}/${parser.totalCount}`,
    },
    {
      claim: `${commands.length} high-certainty record(s) contributed to this ${mode} branch with pattern values ${patterns}`,
      source: 'safety.dangerous-bypass branch selection',
      field:
        mode === 'bypass'
          ? 'computeSafetyScores(...).bypassMode / DangerousCommand.sessionId'
          : 'high-certainty records not handled by the bypass branch',
      value: commands.length,
    },
    {
      claim: `${commands.filter((command) => command.matchingRules !== null).length} of ${commands.length} contributing record(s) had usable dangerous permission-prefix truth`,
      source: 'parse-permissions.detectDangerousCommands(toolData)',
      field:
        'toolData[].calls[].input.command or commandDangerousRuleMatches',
      value: `${commands.filter((command) => command.matchingRules !== null).length}/${commands.length}`,
    },
    {
      claim: `${temporal.plausibleTimestampCount} of ${commands.length} contributing call timestamp(s) passed the detector's RFC3339/calendar/future-skew check`,
      source: '~/.claude/projects/<slug>/<sessionId>.jsonl via parse-tools',
      field: 'toolData[].calls[].timestamp',
      value: `${temporal.plausibleTimestampCount}/${commands.length}`,
    },
  ];

  if (mode === 'bypass') {
    observations.push({
      claim: `${riskySessionCount} contributing session(s) had at least one permissionRows mode=bypassPermissions`,
      source: '~/.claude/projects/<slug>/<sessionId>.jsonl via parse-permissions',
      field: 'computeSafetyScores(...).bypassMode from permissionRows[].mode',
      value: riskySessionCount,
    });
  }
  if (protection.settingsAvailable && protection.rules.length > 0) {
    observations.push({
      claim: `${protection.coveredRules.length} of ${protection.rules.length} mapped relevant rule string(s) are covered by current ${mode === 'bypass' ? 'deny' : 'ask-or-deny'} arrays`,
      source: 'merged ~/.claude/settings*.json via liveConfig',
      field:
        mode === 'bypass'
          ? 'settings.permissions.deny'
          : 'settings.permissions.ask / settings.permissions.deny',
      value: `${protection.coveredRules.length}/${protection.rules.length}`,
    });
  } else if (!protection.settingsAvailable) {
    observations.push(
      protection.settingsUnavailableReason === 'unhealthy'
        ? {
            claim:
              'Live settings coverage was not evaluated because settings validation was unhealthy',
            source: 'liveConfig.settingsHealth',
            field: 'settingsHealth.ok',
            value: 'false',
          }
        : {
            claim: 'No liveConfig snapshot was supplied to this detector run',
            source: 'buildRecommendations RecommendationInput',
            field: 'liveConfig',
            value: 'absent',
          }
    );
  }
  if (protection.unmappablePatterns.length) {
    observations.push({
      claim: `No own-property DANGEROUS_PATTERN_RULES entry is registered for pattern values: ${protection.unmappablePatterns.join(', ')}`,
      source: 'parse-permissions',
      field: 'DANGEROUS_PATTERN_RULES',
      value: protection.unmappablePatterns.join(', '),
    });
  }
  if (protection.unknownObservedPatterns.length) {
    observations.push({
      claim: `Dangerous permission-prefix truth was unavailable for pattern values: ${protection.unknownObservedPatterns.join(', ')}`,
      source: 'parse-permissions.detectDangerousCommands(toolData)',
      field:
        'toolData[].calls[].input.command or commandDangerousRuleMatches',
      value: protection.unknownObservedPatterns.join(', '),
    });
    if (protection.coveredByWholeTool) {
      observations.push({
        claim: `A current whole-tool Bash ${mode === 'bypass' ? 'deny' : 'ask-or-deny'} rule covers records whose exact permission-prefix truth is unavailable`,
        source: 'merged ~/.claude/settings*.json via liveConfig',
        field:
          mode === 'bypass'
            ? 'settings.permissions.deny'
            : 'settings.permissions.ask / settings.permissions.deny',
        value: 'Bash',
      });
    }
  }
  if (protection.unmatchedObservedPatterns.length) {
    observations.push({
      claim: `Canonical mappings exist but none matched the observed Bash invocation for pattern values: ${protection.unmatchedObservedPatterns.join(', ')}`,
      source: 'parse-permissions / live toolData',
      field:
        'toolData[].calls[].input.command or commandDangerousRuleMatches / DANGEROUS_PATTERN_RULES',
      value: protection.unmatchedObservedPatterns.join(', '),
    });
  }
  if (temporal.asOf) {
    observations.push({
      claim: `The newest contributing command was recorded on ${temporal.asOf}`,
      source: '~/.claude/projects/<slug>/<sessionId>.jsonl via parse-tools',
      field: 'toolData[].calls[].timestamp',
      value: temporal.asOf,
    });
  }

  return {
    observations,
    inference:
      'The classifier treats commandDangerousCertainty=high calls as dangerous evidence. Candidate protections are limited to canonical pattern rules that match the observed Bash invocation under the repository permission matcher. Coverage uses permission-rule containment, so a broader configured prefix or bare Bash rule covers a narrower requirement: deny is required for bypassed commands, while ask or stronger deny covers the warning branch. An unavailable persisted match set is unknown, while an empty validated set is a proven non-match; neither is used to fabricate a settings rule. A current whole-tool Bash rule can still prove coverage for unknown, non-prefixable, or unmappable observations because it covers every Bash invocation. A missing pattern mapping otherwise remains visible without a fabricated settings rule.',
    ...(temporal.asOf
      ? { asOf: temporal.asOf, stale: temporal.stale }
      : {}),
  };
}

/**
 * Dangerous commands that ran while permission prompts were bypassed.
 *
 * DUAL-EMIT: this detector's `id` is `safety.dangerous-bypass`, but its rule
 * body emits `safety.dangerous-commands` on its second branch (dangerous
 * commands present but not under bypass). Both branches share one detector; see
 * the shared DUAL_EMIT allowlist in ../dual-emit.
 */
export const detector: Detector = {
  id: 'safety.dangerous-bypass',
  category: 'safety',
  dataDeps: ['toolData', 'tokenData', 'permissionRows', 'liveConfig'],
  rule(input, now) {
    // Gate on HIGH-certainty (#2011): scoped/reversible rm -rf (./.worktrees,
    // /tmp scratch, …) and the statically-medium `dd if=` pattern do not drive
    // this CRITICAL finding or its warning sibling.
    const parsedDangerous = detectDangerousCommands(input.toolData);
    const dangerous = parsedDangerous.filter(
      (command) => command.certainty === 'high'
    );
    if (dangerous.length === 0) return null;

    const unattendedSessions = new Set(
      input.tokenData
        .filter((data) => isUnattendedEntrypoint(data.entrypoint))
        .map((data) => data.sessionId)
    );
    const ranUnattended = (commands: { sessionId: string }[]) =>
      commands.some((command) => unattendedSessions.has(command.sessionId));

    const scores = computeSafetyScores(dangerous, input.permissionRows);
    const risky = scores.filter(
      (score) => score.bypassMode && score.dangerousCount > 0
    );
    let warningCommands = dangerous;
    if (risky.length > 0) {
      const riskySessions = new Set(risky.map((score) => score.sessionId));
      const contributing = dangerous.filter((command) =>
        riskySessions.has(command.sessionId)
      );
      const protection = protectionContext(
        contributing,
        'bypass',
        input.liveConfig
      );
      const bypassCovered = protectionFullyCovered(protection);
      if (bypassCovered) {
        warningCommands = dangerous.filter(
          (command) => !riskySessions.has(command.sessionId)
        );
        if (warningCommands.length === 0) return null;
      } else {
        const temporal = temporalContext(contributing, now);
        const bumped = ranUnattended(contributing);
        const unattendedCount = contributing.filter((command) =>
          unattendedSessions.has(command.sessionId)
        ).length;
        const baseSeverity: RecSeverity = 'critical';
        const unattendedNote = unattendedCount
          ? ` ${unattendedCount} of these ran in unattended sdk-* session(s).`
          : '';
        const staleAction = temporal.stale
          ? 'Re-check whether this historical pattern still applies. '
          : '';
        const fix = settingsFix(protection, 'bypass');

        return {
          id: 'safety.dangerous-bypass',
          category: 'safety',
          severity: bumped ? bumpSeverity(baseSeverity) : baseSeverity,
          unattended: bumped,
          ...(unattendedCount ? { unattendedCount } : {}),
          title: 'Dangerous commands ran under bypassed permissions',
          detail:
            `${temporal.historyLead} ${contributing.length} high-certainty dangerous command(s) in ${risky.length} session(s) that used bypassPermissions.${unattendedNote} ` +
            coverageDetail(protection, 'bypass'),
          action:
            staleAction +
            'Reserve bypassPermissions for trusted, reversible work; review the cited commands and verify current protections. ' +
            (hasUncoveredNonPrefixableEvidence(protection)
              ? 'Handle patterns without a proven applicable prefix rule with a reviewed hook or operational control rather than inventing one.'
              : 'Manually add only the missing observed-pattern deny rules, if any.'),
          affected: contributing.length,
          evidence: contributing.slice(0, 5).map(dangerousEvidence),
          view: 'permissions',
          claimClass: 'accounting',
          proofTier: 'accounting',
          provenance: provenance(
            contributing,
            protection,
            temporal,
            'bypass',
            {
              totalCount: parsedDangerous.length,
              highCertaintyCount: dangerous.length,
            },
            risky.length
          ),
          ...(fix ? { fix } : {}),
        };
      }
    }

    const protection = protectionContext(
      warningCommands,
      'warning',
      input.liveConfig
    );
    if (protectionFullyCovered(protection)) {
      return null;
    }

    const temporal = temporalContext(warningCommands, now);
    const commandsBumped = ranUnattended(warningCommands);
    const commandsBaseSeverity: RecSeverity = 'warning';
    const staleAction = temporal.stale
      ? 'Re-check whether this historical pattern still applies. '
      : '';
    const fix = settingsFix(protection, 'warning');
    return {
      id: 'safety.dangerous-commands',
      category: 'safety',
      severity: commandsBumped
        ? bumpSeverity(commandsBaseSeverity)
        : commandsBaseSeverity,
      unattended: commandsBumped,
      title: 'Dangerous command patterns detected',
      detail:
        `${temporal.historyLead} ${warningCommands.length} high-certainty dangerous command(s). ` +
        coverageDetail(protection, 'warning'),
      action:
        staleAction +
        'Spot-check these were intentional and verify current protections. ' +
        (hasUncoveredNonPrefixableEvidence(protection)
          ? 'Handle patterns without a proven applicable prefix rule with a reviewed hook or operational control rather than inventing one.'
          : 'Manually add only the missing observed-pattern ask rules, if any.'),
      affected: warningCommands.length,
      evidence: warningCommands.slice(0, 5).map(dangerousEvidence),
      view: 'permissions',
      claimClass: 'accounting',
      proofTier: 'accounting',
      provenance: provenance(
        warningCommands,
        protection,
        temporal,
        'warning',
        {
          totalCount: parsedDangerous.length,
          highCertaintyCount: dangerous.length,
        }
      ),
      ...(fix ? { fix } : {}),
    };
  },
};
