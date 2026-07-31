/**
 * `reliability.workflow-ratelimit-burst` (#2305, epic #2199).
 *
 * A multi-agent Workflow that reaches a shared Claude usage boundary dies in a
 * characteristic way: a BURST of agent failures inside one run, each carrying
 * explicit Claude/session/usage/plan/weekly exhaustion text ("You've hit your
 * session limit", "usage limit reached"). The observed incident (2026-07-03,
 * session f8f7788b): a 68-agent adversarial review lost 24 verifier agents to
 * "You've hit your session limit" — ~2.8M subagent tokens with no completed
 * result. The generic `workflow.failed-workflow-runs` card already flags any
 * failed run; this detector isolates the RATE-LIMIT cause specifically,
 * because its fix is different — check the applicable plan headroom before the
 * next fan-out, gate 5h-window work against remaining capacity, cap the fan-out
 * shape, and salvage completed-agent transcripts instead of retrying agents.
 *
 * Signal: within ONE run, >= {@link BURST_MIN_FAILURES} agents whose outcome
 * text matches {@link hasUsageLimitExhaustionEvidence}. An agent counts only
 * when its `state` is a concrete failure state AND its state/result/error text
 * matches. Null states remain unknown: legacy/cached manifests can omit state,
 * so result prose alone cannot prove the agent failed.
 * A COMPLETED agent whose result merely mentions rate limits (e.g. its task
 * was ABOUT rate limiting) never counts — that is the false-positive guard.
 *
 * Severity scales with the blast radius: `warning` for a small burst,
 * `critical` when a large fraction of a big fan-out died
 * (>= {@link CRITICAL_MIN_FAILURES} failures AND >= {@link CRITICAL_FRAC} of
 * >= {@link CRITICAL_MIN_AGENTS} agents — the 68-agent/24-failure incident
 * clears all three).
 *
 * dataDeps: reads the optional `workflows` field on RecommendationInput
 * (parse-workflows output). Absent/empty ⇒ silent (dark on the SPA dataset).
 */
import type { Detector, Recommendation, RecObservation } from '../types';
import type { WorkflowAgent, WorkflowRun } from '../../parse-workflows';
import { short } from '../shared';

/** Failure burst floor: fewer same-run rate-limit failures than this ⇒ silent. */
export const BURST_MIN_FAILURES = 3;
/** Critical needs at least this many failed agents in one run... */
const CRITICAL_MIN_FAILURES = 10;
/** ...that make up at least this fraction of the run's fan-out... */
const CRITICAL_FRAC = 0.25;
/** ...on a genuinely big fan-out. */
const CRITICAL_MIN_AGENTS = 20;
const MAX_EVIDENCE = 5;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Manifest writers and detector hosts may differ slightly in wall-clock time. */
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Last millisecond whose ISO date has a normal four-digit year. */
const MAX_NORMAL_ISO_TIMESTAMP_MS = 253_402_300_799_999;

/**
 * `resultPreview` is ordinary task prose, not a structured provider error. A
 * finite provider denylist can therefore never establish Claude attribution.
 * The unqualified exceptions below are whole-message shapes emitted by the
 * harness; every generalized shape must bind the exhausted boundary directly
 * to Claude/Claude Code instead.
 */
const CANONICAL_RESET_DATE =
  String.raw`(?:(?:Jan|Mar|May|Jul|Aug|Oct|Dec)\s+(?:[1-9]|[12]\d|3[01])|(?:Apr|Jun|Sep|Nov)\s+(?:[1-9]|[12]\d|30)|Feb\s+(?:[1-9]|1\d|2\d))(?:,\s+\d{4})?,\s+`;
const CANONICAL_RESET_AT =
  String.raw`(?:${CANONICAL_RESET_DATE})?(?:[1-9]|1[0-2])(?::[0-5]\d)?\s?(?:am|pm)(?:\s+\((?:UTC|GMT|[\w+.-]+(?:\/[\w+.-]+)+)\))?`;
