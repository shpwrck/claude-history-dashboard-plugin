import type {
  AppliedMarkers,
  Detector,
  RecFix,
  RecObservation,
  Recommendation,
} from '../types';
import {
  classifyDurableCommand,
  type DurableCommandKind,
  type ToolCall,
  type ToolUsageData,
} from '../../parse-tools';
import { observeLeaveBehindWrite } from '../../leave-behind';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import { isRediscoveryText } from '../../parse-timeline';
import { claudeMdMarksApplied, short } from '../shared';

/**
 * workflow.value-of-agent-handoff (#2312, epic #2281).
 *
 * This is the agent->human inverse of `workflow.human-input-leverage`: measure
 * where an agent established durable external state but left no committed leave-behind evidence,
 * then a later session had to rediscover the setup. The v1 detector is a
 * mechanism plus hypothesis, not a proven time-saving claim:
 *
 * - PRE-SIGNAL (accounting): a session made a durable-state mutation without
 *   committed-at-HEAD leave-behind evidence. A transcript-only structural Write
 *   remains a candidate because transcript data cannot prove Git state.
 * - RE-DISCOVERY (accounting when present): a later session in the same project
 *   spends its early turns asking "where/how was this set up?" and is billed
 *   back to the prior no-leave-behind durable-state session.
 * - TIME VALUE (hypothesis): `estTimeReclaimedMin` floors each missing-handoff
 *   session and rediscovery burst at 15 minutes, using the observed burst span
 *   when longer. The wording does not call the minutes proven.
 *
 * The detector reads only existing local artifacts: `toolData` for durable
 * mutations and structural leave-behind candidates, `timelines` for rediscovery language, and
 * `sessions`/`tokenData` for the project/task-class join. It cites the #1926 /
 * #1928 attribution substrate via the existing token/tool fields instead of
 * rebuilding attribution.
 */

const DETECTOR_ID = 'workflow.value-of-agent-handoff';
const CANDIDATE_VERIFICATION_ID = 'workflow.leave-behind-candidate-verification';

const CONSERVATIVE_PRESET_MIN = 15;
const REDISCOVERY_WINDOW_MS = 20 * 60 * 1000;
const REDISCOVERY_MIN_HITS = 2;
const FRESHNESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const MARKERS: AppliedMarkers = {
  headings: [
    /^##\s+(?:Agent handoff|Handoff artifacts|Durable state handoff|Runbooks for durable state)\b/i,
  ],
  bodyPhrases: ['durable external state changes need a handoff artifact'],
};

interface DurableMutation {
  sessionId: string;
  taskClass: string;
  timestampMs: number | null;
  date: string | null;
  toolUseId: string;
  order: number;
  kind: DurableCommandKind;
  label: string;
  field: string;
}

interface PreSignal {
  sessionId: string;
  taskClass: string;
  mutations: DurableMutation[];
  structuralCandidatePaths: string[];
  leaveBehindDecisions: LeaveBehindDecision[];
  latestMs: number | null;
  latestDate: string | null;
}

interface RediscoveryBurst {
  sessionId: string;
  taskClass: string;
  startMs: number;
  endMs: number;
  date: string;
  hits: number;
  earlyEntries: number;
  /**
   * The ACTUAL observed span of the rediscovery burst in minutes (last hit minus
   * session start), rounded, floored only at 0. This is the measurement — it is
   * NOT floored at the conservative preset, so anything labeled observed/billed/
   * provenance reports the real number even for a sub-15-minute burst. The
   * 15-minute preset floor lives solely in the clearly-labeled hypothesis total
   * (see {@link buildRollups}), never here (adversarial-review finding #2).
   */
  observedMinutes: number;
  sample: string;
}

interface BilledRediscovery {
  priorSessionId: string;
  burst: RediscoveryBurst;
}

interface ClassRollup {
  taskClass: string;
  preSignals: PreSignal[];
  rediscoveries: BilledRediscovery[];
  estimatedMinutes: number;
  latestMs: number | null;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function commandText(call: ToolCall): { text: string; field: string } | null {
  if (typeof call.input.command === 'string' && call.input.command.trim()) {
    return { text: call.input.command, field: 'input.command' };
  }
  if (typeof call.commandPreview === 'string' && call.commandPreview.trim()) {
    return { text: call.commandPreview, field: 'commandPreview' };
  }
  return null;
}

function projectBySession(input: Parameters<Detector['rule']>[0]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of input.sessions ?? []) {
    if (s.sessionId && s.project) out.set(s.sessionId, s.project);
  }
  for (const t of input.tokenData ?? []) {
    if (t.sessionId && t.project && !out.has(t.sessionId)) out.set(t.sessionId, t.project);
  }
  return out;
}

