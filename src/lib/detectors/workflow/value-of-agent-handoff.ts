import type {
  AppliedMarkers,
  Detector,
  RecFix,
  RecObservation,
  Recommendation,
} from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import { isRediscoveryText } from '../../parse-timeline';
import { claudeMdMarksApplied, short } from '../shared';

/**
 * workflow.value-of-agent-handoff (#2312, epic #2281).
 *
 * This is the agent->human inverse of `workflow.human-input-leverage`: measure
 * where an agent established durable external state but left no handoff/runbook,
 * then a later session had to rediscover the setup. The v1 detector is a
 * mechanism plus hypothesis, not a proven time-saving claim:
 *
 * - PRE-SIGNAL (accounting): a session made a durable-state mutation and wrote
 *   no runbook-like artifact in that same transcript.
 * - RE-DISCOVERY (accounting when present): a later session in the same project
 *   spends its early turns asking "where/how was this set up?" and is billed
 *   back to the prior no-runbook durable-state session.
 * - TIME VALUE (hypothesis): `estTimeReclaimedMin` is the conservative floor plus
 *   observed rediscovery minutes. The wording deliberately says "hypothesis" and
 *   does not call the minutes proven.
 *
 * The detector reads only existing local artifacts: `toolData` for durable
 * mutations and runbook writes, `timelines` for rediscovery language, and
 * `sessions`/`tokenData` for the project/task-class join. It cites the #1926 /
 * #1928 attribution substrate via the existing token/tool fields instead of
 * rebuilding attribution.
 */

const DETECTOR_ID = 'workflow.value-of-agent-handoff';

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

type DurableKind = 'remote-state' | 'generated-config' | 'multi-step-install';

interface DurableMutation {
  sessionId: string;
  taskClass: string;
  timestampMs: number | null;
  date: string | null;
  toolUseId: string;
  kind: DurableKind;
  label: string;
  field: string;
}

