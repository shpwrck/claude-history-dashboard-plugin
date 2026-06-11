/**
 * Tier-3 judge-audit harness (#605 / #738) — the run/aggregate entrypoint plus
 * one trivial reference audit that proves the deterministic-seed -> judge-
 * interpret path end-to-end.
 *
 * SERVER-ONLY. Imported by `scripts/server.mjs` behind `/api/audit.json`. The
 * server injects the real Anthropic chat implementation so every server egress
 * path can pass through the LLM registry/chokepoint before any network call.
 *
 * The judge is INJECTABLE ({@link JudgeFn}) so tests drive the full path with a
 * fake verdict and never hit the network. With no injected judge the
 * runner degrades to `[]` — the same "never 500, just empty" contract the route
 * presents (mirroring `/api/usage`).
 */
import type { AuditFinding, AuditConfidence } from './types';
import {
  detectRecurringSequences,
  runAgenticOpportunityAudit,
  type ToolSequenceSession,
} from './agentic-opportunities';
import {
  detectSuccessfulTrajectories,
  runSkillCandidateAudit,
  parseDraftVerdict,
  type SkillCandidateSession,
  type DraftJudgeFn,
} from './skill-candidates';
import {
  detectBoomerangCandidates,
  runBoomerangAudit,
  type ReworkSession,
  type ChurnFile,
} from './boomerang-rework';
import {
  runNaturalExperimentAudit,
  type NaturalExperimentRow,
} from './natural-experiment';
import {
  runStartStopOracleAudit,
  type StartStopRow,
} from './start-stop-oracle';
import {
  detectCapabilityGaps,
  runMcpAdoptionGapAudit,
  type ToolUsageSignal,
} from './mcp-adoption-gap';
import {
  seedDeceitCandidates,
  runDeceitJudgeAudit,
  type DeceitCandidate,
  type GetTranscriptText,
} from './judge-deceit';

/**
 * The minimal per-session shape the tier-3 audits reason over. The server route
 * maps the assembled dataset (sessions + token totals + tool-call counts) into
 * this; tests construct it directly.
 */
export interface AuditSession {
  sessionId: string;
  project: string;
  totalTokens: number;
  toolCalls: number;
  messageCount: number;
}

/** A judge's verdict over one candidate. */
export interface JudgeVerdict {
  isFinding: boolean;
  rationale: string;
  confidence: AuditConfidence;
}

/** The judge call, abstracted so tests inject a deterministic fake. */
export type JudgeFn = (prompt: {
  system: string;
  user: string;
}) => Promise<JudgeVerdict>;