function taskClassOf(sessionId: string, projects: Map<string, string>): string {
  return projects.get(sessionId) ?? 'unknown-project';
}

const DURABLE_COMMAND_KINDS = new Set<DurableCommandKind>([
  'remote-state',
  'generated-config',
  'multi-step-install',
]);

function isDurableCommandKind(value: unknown): value is DurableCommandKind {
  return (
    typeof value === 'string' &&
    DURABLE_COMMAND_KINDS.has(value as DurableCommandKind)
  );
}

function classifyDurableMutation(call: ToolCall): {
  kind: DurableCommandKind;
  label: string;
  field: string;
} | null {
  if (call.toolName !== 'Bash') return null;
  const cmd = commandText(call);
  if (isDurableCommandKind(call.commandDurableKind)) {
    const previewMatchesKind =
      cmd && classifyDurableCommand(cmd.text) === call.commandDurableKind;
    return {
      kind: call.commandDurableKind,
      label: previewMatchesKind
        ? cmd.text
        : 'full Bash command (body omitted)',
      field: 'commandDurableKind',
    };
  }
  if (cmd) {
    const kind = classifyDurableCommand(cmd.text);
    if (kind) return { kind, label: cmd.text, field: cmd.field };
  }
  return null;
}

interface CrossSessionTransition {
  sessionId: string;
  project: string;
  key: string;
  timestampMs: number | null;
  order: number;
  toolUseId: string;
  toolName: string;
  path: string;
  status: 'candidate' | 'invalidated';
}

interface LeaveBehindDecision {
  key: string;
  path: string;
  outcome: 'candidate' | 'invalidated' | 'ambiguous';
  transitions: CrossSessionTransition[];
}