const EXPLICIT_RESET_DATE_RE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4}),\s+/i;
const RESET_MONTH_MAX_DAYS: Readonly<Record<string, number>> = {
  jan: 31,
  feb: 28,
  mar: 31,
  apr: 30,
  may: 31,
  jun: 30,
  jul: 31,
  aug: 31,
  sep: 30,
  oct: 31,
  nov: 30,
  dec: 31,
};

/** The CLI may omit a year; when it supplies one, require a real calendar day. */
function hasValidExplicitResetDate(text: string): boolean {
  const match = EXPLICIT_RESET_DATE_RE.exec(text);
  if (match == null) return true;
  const month = match[1].toLowerCase();
  const day = Number(match[2]);
  const year = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = RESET_MONTH_MAX_DAYS[month] + (month === 'feb' && leapYear ? 1 : 0);
  return day >= 1 && day <= maxDay;
}

const TIME_ZONE_VALIDITY = new Map<string, boolean>();
function hasValidTimeZone(text: string): boolean {
  const zone = /\s\(([^()]*)\)\s*$/.exec(text)?.[1];
  if (zone == null) return true;
  const cached = TIME_ZONE_VALIDITY.get(zone);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    valid = false;
  }
  if (TIME_ZONE_VALIDITY.size < 64) TIME_ZONE_VALIDITY.set(zone, valid);
  return valid;
}
const CANONICAL_RESET_DETAIL =
  String.raw`reset(?:s|ting)?(?:\s+(?:later|(?:at\s+)?${CANONICAL_RESET_AT}))?`;
const CAPACITY_EXHAUSTED = String.raw`(?:reached|exceeded|exhausted)`;
const CANONICAL_FABLE_API_ERROR =
  String.raw`you(?:['’]ve|\s+have)\s+reached\s+your\s+fable\s+5\s+limit(?:\.\s+(?:run\s+/usage-credits\s+to\s+continue\s+or\s+switch\s+models\s+with\s+/model|/model\s+to\s+switch\s+models))?`;
const CANONICAL_CLAUDE_CAPACITY_MESSAGES = [
  new RegExp(String.raw`^\s*${CANONICAL_FABLE_API_ERROR}\s*$`, 'i'),
  new RegExp(String.raw`^\s*you(?:['’]ve|\s+have)\s+hit\s+your\s+(?:session\s+limit(?:\s*[.!·—–-]\s*(?:(?:your|the)\s+limit\s+will\s+)?${CANONICAL_RESET_DETAIL})?|(?:opus|sonnet|fable\s+5)\s+limit(?:\s*·\s*resets\s+${CANONICAL_RESET_AT})?|usage\s+limit(?:\s*·\s*(?:resets\s+${CANONICAL_RESET_AT}|contact\s+your\s+admin\s+to\s+increase\s+it))?)\s*$`, 'i'),
  new RegExp(String.raw`^\s*usage\s+limit\s+(?:was\s+|has\s+been\s+)?${CAPACITY_EXHAUSTED}\s*[.!·—–-]\s*${CANONICAL_RESET_DETAIL}\s*$`, 'i'),
  new RegExp(String.raw`^\s*(?:you(?:['’]ve|\s+have)\s+hit\s+your\s+weekly\s+limit|(?:the\s+)?weekly(?:\s+plan)?\s+limit\s+(?:was\s+|has\s+been\s+)?${CAPACITY_EXHAUSTED})(?:\s*[.!·—–-]\s*(?:(?:your|the)\s+limit\s+will\s+)?${CANONICAL_RESET_DETAIL})?\s*$`, 'i'),
  new RegExp(String.raw`^\s*(?:the\s+)?session\s+window(?:\s+limit)?\s+(?:was\s+|has\s+been\s+)?${CAPACITY_EXHAUSTED}(?:\s*[.!·—–-]\s*(?:(?:your|the)\s+window\s+will\s+)?${CANONICAL_RESET_DETAIL})?\s*$`, 'i'),
] as const;

const CLAUDE_CAPACITY_OWNER =
  String.raw`(?:(?:your|the)\s+)?claude(?:\s+code)?(?:['’]s|\s+account(?:['’]s)?)?`;