export interface ClaudeJudgeChatRequest {
  model?: string;
  system?: string;
  maxTokens: number;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface ClaudeJudgeChatResult {
  text: string;
}

export type ClaudeJudgeChatFn = (
  req: ClaudeJudgeChatRequest
) => Promise<ClaudeJudgeChatResult>;

export interface RunAuditsOptions {
  sessions: AuditSession[];
  /**
   * Per-session ordered tool usage + cost for the agentic-opportunity audit
   * (#741). Omitted -> that audit is skipped (the reference audit still runs).
   */
  agenticSessions?: ToolSequenceSession[];
  /**
   * Per-session ordered tool usage + successful-outcome flag for the
   * skill-candidate audit (#739). Omitted -> that audit is skipped. The judge
   * for this audit drafts an artifact, so it carries extra fields beyond the
   * base verdict (see {@link DraftJudgeFn}).
   */
  skillCandidateSessions?: SkillCandidateSession[];
  /**
   * Deterministic rework signals for the boomerang/rework-rate audit (#742):
   * per-session rework rows (from parse-file-history) plus the high-churn files
   * (from parse-files.topChurnFiles) that corroborate cross-session re-touch.
   * Omitted / empty `reworkSessions` -> that audit is skipped. Reuses the base
   * {@link JudgeFn} (isFinding = "genuine rework").
   */
  boomerangInput?: { reworkSessions: ReworkSession[]; churnFiles: ChurnFile[] };
  /**
   * Per-session rows for the natural-experiment regression audit (#744): an
   * outcome label, the model + tool factors, and a per-session difficulty proxy.
   * Omitted / empty -> that audit is skipped. Reuses the base {@link JudgeFn}
   * for the single coefficient-interpretation call.
   */
  naturalExperimentRows?: NaturalExperimentRow[];
  /**
   * Per-session rows for the start/stop-oracle audit (#743): a session opener
   * (first user message) joined to its good/bad outcome. Omitted / empty -> that
   * audit is skipped. Reuses the base {@link JudgeFn} (isFinding = "genuine
   * don't-start / stop-early signal").
   */
  startStopRows?: StartStopRow[];
  /**
   * Installed-MCP baseline + aggregated tool-usage signals for the MCP
   * adoption-gap audit (#740): `installedServers` is the configured set
   * (`liveConfig.mcpServers[].id`) used to EXCLUDE already-covered capabilities,
   * and `usage` is the coarse capability signals derived from tool history.
   * Omitted / empty `usage` -> that audit is skipped. Reuses the base
   * {@link JudgeFn} (isFinding = "the workload would benefit from adopting it").
   */
  mcpAdoptionInput?: {
    installedServers: string[];
    usage: ToolUsageSignal[];
  };
  /**
   * Judge-based deceit audit input (#687): the per-session candidates to judge
   * (seeded from the dataset's deceit signals) plus an injected transcript
   * fetcher (the server wraps `getTranscript` + brotli decompression). Omitted /
   * empty `candidates` -> that audit is skipped. Reuses the base {@link JudgeFn}
   * (isFinding = "undisclosed semantic shortcut").
   */
  deceitInput?: {
    candidates: DeceitCandidate[];
    getTranscript: GetTranscriptText;
  };
  /** Injected in tests or by the server. Absent -> graceful degrade to `[]`. */
  judge?: JudgeFn;
  /**
   * The skill-candidate audit's draft-judge, injected in tests; built from
   * {@link makeClaudeDraftJudge} by the server (#739).
   */
  draftJudge?: DraftJudgeFn;
  /** Optional model override for the judge call. */
  model?: string;
  /**
   * Shared per-run ceiling for external judge calls. Applies across the reference,
   * agentic, boomerang, natural-experiment, start/stop, MCP, skill-draft, and
   * deceit audits. Omitted means uncapped for backwards-compatible tests; the
   * server route passes a finite enterprise default.
   */
  maxJudgeCalls?: number;
}

/**
 * Only sessions with real token volume are worth judging — a tiny session with
 * a high tokens/tool ratio is noise, not waste.
 */
const RATIO_VOLUME_FLOOR = 50_000;
/**
 * A lone session this far above "tokens per tool call" is an outlier on its own,
 * even without a population to compare against (keeps single-session inputs and
 * fixtures meaningful).
 */
const RATIO_ABSOLUTE_FLOOR = 100_000;

export interface RunReferenceAuditOptions {
  /** Max token/tool outlier candidates to judge; omitted means no candidate cap. */
  maxCandidates?: number;
}

function normalizeOptionalCap(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}

/**
 * Deterministic seed for the reference audit: sessions that burned many tokens
 * while making few tool calls ("thinking without acting"). A candidate is a
 * session whose tokens/tool ratio is >= max(3x the population median, an
 * absolute floor). PURE and unit-tested without the judge.
 */
export function seedTokenToToolOutliers(
  sessions: AuditSession[]
): AuditSession[] {
  const scored = sessions
    .filter((s) => s.totalTokens >= RATIO_VOLUME_FLOOR)
    .map((s) => ({ s, ratio: s.totalTokens / Math.max(1, s.toolCalls) }));
  if (scored.length === 0) return [];
  // With a single volume-clearing session there is no population to compare
  // against, so `median * 3` (== 3x its own ratio) would always dominate and
  // wrongly drop it; fall back to the absolute floor alone (the lone-outlier
  // contract RATIO_ABSOLUTE_FLOOR exists for).
  if (scored.length === 1) {
    return scored[0].ratio >= RATIO_ABSOLUTE_FLOOR ? [scored[0].s] : [];
  }
  const sortedRatios = scored.map((r) => r.ratio).sort((a, b) => a - b);
  const median = sortedRatios[Math.floor(sortedRatios.length / 2)];
  const threshold = Math.max(median * 3, RATIO_ABSOLUTE_FLOOR);
  return scored.filter((r) => r.ratio >= threshold).map((r) => r.s);
}

/** Round helper kept out of the template literal for readability. */
function ratioOf(s: AuditSession): number {
  return Math.round(s.totalTokens / Math.max(1, s.toolCalls));
}

/**
 * The reference audit: for each token-to-tool outlier, ask the judge whether it
 * is genuine "thinking without acting" inefficiency vs. legitimately
 * analysis-heavy work, and emit a finding when it is.
 */
export async function runReferenceAudit(
  sessions: AuditSession[],
  judge: JudgeFn,
  options: RunReferenceAuditOptions = {}
): Promise<AuditFinding[]> {
  const candidates = seedTokenToToolOutliers(sessions).slice(
    0,
    normalizeOptionalCap(options.maxCandidates)
  );
  const findings: AuditFinding[] = [];
  for (const c of candidates) {
    const ratio = ratioOf(c);
    let verdict: JudgeVerdict;
    // Isolate per-candidate failures: a transient judge error (network, rate
    // limit) skips just this candidate, keeping findings accumulated so far —
    // it must NOT discard the whole run.
    try {
      verdict = await judge({
        system:
          'You audit coding-agent sessions for efficiency. You are given one ' +
          'session that spent many tokens relative to how many tool calls it ' +
          'made. Decide whether this is genuine "thinking without acting" waste ' +
          '(lots of deliberation, little execution) or legitimately analysis-' +
          'heavy work. Reply ONLY with JSON: ' +
          '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}.',
        user:
          `Session ${c.sessionId} in project "${c.project}": ` +
          `${c.totalTokens} tokens across ${c.messageCount} messages, but only ` +
          `${c.toolCalls} tool call(s) — ${ratio} tokens per tool call. ` +
          'Is this a genuine efficiency finding?',
      });
    } catch {
      continue;
    }
    if (verdict.isFinding) {
      findings.push({
        id: `token-to-tool-ratio:${c.sessionId}`,
        domain: 'workflow',
        summary:
          `Session ${c.sessionId} spent ${c.totalTokens.toLocaleString()} ` +
          `tokens with only ${c.toolCalls} tool call(s) (${ratio} tokens/tool).`,
        evidenceRefs: [`session:${c.sessionId}`, `project:${c.project}`],
        judgeRationale: verdict.rationale,
        confidence: verdict.confidence,
      });
    }
  }
  return findings;
}

const VALID_CONFIDENCE: readonly AuditConfidence[] = ['low', 'medium', 'high'];

/** Parse a judge's free-text reply into a verdict, defaulting safely. */
export function parseVerdict(text: string): JudgeVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const obj = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    const confidence = obj.confidence as AuditConfidence;
    return {
      isFinding: obj.isFinding === true,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      confidence: VALID_CONFIDENCE.includes(confidence) ? confidence : 'low',
    };
  } catch {
    return { isFinding: false, rationale: '', confidence: 'low' };
  }
}

