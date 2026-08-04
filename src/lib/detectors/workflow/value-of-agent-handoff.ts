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
import { observeLeaveBehindWrites } from '../../leave-behind';
import {
  normalizePosixAbsolutePath,
  normalizePosixRelativePath,
  resolveProjectBySession,
  windowsProjectIdentityKey,
} from '../../project-identity';
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
 * - TIME VALUE (gated publish, #2314): the human-minute figure publishes as a
 *   present-tense recommendation ONLY with a calibrated receipt -- at least
 *   `MIN_HANDOFF_RECEIPT_SAMPLES` genuinely observed re-discovery bursts for the
 *   task class, aggregated to a measured (T2 `observational`) cost from
 *   unfloored `RediscoveryBurst.observedMinutes`. Below that floor (including
 *   every cold-start pre-signal, which has zero measured bursts by construction)
 *   the detector emits an HONEST NULL ("not enough history to size the handoff
 *   cost yet") and asserts no `estTimeReclaimedMin`, rather than presenting the
 *   15-minute preset floor as a proven saving. The pre-signal itself (the
 *   missing-handoff accounting finding + the fix) fires either way.
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
// #2314 calibration floor: the human-minute figure only publishes once a task
// class has at least this many genuinely observed re-discovery bursts to
// aggregate into a measured (T2 observational) receipt. Below it, the detector
// emits an honest null instead of asserting the preset floor as proven. Mirrors
// the sample-size gate precedents (shadow-axis-wins MIN_DECIDED,
// human-input-leverage MIN_BASELINE_SPANS).
const MIN_HANDOFF_RECEIPT_SAMPLES = 3;
const REDISCOVERY_WINDOW_MS = 20 * 60 * 1000;
const REDISCOVERY_MIN_HITS = 2;
const FRESHNESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
  timestampIssue?: TimestampIssue;
  /** Monotone transcript-order lower bound for causal comparisons. */
  orderingTimestampMs: number | null;
  /** False when the raw timestamp is absent or moves backwards in the transcript. */
  orderingTimestampExact: boolean;
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
  /** Latest monotone ordering bound across the mutation and deciding state. */
  latestMs: number | null;
  /** Whether every event contributing to this signal has exact timestamp evidence. */
  orderingTimestampExact: boolean;
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
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(
      value
    );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

type TimestampIssue = 'missing-or-unparseable' | 'future';

function parseTimestamp(
  value: string | undefined,
  now: number
): { ms: number | null; issue?: TimestampIssue } {
  const ms = parseMs(value);
  if (ms == null) return { ms: null, issue: 'missing-or-unparseable' };
  if (Number.isFinite(now) && now > 0 && ms > now + MAX_FUTURE_SKEW_MS) {
    return { ms: null, issue: 'future' };
  }
  return { ms };
}

function timestampLimitation(
  timestampIssue: TimestampIssue | undefined,
  timestampMs: number | null
): string {
  if (timestampIssue === 'future') {
    return 'has a timestamp materially in the future relative to the evaluation clock';
  }
  if (timestampMs == null) return 'has a missing or unparseable timestamp';
  return 'has a timestamp earlier than a prior transcript call, so only a monotone ordering lower bound is available';
}

function timestampEvidenceLimitation(
  timestampIssue: TimestampIssue | undefined,
  timestampMs: number | null
): string {
  if (timestampIssue === 'future') {
    return 'has a timestamp materially in the future relative to the evaluation clock';
  }
  if (timestampMs == null) return 'has timestamp unavailable';
  return 'has only an ordering lower bound because its transcript clock moves backwards';
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
  return resolveProjectBySession([
    ...(input.sessions ?? []),
    ...(input.tokenData ?? []),
  ]);
}

function taskClassOf(sessionId: string, projects: Map<string, string>): string {
  // A shared `unknown-project` bucket would let unrelated transcripts satisfy
  // the detector's same-project join and fabricate rediscovery attribution.
  // Keep unresolved identity unique per session: the cold-start pre-signal can
  // still fire, but no cross-session claim is made without a proven project.
  return projects.get(sessionId) ?? `unknown-project:${sessionId}`;
}

const UNKNOWN_PROJECT_PREFIX = 'unknown-project:';

function taskClassDisplay(taskClass: string): string {
  return taskClass.startsWith(UNKNOWN_PROJECT_PREFIX)
    ? 'a session with unresolved project identity (session-local)'
    : `project "${taskClass}"`;
}

/** Project filters index only the first evidence token. Do not let an
 * unresolved session's short id alias an unrelated resolved session; keep the
 * id later in a non-indexable token while preserving it for human audit. */
function projectEvidenceLead(sessionId: string, taskClass: string): string {
  return taskClass.startsWith(UNKNOWN_PROJECT_PREFIX)
    ? `unresolved-project(session=${short(sessionId)})`
    : short(sessionId);
}

function projectJoinObservation(taskClass: string): RecObservation {
  if (taskClass.startsWith(UNKNOWN_PROJECT_PREFIX)) {
    return {
      claim:
        'project identity was unresolved, so this session was isolated in a session-local bucket and no cross-session project join was attempted',
      source: 'sessions + tokenData',
      field:
        'sessions[].sessionId + sessions[].project / tokenData[].sessionId + tokenData[].project',
      value: 'unresolved',
    };
  }
  return {
    claim:
      `same-project grouping and cross-session leave-behind ordering used project identity "${taskClass}"`,
    source: 'sessions + tokenData',
    field:
      'sessions[].sessionId + sessions[].project / tokenData[].sessionId + tokenData[].project',
    value: taskClass,
  };
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
  if (call.commandAnalysisComplete === true) return null;
  if (cmd) {
    const kind = classifyDurableCommand(cmd.text);
    if (kind) return { kind, label: cmd.text, field: cmd.field };
  }
  return null;
}

interface CrossSessionTransition {
  sessionId: string;
  project: string | null;
  key: string;
  timestampMs: number | null;
  timestampIssue?: TimestampIssue;
  order: number;
  toolUseId: string;
  toolName: string;
  path: string;
  pathField:
    | 'input.file_path'
    | 'leaveBehindMutationPath'
    | 'leaveBehindMutationPaths'
    | 'commandAnalysisTruncated';
  status: 'candidate' | 'invalidated' | 'ambiguous';
  ambiguityReason?:
    | 'cross-session-ordering'
    | 'truncated-path-tail'
    | 'truncated-command-analysis';
  /** Monotone lower bound used only to order final calls across transcripts.
   * A transcript's array order wins when per-call clocks move backwards. */
  orderingTimestampMs?: number | null;
  /** False when orderingTimestampMs is only a lower bound because this call's
   * timestamp is absent or moved backwards within its transcript. */
  orderingTimestampExact?: boolean;
}

interface SessionLeaveBehindState {
  status: 'candidate' | 'invalidated' | 'ambiguous';
  order: number;
  path: string;
  timestampMs: number | null;
  transition?: CrossSessionTransition;
  /** A conformant candidate that remains possible at this point in the
   * transcript. Exact invalidations clear it; uncertainty barriers preserve it. */
  candidateTransition?: CrossSessionTransition;
}

interface LeaveBehindDecision {
  key: string;
  path: string;
  outcome: 'candidate' | 'invalidated' | 'ambiguous';
  ambiguityReason?:
    | 'cross-session-ordering'
    | 'truncated-path-tail'
    | 'truncated-command-analysis';
  transitions: CrossSessionTransition[];
  /** Conformant candidates not proven superseded before the final decision.
   * Kept separate because an uncertainty barrier is not itself a candidate. */
  provenCandidateTransitions: CrossSessionTransition[];
}

interface CrossSessionInvalidationBarrier {
  sessionId: string;
  project: string;
  timestampMs: number | null;
  timestampIssue?: TimestampIssue;
  orderingTimestampMs?: number | null;
  orderingTimestampExact?: boolean;
  order: number;
  toolUseId: string;
  toolName: string;
  ambiguityReason: 'truncated-path-tail' | 'truncated-command-analysis';
}

function projectScopedTransitionKey(
  path: string,
  relativeKey: string,
  project: string | null
): string | null {
  if (project == null) {
    const windowsPath = windowsProjectIdentityKey(path);
    if (windowsPath) return `absolute:${windowsPath}`;
    const absolutePath = normalizePosixAbsolutePath(path);
    if (absolutePath) return `absolute:posix:${absolutePath}`;
  }
  const projectIsWindows =
    project != null &&
    windowsProjectIdentityKey(project) != null;
  // Structured tool paths are platform-dependent. A backslash is a separator
  // only when session project identity proves Windows; on POSIX it is a valid
  // filename character and must not alias the canonical slash path.
  if (!projectIsWindows) {
    // POSIX permits literal backslashes and normalizes only slash separators.
    // A relative `docs\\runbooks...` path therefore remains a different file.
    if (!path.startsWith('/')) {
      return normalizePosixRelativePath(path) === relativeKey
        ? relativeKey
        : null;
    }
    if (!project) return null;
    const normalizedPath = normalizePosixAbsolutePath(path);
    const normalizedProject = normalizePosixAbsolutePath(project);
    if (!normalizedPath || !normalizedProject) return null;
    const expected = `${normalizedProject}${normalizedProject.endsWith('/') ? '' : '/'}${relativeKey}`;
    return normalizedPath === expected ? relativeKey : null;
  }
  const normalizePath = (value: string): string => {
    const leadingSeparators = /^[\\/]+/.exec(value)?.[0].length ?? 0;
    const slashes = value.replace(/\\/g, '/');
    const collapsedTail = slashes
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/');
    const collapsed =
      leadingSeparators === 2
        ? `//${collapsedTail}`
        : leadingSeparators >= 3
          ? `/${collapsedTail}`
          : slashes.replace(/\/{2,}/g, '/');
    const rootLength = collapsed.startsWith('//')
      ? 2
      : /^[A-Za-z]:\//.test(collapsed)
        ? 3
        : collapsed.startsWith('/')
          ? 1
          : 0;
    const prefix = collapsed.slice(0, rootLength);
    const tail = collapsed
      .slice(rootLength)
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
    return tail ? `${prefix}${tail}` : prefix;
  };
  const normalizedPath = normalizePath(path);
  const isAbsolute =
    normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
  if (!isAbsolute) {
    return normalizedPath.toLowerCase() === relativeKey.toLowerCase()
      ? relativeKey
      : null;
  }
  if (!project) return null;
  const projectPath = normalizePath(project);
  const normalizedProject =
    projectPath === '/' || /^[A-Za-z]:\/$/.test(projectPath)
      ? projectPath
      : projectPath.replace(/\/$/, '');
  if (
    !normalizedProject.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalizedProject)
  ) {
    return null;
  }
  const expected = `${normalizedProject}${normalizedProject.endsWith('/') ? '' : '/'}${relativeKey}`;
  return normalizedPath.toLowerCase() === expected.toLowerCase()
    ? relativeKey
    : null;
}

function candidateTransitionForEvidence(
  transitions: CrossSessionTransition[]
): CrossSessionTransition | undefined {
  return transitions
    .filter((transition) => transition.status === 'candidate')
    .sort(
      (a, b) =>
        (b.timestampMs ?? -Infinity) - (a.timestampMs ?? -Infinity) ||
        b.order - a.order ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.toolUseId.localeCompare(b.toolUseId)
    )[0];
}

function transitionIsProvenAfter(
  later: CrossSessionTransition,
  earlier: CrossSessionTransition
): boolean {
  if (later.sessionId === earlier.sessionId) {
    return later.order > earlier.order;
  }
  return (
    earlier.orderingTimestampExact === true &&
    later.orderingTimestampMs != null &&
    earlier.orderingTimestampMs != null &&
    later.orderingTimestampMs > earlier.orderingTimestampMs
  );
}

function candidateTransitionsNotProvenSuperseded(
  state: SessionLeaveBehindState,
  transitions: CrossSessionTransition[]
): CrossSessionTransition[] {
  const candidates = [
    ...(state.candidateTransition ? [state.candidateTransition] : []),
    ...transitions.filter((transition) => transition.status === 'candidate'),
  ];
  const uniqueCandidates = new Map<string, CrossSessionTransition>();
  for (const candidate of candidates) {
    uniqueCandidates.set(
      `${candidate.sessionId}\u0000${candidate.order}\u0000${candidate.toolUseId}`,
      candidate
    );
  }
  const invalidations = transitions.filter(
    (transition) => transition.status === 'invalidated'
  );
  return [...uniqueCandidates.values()].filter(
    (candidate) =>
      !invalidations.some((invalidation) =>
        transitionIsProvenAfter(invalidation, candidate)
      )
  );
}

function candidateIsProvenBeforeLatestMutation(
  candidate: CrossSessionTransition,
  durableSessionId: string,
  mutations: DurableMutation[]
): boolean {
  if (candidate.sessionId === durableSessionId) {
    return candidate.order < Math.max(
      ...mutations.map((mutation) => mutation.order)
    );
  }
  if (
    candidate.orderingTimestampExact !== true ||
    candidate.orderingTimestampMs == null ||
    !mutations.every(
      (mutation) =>
        mutation.orderingTimestampExact &&
        mutation.orderingTimestampMs != null
    )
  ) {
    return false;
  }
  const latestMutationMs = maxMs(
    mutations.map((mutation) => mutation.orderingTimestampMs)
  );
  return (
    latestMutationMs != null &&
    candidate.orderingTimestampMs < latestMutationMs
  );
}

/**
 * Bucket cross-session transitions by `project + '\0' + key` (#3251).
 *
 * `collectPreSignals` resolves, for every session's every final leave-behind
 * state, the transitions in the SAME project that carry the SAME transition
 * key. Doing that as `crossSessionTransitions.filter(...)` inside the finalStates
 * loop is O(F × T) full-array scans per detector evaluation. This builds the
 * lookup once so each final state reads only its own bucket. `project === null`
 * transitions can never match the loop's `transition.project === project`
 * (project is non-null there), so they are dropped from the index. Insertion
 * order within a bucket preserves the original array order, so the downstream
 * first-write-wins per-session dedup is unaffected.
 */
export function indexTransitionsByProjectKey(
  transitions: CrossSessionTransition[]
): Map<string, CrossSessionTransition[]> {
  const index = new Map<string, CrossSessionTransition[]>();
  for (const transition of transitions) {
    if (transition.project == null) continue;
    const key = `${transition.project}\0${transition.key}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(transition);
    else index.set(key, [transition]);
  }
  return index;
}

/** Bucket cross-session invalidation barriers by project (#3251), preserving order. */
export function indexBarriersByProject(
  barriers: CrossSessionInvalidationBarrier[]
): Map<string, CrossSessionInvalidationBarrier[]> {
  const index = new Map<string, CrossSessionInvalidationBarrier[]>();
  for (const barrier of barriers) {
    const bucket = index.get(barrier.project);
    if (bucket) bucket.push(barrier);
    else index.set(barrier.project, [barrier]);
  }
  return index;
}

function collectPreSignals(
  toolData: ToolUsageData[],
  projects: Map<string, string>,
  now: number
): PreSignal[] {
  const leaveBehindStateBySession = new Map<
    string,
    Map<string, SessionLeaveBehindState>
  >();
  const mutationsBySession = new Map<string, DurableMutation[]>();
  const crossSessionTransitions: CrossSessionTransition[] = [];
  const crossSessionInvalidationBarriers: CrossSessionInvalidationBarrier[] = [];

  for (const session of toolData) {
    let sessionOrderingTimestampMs: number | null = null;
    const leaveBehindState = new Map<string, SessionLeaveBehindState>();
    for (const [order, call] of (session.calls ?? []).entries()) {
      const project = projects.get(session.sessionId) ?? null;
      const parsedTransitionTimestamp = parseTimestamp(call.timestamp, now);
      const transitionMs = parsedTransitionTimestamp.ms;
      const priorSessionOrderingTimestampMs = sessionOrderingTimestampMs;
      sessionOrderingTimestampMs = maxMs([
        sessionOrderingTimestampMs,
        transitionMs,
      ]);
      const orderingTimestampExact =
        transitionMs != null &&
        (priorSessionOrderingTimestampMs == null ||
          transitionMs >= priorSessionOrderingTimestampMs);
      const transitions = observeLeaveBehindWrites(call);
      const transitionedKeysThisCall = new Set<string>();
      for (const transition of transitions) {
        const transitionKey = projectScopedTransitionKey(
          transition.path,
          transition.key,
          project
        );
        if (!transitionKey) continue;
        transitionedKeysThisCall.add(transitionKey);
        const observedTransition: CrossSessionTransition = {
          sessionId: session.sessionId,
          project,
          key: transitionKey,
          timestampMs: transitionMs,
          timestampIssue: parsedTransitionTimestamp.issue,
          orderingTimestampMs: sessionOrderingTimestampMs,
          orderingTimestampExact,
          order,
          toolUseId: call.toolUseId,
          toolName: call.toolName,
          path: transition.path,
          pathField: transition.field,
          status: transition.status,
        };
        leaveBehindState.set(
          transitionKey,
          {
            status: transition.status,
            order,
            path: transition.path,
            timestampMs: transitionMs,
            transition: observedTransition,
            ...(transition.status === 'candidate'
              ? { candidateTransition: observedTransition }
              : {}),
          }
        );
        if (project != null) crossSessionTransitions.push(observedTransition);
      }
      const mutationAmbiguityReason =
        call.commandAnalysisTruncated === true
          ? ('truncated-command-analysis' as const)
          : call.leaveBehindMutationPathsTruncated === true
            ? ('truncated-path-tail' as const)
            : null;
      if (
        call.toolName === 'Bash' &&
        call.isError === false &&
        mutationAmbiguityReason != null
      ) {
        for (const [transitionKey, state] of leaveBehindState) {
          if (transitionedKeysThisCall.has(transitionKey)) continue;
          const observedTransition: CrossSessionTransition = {
            sessionId: session.sessionId,
            project,
            key: transitionKey,
            timestampMs: transitionMs,
            timestampIssue: parsedTransitionTimestamp.issue,
            orderingTimestampMs: sessionOrderingTimestampMs,
            orderingTimestampExact,
            order,
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            path: state.path,
            pathField:
              mutationAmbiguityReason === 'truncated-command-analysis'
                ? 'commandAnalysisTruncated'
                : 'leaveBehindMutationPaths',
            status: 'ambiguous',
            ambiguityReason: mutationAmbiguityReason,
          };
          leaveBehindState.set(transitionKey, {
            ...state,
            status: 'ambiguous',
            order,
            timestampMs: transitionMs,
            transition: observedTransition,
          });
          // A bounded prefix or an analysis resource barrier does not prove
          // which path was omitted. Keep the same-session candidate uncertain,
          // while the project-wide barrier below gives other sessions the same
          // non-claiming outcome.
        }
        if (project != null) {
          crossSessionInvalidationBarriers.push({
            sessionId: session.sessionId,
            project,
            timestampMs: transitionMs,
            timestampIssue: parsedTransitionTimestamp.issue,
            orderingTimestampMs: sessionOrderingTimestampMs,
            orderingTimestampExact,
            order,
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            ambiguityReason: mutationAmbiguityReason,
          });
        }
      }
      // A failed or result-less attempt is not evidence that durable state
      // changed. Requiring the observed successful result keeps mutation order
      // and booked savings auditable instead of letting a later failed command
      // invalidate an otherwise final leave-behind candidate.
      if (call.isError !== false) continue;
      const classified = classifyDurableMutation(call);
      if (!classified) continue;
      const mutation: DurableMutation = {
        sessionId: session.sessionId,
        taskClass: taskClassOf(session.sessionId, projects),
        timestampMs: transitionMs,
        timestampIssue: parsedTransitionTimestamp.issue,
        orderingTimestampMs: sessionOrderingTimestampMs,
        orderingTimestampExact,
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
  // #3251: built lazily on first project-scoped resolution so a corpus with no
  // project-bearing final state pays nothing (the #3481 non-querying path).
  let transitionsByProjectKey:
    | Map<string, CrossSessionTransition[]>
    | undefined;
  let barriersByProject:
    | Map<string, CrossSessionInvalidationBarrier[]>
    | undefined;
  for (const [sessionId, mutations] of mutationsBySession) {
    const latestMutationOrder = Math.max(...mutations.map((mutation) => mutation.order));
    const project = projects.get(sessionId);
    const finalStates = [
      ...(leaveBehindStateBySession.get(sessionId) ?? []),
    ].filter(([, state]) => state.order > latestMutationOrder);
    const leaveBehindDecisions: LeaveBehindDecision[] = [];
    const structuralCandidatePaths: string[] = [];
    for (const [key, state] of finalStates) {
      let laterTransitions: CrossSessionTransition[] = [];
      if (project) {
        transitionsByProjectKey ??= indexTransitionsByProjectKey(
          crossSessionTransitions
        );
        barriersByProject ??= indexBarriersByProject(
          crossSessionInvalidationBarriers
        );
        const transitionBucket =
          transitionsByProjectKey.get(`${project}\0${key}`) ?? [];
        const barrierBucket = barriersByProject.get(project) ?? [];
        laterTransitions = [
          ...transitionBucket.filter(
            (transition) => transition.sessionId !== sessionId
          ),
          ...barrierBucket
            .filter((barrier) => barrier.sessionId !== sessionId)
            .map(
              (barrier): CrossSessionTransition => ({
                ...barrier,
                key,
                path: state.path,
                pathField:
                  barrier.ambiguityReason === 'truncated-command-analysis'
                    ? 'commandAnalysisTruncated'
                    : 'leaveBehindMutationPaths',
                status: 'ambiguous',
                ambiguityReason: barrier.ambiguityReason,
              })
            ),
        ];
      }
      const potentiallyFinalTransitions = [
        ...(state.transition ? [state.transition] : []),
        ...laterTransitions,
      ];
      // Calls within one transcript have proven array order even when their
      // timestamps tie, are absent, or move backwards. Collapse every session
      // to its final relevant call first; only then compare those final states
      // by timestamp across transcripts.
      const finalTransitionBySession = new Map<string, CrossSessionTransition>();
      for (const transition of potentiallyFinalTransitions) {
        const prior = finalTransitionBySession.get(transition.sessionId);
        if (!prior || transition.order > prior.order) {
          finalTransitionBySession.set(transition.sessionId, transition);
        }
      }
      const perSessionFinalTransitions = [...finalTransitionBySession.values()];
      const latestTransitionMs = maxMs(
        perSessionFinalTransitions.map(
          (transition) => transition.orderingTimestampMs ?? null
        )
      );
      // A lower-bound-only final may occur after any later point timestamp, so
      // it always remains a contender. Exact points are discarded only when a
      // different session-final state has a strictly later proven lower bound.
      const finalLatestTransitions = perSessionFinalTransitions.filter(
        (transition) =>
          transition.orderingTimestampExact === false ||
          transition.orderingTimestampMs == null ||
          latestTransitionMs == null ||
          transition.orderingTimestampMs === latestTransitionMs
      );
      const decidingTransitions =
        finalLatestTransitions.length > 0
          ? finalLatestTransitions
          : [];
      const provenCandidateTransitions =
        candidateTransitionsNotProvenSuperseded(
          state,
          potentiallyFinalTransitions
        ).filter(
          (candidate) =>
            !candidateIsProvenBeforeLatestMutation(
              candidate,
              sessionId,
              mutations
            )
        );
      const finalStatuses = new Set(
        finalLatestTransitions.map((transition) => transition.status)
      );
      const outcome: LeaveBehindDecision['outcome'] =
        finalLatestTransitions.length === 0
          ? state.status
          : finalStatuses.size > 1
            ? 'ambiguous'
            : finalLatestTransitions[0].status;
      const latestCandidate = candidateTransitionForEvidence(
        provenCandidateTransitions
      );
      const path = latestCandidate?.path ?? state.path;
      leaveBehindDecisions.push({
        key,
        path,
        outcome,
        ...(outcome === 'ambiguous'
          ? {
              ambiguityReason: finalLatestTransitions.some(
                (transition) =>
                  transition.ambiguityReason ===
                  'truncated-command-analysis'
              )
                ? ('truncated-command-analysis' as const)
                : finalLatestTransitions.some(
                      (transition) =>
                        transition.ambiguityReason === 'truncated-path-tail'
                    )
                  ? ('truncated-path-tail' as const)
                  : ('cross-session-ordering' as const),
            }
          : {}),
        transitions: decidingTransitions,
        provenCandidateTransitions,
      });
      // An equal-time cross-session conflict cannot prove either absence or a
      // final candidate. Keep it on the zero-savings verification path.
      if (
        outcome !== 'invalidated' &&
        provenCandidateTransitions.length > 0
      ) {
        structuralCandidatePaths.push(path);
      }
    }
    const orderingEvents = [
      ...mutations.map((mutation) => ({
        timestampMs: mutation.orderingTimestampMs,
        exact: mutation.orderingTimestampExact,
      })),
      ...leaveBehindDecisions.flatMap((decision) =>
        decision.transitions.map((transition) => ({
          timestampMs: transition.orderingTimestampMs ?? null,
          exact: transition.orderingTimestampExact === true,
        }))
      ),
    ];
    const latestMs = maxMs(orderingEvents.map((event) => event.timestampMs));
    signals.push({
      sessionId,
      taskClass: taskClassOf(sessionId, projects),
      mutations,
      structuralCandidatePaths,
      leaveBehindDecisions,
      latestMs,
      orderingTimestampExact:
        orderingEvents.length > 0 &&
        orderingEvents.every(
          (event) => event.exact && event.timestampMs != null
        ),
    });
  }
  return signals;
}

function maxMs(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function rediscoveryBurst(
  timeline: SessionTimeline,
  projects: Map<string, string>,
  now: number
): RediscoveryBurst | null {
  const firstMs =
    parseTimestamp(timeline.startTime, now).ms ??
    parseTimestamp(timeline.entries[0]?.timestamp, now).ms;
  if (firstMs == null) return null;
  const early = timeline.entries
    .filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
    .filter((entry) => {
      const ms = parseTimestamp(entry.timestamp, now).ms;
      return (
        ms != null &&
        ms >= firstMs &&
        ms - firstMs <= REDISCOVERY_WINDOW_MS
      );
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
    .map((entry) => parseTimestamp(entry.timestamp, now).ms)
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
      (signal) =>
        signal.sessionId !== burst.sessionId &&
        signal.orderingTimestampExact &&
        signal.latestMs != null &&
        signal.latestMs < burst.startMs
    );
    if (candidates.length === 0) continue;
    const prior = candidates[candidates.length - 1];
    if (
      candidates.length > 1 &&
      candidates[candidates.length - 2].latestMs === prior.latestMs
    ) {
      // Two project-local sessions at the same latest proven instant are both
      // before the burst, but the transcript clocks cannot identify which one
      // the rediscovery revisited. Keep the burst unbilled rather than choosing
      // by input order and manufacturing a causal edge.
      continue;
    }
    out.push({ priorSessionId: prior.sessionId, burst });
  }
  return out;
}

// A single-unit attribution figure: context tool-result TOKENS for the involved
// sessions. The earlier version added `toolResultBytes` (characters) into the
// same running total, producing a meaningless mixed-unit number (adversarial-
// review finding #4). `toolResultBytes` / `toolUseIds` remain the join keys the
// provenance cites, but they are not summed into a token figure.
interface TokenAttributionCoverage {
  tokenTotal: number;
  tokenRowsMeasured: number;
  relevantTokenRows: number;
  involvedSessions: number;
  matchingToolUseLinks: number;
  involvedToolUseLinks: number;
  matchingEntriesWithResultBytes: number;
}

function tokenAttributionCoverage(
  input: Parameters<Detector['rule']>[0],
  sessionIds: Set<string>,
  involvedToolUseIdsBySession: Map<string, Set<string>>
): TokenAttributionCoverage {
  const rows = (input.tokenData ?? []).filter((row) =>
    sessionIds.has(row.sessionId)
  );
  const measuredRows = rows.filter(
    (row) =>
      typeof row.contextToolResultTokensSum === 'number' &&
      Number.isFinite(row.contextToolResultTokensSum) &&
      row.contextToolResultTokensSum >= 0
  );
  const matchingToolUseLinks = new Set<string>();
  let matchingEntriesWithResultBytes = 0;
  for (const row of rows) {
    const involvedToolUseIds = involvedToolUseIdsBySession.get(row.sessionId);
    if (!involvedToolUseIds) continue;
    for (const entry of row.entries ?? []) {
      const matches = (entry.toolUseIds ?? []).filter((toolUseId) =>
        involvedToolUseIds.has(toolUseId)
      );
      if (matches.length === 0) continue;
      for (const toolUseId of matches) {
        matchingToolUseLinks.add(`${row.sessionId}\u0000${toolUseId}`);
      }
      if (
        typeof entry.toolResultBytes === 'number' &&
        Number.isFinite(entry.toolResultBytes) &&
        entry.toolResultBytes >= 0
      ) {
        matchingEntriesWithResultBytes += 1;
      }
    }
  }
  return {
    tokenTotal: measuredRows.reduce(
      (total, row) => total + row.contextToolResultTokensSum!,
      0
    ),
    tokenRowsMeasured: measuredRows.length,
    relevantTokenRows: rows.length,
    involvedSessions: sessionIds.size,
    matchingToolUseLinks: matchingToolUseLinks.size,
    involvedToolUseLinks: [...involvedToolUseIdsBySession.values()].reduce(
      (total, toolUseIds) => total + toolUseIds.size,
      0
    ),
    matchingEntriesWithResultBytes,
  };
}

interface DetectorAnalysis {
  projects: Map<string, string>;
  preSignals: PreSignal[];
}

function analyzeInput(
  input: Parameters<Detector['rule']>[0],
  now: number
): DetectorAnalysis {
  const projects = projectBySession(input);
  return {
    projects,
    preSignals: collectPreSignals(input.toolData ?? [], projects, now),
  };
}

function buildRollups(
  input: Parameters<Detector['rule']>[0],
  analysis: DetectorAnalysis,
  now: number
): ClassRollup[] {
  const preSignals = analysis.preSignals.filter(
    (signal) =>
      signal.structuralCandidatePaths.length === 0 &&
      !signal.leaveBehindDecisions.some(
        (decision) => decision.outcome === 'ambiguous'
      )
  );
  if (preSignals.length === 0) return [];

  const bursts = (input.timelines ?? [])
    .map((timeline) => rediscoveryBurst(timeline, analysis.projects, now))
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

  // Only the top rollup is surfaced, so a class with a calibrated (publishable)
  // receipt must outrank one without -- otherwise the preset-floored hypothesis
  // total below could starve a measured receipt out of the single emitted
  // recommendation, letting the 15-minute preset silently decide WHICH claim
  // publishes (#2314; fable-review finding 1). Receipts first (by measured
  // total); honest-null classes keep the prior hypothesis-total ordering, which
  // is an internal ranking heuristic that never reaches a published figure.
  const rolls = [...byClass.values()];
  const receiptByClass = new Map(
    rolls.map((roll) => [roll.taskClass, handoffReceipt(roll)])
  );
  return rolls.sort((a, b) => {
    const ra = receiptByClass.get(a.taskClass);
    const rb = receiptByClass.get(b.taskClass);
    if (!!ra !== !!rb) return (rb ? 1 : 0) - (ra ? 1 : 0);
    if (ra && rb && rb.totalMinutes !== ra.totalMinutes) {
      return rb.totalMinutes - ra.totalMinutes;
    }
    if (b.estimatedMinutes !== a.estimatedMinutes) return b.estimatedMinutes - a.estimatedMinutes;
    return b.preSignals.length - a.preSignals.length;
  });
}

function candidateIsProvenAfterMutations(
  signal: PreSignal,
  candidate: CrossSessionTransition
): boolean {
  if (candidate.sessionId === signal.sessionId) {
    return candidate.order > Math.max(
      ...signal.mutations.map((mutation) => mutation.order)
    );
  }
  if (
    candidate.orderingTimestampExact !== true ||
    candidate.orderingTimestampMs == null ||
    !signal.mutations.every(
      (mutation) =>
        mutation.orderingTimestampExact &&
        mutation.orderingTimestampMs != null
    )
  ) {
    return false;
  }
  const latestMutationMs = maxMs(
    signal.mutations.map((mutation) => mutation.orderingTimestampMs)
  );
  return (
    latestMutationMs != null &&
    candidate.orderingTimestampMs > latestMutationMs
  );
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
  const displayedTaskClass = taskClassDisplay(taskClass);
  const paths = [...new Set(signals.flatMap((signal) => signal.structuralCandidatePaths))];
  const candidateEntries = signals.flatMap((signal) =>
    signal.leaveBehindDecisions
      .filter(
        (decision) =>
          decision.outcome !== 'invalidated' &&
          decision.provenCandidateTransitions.length > 0
      )
      .map((decision) => {
        const candidateTransitions = decision.provenCandidateTransitions;
        return {
          signal,
          decision,
          candidateTransitions,
          provenAfterMutation: candidateTransitions.some((transition) =>
            candidateIsProvenAfterMutations(signal, transition)
          ),
          latestMs:
            maxMs(
              decision.transitions.map(
                (transition) => transition.orderingTimestampMs ?? null
              )
            ) ?? signal.latestMs,
        };
      })
  );
  candidateEntries.sort(
    (a, b) => (b.latestMs ?? -Infinity) - (a.latestMs ?? -Infinity)
  );
  const latestMs = maxMs(candidateEntries.map((entry) => entry.latestMs));
  const candidateFreshnessUnknown = candidateEntries.some(
    ({ signal, decision }) =>
      signal.mutations.some(
        (mutation) =>
          mutation.timestampMs == null || !mutation.orderingTimestampExact
      ) ||
      decision.transitions.length === 0 ||
      decision.transitions.some(
        (transition) =>
          transition.timestampMs == null ||
          transition.orderingTimestampExact === false
      ) ||
      decision.provenCandidateTransitions.some(
        (transition) =>
          transition.timestampMs == null ||
          transition.orderingTimestampExact === false
      )
  );
  const latestDate =
    latestMs == null || candidateFreshnessUnknown
      ? undefined
      : isoDate(latestMs);
  const stale = latestMs != null ? now - latestMs > FRESHNESS_DAYS * DAY_MS : undefined;
  const asOfPrefix = stale && latestDate ? `As of ${latestDate}, ` : '';
  const exampleEntry = [...candidateEntries].sort(
    (a, b) =>
      Number(b.provenAfterMutation) - Number(a.provenAfterMutation) ||
      (b.latestMs ?? -Infinity) - (a.latestMs ?? -Infinity)
  )[0];
  const { signal: example, decision: exampleDecision } = exampleEntry;
  const decidingCandidate =
    exampleEntry.candidateTransitions.find((transition) =>
      candidateIsProvenAfterMutations(example, transition)
    ) ?? candidateTransitionForEvidence(exampleEntry.candidateTransitions);
  const exampleCandidateProvenAfterMutation =
    decidingCandidate != null &&
    candidateIsProvenAfterMutations(example, decidingCandidate);
  const evidencePath = decidingCandidate?.path ?? exampleDecision.path;
  const evidenceSessionId = decidingCandidate?.sessionId ?? example.sessionId;
  const provenAfterMutationCount = candidateEntries.filter(
    (entry) => entry.provenAfterMutation
  ).length;
  const mutationOrderingUnknownCount =
    candidateEntries.length - provenAfterMutationCount;
  const freshnessTransition = candidateEntries
    .flatMap(({ decision }) => decision.transitions)
    .find(
      (transition) =>
        transition.timestampMs == null ||
        transition.orderingTimestampExact === false
    );
  const freshnessCandidate = candidateEntries
    .flatMap(({ decision }) => decision.provenCandidateTransitions)
    .find(
      (transition) =>
        transition.timestampMs == null ||
        transition.orderingTimestampExact === false
    );
  const freshnessMutation = candidateEntries
    .flatMap(({ signal }) => signal.mutations)
    .find(
      (mutation) =>
        mutation.timestampMs == null || !mutation.orderingTimestampExact
    );
  const hasMissingDecisionTiming = candidateEntries.some(
    ({ decision }) => decision.transitions.length === 0
  );
  const orderingAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'cross-session-ordering'
  ).length;
  const truncatedTailAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'truncated-path-tail'
  ).length;
  const truncatedAnalysisAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'truncated-command-analysis'
  ).length;
  const unknownTimeAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'cross-session-ordering' &&
      decision.transitions.some(
        (transition) =>
          transition.timestampMs == null &&
          transition.timestampIssue !== 'future'
      )
  ).length;
  const futureTimeAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'cross-session-ordering' &&
      decision.transitions.some(
        (transition) => transition.timestampIssue === 'future'
      )
  ).length;
  const lowerBoundTimeAmbiguities = candidateEntries.filter(
    ({ decision }) =>
      decision.outcome === 'ambiguous' &&
      decision.ambiguityReason === 'cross-session-ordering' &&
      decision.transitions.some(
        (transition) => transition.orderingTimestampExact === false
      )
  ).length;
  const orderingAmbiguityDetail =
    orderingAmbiguities > 0
      ? ` ${orderingAmbiguities} state-scope observation(s) also have conflicting candidate ` +
        `and invalidation transitions that cannot be ordered across sessions` +
        (unknownTimeAmbiguities > 0
          ? `; ${unknownTimeAmbiguities} include missing or unparseable timestamps.`
          : futureTimeAmbiguities > 0
          ? ` because ${futureTimeAmbiguities} include timestamps materially in the future relative to the evaluation clock.`
          : lowerBoundTimeAmbiguities > 0
          ? ` because ${lowerBoundTimeAmbiguities} include transcript clocks that move backwards, leaving only an ordering lower bound.`
          : ` because their timestamps are equal.`)
      : '';
  const truncatedTailDetail =
    truncatedTailAmbiguities > 0
      ? ` ${truncatedTailAmbiguities} state-scope observation(s) remain uncertain because ` +
        `a successful Bash mutation exceeded the persisted path bound; the omitted path tail ` +
        `is unknown, so no exact-path invalidation is claimed.`
      : '';
  const truncatedAnalysisDetail =
    truncatedAnalysisAmbiguities > 0
      ? ` ${truncatedAnalysisAmbiguities} state-scope observation(s) remain uncertain because ` +
        `a successful Bash call exceeded the static command analysis resource bound; its mutation paths ` +
        `are unknown, so no final-state claim is made.`
      : '';
  const freshnessDetail = candidateFreshnessUnknown
    ? ` Candidate freshness cannot be established because at least one relevant ` +
      `mutation or same-scope transition lacks complete timestamp evidence.`
    : '';
  const candidateOrderingDetail =
    (provenAfterMutationCount > 0
      ? ` ${provenAfterMutationCount} association(s) include candidate evidence proven after the durable mutation.`
      : '') +
    (mutationOrderingUnknownCount > 0
      ? ` ${mutationOrderingUnknownCount} association(s) have same-scope candidate evidence whose order relative to the durable mutation is not proven.`
      : '');

  return {
    id: CANDIDATE_VERIFICATION_ID,
    category: 'workflow',
    severity: 'info',
    title: 'Verify the leave-behind candidate reached Git',
    detail:
      `${asOfPrefix}${signals.length} durable-state session(s) in ${displayedTaskClass} have ` +
      `${candidateEntries.length} structurally conformant leave-behind candidate state association(s) ` +
      `across ${paths.length} unique path(s) that are not provably superseded by a later invalidation.` +
      candidateOrderingDetail +
      orderingAmbiguityDetail + truncatedTailDetail + truncatedAnalysisDetail + freshnessDetail + ' ' +
      `Transcript data cannot prove Git HEAD tracking or scope coverage, so no missing-artifact ` +
      `savings are booked until both are verified.`,
    action:
      `Verify ${evidencePath} is tracked at HEAD and covers the durable mutation(s) in ` +
      `${short(example.sessionId)}. ` +
      `If either check fails, update and commit the leave-behind for the correct state scope; an ` +
      `unrelated tracked artifact does not satisfy the contract.`,
    affected: signals.length,
    view: 'timeline',
    evidence: [
      `${projectEvidenceLead(evidenceSessionId, taskClass)} ${candidateEntries.length} candidate state association(s) across ${paths.length} unique path(s) not provably superseded in ${signals.length} durable-state session(s); Git HEAD is unobserved in transcript data` +
        (orderingAmbiguities > 0
          ? `; ${orderingAmbiguities} cross-session state conflict(s) remain unordered`
          : '') +
        (truncatedTailAmbiguities > 0
          ? `; ${truncatedTailAmbiguities} bounded mutation-path tail(s) remain unknown`
          : '') +
        (truncatedAnalysisAmbiguities > 0
          ? `; ${truncatedAnalysisAmbiguities} bounded command analysis result(s) leave mutation paths unknown`
          : ''),
      `${projectEvidenceLead(evidenceSessionId, taskClass)} cited conformant Write candidate -> ${evidencePath}` +
        (decidingCandidate
          ? ` (tool_use_id ${decidingCandidate.toolUseId}` +
            (decidingCandidate.timestampMs == null
              ? decidingCandidate.timestampIssue === 'future'
                ? ', timestamp materially in the future relative to the evaluation clock)'
                : ', timestamp unavailable)'
              : `, ${new Date(decidingCandidate.timestampMs).toISOString()}` +
                (decidingCandidate.orderingTimestampExact === false
                  ? ', ordering lower bound only)'
                  : ')')) +
            (exampleCandidateProvenAfterMutation
              ? '; transcript/timestamp ordering proves this candidate follows the mutation'
              : '; ordering relative to the mutation is not proven')
          : ''),
      ...(freshnessTransition
        ? [
            `${projectEvidenceLead(freshnessTransition.sessionId, taskClass)} freshness-limiting transition ` +
              `(tool_use_id ${freshnessTransition.toolUseId}) ` +
              timestampEvidenceLimitation(
                freshnessTransition.timestampIssue,
                freshnessTransition.timestampMs
              ),
          ]
        : freshnessCandidate
          ? [
              `${projectEvidenceLead(freshnessCandidate.sessionId, taskClass)} freshness-limiting conformant candidate ` +
                `(tool_use_id ${freshnessCandidate.toolUseId}) ` +
                timestampEvidenceLimitation(
                  freshnessCandidate.timestampIssue,
                  freshnessCandidate.timestampMs
                ),
            ]
          : freshnessMutation
          ? [
              `${projectEvidenceLead(freshnessMutation.sessionId, taskClass)} freshness-limiting durable mutation ` +
                `(tool_use_id ${freshnessMutation.toolUseId}) ` +
                timestampEvidenceLimitation(
                  freshnessMutation.timestampIssue,
                  freshnessMutation.timestampMs
                ),
            ]
          : hasMissingDecisionTiming
            ? [
                `${projectEvidenceLead(example.sessionId, taskClass)} at least one candidate association has no deciding transition timestamp evidence`,
              ]
            : []),
    ],
    claimClass: 'accounting',
    proofTier: 'accounting',
    provenance: {
      observations: [
        {
          claim:
            `${candidateEntries.length} durable-session/state-scope candidate association(s) across ${paths.length} unique path(s) have conformant full-file Write evidence without a provably later invalidation; ` +
            `${provenAfterMutationCount} are proven after their durable mutation and ${mutationOrderingUnknownCount} have mutation ordering unproven`,
          source: 'parse-tools',
          field: 'ToolCall.toolName + ToolCall.input.file_path + ToolCall.leaveBehindStructure + ToolCall.isError',
          value: candidateEntries.length,
        },
        projectJoinObservation(taskClass),
        ...(decidingCandidate
          ? [
              {
                claim:
                  (exampleDecision?.ambiguityReason === 'truncated-path-tail'
                    ? `a conformant Write remains unresolved after a bounded mutation-path overflow in session ${decidingCandidate.sessionId}`
                    : exampleDecision?.ambiguityReason ===
                        'truncated-command-analysis'
                      ? `a conformant Write remains unresolved after bounded command analysis stopped in session ${decidingCandidate.sessionId}`
                    : exampleDecision?.outcome === 'ambiguous'
                    ? `a conformant Write in an unresolved cross-session state conflict was observed in session ${decidingCandidate.sessionId}`
                    : `a same-scope conformant Write candidate was observed in session ${decidingCandidate.sessionId}`) +
                  (exampleCandidateProvenAfterMutation
                    ? '; the candidate is proven after the durable mutation by transcript/timestamp ordering'
                    : '; its order relative to the durable mutation is unproven'),
                source: 'parse-tools',
                field:
                  'ToolCall.timestamp + toolName + input.file_path + leaveBehindStructure + isError',
                value: decidingCandidate.toolUseId,
              } satisfies RecObservation,
            ]
          : []),
        ...(freshnessTransition
          ? [
              {
                claim:
                  `transition ${freshnessTransition.toolUseId} in session ${freshnessTransition.sessionId} ` +
                  timestampLimitation(
                    freshnessTransition.timestampIssue,
                    freshnessTransition.timestampMs
                  ) +
                  '; candidate freshness is not claimed',
                source: 'parse-tools',
                field:
                  'ToolCall.timestamp + ordered ToolCall[] + toolName + input.file_path/leaveBehindMutationPaths',
                value: freshnessTransition.toolUseId,
              } satisfies RecObservation,
            ]
          : freshnessCandidate
            ? [
                {
                  claim:
                    `conformant candidate ${freshnessCandidate.toolUseId} in session ${freshnessCandidate.sessionId} ` +
                    timestampLimitation(
                      freshnessCandidate.timestampIssue,
                      freshnessCandidate.timestampMs
                    ) +
                    '; candidate freshness is not claimed',
                  source: 'parse-tools',
                  field:
                    'ToolCall.timestamp + toolName + input.file_path + leaveBehindStructure + isError',
                  value: freshnessCandidate.toolUseId,
                } satisfies RecObservation,
              ]
            : freshnessMutation
            ? [
                {
                  claim:
                    `durable mutation ${freshnessMutation.toolUseId} in session ${freshnessMutation.sessionId} ` +
                    timestampLimitation(
                      freshnessMutation.timestampIssue,
                      freshnessMutation.timestampMs
                    ) +
                    '; candidate freshness is not claimed',
                  source: 'parse-tools',
                  field: 'ToolCall.timestamp + ordered ToolCall[]',
                  value: freshnessMutation.toolUseId,
                } satisfies RecObservation,
              ]
            : hasMissingDecisionTiming
              ? [
                  {
                    claim:
                      'at least one candidate association has no deciding transition timestamp evidence; candidate freshness is not claimed',
                    source: 'parse-tools',
                    field: 'LeaveBehindDecision.transitions',
                    value: 'unavailable',
                  } satisfies RecObservation,
                ]
              : []),
        ...(orderingAmbiguities > 0
          ? [
              {
                claim:
                  `${orderingAmbiguities} state-scope observation(s) have conflicting candidate and invalidation transitions that cannot be ordered across sessions`,
                source: 'parse-tools',
                field:
                  'ToolCall.timestamp + sessionId + toolName + input.file_path + leaveBehindStructure + isError',
                value: orderingAmbiguities,
              } satisfies RecObservation,
            ]
          : []),
        ...(truncatedTailAmbiguities > 0
          ? [
              {
                claim:
                  `${truncatedTailAmbiguities} state-scope observation(s) remain uncertain because a bounded leaveBehindMutationPaths tail was omitted; no exact-path invalidation is claimed`,
                source: 'parse-tools',
                field:
                  'ToolCall.leaveBehindMutationPaths + ToolCall.leaveBehindMutationPathsTruncated + ToolCall.isError',
                value: truncatedTailAmbiguities,
              } satisfies RecObservation,
            ]
          : []),
        ...(truncatedAnalysisAmbiguities > 0
          ? [
              {
                claim:
                  `${truncatedAnalysisAmbiguities} state-scope observation(s) remain uncertain because static Bash analysis stopped at its resource bound; no final mutation-path state is claimed`,
                source: 'parse-tools',
                field:
                  'ToolCall.commandAnalysisTruncated + ToolCall.isError',
                value: truncatedAnalysisAmbiguities,
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
        'A conformant document structure was observed in the same state scope without a provably later exact-path invalidation. Some candidates are provably after the durable mutation while others may have unproven mutation ordering; cross-session transitions can also remain unordered when timestamps tie or are unavailable, and a bounded mutation-path tail or bounded command analysis may leave final state uncertain. Git commitment plus semantic scope coverage are unknown. Verification is warranted; final state, absence, saved time, and a need to rewrite the artifact are not claimed.',
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

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The calibrated per-task-class handoff receipt (#2314). A receipt exists only
 * once the class has at least `MIN_HANDOFF_RECEIPT_SAMPLES` genuinely observed
 * re-discovery bursts; the figure is aggregated purely from the unfloored
 * measured `observedMinutes` spans, so it never mixes the 15-minute preset floor
 * into the published number. Returns `null` below the floor (cold-start classes,
 * with zero measured bursts, always fall here), and the caller then emits an
 * honest null rather than asserting a minutes saving.
 */
interface HandoffReceipt {
  sampleSize: number;
  medianMinutes: number;
  totalMinutes: number;
  /** Latest contributing burst end (ms) — the freshness clock for the published
   *  figure, distinct from `roll.latestMs` which also tracks non-billing
   *  pre-signal mutations. */
  latestMs: number;
  asOf: string;
}

function handoffReceipt(roll: ClassRollup): HandoffReceipt | null {
  if (roll.rediscoveries.length < MIN_HANDOFF_RECEIPT_SAMPLES) return null;
  const minutes = roll.rediscoveries.map((r) => r.burst.observedMinutes);
  const totalMinutes = minutes.reduce((sum, m) => sum + m, 0);
  // A calibrated sample of bursts that measured ~0 re-discovery minutes has no
  // material cost to publish, so it is not treated as a receipt: fall through to
  // the honest null rather than asserting a 0-minute causal claim.
  if (totalMinutes <= 0) return null;
  const latestMs = Math.max(...roll.rediscoveries.map((r) => r.burst.endMs));
  return {
    sampleSize: roll.rediscoveries.length,
    medianMinutes: medianOf(minutes),
    totalMinutes,
    latestMs,
    asOf: isoDate(latestMs),
  };
}

function toRecommendation(
  input: Parameters<Detector['rule']>[0],
  roll: ClassRollup,
  now: number
): Recommendation {
  const uncertainTimeMutation = roll.preSignals
    .flatMap((signal) => signal.mutations)
    .find(
      (mutation) =>
        mutation.timestampMs == null || !mutation.orderingTimestampExact
    );
  const mutationFreshnessUnknown = uncertainTimeMutation != null;
  const invalidationHasUnknownTime = roll.preSignals.some((signal) =>
    signal.leaveBehindDecisions.some(
      (decision) =>
        decision.outcome === 'invalidated' &&
        decision.transitions.some(
          (transition) =>
            transition.timestampMs == null &&
            transition.timestampIssue !== 'future'
        )
    )
  );
  const invalidationHasFutureTime = roll.preSignals.some((signal) =>
    signal.leaveBehindDecisions.some(
      (decision) =>
        decision.outcome === 'invalidated' &&
        decision.transitions.some(
          (transition) => transition.timestampIssue === 'future'
        )
    )
  );
  const invalidationHasLowerBoundTime = roll.preSignals.some((signal) =>
    signal.leaveBehindDecisions.some(
      (decision) =>
        decision.outcome === 'invalidated' &&
        decision.transitions.some(
          (transition) => transition.orderingTimestampExact === false
        )
    )
  );
  const invalidationFreshnessUnknown = roll.preSignals.some((signal) =>
    signal.leaveBehindDecisions.some(
      (decision) =>
        decision.outcome === 'invalidated' &&
        (decision.transitions.length === 0 ||
          decision.transitions.some(
          (transition) => transition.timestampMs == null
            || transition.orderingTimestampExact === false
          ))
    )
  );
  const freshnessInvalidation = roll.preSignals
    .flatMap((signal) => signal.leaveBehindDecisions)
    .filter((decision) => decision.outcome === 'invalidated')
    .flatMap((decision) => decision.transitions)
    .find(
      (transition) =>
        transition.status === 'invalidated' &&
        (transition.timestampMs == null ||
          transition.orderingTimestampExact === false)
    );
  const aggregateFreshnessUnknown =
    mutationFreshnessUnknown || invalidationFreshnessUnknown;
  const latestDate =
    roll.latestMs == null || aggregateFreshnessUnknown
      ? undefined
      : isoDate(roll.latestMs);
  const latestRediscovery = latestDate
    ? roll.rediscoveries.find(
        (rediscovery) => rediscovery.burst.endMs === roll.latestMs
      )
    : undefined;
  const latestStateTransition = latestDate
    ? roll.preSignals
        .flatMap((signal) => signal.leaveBehindDecisions)
        .flatMap((decision) => decision.transitions)
        .find(
          (transition) =>
            transition.orderingTimestampExact === true &&
            transition.orderingTimestampMs === roll.latestMs
        )
    : undefined;
  const latestMutation = latestDate
    ? roll.preSignals
        .flatMap((signal) => signal.mutations)
        .find(
          (mutation) =>
            mutation.orderingTimestampExact &&
            mutation.orderingTimestampMs === roll.latestMs
        )
    : undefined;
  const latestFreshnessObservation: RecObservation | undefined =
    latestRediscovery
      ? {
          claim:
            `rediscovery burst ${latestRediscovery.burst.sessionId} determines aggregate freshness as of ${latestDate}`,
          source: 'parse-timeline',
          field:
            'SessionTimeline.sessionId + startTime + entries[].timestamp + entries[].rediscovery',
          value: latestRediscovery.burst.sessionId,
        }
      : latestStateTransition
      ? {
          claim:
            `state transition ${latestStateTransition.toolUseId} in session ${latestStateTransition.sessionId} ` +
            `determines aggregate freshness as of ${latestDate}`,
          source: 'parse-tools',
          field:
            `ToolCall.timestamp + toolName + ${latestStateTransition.pathField} + isError`,
          value: latestStateTransition.toolUseId,
        }
      : latestMutation
      ? {
          claim:
            `durable mutation ${latestMutation.toolUseId} in session ${latestMutation.sessionId} ` +
            `determines aggregate freshness as of ${latestDate}`,
          source: 'parse-tools',
          field:
            'ToolCall.timestamp + commandAnalysisComplete + commandDurableKind/input.command/commandPreview + isError',
          value: latestMutation.toolUseId,
        }
      : undefined;
  const stale =
    roll.latestMs != null ? now - roll.latestMs > FRESHNESS_DAYS * DAY_MS : undefined;
  const invalidationTimingCaveat = invalidationHasUnknownTime
    ? 'at least one relevant same-scope transition has timestamp unavailable'
    : invalidationHasFutureTime
    ? 'at least one relevant same-scope transition has a timestamp materially in the future relative to the evaluation clock'
    : invalidationHasLowerBoundTime
    ? 'at least one relevant same-scope transition has only an ordering lower bound because its transcript clock moves backwards'
    : 'complete cross-session timing evidence is unavailable for at least one relevant same-scope state';
  const aggregateFreshnessDetail = aggregateFreshnessUnknown
    ? 'Aggregate freshness cannot be established because at least one relevant durable mutation or same-scope state transition lacks complete timestamp evidence. '
    : '';

  const sessionIds = new Set<string>();
  for (const signal of roll.preSignals) sessionIds.add(signal.sessionId);
  for (const billed of roll.rediscoveries) {
    sessionIds.add(billed.priorSessionId);
    sessionIds.add(billed.burst.sessionId);
  }
  const involvedToolUseIdsBySession = new Map<string, Set<string>>();
  const addInvolvedToolUse = (sessionId: string, toolUseId: string) => {
    const toolUseIds =
      involvedToolUseIdsBySession.get(sessionId) ?? new Set<string>();
    toolUseIds.add(toolUseId);
    involvedToolUseIdsBySession.set(sessionId, toolUseIds);
    sessionIds.add(sessionId);
  };
  for (const signal of roll.preSignals) {
    for (const mutation of signal.mutations) {
      addInvolvedToolUse(mutation.sessionId, mutation.toolUseId);
    }
    for (const decision of signal.leaveBehindDecisions) {
      for (const transition of decision.transitions) {
        addInvolvedToolUse(transition.sessionId, transition.toolUseId);
      }
    }
  }
  const attribution = tokenAttributionCoverage(
    input,
    sessionIds,
    involvedToolUseIdsBySession
  );

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
        (b.transition.orderingTimestampMs ?? -Infinity) -
          (a.transition.orderingTimestampMs ?? -Infinity) ||
        b.transition.order - a.transition.order
    )[0];
  const observedRediscoveryMin = roll.rediscoveries.reduce(
    (sum, r) => sum + r.burst.observedMinutes,
    0
  );
  const displayedTaskClass = taskClassDisplay(roll.taskClass);
  // #2314: publish the human-minute figure only with a calibrated receipt; below
  // the sample floor (and for every cold-start pre-signal) `receipt` is null and
  // the recommendation emits an honest null instead of the preset floor.
  const receipt = handoffReceipt(roll);
  // The published present-tense figure is only "current" if the bursts backing it
  // are recent, so its staleness is gated on the receipt's own freshness -- NOT
  // on roll.latestMs, which a fresh non-billing pre-signal mutation in the same
  // project would keep recent and thereby suppress a needed demotion. The
  // honest-null branch (no minutes claim) keeps the pre-signal-based freshness.
  const receiptStale =
    receipt != null && now - receipt.latestMs > FRESHNESS_DAYS * DAY_MS;
  const publishAsOf = receipt ? receipt.asOf : latestDate;
  const publishStale = receipt ? receiptStale : stale;
  const publishAsOfPrefix =
    publishStale && publishAsOf ? `As of ${publishAsOf}, ` : '';
  const orderingScope = roll.taskClass.startsWith(UNKNOWN_PROJECT_PREFIX)
    ? 'within the same transcript; cross-session state ordering was not attempted because project identity is unresolved'
    : 'in the same project';
  const evidence = [
    `${projectEvidenceLead(lead.sessionId, roll.taskClass)} ${displayedTaskClass}: ${roll.preSignals.length} durable-state session(s) without an uninvalidated final v1 structural candidate written after the latest durable mutation in the transcript and remaining uninvalidated by later observed file mutations ${orderingScope}; ` +
      `example ${short(lead.sessionId)} ${leadMutation.kind} via ${clip(leadMutation.label)}`,
    ...(uncertainTimeMutation
      ? [
          `${projectEvidenceLead(uncertainTimeMutation.sessionId, roll.taskClass)} durable mutation ` +
            `(tool_use_id ${uncertainTimeMutation.toolUseId}) ` +
            timestampEvidenceLimitation(
              uncertainTimeMutation.timestampIssue,
              uncertainTimeMutation.timestampMs
            ) +
            '; ' +
            `aggregate freshness is not claimed`,
        ]
      : []),
    ...(latestInvalidation
      ? [
          invalidationFreshnessUnknown
            ? `${projectEvidenceLead(latestInvalidation.transition.sessionId, roll.taskClass)} ` +
              `${latestInvalidation.transition.timestampMs == null ? 'undated' : 'dated'} invalidation example: ` +
              `successful ${latestInvalidation.transition.toolName} ` +
              `(tool_use_id ${latestInvalidation.transition.toolUseId}) provided invalidation evidence for ` +
              `${latestInvalidation.decision.path}; ${invalidationTimingCaveat}, so no latest ` +
              `invalidated state is claimed`
            : `${projectEvidenceLead(latestInvalidation.transition.sessionId, roll.taskClass)} successful ${latestInvalidation.transition.toolName} ` +
              `(tool_use_id ${latestInvalidation.transition.toolUseId}) established the latest observed invalidated state for ${latestInvalidation.decision.path}`,
        ]
      : []),
    ...(freshnessInvalidation
      ? [
          `${projectEvidenceLead(freshnessInvalidation.sessionId, roll.taskClass)} freshness-limiting invalidation ` +
            `(tool_use_id ${freshnessInvalidation.toolUseId}) ` +
            `${timestampEvidenceLimitation(freshnessInvalidation.timestampIssue, freshnessInvalidation.timestampMs)}; ` +
            'aggregate freshness is not claimed',
        ]
      : []),
    ...(roll.rediscoveries.length
      ? [
          `${projectEvidenceLead(roll.rediscoveries[0].priorSessionId, roll.taskClass)} ${roll.rediscoveries.length} later rediscovery session(s), ~${fmtMin(observedRediscoveryMin)} billed back; ` +
            `example ${short(roll.rediscoveries[0].priorSessionId)} -> ${short(roll.rediscoveries[0].burst.sessionId)} ` +
            `(${clip(roll.rediscoveries[0].burst.sample)})`,
        ]
      : [
          `cold-start pre-signal only: no measured re-discovery burst exists for this task class yet, so no human-minute figure is asserted`,
        ]),
  ];

  const observations: RecObservation[] = [
    {
      claim:
        `${roll.preSignals.length} session(s) in ${displayedTaskClass} mutated durable external state and did not end with an uninvalidated v1 structural candidate written after the latest durable external-state mutation in the same transcript and remaining uninvalidated by later observed file mutations ${orderingScope}`,
      source: 'parse-tools',
      field: 'ordered ToolCall[]: toolName + commandAnalysisComplete + commandDurableKind/input.command/commandPreview + input.file_path/leaveBehindMutationPath/leaveBehindMutationPaths/leaveBehindMutationPathsTruncated + leaveBehindStructure + timestamp + isError',
      value: roll.preSignals.length,
    },
    ...(uncertainTimeMutation
      ? [
          {
            claim:
              `durable mutation ${uncertainTimeMutation.toolUseId} in session ${uncertainTimeMutation.sessionId} ` +
              timestampLimitation(
                uncertainTimeMutation.timestampIssue,
                uncertainTimeMutation.timestampMs
              ) +
              '; aggregate freshness is not claimed',
            source: 'parse-tools',
            field:
              'ToolCall.timestamp + commandAnalysisComplete + commandDurableKind/input.command/commandPreview + isError',
            value: uncertainTimeMutation.toolUseId,
          } satisfies RecObservation,
        ]
      : []),
    ...(latestInvalidation
      ? [
          {
            // A same-transcript transition remains auditable when project
            // identity is absent; only the cross-session join is unavailable.
            claim:
              invalidationFreshnessUnknown
                ? `${latestInvalidation.transition.timestampMs == null ? 'an undated' : 'a dated'} invalidation example: ` +
                  `a successful ${latestInvalidation.transition.toolName} in session ${latestInvalidation.transition.sessionId} ` +
                  `provided invalidation evidence for the canonical leave-behind path ` +
                  `${latestInvalidation.transition.project == null ? 'within the same transcript (project identity unresolved)' : `in project ${latestInvalidation.transition.project}`}; ${invalidationTimingCaveat}, so no latest ` +
                  `invalidated state or freshness is claimed`
                : `a successful ${latestInvalidation.transition.toolName} in session ${latestInvalidation.transition.sessionId} established the latest observed invalidated state for the canonical leave-behind path ${latestInvalidation.transition.project == null ? 'within the same transcript (project identity unresolved)' : `in project ${latestInvalidation.transition.project}`}`,
            source:
              latestInvalidation.transition.project == null
                ? 'parse-tools'
                : 'parse-tools + sessions + tokenData',
            field:
              latestInvalidation.transition.project == null
                ? `ToolCall.timestamp + toolName + ${latestInvalidation.transition.pathField} + isError`
                : `ToolCall.timestamp + toolName + ${latestInvalidation.transition.pathField} + isError joined by sessionId to sessions[].project / tokenData[].project`,
            value: latestInvalidation.transition.toolUseId,
          } satisfies RecObservation,
        ]
      : []),
    ...(freshnessInvalidation
      ? [
          {
            claim:
              `invalidation ${freshnessInvalidation.toolUseId} in session ${freshnessInvalidation.sessionId} ` +
              `${timestampLimitation(freshnessInvalidation.timestampIssue, freshnessInvalidation.timestampMs)}; ` +
              'aggregate freshness is not claimed',
            source: 'parse-tools',
            field:
              `ToolCall.timestamp + ordered ToolCall[] + toolName + ${freshnessInvalidation.pathField} + isError`,
            value: freshnessInvalidation.toolUseId,
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
          : `no later rediscovery session is recorded for this task class yet, so no human-minute figure is asserted for the day-one pre-signal`,
      source: 'parse-timeline',
      field: 'entries[].rediscovery (derived at parse time from the full turn text; survives slimming) in the first 20 minutes',
      value: roll.rediscoveries.length > 0 ? observedRediscoveryMin : 0,
    },
    receipt
      ? ({
          claim:
            `${receipt.sampleSize} measured rediscovery burst(s) in ${displayedTaskClass} clear the ` +
            `${MIN_HANDOFF_RECEIPT_SAMPLES}-sample calibration floor and span ${fmtMin(receipt.totalMinutes)} of ` +
            `elapsed wall-clock total (median ${fmtMin(receipt.medianMinutes)} per occurrence, start-of-session to ` +
            `last rediscovery) -- an observed ACCOUNTING span that includes assistant work and idle time, not a ` +
            `measurement of active human effort, so no human-minute saving is asserted`,
          source: 'parse-timeline',
          field:
            'aggregated per taskClass from RediscoveryBurst.observedMinutes (elapsed start-to-last-hit wall-clock span)',
          value: receipt.totalMinutes,
        } satisfies RecObservation)
      : ({
          claim:
            (roll.rediscoveries.length < MIN_HANDOFF_RECEIPT_SAMPLES
              ? `only ${roll.rediscoveries.length} measured rediscovery burst(s) in ${displayedTaskClass}, below the ${MIN_HANDOFF_RECEIPT_SAMPLES}-sample calibration floor`
              : `${roll.rediscoveries.length} measured rediscovery burst(s) in ${displayedTaskClass} carry no material re-discovery time`) +
            `, so no human-minute figure is asserted (honest null)`,
          source: 'parse-timeline',
          field:
            'RediscoveryBurst count and unfloored observedMinutes total per taskClass vs MIN_HANDOFF_RECEIPT_SAMPLES',
          value: roll.rediscoveries.length,
        } satisfies RecObservation),
    ...(attribution.tokenRowsMeasured > 0
      ? [
          {
            claim:
              `#1926 contextToolResultTokensSum is numeric on ${attribution.tokenRowsMeasured} of ` +
              `${attribution.relevantTokenRows} matching token row(s) across ${attribution.involvedSessions} involved session(s), ` +
              `totaling ${Math.round(attribution.tokenTotal)} context tool-result tokens`,
            source: 'tokenData',
            field: 'SessionTokenData.sessionId + contextToolResultTokensSum',
            value: Math.round(attribution.tokenTotal),
          } satisfies RecObservation,
        ]
      : [
          {
            claim:
              `#1926 contextToolResultTokensSum is unavailable for the ${attribution.involvedSessions} involved session(s); ` +
              `${attribution.relevantTokenRows} matching token row(s) were present`,
            source: 'tokenData',
            field: 'SessionTokenData.sessionId + contextToolResultTokensSum',
            value: 'unavailable',
          } satisfies RecObservation,
        ]),
    ...(attribution.matchingToolUseLinks > 0
      ? [
          {
            claim:
              `#1928 token-entry join evidence intersects ${attribution.matchingToolUseLinks} of ` +
              `${attribution.involvedToolUseLinks} involved session-scoped ToolCall.toolUseId value(s); ` +
              `${attribution.matchingEntriesWithResultBytes} matching entry/entries also carry numeric toolResultBytes`,
            source: 'tokenData + parse-tools',
            field:
              'SessionTokenData.sessionId + TokenEntry.toolUseIds intersect ToolUsageData.sessionId + ToolCall.toolUseId; TokenEntry.toolResultBytes coverage reported separately',
            value: attribution.matchingToolUseLinks,
          } satisfies RecObservation,
        ]
      : [
          {
            claim:
              `#1928 token-entry tool-use attribution is unavailable because 0 of ${attribution.involvedToolUseLinks} ` +
              'involved session-scoped ToolCall.toolUseId values intersect tokenData entry toolUseIds',
            source: 'tokenData + parse-tools',
            field:
              'SessionTokenData.sessionId + TokenEntry.toolUseIds intersect ToolUsageData.sessionId + ToolCall.toolUseId',
            value: 'unavailable',
          } satisfies RecObservation,
        ]),
    ...(latestFreshnessObservation ? [latestFreshnessObservation] : []),
    projectJoinObservation(roll.taskClass),
  ];

  return {
    id: DETECTOR_ID,
    category: 'workflow',
    severity: roll.rediscoveries.length > 0 ? 'warning' : 'info',
    title: 'Leave a handoff when agents establish durable state',
    detail:
      `${publishAsOfPrefix}${roll.preSignals.length} durable-state session(s) in ${displayedTaskClass} ` +
      `changed remote/config/install state without an uninvalidated final v1 structural candidate written after the latest durable mutation in the transcript and remaining uninvalidated by later observed file mutations ${orderingScope}. ` +
      aggregateFreshnessDetail +
      (roll.rediscoveries.length > 0
        ? `${roll.rediscoveries.length} later session(s) then spent early turns re-discovering that setup (~${fmtMin(observedRediscoveryMin)} observed). `
        : `This is a cold-start pre-signal: no later historical corpus is needed. `) +
      (receipt
        ? `Across ${receipt.sampleSize} measured re-discovery burst(s) in ${displayedTaskClass} ` +
          `(median ${fmtMin(receipt.medianMinutes)} per occurrence, as of ${receipt.asOf}), ` +
          `re-discovering that un-handed-off durable state spans ~${fmtMin(receipt.totalMinutes)} of elapsed ` +
          `wall-clock (start-of-session to last rediscovery) -- an observed accounting span that includes ` +
          `assistant work and idle time, not a measurement of active human effort, so no human-minute saving ` +
          `is claimed.`
        : `Not enough history to size the handoff cost for ${displayedTaskClass} yet: ` +
          (roll.rediscoveries.length < MIN_HANDOFF_RECEIPT_SAMPLES
            ? `${roll.rediscoveries.length} measured re-discovery burst(s) is below the ` +
              `${MIN_HANDOFF_RECEIPT_SAMPLES} needed to calibrate a per-task-class human-minute figure`
            : `the ${roll.rediscoveries.length} measured re-discovery burst(s) carry no material ` +
              `re-discovery time`) +
          `, so no time saving is asserted. The missing-handoff pre-signal is still tracked.`),
    action:
      `For tasks in ${displayedTaskClass} that mutate material durable external state, follow docs/leave-behind-contract.md and update docs/runbooks/<state-scope>/README.md with both Operability and Decision log halves. Skip trivial local-only changes.`,
    affected: roll.preSignals.length,
    // #3250: the burst quantity is elapsed wall-clock (start-of-session to last
    // rediscovery), NOT a measured active-human-duration artifact — the transcript
    // carries none — so it is never published as estTimeReclaimedMin. Booking an
    // elapsed accounting span as reclaimed human time would over-claim causally.
    view: 'timeline',
    evidence,
    // #3250: an elapsed burst span is an accounting measurement (arithmetic on
    // timestamps), never a causal human-time claim. A receipt reports the observed
    // span at proofTier 'accounting'; without one it stays 'auditable'.
    claimClass: 'accounting',
    proofTier: receipt ? 'accounting' : 'auditable',
    provenance: {
      observations,
      inference: receipt
        ? `A missing handoff after a durable-state mutation is an accounting pre-signal; the ${receipt.sampleSize} measured early-turn rediscovery burst(s) in this task class span a median ${fmtMin(receipt.medianMinutes)} of elapsed wall-clock per occurrence (${fmtMin(receipt.totalMinutes)} total). That span is an observed ACCOUNTING measurement -- start-of-session to last rediscovery, including assistant work and idle time -- not a measured active-human-duration and not a causal saving, so no estTimeReclaimedMin is published.`
        : `A missing handoff after a durable-state mutation is an accounting pre-signal. Fewer than ${MIN_HANDOFF_RECEIPT_SAMPLES} measured early-turn rediscovery bursts exist for this task class, so no human-minute saving is asserted; the pre-signal is tracked until enough bursts accrue to calibrate an observational receipt.`,
      ...(publishAsOf ? { asOf: publishAsOf, stale: !!publishStale } : {}),
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
    const analysis = analyzeInput(input, now);
    const roll = claudeMdMarksApplied(input.liveConfig, MARKERS)
      ? undefined
      : buildRollups(input, analysis, now)[0];
    return roll
      ? toRecommendation(input, roll, now)
      : candidateVerificationRecommendation(now, analysis);
  },
  emitAll(input, now): Recommendation[] {
    const analysis = analyzeInput(input, now);
    const recommendations: Recommendation[] = [];
    if (!claudeMdMarksApplied(input.liveConfig, MARKERS)) {
      const roll = buildRollups(input, analysis, now)[0];
      if (roll) recommendations.push(toRecommendation(input, roll, now));
    }
    const candidate = candidateVerificationRecommendation(now, analysis);
    if (candidate) recommendations.push(candidate);
    return recommendations;
  },
};