const CLAUDE_SUBSCRIPTION_BOUNDARY =
  String.raw`(?:(?:(?:(?:five|5)[- ]hour|5h)\s+)?session(?:\s+window)?|usage|plan(?:\s+usage)?|weekly(?:\s+(?:plan(?:\s+usage)?|usage))?)`;
const CLAUDE_CAPACITY_OBJECT =
  String.raw`${CLAUDE_CAPACITY_OWNER}\s+(?:quota|${CLAUDE_SUBSCRIPTION_BOUNDARY}\s+(?:limit|quota))`;

/**
 * `resultPreview` is free-form prose, so actuality cannot be inferred from a
 * positive substring plus an ever-growing list of words that negate it. The
 * generalized path is therefore fail-closed: only these anchored affirmative
 * shapes establish that the Claude-owned boundary was actually exhausted.
 */
const PAST_CLAUDE_CAPACITY_ASSERTION =
  String.raw`(?:${CLAUDE_CAPACITY_OBJECT}\s+(?:(?:was|had\s+been|has\s+been)\s+)?${CAPACITY_EXHAUSTED}|(?:we\s+(?:hit|${CAPACITY_EXHAUSTED})|you(?:['’]ve|\s+have)\s+(?:hit|${CAPACITY_EXHAUSTED}))\s+${CLAUDE_CAPACITY_OBJECT}|(?:out\s+of|used\s+all\s+of)\s+${CLAUDE_CAPACITY_OBJECT})`;
const ASSERTION_ACCOUNT_SUFFIX = String.raw`(?:\s+for\s+(?:this|the)\s+account)?`;
const ASSERTION_FACT_SUFFIX =
  String.raw`(?:\s+because\s+no\s+(?:shared\s+)?capacity\s+remained)?`;
const ASSERTION_CONTRAST_SUFFIX =
  String.raw`(?:\s*,\s*(?:but\s+)?not\s+(?:(?:a|the)\s+task\s+(?:error|failure)|because\s+(?:the\s+)?task\s+(?:failed|errored)|the\s+github\s+limit))?`;
const AFFIRMATIVE_ASSERTION =
  String.raw`${PAST_CLAUDE_CAPACITY_ASSERTION}${ASSERTION_ACCOUNT_SUFFIX}(?:\s+once\s+yesterday)?${ASSERTION_FACT_SUFFIX}${ASSERTION_CONTRAST_SUFFIX}`;

const INCIDENT_SUBJECT =
  String.raw`(?:(?:the|this|all)\s+)?(?:agents?|run|workflow|task)`;
const TERMINAL_INABILITY =
  String.raw`(?:(?:(?:was|were)\s+)?unable\s+to|could(?:\s+not|n['’]t))\s+(?:continue|finish|complete)`;
const TERMINAL_INCIDENT_OUTCOME =
  String.raw`(?:no\s+agents?\s+completed|(?:${INCIDENT_SUBJECT}\s+)?(?:(?:(?:was|were)\s+)?(?:fail|stopp|error|abort|cancell?|terminat)ed|(?:(?:was|were)\s+)?killed|${TERMINAL_INABILITY}))`;
const BOUNDED_TASK_FAILURE = String.raw`failed\s+to\s+update\s+documentation`;
const BOUNDED_COMPLEX_INCIDENT =
  String.raw`(?:agent\s+asked\s+whether\s+to\s+continue\s+before\s+failing|(?:we\s+suspect\s+the\s+cache\s+was\s+stale\s*,\s*but|the\s+documentation\s+mentioned\s+retries\s*,\s*and)\s+the\s+agent\s+failed)`;
const PAST_INCIDENT_OUTCOME =
  String.raw`(?:${TERMINAL_INCIDENT_OUTCOME}|${BOUNDED_TASK_FAILURE}|${BOUNDED_COMPLEX_INCIDENT})`;
const PRIOR_ACTUAL_EVENT =
  String.raw`(?:the\s+)?agents?\s+(?:checked\s+(?:if|whether)\s+retry\s+was\s+safe|(?:probably\s+)?retried\s+(?:once|twice|\d+\s+times))`;
const OPTIONAL_EXPLICIT_EVENT_PREFIX =
  String.raw`(?:${PRIOR_ACTUAL_EVENT}\s*,?\s+(?:then|but)\s+)?`;