/** Build the real judge: one governed chat call per candidate, parsed into a verdict. */
export function makeClaudeJudge(
  chat: ClaudeJudgeChatFn,
  model?: string
): JudgeFn {
  return async ({ system, user }) => {
    const res = await chat({
      model,
      system,
      maxTokens: 512,
      messages: [{ role: 'user', content: user }],
    });
    return parseVerdict(res.text);
  };
}

/**
 * Build the skill-candidate draft-judge (#739): one `chat()` call per candidate,
 * parsed into a {@link DraftJudgeFn} verdict that carries the drafted artifact.
 */
export function makeClaudeDraftJudge(
  chat: ClaudeJudgeChatFn,
  model?: string
): DraftJudgeFn {
  return async ({ system, user }) => {
    const res = await chat({
      model,
      system,
      // Drafting an artifact needs more headroom than a yes/no verdict.
      maxTokens: 1024,
      messages: [{ role: 'user', content: user }],
    });
    return parseDraftVerdict(res.text);
  };
}

type JudgeCallBudget = { remaining: number };

function auditJudgeBudgetExceeded(): Error & { code?: string } {
  const err = new Error('Audit judge call budget exhausted') as Error & {
    code?: string;
  };
  err.code = 'ERR_DASHBOARD_AUDIT_JUDGE_BUDGET_EXHAUSTED';
  return err;
}