function collectPreSignals(
  toolData: ToolUsageData[],
  projects: Map<string, string>
): PreSignal[] {
  const leaveBehindStateBySession = new Map<
    string,
    Map<
      string,
      {
        status: 'candidate' | 'invalidated';
        order: number;
        path: string;
        timestampMs: number | null;
        transition?: CrossSessionTransition;
      }
    >
  >();
  const mutationsBySession = new Map<string, DurableMutation[]>();
  const crossSessionTransitions: CrossSessionTransition[] = [];

  for (const session of toolData) {
    const leaveBehindState = new Map<
      string,
      {
        status: 'candidate' | 'invalidated';
        order: number;
        path: string;
        timestampMs: number | null;
        transition?: CrossSessionTransition;
      }
    >();
    for (const [order, call] of (session.calls ?? []).entries()) {
      const transition = observeLeaveBehindWrite(call);
      if (transition) {
        const transitionMs = parseMs(call.timestamp);
        const project = projects.get(session.sessionId);
        const observedTransition =
          project
            ? {
                sessionId: session.sessionId,
                project,
                key: transition.key,
                timestampMs: transitionMs,
                order,
                toolUseId: call.toolUseId,
                toolName: call.toolName,
                path: transition.path,
                status: transition.status,
              }
            : undefined;
        leaveBehindState.set(
          transition.key,
          {
            status: transition.status,
            order,
            path: transition.path,
            timestampMs: transitionMs,
            ...(observedTransition ? { transition: observedTransition } : {}),
          }
        );
        if (observedTransition) crossSessionTransitions.push(observedTransition);
      }
      // A failed or result-less attempt is not evidence that durable state
      // changed. Requiring the observed successful result keeps mutation order
      // and booked savings auditable instead of letting a later failed command
      // invalidate an otherwise final leave-behind candidate.
      if (call.isError !== false) continue;
      const classified = classifyDurableMutation(call);
      if (!classified) continue;
      const ms = parseMs(call.timestamp);
      const mutation: DurableMutation = {
        sessionId: session.sessionId,
        taskClass: taskClassOf(session.sessionId, projects),
        timestampMs: ms,
        date: ms == null ? null : isoDate(ms),
        toolUseId: call.toolUseId,
        order,
        kind: classified.kind,
        label: classified.label,
        field: `ToolCall.${classified.field}`,
      };
      const arr = mutationsBySession.get(session.sessionId) ?? [];
      arr.push(mutation);
      mutationsBySession.set(session.sessionId, arr);
    }
    if (leaveBehindState.size > 0) {
      leaveBehindStateBySession.set(session.sessionId, leaveBehindState);
    }
  }

  const signals: PreSignal[] = [];
  for (const [sessionId, mutations] of mutationsBySession) {
    const latestMutationOrder = Math.max(...mutations.map((mutation) => mutation.order));
    const project = projects.get(sessionId);
    const finalStates = [
      ...(leaveBehindStateBySession.get(sessionId) ?? []),
    ].filter(([, state]) => state.order > latestMutationOrder);
    const leaveBehindDecisions: LeaveBehindDecision[] = [];
    const structuralCandidatePaths: string[] = [];
    for (const [key, state] of finalStates) {
      const candidateTimestampMs = state.timestampMs;
      const laterTransitions =
        project
          ? crossSessionTransitions.filter(
              (transition) =>
                transition.sessionId !== sessionId &&
                transition.project === project &&
                transition.key === key &&
                (candidateTimestampMs == null ||
                  transition.timestampMs == null ||
                  transition.timestampMs >= candidateTimestampMs)
            )
          : [];
      const potentiallyFinalTransitions = [
        ...(state.transition ? [state.transition] : []),
        ...laterTransitions,
      ];
      const latestTransitionMs = maxMs(
        potentiallyFinalTransitions.map((transition) => transition.timestampMs)
      );
      const latestTransitions =
        latestTransitionMs == null
          ? []
          : potentiallyFinalTransitions.filter(
              (transition) => transition.timestampMs === latestTransitionMs
            );
      // Calls within one transcript have a proven order even when every tool
      // use in the assistant message shares one timestamp. Collapse each
      // session to its final call at the latest timestamp; conflicting final
      // states across different sessions remain genuinely unordered.
      const finalLatestTransitionBySession = new Map<
        string,
        CrossSessionTransition
      >();
      for (const transition of latestTransitions) {
        const prior = finalLatestTransitionBySession.get(transition.sessionId);
        if (!prior || transition.order > prior.order) {
          finalLatestTransitionBySession.set(transition.sessionId, transition);
        }
      }
      // An unparseable cross-session timestamp cannot be ordered against a
      // known timestamp. Retain the final such call per transcript alongside
      // the latest known-time calls; a status conflict then becomes ambiguous
      // rather than a billable missing-artifact claim.
      for (const transition of potentiallyFinalTransitions) {
        if (transition.timestampMs != null) continue;
        const prior = finalLatestTransitionBySession.get(transition.sessionId);
        if (!prior || transition.order > prior.order) {
          finalLatestTransitionBySession.set(transition.sessionId, transition);
        }
      }
      const finalLatestTransitions = [...finalLatestTransitionBySession.values()];
      const decidingTransitions =
        finalLatestTransitions.length > 0
          ? finalLatestTransitions
          : [];
      const finalStatuses = new Set(
        finalLatestTransitions.map((transition) => transition.status)
      );
      const outcome: LeaveBehindDecision['outcome'] =
        finalLatestTransitions.length === 0
          ? state.status
          : finalStatuses.size > 1
            ? 'ambiguous'
            : finalLatestTransitions[0].status;
      const latestCandidate = decidingTransitions.find(
        (transition) => transition.status === 'candidate'
      );
      const path = latestCandidate?.path ?? state.path;
      leaveBehindDecisions.push({
        key,
        path,
        outcome,
        transitions: decidingTransitions,
      });
      // An equal-time cross-session conflict cannot prove either absence or a
      // final candidate. Keep it on the zero-savings verification path.
      if (outcome !== 'invalidated') structuralCandidatePaths.push(path);
    }
    const latestMs = maxMs([
      ...mutations.map((mutation) => mutation.timestampMs),
      ...leaveBehindDecisions.flatMap((decision) =>
        decision.transitions.map((transition) => transition.timestampMs)
      ),
    ]);
    signals.push({
      sessionId,
      taskClass: taskClassOf(sessionId, projects),
      mutations,
      structuralCandidatePaths,
      leaveBehindDecisions,
      latestMs,
      latestDate: latestMs == null ? null : isoDate(latestMs),
    });
  }
  return signals;
}