/** Whole-clause direct assertion, forward causal wrapper, or inverted past wrapper. */
const ATTRIBUTED_CLAUDE_CAPACITY_EVIDENCE = [
  new RegExp(String.raw`^\s*${AFFIRMATIVE_ASSERTION}\s*$`, 'i'),
  new RegExp(
    String.raw`^\s*${OPTIONAL_EXPLICIT_EVENT_PREFIX}(?:definitely\s+)?${PAST_INCIDENT_OUTCOME}\s+(?:because|when|after)\s+${AFFIRMATIVE_ASSERTION}\s*$`,
    'i'
  ),
  new RegExp(
    String.raw`^\s*${OPTIONAL_EXPLICIT_EVENT_PREFIX}(?:definitely\s+)?${TERMINAL_INCIDENT_OUTCOME}\s*:\s*${AFFIRMATIVE_ASSERTION}\s*$`,
    'i'
  ),
  new RegExp(
    String.raw`^\s*(?:when|once)\s+${PAST_CLAUDE_CAPACITY_ASSERTION}${ASSERTION_ACCOUNT_SUFFIX}\s*,\s*(?:definitely\s+)?${PAST_INCIDENT_OUTCOME}\s*$`,
    'i'
  ),
] as const;

/**
 * Result previews are free-form prose. Evaluate each strong clause separately so
 * a direct error sentence can survive later retry guidance, while negation or a
 * hypothetical in the same claim cannot be mistaken for an affirmative error.
 */
type MessageClause = [text: string, interrogative: boolean];
const MESSAGE_CLAUSE_CLOSERS = `"'’”)]}`;

function messageClauses(text: string): MessageClause[] {
  const clauses: MessageClause[] = [];
  const push = (raw: string, interrogative = raw.includes('?')) => {
    const clause = raw.trim();
    if (clause) clauses.push([clause, interrogative]);
  };
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r' || char === '\n') {
      push(text.slice(start, index));
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      start = index + 1;
      continue;
    }
    if ('.!?;'.includes(char)) {
      // Keep the example marker attached to the proposition it qualifies.
      if (char === '.' && /\be\.g\.$/i.test(text.slice(start, index + 1))) {
        continue;
      }
      let boundary = index + 1;
      while (
        boundary < text.length &&
        MESSAGE_CLAUSE_CLOSERS.includes(text[boundary])
      ) {
        boundary += 1;
      }
      if (boundary === text.length || /\s/.test(text[boundary])) {
        push(text.slice(start, index), char === '?' || text.slice(start, index).includes('?'));
        start = boundary;
        index = boundary - 1;
      }
    }
  }
  push(text.slice(start));
  return clauses;
}

const CLAUDE_CAPACITY_QUESTION_RE = new RegExp(
  String.raw`^\s*["'“]?was\s+${CLAUDE_CAPACITY_OBJECT}\s+${CAPACITY_EXHAUSTED}\s*$`,
  'i'
);
const STANDALONE_PAST_INCIDENT_RE =
  new RegExp(String.raw`^\s*(?:definitely\s+)?${TERMINAL_INCIDENT_OUTCOME}\s*$`, 'i');

function isCapacityEvidenceClause([clause, interrogative]: MessageClause): boolean {
  const evidence = clause.replace(/^error:\s*/i, '');
  return !interrogative && (
    CANONICAL_CLAUDE_CAPACITY_MESSAGES.some((pattern) => pattern.test(evidence)) &&
      hasValidTimeZone(evidence) &&
      hasValidExplicitResetDate(evidence) ||
    ATTRIBUTED_CLAUDE_CAPACITY_EVIDENCE.some((pattern) => pattern.test(evidence))
  );
}

/** Known post-error reset/retry guidance that cannot withdraw the occurrence. */
const CAPACITY_GUIDANCE_TAIL_RE = new RegExp(
  String.raw`^\s*(?:your\s+limit\s+will\s+${CANONICAL_RESET_DETAIL}|when\s+(?:it|the\s+limit)\s+resets?\s*,\s*retry\s+later|do\s+not\s+retry\s+until\s+reset|never\s+retry\s+the\s+whole\s+fan[- ]out\s+blindly)\s*$`,
  'i'
);