function withJudgeCallBudget<T>(
  judge: (prompt: { system: string; user: string }) => Promise<T>,
  budget: JudgeCallBudget
): (prompt: { system: string; user: string }) => Promise<T> {
  return async (prompt) => {
    if (budget.remaining <= 0) throw auditJudgeBudgetExceeded();
    budget.remaining -= 1;
    return judge(prompt);
  };
}

/**
 * Aggregate runner. Uses injected judges, runs every tier-3 audit, and collects
 * findings. NEVER throws: with no judge it returns `[]`, and each audit is
 * isolated so one failing audit can't drop another's findings — the route
 * presents an empty-but-200 degrade.
 */
export async function runAudits(
  opts: RunAuditsOptions
): Promise<AuditFinding[]> {
  const judge = opts.judge ?? null;
  if (!judge) return [];
  const budget: JudgeCallBudget = {
    remaining: normalizeOptionalCap(opts.maxJudgeCalls),
  };
  const budgetedJudge = withJudgeCallBudget(judge, budget);

  const findings: AuditFinding[] = [];
  try {
    findings.push(
      ...(await runReferenceAudit(opts.sessions, budgetedJudge, {
        maxCandidates: opts.maxJudgeCalls,
      }))
    );
  } catch {
    /* reference audit failed wholesale — keep going to the next audit */
  }
  if (opts.agenticSessions && opts.agenticSessions.length > 0) {
    try {
      findings.push(
        ...(await runAgenticOpportunityAudit(
          detectRecurringSequences(opts.agenticSessions),
          budgetedJudge
        ))
      );
    } catch {
      /* agentic audit failed wholesale — return what the others found */
    }
  }
  if (
    opts.boomerangInput &&
    opts.boomerangInput.reworkSessions.length > 0
  ) {
    try {
      findings.push(
        ...(await runBoomerangAudit(
          detectBoomerangCandidates(
            opts.boomerangInput.reworkSessions,
            opts.boomerangInput.churnFiles
          ),
          budgetedJudge
        ))
      );
    } catch {
      /* boomerang audit failed wholesale — return what the others found */
    }
  }
  if (
    opts.naturalExperimentRows &&
    opts.naturalExperimentRows.length > 0
  ) {
    try {
      findings.push(
        ...(await runNaturalExperimentAudit(opts.naturalExperimentRows, budgetedJudge))
      );
    } catch {
      /* natural-experiment audit failed wholesale — return what others found */
    }
  }
  if (opts.startStopRows && opts.startStopRows.length > 0) {
    try {
      findings.push(
        ...(await runStartStopOracleAudit(opts.startStopRows, budgetedJudge))
      );
    } catch {
      /* start/stop-oracle audit failed wholesale — return what others found */
    }
  }
  if (
    opts.mcpAdoptionInput &&
    opts.mcpAdoptionInput.usage.length > 0
  ) {
    try {
      findings.push(
        ...(await runMcpAdoptionGapAudit(
          detectCapabilityGaps(
            opts.mcpAdoptionInput.installedServers,
            opts.mcpAdoptionInput.usage
          ),
          budgetedJudge
        ))
      );
    } catch {
      /* mcp-adoption-gap audit failed wholesale — return what others found */
    }
  }
  if (opts.skillCandidateSessions && opts.skillCandidateSessions.length > 0) {
    // The skill-candidate audit drafts an artifact, so it needs the
    // draft-judge (carries `artifactType`/`draft`). With no injected draft
    // judge, skip this audit (still no throw).
    const draftJudge = opts.draftJudge ?? null;
    if (draftJudge) {
      const budgetedDraftJudge = withJudgeCallBudget(draftJudge, budget);
      try {
        findings.push(
          ...(await runSkillCandidateAudit(
            detectSuccessfulTrajectories(opts.skillCandidateSessions),
            budgetedDraftJudge
          ))
        );
      } catch {
        /* skill-candidate audit failed wholesale — return what others found */
      }
    }
  }
  if (
    opts.deceitInput &&
    opts.deceitInput.candidates.length > 0
  ) {
    try {
      findings.push(
        ...(await runDeceitJudgeAudit(
          seedDeceitCandidates(opts.deceitInput.candidates),
          opts.deceitInput.getTranscript,
          budgetedJudge
        ))
      );
    } catch {
      /* deceit-judge audit failed wholesale — return what others found */
    }
  }
  return findings;
}