function maxMs(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function rediscoveryBurst(timeline: SessionTimeline, projects: Map<string, string>): RediscoveryBurst | null {
  const firstMs = parseMs(timeline.startTime) ?? parseMs(timeline.entries[0]?.timestamp);
  if (firstMs == null) return null;
  const early = timeline.entries
    .filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
    .filter((entry) => {
      const ms = parseMs(entry.timestamp);
      return ms != null && ms - firstMs <= REDISCOVERY_WINDOW_MS;
    })
    // Cap the early window at the first 10 conversational turns: a rediscovery
    // burst is a start-of-session phenomenon, and the density gate below
    // (`hits / early.length`) would be diluted by a long tail of later,
    // unrelated turns that still fall inside REDISCOVERY_WINDOW_MS.
    .slice(0, 10);
  if (early.length === 0) return null;

  const hits = early.filter((entry) => isRediscoveryEntry(entry));
  if (hits.length < REDISCOVERY_MIN_HITS) return null;
  if (hits.length / early.length < 0.4) return null;

  const hitTimes = hits
    .map((entry) => parseMs(entry.timestamp))
    .filter((ms): ms is number => ms != null);
  const endMs = hitTimes.length ? Math.max(...hitTimes) : firstMs;
  // The observed measurement — NOT floored at the preset (finding #2).
  const observedMinutes = Math.max(0, Math.round((endMs - firstMs) / 60000));
  return {
    sessionId: timeline.sessionId,
    taskClass: taskClassOf(timeline.sessionId, projects),
    startMs: firstMs,
    endMs,
    date: isoDate(endMs),
    hits: hits.length,
    earlyEntries: early.length,
    observedMinutes,
    sample: hits[0]?.summary ?? 'rediscovery language',
  };
}

function isRediscoveryEntry(entry: TimelineEntry): boolean {
  // Primary path: the parser bakes `rediscovery` in at parse time from the full
  // untruncated turn text, so it survives `slimSessionTimeline` (which strips
  // `summary`). On the production bulk/server dataset `summary` is gone, so the
  // flag is the ONLY signal — the earlier summary-only read was dead there
  // (adversarial-review finding #1). Fall back to a summary match only for
  // client-parsed/hand-built timelines that predate the flag.
  if (entry.rediscovery === true) return true;
  return isRediscoveryText(entry.summary);
}

function billRediscoveries(
  bursts: RediscoveryBurst[],
  preSignals: PreSignal[]
): BilledRediscovery[] {
  const priorsByClass = new Map<string, PreSignal[]>();
  for (const signal of preSignals) {
    const arr = priorsByClass.get(signal.taskClass) ?? [];
    arr.push(signal);
    priorsByClass.set(signal.taskClass, arr);
  }
  for (const arr of priorsByClass.values()) {
    arr.sort((a, b) => (a.latestMs ?? -Infinity) - (b.latestMs ?? -Infinity));
  }

  const out: BilledRediscovery[] = [];
  for (const burst of bursts) {
    // Only bill a prior whose mutation is PROVABLY before the burst. A prior
    // with an unparseable timestamp (latestMs == null) has no provable ordering,
    // so admitting it could bill a mutation as the cause of an earlier burst
    // (adversarial-review finding #5) — exclude it.
    const candidates = (priorsByClass.get(burst.taskClass) ?? []).filter(
      (signal) => signal.latestMs != null && signal.latestMs < burst.startMs
    );
    if (candidates.length === 0) continue;
    const prior = candidates[candidates.length - 1];
    out.push({ priorSessionId: prior.sessionId, burst });
  }
  return out;
}

// A single-unit attribution figure: context tool-result TOKENS for the involved
// sessions. The earlier version added `toolResultBytes` (characters) into the
// same running total, producing a meaningless mixed-unit number (adversarial-
// review finding #4). `toolResultBytes` / `toolUseIds` remain the join keys the
// provenance cites, but they are not summed into a token figure.
function tokenAttributionTokens(
  input: Parameters<Detector['rule']>[0],
  sessionIds: Set<string>
): number {
  let total = 0;
  for (const row of input.tokenData ?? []) {
    if (!sessionIds.has(row.sessionId)) continue;
    total += row.contextToolResultTokensSum ?? 0;
  }
  return total;
}

interface DetectorAnalysis {
  projects: Map<string, string>;
  preSignals: PreSignal[];
}

function analyzeInput(input: Parameters<Detector['rule']>[0]): DetectorAnalysis {
  const projects = projectBySession(input);
  return {
    projects,
    preSignals: collectPreSignals(input.toolData ?? [], projects),
  };
}

function buildRollups(
  input: Parameters<Detector['rule']>[0],
  analysis: DetectorAnalysis
): ClassRollup[] {
  const preSignals = analysis.preSignals.filter(
    (signal) => signal.structuralCandidatePaths.length === 0
  );
  if (preSignals.length === 0) return [];

  const bursts = (input.timelines ?? [])
    .map((timeline) => rediscoveryBurst(timeline, analysis.projects))
    .filter((b): b is RediscoveryBurst => b != null);
  const rediscoveries = billRediscoveries(bursts, preSignals);

  const byClass = new Map<string, ClassRollup>();
  for (const signal of preSignals) {
    const roll = byClass.get(signal.taskClass) ?? {
      taskClass: signal.taskClass,
      preSignals: [],
      rediscoveries: [],
      estimatedMinutes: 0,
      latestMs: null,
    };
    roll.preSignals.push(signal);
    roll.latestMs = maxMs([roll.latestMs, signal.latestMs]);
    byClass.set(signal.taskClass, roll);
  }
  for (const rediscovery of rediscoveries) {
    const roll = byClass.get(rediscovery.burst.taskClass);
    if (!roll) continue;
    roll.rediscoveries.push(rediscovery);
    roll.latestMs = maxMs([roll.latestMs, rediscovery.burst.endMs]);
  }

  for (const roll of byClass.values()) {
    // Hypothesis total (the ONLY place the conservative 15-minute preset floor
    // applies): a floor per no-leave-behind durable-state session, plus each observed
    // rediscovery burst counted at least at the floor. The raw observed minutes
    // are surfaced separately, unfloored, in evidence/provenance (finding #2).
    const preset = roll.preSignals.length * CONSERVATIVE_PRESET_MIN;
    const billedFloor = roll.rediscoveries.reduce(
      (sum, r) => sum + Math.max(CONSERVATIVE_PRESET_MIN, r.burst.observedMinutes),
      0
    );
    roll.estimatedMinutes = preset + billedFloor;
  }

  return [...byClass.values()].sort((a, b) => {
    if (b.estimatedMinutes !== a.estimatedMinutes) return b.estimatedMinutes - a.estimatedMinutes;
    return b.preSignals.length - a.preSignals.length;
  });
}

function candidateVerificationRecommendation(
  now: number,
  analysis: DetectorAnalysis
): Recommendation | null {
  const candidates = analysis.preSignals.filter(
    (signal) => signal.structuralCandidatePaths.length > 0
  );
  if (candidates.length === 0) return null;

  const byClass = new Map<string, PreSignal[]>();
  for (const signal of candidates) {
    const group = byClass.get(signal.taskClass) ?? [];
    group.push(signal);
    byClass.set(signal.taskClass, group);
  }
  const [taskClass, signals] = [...byClass.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return (maxMs(b[1].map((signal) => signal.latestMs)) ?? -Infinity) -
      (maxMs(a[1].map((signal) => signal.latestMs)) ?? -Infinity);
  })[0];
  const paths = [...new Set(signals.flatMap((signal) => signal.structuralCandidatePaths))];
  const candidateEntries = signals.flatMap((signal) =>
    signal.leaveBehindDecisions
      .filter((decision) => decision.outcome !== 'invalidated')
      .map((decision) => ({
        signal,
        decision,
        latestMs:
          maxMs(decision.transitions.map((transition) => transition.timestampMs)) ??
          signal.latestMs,
      }))
  );
  candidateEntries.sort(
    (a, b) => (b.latestMs ?? -Infinity) - (a.latestMs ?? -Infinity)
  );
  const latestMs = maxMs(candidateEntries.map((entry) => entry.latestMs));
  const latestDate = latestMs == null ? undefined : isoDate(latestMs);
  const stale = latestMs != null ? now - latestMs > FRESHNESS_DAYS * DAY_MS : undefined;
  const asOfPrefix = stale && latestDate ? `As of ${latestDate}, ` : '';
  const { signal: example, decision: exampleDecision } = candidateEntries[0];
  const decidingCandidate = exampleDecision?.transitions
    .filter((transition) => transition.status === 'candidate')
    .sort(
      (a, b) =>
        (b.timestampMs ?? -Infinity) - (a.timestampMs ?? -Infinity) ||
        b.order - a.order
    )[0];
  const evidenceSessionId = decidingCandidate?.sessionId ?? example.sessionId;
  const ambiguousDecisions = candidateEntries.filter(
    ({ decision }) => decision.outcome === 'ambiguous'
  ).length;
  const unknownTimeAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.transitions.some((transition) => transition.timestampMs == null)
  ).length;
  const ambiguityDetail =
    ambiguousDecisions > 0
      ? ` ${ambiguousDecisions} state-scope observation(s) also have conflicting candidate ` +
        `and invalidation transitions that cannot be ordered across sessions` +
        (unknownTimeAmbiguities > 0
          ? `; ${unknownTimeAmbiguities} include missing or unparseable timestamps.`
          : ` because their timestamps are equal.`)
      : '';

  return {
    id: CANDIDATE_VERIFICATION_ID,
    category: 'workflow',
    severity: 'info',
    title: 'Verify the leave-behind candidate reached Git',
    detail:
      `${asOfPrefix}${signals.length} durable-state session(s) in "${taskClass}" have ` +
      `${candidateEntries.length} structurally conformant leave-behind candidate observation(s) ` +
      `across ${paths.length} unique path(s) after their mutations that are not provably ` +
      `superseded by a later invalidation.` +
      ambiguityDetail + ' ' +
      `Transcript data cannot prove Git HEAD tracking or scope coverage, so no missing-artifact ` +
      `savings are booked until both are verified.`,
    action:
      `Verify ${exampleDecision.path} is tracked at HEAD and covers the durable mutation(s) in ` +
      `${short(example.sessionId)}. ` +
      `If either check fails, update and commit the leave-behind for the correct state scope; an ` +
      `unrelated tracked artifact does not satisfy the contract.`,
    affected: signals.length,
    view: 'timeline',
    evidence: [
      `${short(evidenceSessionId)} ${candidateEntries.length} structural candidate observation(s) across ${paths.length} unique path(s) not provably superseded in ${signals.length} durable-state session(s); Git HEAD is unobserved in transcript data` +
        (ambiguousDecisions > 0
          ? `; ${ambiguousDecisions} cross-session state conflict(s) remain unordered`
          : ''),
      `${short(evidenceSessionId)} cited conformant Write candidate -> ${exampleDecision?.path ?? example.structuralCandidatePaths[0]}` +
        (decidingCandidate
          ? ` (tool_use_id ${decidingCandidate.toolUseId}` +
            (decidingCandidate.timestampMs == null
              ? ', timestamp unavailable)'
              : `, ${new Date(decidingCandidate.timestampMs).toISOString()})`)
          : ''),
    ],
    claimClass: 'accounting',
    proofTier: 'accounting',
    provenance: {
      observations: [
        {
          claim: `${candidateEntries.length} full-file Write candidate observation(s) across ${paths.length} unique path(s) passed the v1 path and two-half structure without a provably later invalidation`,
          source: 'parse-tools',
          field: 'ToolCall.toolName + ToolCall.input.file_path + ToolCall.leaveBehindStructure + ToolCall.isError',
          value: candidateEntries.length,
        },
        {
          claim:
            `same-project transition ordering for candidate verification used project identity "${taskClass}"`,
          source: 'sessions + tokenData',
          field:
            'sessions[].sessionId + sessions[].project / tokenData[].sessionId + tokenData[].project',
          value: taskClass,
        },
        ...(decidingCandidate
          ? [
              {
                claim:
                  exampleDecision?.outcome === 'ambiguous'
                    ? `a conformant Write in the equal-time unresolved state conflict was observed in session ${decidingCandidate.sessionId}`
                    : `the latest observed conformant Write candidate was observed in session ${decidingCandidate.sessionId}`,
                source: 'parse-tools',
                field:
                  'ToolCall.timestamp + toolName + input.file_path + leaveBehindStructure + isError',
                value: decidingCandidate.toolUseId,
              } satisfies RecObservation,
            ]
          : []),
        ...(ambiguousDecisions > 0
          ? [
              {
                claim:
                  `${ambiguousDecisions} state-scope observation(s) have conflicting candidate and invalidation transitions that cannot be ordered across sessions`,
                source: 'parse-tools',
                field:
                  'ToolCall.timestamp + sessionId + toolName + input.file_path + leaveBehindStructure + isError',
                value: ambiguousDecisions,
              } satisfies RecObservation,
            ]
          : []),
        {
          claim: 'transcript tool data does not contain repository HEAD tracking state',
          source: 'parse-tools',
          field: 'ToolCall (trackedAtHead unavailable)',
          value: 'unobserved',
        },
      ],
      inference:
        'A conformant document structure was observed after the durable-state mutation without a provably later invalidation, but cross-session conflicts may be unordered when timestamps tie or are unavailable, and Git commitment plus semantic scope coverage are unknown. Verification is warranted; final state, absence, saved time, and a need to rewrite the artifact are not claimed.',
      ...(latestDate ? { asOf: latestDate, stale: !!stale } : {}),
    },
  };
}