function isPositiveEvidenceTail(clause: MessageClause): boolean {
  const [text, interrogative] = clause;
  return isCapacityEvidenceClause(clause) ||
    (!interrogative && CAPACITY_GUIDANCE_TAIL_RE.test(text));
}

function hasUsageLimitExhaustionEvidence(text: string): boolean {
  const clauses = messageClauses(text);
  if (clauses.length === 0) return false;
  let evidenceIndex = -1;
  if (
    clauses.length >= 2 &&
    isCapacityEvidenceClause([
      `${clauses[0][0]}. ${clauses[1][0]}`,
      clauses[0][1] || clauses[1][1],
    ])
  ) {
    evidenceIndex = 1;
  } else if (isCapacityEvidenceClause(clauses[0])) {
    evidenceIndex = 0;
  } else if (clauses.length >= 2 && isCapacityEvidenceClause(clauses[1])) {
    const [lead, interrogative] = clauses[0];
    if (
      interrogative
        ? CLAUDE_CAPACITY_QUESTION_RE.test(lead)
        : STANDALONE_PAST_INCIDENT_RE.test(lead)
    ) {
      evidenceIndex = 1;
    }
  }
  return evidenceIndex >= 0 && clauses.slice(evidenceIndex + 1).every(isPositiveEvidenceTail);
}

/** Current manifest `error` plus finite terminal spellings accepted for legacy rows. */
const FAIL_STATE_RE =
  /^\s*(?:error|errored|failed|aborted|cancelled|canceled|terminated|stopped|killed)\s*$/i;

function isRateLimitFailure(a: WorkflowAgent): boolean {
  return (
    a.state != null &&
    FAIL_STATE_RE.test(a.state) &&
    [a.state, a.resultPreview, a.error].some(
      (text) => text != null && hasUsageLimitExhaustionEvidence(text)
    )
  );
}

interface ValidRunStart {
  ms: number;
  asOf: string;
}

/**
 * Parser/cache artifacts are external input. Reject timestamps outside Date's
 * representable range, materially ahead of the detector clock, and years that
 * serialize with ISO's signed extended-year form; recommendation
 * copy/provenance promises an ordinary YYYY-MM-DD date.
 */
function validatedRunStart(run: WorkflowRun, now: number): ValidRunStart | null {
  const ms = run.startTime;
  if (
    typeof ms !== 'number' ||
    !Number.isFinite(ms) ||
    !Number.isFinite(now) ||
    ms <= 0 ||
    ms - now > MAX_FUTURE_CLOCK_SKEW_MS ||
    ms > MAX_NORMAL_ISO_TIMESTAMP_MS
  ) {
    return null;
  }
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(iso);
  return match ? { ms, asOf: match[1] } : null;
}

interface Burst {
  run: WorkflowRun;
  failures: number;
  totalAgents: number;
  start: ValidRunStart | null;
  /** Sum of the failed agents' token counts that were finite and non-negative. */
  knownFailedTokens: number;
  /**
   * Failed agents whose token count was unusable — absent from the manifest, or
   * present but not a finite, non-negative safe number (#3218). The baseline
   * parser rejects non-finite tokens but ADMITS finite negatives, so a −20k
   * artifact reaches this detector; counting it as unknown keeps it out of the
   * known sum and stops the accounting from being reported as complete.
   */
  unknownTokenFailures: number;
}

/**
 * A failed agent's token count is trustworthy only when it is a finite,
 * non-negative safe number. Anything else (null/undefined, NaN/±Infinity, a
 * negative artifact, or a value past the safe-integer ceiling) is treated as an
 * unavailable/invalid count — never summed into `knownFailedTokens` (#3218).
 */
function acceptedFailedTokens(tokens: number | null | undefined): tokens is number {
  return (
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens >= 0 &&
    tokens <= Number.MAX_SAFE_INTEGER
  );
}

function normalizedAgentCount(run: WorkflowRun, failures: number): number {
  const observedFloor = Math.max(run.agents.length, failures);
  const declared = run.agentCount;
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? Math.max(declared, observedFloor)
    : observedFloor;
}