interface PreSignal {
  sessionId: string;
  taskClass: string;
  mutations: DurableMutation[];
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

const REMOTE_STATE_RE =
  /\b(?:kubectl\s+(?:apply|create|patch|set|rollout|scale|annotate)|helm\s+(?:upgrade|install)|terraform\s+(?:apply|import)|pulumi\s+up|ansible-playbook|docker\s+compose\s+up|podman\s+compose\s+up|flyctl\s+deploy|vercel\s+(?:deploy|env)|netlify\s+deploy)\b/i;

const SSH_REMOTE_WRITE_RE =
  /\b(?:ssh\b[^;&|]*(?:sudo|tee\b|cat\s*>|mkdir\b|systemctl\b|docker\s+compose|podman\s+compose|kubectl\b|helm\b|terraform\b)|scp\b|rsync\b[^;&|]*(?:@|:\/))/i;

const GENERATED_CONFIG_RE =
  /\b(?:(?:envsubst|gomplate|jinja2|mustache|ytt|kustomize\s+build|helm\s+template)\b[^;&|]*(?:>|--output|-o\b)|(?:cp|install)\s+\S+\.(?:tmpl|template|example|sample|dist)\b\s+\S+\.(?:ya?ml|json|env|conf|toml|ini|service)\b|(?:sed|perl|python|node)\b[^;&|]*>\s*\S+\.(?:ya?ml|json|env|conf|toml|ini|service)\b)/i;

// System-level, genuinely durable install/state mutations only. A bare
// project-level install (`npm install`, `pip install`, `yarn add`, `cargo add`)
// is NOT in this class: it fires for virtually every session and leaves state
// that is reconstructible from a lockfile in the repo, so it carries no
// rediscovery cost worth a handoff (adversarial-review finding #3). What stays
// are mutations that persist OUTSIDE the checkout and are not recreated by a
// checked-in manifest: system package installs, pipe-to-shell installers,
// enabled system services, cron entries, and named container volumes.
const INSTALL_RE =
  /\b(?:(?:apt-get|apt|brew)\s+install\b|curl\b[^;&|]*\|\s*(?:bash|sh)|systemctl\s+enable\b|launchctl\s+(?:load|bootstrap)|crontab\b|(?:docker|podman)\s+volume\s+create)\b/i;

const RUNBOOK_PATH_RE =
  /(?:^|\/)(?:runbook|handoff|operations?|ops|deployment|deploy|setup|install|bootstrap|readme)(?:[-_./][^/]*)?\.(?:md|mdx|txt)$/i;

const RUNBOOK_COMMAND_RE =
  /\b(?:git\s+add|tee|cat\s*>|printf\b[^|;]*>|echo\b[^|;]*>)\s+[^;&|]*(?:runbook|handoff|operations?|deploy|setup|install|bootstrap|README)\S*\.(?:md|mdx|txt)\b/i;

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

function classifyDurableMutation(call: ToolCall): { kind: DurableKind; label: string; field: string } | null {
  const cmd = commandText(call);
  if (cmd) {
    if (REMOTE_STATE_RE.test(cmd.text) || SSH_REMOTE_WRITE_RE.test(cmd.text)) {
      return { kind: 'remote-state', label: cmd.text, field: cmd.field };
    }
    if (GENERATED_CONFIG_RE.test(cmd.text)) {
      return { kind: 'generated-config', label: cmd.text, field: cmd.field };
    }
    if (INSTALL_RE.test(cmd.text)) {
      return { kind: 'multi-step-install', label: cmd.text, field: cmd.field };
    }
  }
  return null;
}

function isRunbookWrite(call: ToolCall): boolean {
  const filePath = call.input.file_path;
  if (
    typeof filePath === 'string' &&
    RUNBOOK_PATH_RE.test(filePath) &&
    /^(?:Write|Edit|MultiEdit)$/i.test(call.toolName)
  ) {
    return true;
  }
  const cmd = commandText(call);
  return cmd ? RUNBOOK_COMMAND_RE.test(cmd.text) : false;
}

function collectPreSignals(
  toolData: ToolUsageData[],
  projects: Map<string, string>
): PreSignal[] {
  const runbookSessions = new Set<string>();
  const mutationsBySession = new Map<string, DurableMutation[]>();

  for (const session of toolData) {
    for (const call of session.calls ?? []) {
      if (isRunbookWrite(call)) runbookSessions.add(session.sessionId);
      const classified = classifyDurableMutation(call);
      if (!classified) continue;
      const ms = parseMs(call.timestamp);
      const mutation: DurableMutation = {
        sessionId: session.sessionId,
        taskClass: taskClassOf(session.sessionId, projects),
        timestampMs: ms,
        date: ms == null ? null : isoDate(ms),
        toolUseId: call.toolUseId,
        kind: classified.kind,
        label: classified.label,
        field: `ToolCall.${classified.field}`,
      };
      const arr = mutationsBySession.get(session.sessionId) ?? [];
      arr.push(mutation);
      mutationsBySession.set(session.sessionId, arr);
    }
  }

  const signals: PreSignal[] = [];
  for (const [sessionId, mutations] of mutationsBySession) {
    if (runbookSessions.has(sessionId)) continue;
    const latestMs = maxMs(mutations.map((m) => m.timestampMs));
    signals.push({
      sessionId,
      taskClass: taskClassOf(sessionId, projects),
      mutations,
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

function buildRollups(input: Parameters<Detector['rule']>[0]): ClassRollup[] {
  const projects = projectBySession(input);
  const preSignals = collectPreSignals(input.toolData ?? [], projects);
  if (preSignals.length === 0) return [];

  const bursts = (input.timelines ?? [])
    .map((timeline) => rediscoveryBurst(timeline, projects))
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
    // applies): a floor per no-runbook durable-state session, plus each observed
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

function buildFix(): RecFix {
  return {
    target: 'CLAUDE.md',
    label: 'Add durable-state handoff rule',
    note: 'Adapt the artifact names to your environment and keep it lightweight.',
    fixKind: 'illustrative',
    appliedMarkers: MARKERS,
    snippet:
      '## Durable state handoff\n\n' +
      'Durable external state changes need a handoff artifact. When a task changes\n' +
      'remote hosts, deployed services, generated config, installation state, or\n' +
      'other state that a later session may need to operate, leave a compact\n' +
      'runbook or handoff note with:\n' +
      '- what changed and where it lives;\n' +
      '- the template/config/source path used to recreate it;\n' +
      '- the verification command or health check;\n' +
      '- the rollback or teardown command when one exists.\n' +
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
  const observedRediscoveryMin = roll.rediscoveries.reduce(
    (sum, r) => sum + r.burst.observedMinutes,
    0
  );
  const evidence = [
    `${roll.taskClass}: ${roll.preSignals.length} durable-state session(s) with no runbook artifact; ` +
      `example ${short(lead.sessionId)} ${leadMutation.kind} via ${clip(leadMutation.label)}`,
    ...(roll.rediscoveries.length
      ? [
          `${roll.rediscoveries.length} later rediscovery session(s), ~${fmtMin(observedRediscoveryMin)} billed back; ` +
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
        `${roll.preSignals.length} session(s) in task class "${roll.taskClass}" mutated durable external state and did not write a runbook/handoff artifact in the same transcript`,
      source: 'parse-tools',
      field: 'ToolCall.toolName + ToolCall.input.command/commandPreview/input.file_path',
      value: roll.preSignals.length,
    },
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
          : `no later rediscovery session is required for the day-one pre-signal; the conservative preset floor is ${CONSERVATIVE_PRESET_MIN} minute(s) per no-runbook durable-state session`,
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
  ];

  return {
    id: DETECTOR_ID,
    category: 'workflow',
    severity: roll.rediscoveries.length > 0 ? 'warning' : 'info',
    title: 'Leave a handoff when agents establish durable state',
    detail:
      `${asOfPrefix}${roll.preSignals.length} durable-state session(s) in "${roll.taskClass}" ` +
      `changed remote/config/install state without a runbook artifact. ` +
      (roll.rediscoveries.length > 0
        ? `${roll.rediscoveries.length} later session(s) then spent early turns re-discovering that setup (~${fmtMin(observedRediscoveryMin)} observed). `
        : `This is a cold-start pre-signal: no later historical corpus is needed. `) +
      `The ${fmtMin(roll.estimatedMinutes)} estimate is a hypothesis, using a conservative ` +
      `${CONSERVATIVE_PRESET_MIN} minute floor per no-runbook durable-state session plus observed rediscovery minutes when present; it is not a calibrated causal saving.`,
    action:
      `For "${roll.taskClass}" tasks that mutate durable external state, leave a small handoff artifact only when the state is material: what changed, where the config/template/state lives, how to verify it, and how to roll it back. Do not write a runbook for trivial local-only changes.`,
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
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const roll = buildRollups(input)[0];
    return roll ? toRecommendation(input, roll, now) : null;
  },
};