function buildFix(): RecFix {
  return {
    target: 'CLAUDE.md',
    label: 'Add durable-state handoff rule',
    note: 'Use the repository leave-behind contract; adapt only the state scope and content.',
    fixKind: 'illustrative',
    appliedMarkers: MARKERS,
    snippet:
      '## Durable state handoff\n\n' +
      'Durable external state changes need a handoff artifact. When a task changes\n' +
      'remote hosts, deployed services, generated config, installation state, or\n' +
      'other state that a later session may need to operate, leave a compact\n' +
      'v1 artifact at docs/runbooks/<state-scope>/README.md using\n' +
      'docs/leave-behind-contract.md. Keep both required halves:\n' +
      '- Operability: state/access, source -> output map, re-run, and recovery;\n' +
      '- Decision log: non-obvious choices and how the operator drives it.\n' +
      'Skip the artifact for trivial local-only changes where rediscovery cost is\n' +
      'not material.',
  };
}

function fmtMin(n: number): string {
  return `${Math.round(n)} minute(s)`;
}

function clip(text: string, max = 96): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function toRecommendation(
  input: Parameters<Detector['rule']>[0],
  roll: ClassRollup,
  now: number
): Recommendation {
  const latestDate = roll.latestMs == null ? undefined : isoDate(roll.latestMs);
  const stale =
    roll.latestMs != null ? now - roll.latestMs > FRESHNESS_DAYS * DAY_MS : undefined;
  const asOfPrefix = stale && latestDate ? `As of ${latestDate}, ` : '';

  const sessionIds = new Set<string>();
  for (const signal of roll.preSignals) sessionIds.add(signal.sessionId);
  for (const billed of roll.rediscoveries) {
    sessionIds.add(billed.priorSessionId);
    sessionIds.add(billed.burst.sessionId);
  }
  const attributionTokens = tokenAttributionTokens(input, sessionIds);

  const billedLeadSession = roll.rediscoveries[0]?.priorSessionId;
  const lead =
    (billedLeadSession
      ? roll.preSignals.find((signal) => signal.sessionId === billedLeadSession)
      : undefined) ?? roll.preSignals[0];
  const leadMutation = lead.mutations[0];
  const latestInvalidation = roll.preSignals
    .flatMap((signal) =>
      signal.leaveBehindDecisions
        .filter((decision) => decision.outcome === 'invalidated')
        .flatMap((decision) =>
          decision.transitions
            .filter((transition) => transition.status === 'invalidated')
            .map((transition) => ({ decision, transition }))
        )
    )
    .sort(
      (a, b) =>
        (b.transition.timestampMs ?? -Infinity) -
          (a.transition.timestampMs ?? -Infinity) ||
        b.transition.order - a.transition.order
    )[0];
  const observedRediscoveryMin = roll.rediscoveries.reduce(
    (sum, r) => sum + r.burst.observedMinutes,
    0
  );
  const evidence = [
    `${short(lead.sessionId)} ${roll.taskClass}: ${roll.preSignals.length} durable-state session(s) without an uninvalidated final v1 structural candidate written after the latest durable mutation in the transcript and remaining uninvalidated by later observed file mutations in the same project; ` +
      `example ${short(lead.sessionId)} ${leadMutation.kind} via ${clip(leadMutation.label)}`,
    ...(latestInvalidation
      ? [
          `${short(latestInvalidation.transition.sessionId)} successful ${latestInvalidation.transition.toolName} ` +
            `(tool_use_id ${latestInvalidation.transition.toolUseId}) established the latest observed invalidated state for ${latestInvalidation.decision.path}`,
        ]
      : []),
    ...(roll.rediscoveries.length
      ? [
          `${short(roll.rediscoveries[0].priorSessionId)} ${roll.rediscoveries.length} later rediscovery session(s), ~${fmtMin(observedRediscoveryMin)} billed back; ` +
            `example ${short(roll.rediscoveries[0].priorSessionId)} -> ${short(roll.rediscoveries[0].burst.sessionId)} ` +
            `(${clip(roll.rediscoveries[0].burst.sample)})`,
        ]
      : [
          `cold-start pre-signal only: no historical rediscovery is required; uses the conservative ${CONSERVATIVE_PRESET_MIN} minute floor per durable-state session`,
        ]),
  ];

  const observations: RecObservation[] = [
    {
      claim:
        `${roll.preSignals.length} session(s) in task class "${roll.taskClass}" mutated durable external state and did not end with an uninvalidated v1 structural candidate written after the latest durable external-state mutation in the same transcript and remaining uninvalidated by later timestamped file mutations in the same project`,
      source: 'parse-tools',
      field: 'ordered ToolCall[]: toolName + commandDurableKind/input.command/commandPreview + input.file_path + leaveBehindStructure + timestamp + isError',
      value: roll.preSignals.length,
    },
    ...(latestInvalidation
      ? [
          {
            claim:
              `a successful ${latestInvalidation.transition.toolName} in session ${latestInvalidation.transition.sessionId} established the latest observed invalidated state for the canonical leave-behind path in project ${latestInvalidation.transition.project}`,
            source: 'parse-tools + sessions + tokenData',
            field:
              'ToolCall.timestamp + toolName + input.file_path + leaveBehindStructure + isError joined by sessionId to sessions[].project / tokenData[].project',
            value: latestInvalidation.transition.toolUseId,
          } satisfies RecObservation,
        ]
      : []),
    {
      claim:
        `example durable-state write: session ${lead.sessionId}, tool_use_id ${leadMutation.toolUseId}, kind ${leadMutation.kind}`,
      source: 'parse-tools',
      field: leadMutation.field,
      value: leadMutation.toolUseId,
    },
    {
      claim:
        roll.rediscoveries.length > 0
          ? `${roll.rediscoveries.length} later session(s) in the same task class had early-turn rediscovery language, spanning ${fmtMin(observedRediscoveryMin)} observed (unfloored measured span, not the hypothesis preset)`
          : `no later rediscovery session is required for the day-one pre-signal; the conservative preset floor is ${CONSERVATIVE_PRESET_MIN} minute(s) per no-leave-behind durable-state session`,
      source: 'parse-timeline',
      field: 'entries[].rediscovery (derived at parse time from the full turn text; survives slimming) in the first 20 minutes',
      value: roll.rediscoveries.length > 0 ? observedRediscoveryMin : CONSERVATIVE_PRESET_MIN,
    },
    {
      claim:
        `tool/context attribution substrate is present for audit joins: #1926 contextToolResultTokensSum totals ${Math.round(attributionTokens)} context tool-result tokens for involved sessions; #1928 tool_use_id/result-byte fields provide the join keys`,
      source: 'tokenData + parse-tools',
      field: 'SessionTokenData.contextToolResultTokensSum (summed) / TokenEntry.toolUseIds / TokenEntry.toolResultBytes / ToolCall.toolUseId (join keys)',
      value: Math.round(attributionTokens),
    },
    {
      claim:
        `same-project grouping and cross-session leave-behind ordering used project identity "${roll.taskClass}"`,
      source: 'sessions + tokenData',
      field:
        'sessions[].sessionId + sessions[].project / tokenData[].sessionId + tokenData[].project',
      value: roll.taskClass,
    },
  ];

  return {
    id: DETECTOR_ID,
    category: 'workflow',
    severity: roll.rediscoveries.length > 0 ? 'warning' : 'info',
    title: 'Leave a handoff when agents establish durable state',
    detail:
      `${asOfPrefix}${roll.preSignals.length} durable-state session(s) in "${roll.taskClass}" ` +
      `changed remote/config/install state without an uninvalidated final v1 structural candidate written after the latest durable mutation in the transcript and remaining uninvalidated by later observed file mutations in the same project. ` +
      (roll.rediscoveries.length > 0
        ? `${roll.rediscoveries.length} later session(s) then spent early turns re-discovering that setup (~${fmtMin(observedRediscoveryMin)} observed). `
        : `This is a cold-start pre-signal: no later historical corpus is needed. `) +
      `The ${fmtMin(roll.estimatedMinutes)} estimate is a hypothesis, using a conservative ` +
      `${CONSERVATIVE_PRESET_MIN} minute floor per no-leave-behind session and per rediscovery burst (or its observed span when longer); it is not a calibrated causal saving.`,
    action:
      `For "${roll.taskClass}" tasks that mutate material durable external state, follow docs/leave-behind-contract.md and update docs/runbooks/<state-scope>/README.md with both Operability and Decision log halves. Skip trivial local-only changes.`,
    affected: roll.preSignals.length,
    estTimeReclaimedMin: roll.estimatedMinutes,
    view: 'timeline',
    evidence,
    claimClass: 'causal',
    proofTier: 'auditable',
    provenance: {
      observations,
      inference:
        'A missing handoff after a durable-state mutation is an accounting pre-signal; a later early-turn rediscovery burst confirms real re-engagement work. Treating the estimated minutes as saved time is a causal hypothesis until the sibling profiling receipt calibrates the artifact policy.',
      ...(latestDate ? { asOf: latestDate, stale: !!stale } : {}),
    },
    fix: buildFix(),
  };
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'workflow',
  dataDeps: ['toolData', 'timelines', 'sessions', 'tokenData', 'liveConfig'],
  appliedMarkers: MARKERS,
  rule(input, now): Recommendation | null {
    const analysis = analyzeInput(input);
    const roll = claudeMdMarksApplied(input.liveConfig, MARKERS)
      ? undefined
      : buildRollups(input, analysis)[0];
    return roll
      ? toRecommendation(input, roll, now)
      : candidateVerificationRecommendation(now, analysis);
  },
  emitAll(input, now): Recommendation[] {
    const analysis = analyzeInput(input);
    const recommendations: Recommendation[] = [];
    if (!claudeMdMarksApplied(input.liveConfig, MARKERS)) {
      const roll = buildRollups(input, analysis)[0];
      if (roll) recommendations.push(toRecommendation(input, roll, now));
    }
    const candidate = candidateVerificationRecommendation(now, analysis);
    if (candidate) recommendations.push(candidate);
    return recommendations;
  },
};