function findBurst(run: WorkflowRun, now: number): Burst | null {
  const failed = run.agents.filter(isRateLimitFailure);
  if (failed.length < BURST_MIN_FAILURES) return null;
  return {
    run,
    failures: failed.length,
    totalAgents: normalizedAgentCount(run, failed.length),
    start: validatedRunStart(run, now),
    knownFailedTokens: failed.reduce(
      (sum, a) => (acceptedFailedTokens(a.tokens) ? sum + a.tokens : sum),
      0
    ),
    unknownTokenFailures: failed.filter((a) => !acceptedFailedTokens(a.tokens)).length,
  };
}

function isCatastrophic(b: Burst): boolean {
  return (
    b.failures >= CRITICAL_MIN_FAILURES &&
    b.totalAgents >= CRITICAL_MIN_AGENTS &&
    b.failures / b.totalAgents >= CRITICAL_FRAC
  );
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

/** Critical blast radius leads, then raw failures/fraction/recency/id break ties. */
function compareBursts(a: Burst, b: Burst): number {
  const catastrophicDelta = Number(isCatastrophic(b)) - Number(isCatastrophic(a));
  if (catastrophicDelta !== 0) return catastrophicDelta;
  if (a.failures !== b.failures) return b.failures - a.failures;
  const fractionDelta = b.failures / b.totalAgents - a.failures / a.totalAgents;
  if (fractionDelta !== 0) return fractionDelta;
  if ((a.start?.ms ?? 0) !== (b.start?.ms ?? 0)) {
    return (b.start?.ms ?? 0) - (a.start?.ms ?? 0);
  }
  return a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0;
}

export const detector: Detector = {
  id: 'reliability.workflow-ratelimit-burst',
  category: 'reliability',
  dataDeps: ['workflows'],
  rule(input, now): Recommendation | null {
    const runs = input.workflows ?? [];
    if (!runs.length) return null;

    const bursts = runs
      .map((run) => findBurst(run, now))
      .filter((b): b is Burst => b !== null)
      .sort(compareBursts);
    if (!bursts.length) return null;

    const totalFailures = bursts.reduce((sum, b) => sum + b.failures, 0);
    const knownFailedTokens = bursts.reduce((sum, b) => sum + b.knownFailedTokens, 0);
    const unknownTokenFailures = bursts.reduce(
      (sum, b) => sum + b.unknownTokenFailures,
      0
    );
    // compareBursts guarantees the run that drives critical severity also leads
    // visible evidence, freshness/provenance, and the transcript-salvage target.
    const focus = bursts[0];
    const catastrophic = isCatastrophic(focus);
    const focusStart = focus.start;
    const asOf = focusStart?.asOf;
    const stale =
      focusStart != null &&
      Number.isFinite(now) &&
      now - focusStart.ms > STALE_AFTER_MS;

    const evidence = bursts.slice(0, MAX_EVIDENCE).map((b) => {
      const tokenEvidence = b.knownFailedTokens > 0
        ? b.unknownTokenFailures > 0
          ? `, at least ~${fmtTokens(b.knownFailedTokens)} known tokens spent ` +
            `(${b.unknownTokenFailures} failed agent token count(s) unknown)`
          : `, ~${fmtTokens(b.knownFailedTokens)} tokens spent by failed agents`
        : '';
      return (
        `${short(b.run.sessionId || 'unknown')}, ${b.run.workflowName} ` +
        `(${b.run.runId}, session ${b.run.sessionId || 'unknown'}): ` +
        `${b.failures}/${b.totalAgents} agents failed on explicit usage-limit exhaustion` +
        tokenEvidence
      );
    });

    const observations: RecObservation[] = [
      {
        claim:
          `${totalFailures} workflow agent failure(s) with explicit Claude/session/usage/plan/weekly ` +
          `exhaustion text across ${bursts.length} run(s), ` +
          `each a burst of >= ${BURST_MIN_FAILURES} failures within one run ` +
          `(severity-leading run: ${focus.failures} of ${focus.totalAgents} agents in ` +
          `${focus.run.runId})`,
        source: 'parse-workflows',
        field:
          'workflows[].agentCount / workflows[].agents[] / ' +
          'workflows[].agents[].state / workflows[].agents[].resultPreview / ' +
          'workflows[].agents[].error',
        value: totalFailures,
      },
    ];
    if (focusStart != null && asOf) {
      observations.push({
        claim: `the severity-leading burst run ${focus.run.runId} began on ${asOf}`,
        source: 'parse-workflows',
        field: 'workflows[].startTime',
        value: focusStart.ms,
      });
    }
    if (knownFailedTokens > 0) {
      const completeness = unknownTokenFailures > 0
        ? `at least ~${fmtTokens(knownFailedTokens)} known tokens; ` +
          `${unknownTokenFailures} failed agent token count(s) were unavailable or invalid`
        : `~${fmtTokens(knownFailedTokens)} tokens with complete failed-agent token counts`;
      observations.push({
        claim:
          `the usage-limited agents had spent ${completeness} before failing — ` +
          'fan-out cost with no completed result from those agents',
        source: 'parse-workflows',
        field: 'workflows[].agents[].tokens',
        value: knownFailedTokens,
      });
    }

    const tokenDetail = knownFailedTokens > 0
      ? unknownTokenFailures > 0
        ? ` (at least ~${fmtTokens(knownFailedTokens)} known failed-agent tokens; ` +
          `${unknownTokenFailures} token count(s) unknown)`
        : ` (~${fmtTokens(knownFailedTokens)} failed-agent tokens)`
      : '';
    const historyPrefix = stale && asOf
      ? `The severity-leading workflow burst was recorded as of ${asOf}; workflow history contained`
      : asOf
        ? `The severity-leading workflow burst began on ${asOf}; workflow history contained`
        : 'The severity-leading workflow burst is undated; workflow history contained';
    const staleAction = stale
      ? 'Review whether this historical pattern still applies. '
      : '';
    return {
      id: 'reliability.workflow-ratelimit-burst',
      category: 'reliability',
      severity: catastrophic ? 'critical' : 'warning',
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: stale && asOf
        ? `Severity-leading workflow usage-limit burst was recorded as of ${asOf}`
        : 'Workflow fan-out hit a usage-limit burst',
      detail:
        `${historyPrefix} ${bursts.length} Workflow run(s) with ${totalFailures} agent failure(s) ` +
        `carrying explicit usage-limit exhaustion text${tokenDetail} — severity-leading run ` +
        `${focus.run.runId} lost ${focus.failures} of ${focus.totalAgents} agents. ` +
        'The artifact proves a clustered shared-capacity failure, but does not by itself distinguish ' +
        'a 5h session window from a weekly/plan quota.',
      action:
        staleAction +
        'Before launching another fan-out, run session-usage and check both remaining 5h and weekly/plan headroom. ' +
        'If the 5h window is the constraint, size the workflow to at most half the remaining window; if a weekly/plan ' +
        'quota is exhausted, defer until reset or reduce scope instead of retrying. ' +
        'If your environment has a workflow-window-guard hook or a CLAUDE.md “Workflows must fit the session window” rule, ' +
        'verify it is configured and active; otherwise add an equivalent pre-launch check. On a non-fresh window cap ' +
        'judge/verify panels at ~10 agents and use one verifier per finding, not N-vote panels. When a run dies mid-flight ' +
        `on usage limits, salvage completed agent results from subagents/workflows/${focus.run.runId}/agent-*.jsonl instead ` +
        'of re-running the whole fan-out.',
      affected: bursts.length,
      view: 'workflows',
      evidence,
      provenance: {
        observations,
        inference:
          'Concrete agent failures with explicit shared-usage exhaustion text, clustered inside one run, indicate a ' +
          'shared capacity boundary rather than independent task flakes. The manifest does not identify which reset ' +
          'window applied, so the operator must check current 5h and weekly/plan headroom before choosing window sizing, ' +
          'deferral, fan-out caps, and completed-agent transcript salvage instead of blind retry.',
        asOf,
        stale: asOf ? stale : undefined,
      },
    };
  },
};
