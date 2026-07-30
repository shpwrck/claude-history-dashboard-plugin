/**
 * Per-view context builders for the Ask Claude panel.
 *
 * Each `buildContext(view, payload)` call emits a small JSON summary — usually
 * a few KB — capturing the relevant slice of dashboard state for the active
 * view. The Ask Claude panel attaches this summary to the user prompt so the
 * model can answer concretely without seeing the entire dataset.
 *
 * Keep summaries tight: prefer top-N rows over full tables, prefer category
 * counts over raw lists, and round/truncate numbers where exact precision is
 * not useful. The hard ceiling target is ~10 KB per summary.
 */
import type {
  ProjectStats,
  Session,
  SessionTokenData,
  View,
} from '../types';
import type { ToolUsageData } from './parse-tools';
import { aggregateTools, topBashCommands } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import type { ApiErrorEvent } from './parse-errors';
import {
  computeToolEffectiveness,
  type ToolEffectivenessRow,
} from './parse-tool-effectiveness';
import type { SessionOverview } from './session-overview';
import type { Recommendation } from './recommendations';
import type {
  RepoMapDataset,
  RepoMapProjectJoin,
} from './parse-repo-map-join';

const MAX_EVIDENCE_LINES = 4;
const MAX_RECOMMENDATION_CONTEXT_CHARS = 10 * 1024;
const MAX_PROVENANCE_OBSERVATIONS = 4;
const MAX_PROVENANCE_DERIVATIONS = 4;

/**
 * Default ceiling for the bounded repo-map slice injected into project/session
 * Ask Claude context, expressed as an approximate token budget. The slice is a
 * structural index (paths + signatures, no source bodies — see ADR 0007), so
 * the model can name likely files/modules without the panel dumping whole
 * source files. ~4 chars/token matches the panel's own token estimate.
 */
export const DEFAULT_REPO_MAP_TOKEN_CAP = 1500;
const APPROX_CHARS_PER_TOKEN = 4;

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function boundedClaimScalar<T extends string | number | boolean>(
  value: T,
  maxStringLength = 240
): T {
  return (
    typeof value === 'string'
      ? truncate(value, maxStringLength)
      : value
  ) as T;
}

function isoOrUndef(ts: number | undefined): string | undefined {
  if (!ts || ts <= 0) return undefined;
  return new Date(ts).toISOString();
}

// ── bounded repo map (#891) ──────────────────────────────────────────────────

/** A symbol entry in the bounded repo-map slice — name + kind + signature head,
 *  never a body (ADR 0007 privacy invariant). */
interface RepoMapSliceSymbol {
  name: string;
  kind: string;
  signature: string;
}

/** One file's structural row in the bounded repo-map slice. */
interface RepoMapSliceFile {
  path: string;
  symbols: RepoMapSliceSymbol[];
  imports: string[];
  configSections?: string[];
  recommendations?: string[];
}

/** The bounded, token-capped structural map attached to project/session
 *  context. Carries only paths, signatures, references, and the truncation
 *  flag — no source bodies. */
export interface RepoMapSlice {
  root: string;
  generatedAtGitSha: string | null;
  fileCount: number;
  /** True when the source map was already truncated OR this cap dropped rows. */
  truncated: boolean;
  files: RepoMapSliceFile[];
}

/** Configurable bound for the injected repo map. */
export interface RepoMapSliceOptions {
  /** Approximate token ceiling for the slice. Default {@link DEFAULT_REPO_MAP_TOKEN_CAP}. */
  tokenCap?: number;
}

/** Encode an absolute project root the way `~/.claude/projects/` dir names are
 *  encoded (path separators → dashes), so a repo-map `root` can be matched
 *  against a dashboard `project` key. */
function encodeRootForMatch(root: string): string {
  return root.replace(/\\/g, '/').replace(/\//g, '-');
}

/** Find the repo-map project join that corresponds to a dashboard project key.
 *  Matches on the dash-encoded root first, then falls back to a tail match on
 *  the path basename so a worktree/relative root still resolves. */
export function matchRepoMapProject(
  dataset: RepoMapDataset | null | undefined,
  projectKey: string | null | undefined
): RepoMapProjectJoin | null {
  if (!dataset || !projectKey) return null;
  const target = projectKey.replace(/^-+/, '');
  for (const project of dataset.projects) {
    const encoded = encodeRootForMatch(project.root).replace(/^-+/, '');
    if (encoded === target || encoded.endsWith(target) || target.endsWith(encoded)) {
      return project;
    }
  }
  return null;
}

function approxTokensOf(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Build a bounded, token-capped structural slice of one project's repo map for
 * the Ask Claude project/session context. Files are taken in the map's own
 * ranked order (most-referenced first) and added until the approximate token
 * cap would be exceeded; the rest are dropped and `truncated` is set. The cap
 * is enforced strictly — the returned slice never exceeds `tokenCap` tokens.
 *
 * Returns `null` when the dataset is absent (the SPA flavor has no server-only
 * `repoMap` key, so Ask Claude proceeds exactly as before) or when no project
 * in the map matches the focused project key.
 */
export function buildRepoMapSlice(
  dataset: RepoMapDataset | null | undefined,
  projectKey: string | null | undefined,
  options: RepoMapSliceOptions = {}
): RepoMapSlice | null {
  const project = matchRepoMapProject(dataset, projectKey);
  if (!project) return null;

  const tokenCap = Math.max(
    0,
    options.tokenCap ?? DEFAULT_REPO_MAP_TOKEN_CAP
  );

  const files: RepoMapSliceFile[] = [];
  let droppedFiles = false;

  for (const file of project.files) {
    const row: RepoMapSliceFile = {
      path: file.path,
      symbols: file.symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        signature: truncate(s.signature, 120),
      })),
      imports: file.imports.slice(0, 24),
      ...(file.configSections.length
        ? { configSections: file.configSections }
        : {}),
      ...(file.recommendations.length
        ? { recommendations: file.recommendations }
        : {}),
    };
    const candidate: RepoMapSlice = {
      root: project.root,
      generatedAtGitSha: project.generatedAtGitSha,
      fileCount: project.fileCount,
      // Size against the conservative case (`truncated: true`) so the cap holds
      // even when this row turns out to be the last one kept.
      truncated: true,
      files: [...files, row],
    };
    if (approxTokensOf(candidate) > tokenCap) {
      droppedFiles = true;
      break;
    }
    files.push(row);
  }

  const truncated =
    project.truncated || droppedFiles || files.length < project.files.length;

  return {
    root: project.root,
    generatedAtGitSha: project.generatedAtGitSha,
    fileCount: project.fileCount,
    truncated,
    files,
  };
}

// ── view payloads ───────────────────────────────────────────────────────────

export interface SessionPayload {
  session: Session;
  overview: SessionOverview;
  tokenData?: SessionTokenData;
  toolData?: ToolUsageData;
  timeline?: SessionTimeline;
  apiErrors: ApiErrorEvent[];
  /** Server-only bounded structural map for the session's project (#891).
   *  Absent in the SPA flavor; omitted cleanly when null. */
  repoMap?: RepoMapDataset | null;
}

export interface ProjectPayload {
  project: ProjectStats;
  tokenData: SessionTokenData[];
  toolData: ToolUsageData[];
  /** Server-only bounded structural map for this project (#891). Absent in the
   *  SPA flavor; omitted cleanly when null. */
  repoMap?: RepoMapDataset | null;
}

/**
 * Viewer-only (#2719, epic #2443): Ask Claude no longer runs the detector
 * catalog. The recommendations context is built from the SAME server-computed
 * findings the Recommendations page shows, passed in as a pre-built list. There
 * are no "omitted signals" to label — the server computes the full set — so this
 * context formats the shared result and never touches `buildRecommendations`.
 */
export interface RecommendationsPayload {
  recommendations: Recommendation[];
  /** Missing only for legacy callers; treated as a successful ready result. */
  analysisStatus?: 'loading' | 'ready' | 'error' | 'unavailable';
  analysisError?: string | null;
}

export interface ToolsPayload {
  toolData: ToolUsageData[];
  apiErrors: ApiErrorEvent[];
  timelines: SessionTimeline[];
}

export interface OverviewPayload {
  sessions: Session[];
  projects: ProjectStats[];
  tokenData: SessionTokenData[];
}

export type ContextPayload =
  | { view: 'sessions'; data: SessionPayload }
  | { view: 'projects'; data: ProjectPayload }
  | { view: 'recommendations'; data: RecommendationsPayload }
  | { view: 'tools'; data: ToolsPayload }
  | { view: 'generic'; data: OverviewPayload };

// ── builders ────────────────────────────────────────────────────────────────

function buildSessionContext(p: SessionPayload): unknown {
  const tlSummary = p.timeline
    ? {
        userTurns: p.timeline.entries.filter((e) => e.kind === 'user').length,
        assistantTurns: p.timeline.entries.filter(
          (e) => e.kind === 'assistant'
        ).length,
        toolUses: p.timeline.entries.filter((e) => e.kind === 'tool_use')
          .length,
      }
    : undefined;

  const recentErrors = p.apiErrors
    .filter((e) => e.sessionId === p.session.sessionId)
    .slice(-MAX_EVIDENCE_LINES)
    .map((e) => ({
      status: e.status,
      causeCode: e.causeCode,
      level: e.level,
      summary: truncate(e.summary ?? '', 160),
    }));

  const repoMap = buildRepoMapSlice(p.repoMap, p.session.project);

  return {
    view: 'sessions',
    focusSessionId: p.session.sessionId,
    project: p.session.projectShort || p.session.project,
    title: p.session.title,
    ...(repoMap ? { repoMap } : {}),
    version: p.session.version,
    gitBranch: p.session.gitBranch,
    entrypoint: p.session.entrypoint,
    startTime: isoOrUndef(p.session.startTime),
    endTime: isoOrUndef(p.session.endTime),
    messageCount: p.session.messageCount,
    overview: {
      model: p.overview.model,
      totalTokens: p.overview.totalTokens,
      estimatedCost: Number(p.overview.estimatedCost.toFixed(4)),
      uniqueTools: p.overview.uniqueTools,
      totalToolInvocations: p.overview.totalToolInvocations,
      topTools: p.overview.topTools.slice(0, 8),
      topFiles: p.overview.topFiles.slice(0, 6),
      errorCount: p.overview.errorCount,
      toolErrorCount: p.overview.toolErrorCount,
      apiErrorCount: p.overview.apiErrorCount,
      compactionCount: p.overview.compactionCount,
      peakContextTokens: p.overview.peakContextTokens,
      peakContextPercent: Number(p.overview.peakContextPercent.toFixed(1)),
    },
    timeline: tlSummary,
    recentErrors,
  };
}

function buildProjectContext(p: ProjectPayload): unknown {
  const projectSessionIds = new Set(p.project.sessions.map((s) => s.sessionId));
  const tokens = p.tokenData.filter((t) => projectSessionIds.has(t.sessionId));
  const tools = p.toolData.filter((t) => projectSessionIds.has(t.sessionId));

  const aggregates = aggregateTools(tools).slice(0, 10);
  const bash = topBashCommands(tools, 10).slice(0, 10);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  const modelCounts = new Map<string, number>();
  for (const t of tokens) {
    totalInput += t.totalInputTokens;
    totalOutput += t.totalOutputTokens;
    totalCacheCreation += t.totalCacheCreationTokens;
    totalCacheRead += t.totalCacheReadTokens;
    if (t.model) modelCounts.set(t.model, (modelCounts.get(t.model) ?? 0) + 1);
  }

  const branches = new Set<string>();
  const versions = new Set<string>();
  for (const s of p.project.sessions) {
    if (s.gitBranch) branches.add(s.gitBranch);
    if (s.version) versions.add(s.version);
  }

  const repoMap = buildRepoMapSlice(p.repoMap, p.project.project);

  return {
    view: 'projects',
    project: p.project.projectShort || p.project.project,
    ...(repoMap ? { repoMap } : {}),
    sessions: p.project.sessionCount,
    messages: p.project.messageCount,
    firstSeen: isoOrUndef(p.project.firstSeen),
    lastSeen: isoOrUndef(p.project.lastSeen),
    tokens: {
      totalInput,
      totalOutput,
      totalCacheCreation,
      totalCacheRead,
    },
    topModels: Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([model, count]) => ({ model, sessions: count })),
    topTools: aggregates.map((a) => ({
      tool: a.toolName,
      count: a.count,
      errorRate: Number(a.errorRate.toFixed(3)),
    })),
    topBashCommands: bash.map((b) => ({
      command: truncate(b.command, 100),
      count: b.count,
    })),
    gitBranches: Array.from(branches).slice(0, 8),
    versions: Array.from(versions).slice(0, 8),
  };
}

function buildRecommendationContextRow(
  r: Recommendation,
  compact = false
): Record<string, unknown> {
  const lineLimit = compact ? 1 : MAX_EVIDENCE_LINES;
  const observationLimit = compact ? 1 : MAX_PROVENANCE_OBSERVATIONS;
  const derivationLimit = compact ? 1 : MAX_PROVENANCE_DERIVATIONS;
  const savings = r.savingsAttribution;

  return {
    id: truncate(r.id, 160),
    category: r.category,
    severity: r.severity,
    title: truncate(r.title, 200),
    detail: truncate(r.detail, compact ? 200 : 320),
    action: truncate(r.action, compact ? 160 : 240),
    estSavingsUsd:
      r.estSavingsUsd !== undefined
        ? Number(r.estSavingsUsd.toFixed(2))
        : undefined,
    affected: r.affected,
    evidence: r.evidence
      ?.slice(0, lineLimit)
      .map((line) => truncate(line, compact ? 160 : 240)),
    evidenceRefs: r.evidenceRefs?.slice(0, lineLimit).map((ref) => ({
      sessionId: truncate(ref.sessionId, 160),
      entryIndex: ref.entryIndex,
      timestamp: truncate(ref.timestamp, 64),
      ...(ref.toolUseId
        ? { toolUseId: truncate(ref.toolUseId, 160) }
        : {}),
      ...(ref.entryId ? { entryId: truncate(ref.entryId, 160) } : {}),
    })),
    provenance: r.provenance
      ? {
          observations: r.provenance.observations
            .slice(0, observationLimit)
            .map((observation) => ({
              ...(observation.id
                ? { id: truncate(observation.id, 120) }
                : {}),
              claim: truncate(observation.claim, compact ? 180 : 320),
              source: truncate(observation.source, 160),
              ...(observation.record
                ? { record: truncate(observation.record, 160) }
                : {}),
              field: observation.field
                ? truncate(observation.field, 240)
                : undefined,
              value:
                observation.value === undefined
                  ? undefined
                  : boundedClaimScalar(observation.value),
            })),
          ...(r.provenance.derivations
            ? {
                derivations: r.provenance.derivations
                  .slice(0, derivationLimit)
                  .map((derivation) => ({
                    id: truncate(derivation.id, 120),
                    formula: truncate(
                      derivation.formula,
                      compact ? 180 : 320
                    ),
                    operands: Object.fromEntries(
                      Object.entries(derivation.operands)
                        .slice(0, compact ? 2 : 8)
                        .map(([name, value]) => [
                          truncate(name, 100),
                          boundedClaimScalar(value, compact ? 120 : 240),
                        ])
                    ),
                    value: boundedClaimScalar(derivation.value),
                  })),
              }
            : {}),
          ...(r.provenance.inference
            ? {
                inference: truncate(
                  r.provenance.inference,
                  compact ? 240 : 480
                ),
              }
            : {}),
          ...(r.provenance.capturedAt
            ? { capturedAt: r.provenance.capturedAt }
            : {}),
          ...(r.provenance.asOf ? { asOf: r.provenance.asOf } : {}),
          ...(r.provenance.stale !== undefined
            ? { stale: r.provenance.stale }
            : {}),
        }
      : undefined,
    claimClass: r.claimClass,
    proofTier: r.proofTier,
    savingsAttribution: savings
      ? {
          interventionKey: truncate(savings.interventionKey, 160),
          signatureId: truncate(savings.signatureId, 160),
          tier: savings.tier,
          predictedSavingsUsd: savings.predictedSavingsUsd,
          realizedSavingsUsd: savings.realizedSavingsUsd,
          confidence: savings.confidence,
          ...(savings.window
            ? {
                window: {
                  ...(savings.window.baseline
                    ? {
                        baseline: {
                          start: truncate(savings.window.baseline.start, 64),
                          end: truncate(savings.window.baseline.end, 64),
                        },
                      }
                    : {}),
                  ...(savings.window.comparison
                    ? {
                        comparison: {
                          start: truncate(savings.window.comparison.start, 64),
                          end: truncate(savings.window.comparison.end, 64),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          sampleSize: savings.sampleSize,
          judgeAgreement: savings.judgeAgreement,
          asOf: savings.asOf,
          stale: savings.stale,
        }
      : undefined,
  };
}

function buildRecommendationsContext(p: RecommendationsPayload): unknown {
  // Viewer-only (#2719): the findings are the server-computed result the user is
  // looking at — passed in pre-built, never recomputed here. No engine run, no
  // detector-catalog import, no "omitted signals" (the server computes the full
  // set), so this stays a pure formatting pass over the shared list.
  const recs: Recommendation[] = p.recommendations;

  // Trust contract: a non-ready analysis is not a successful empty analysis.
  // Preserve the status in the JSON Ask Claude receives and keep counts null so
  // neither the model nor a user can read a transport/auth/SPA state as "zero
  // findings". Recommendation-specific quick prompts remain disabled upstream;
  // free-form questions can still be answered with this honest state attached.
  if (p.analysisStatus && p.analysisStatus !== 'ready') {
    return {
      view: 'recommendations',
      analysisStatus: p.analysisStatus,
      analysisError: p.analysisError ?? null,
      totalRecommendations: null,
      recommendations: [],
    };
  }

  const summary = {
    view: 'recommendations',
    analysisStatus: p.analysisStatus ?? 'ready',
    totalRecommendations: recs.length,
    bySeverity: {
      critical: recs.filter((r) => r.severity === 'critical').length,
      warning: recs.filter((r) => r.severity === 'warning').length,
      info: recs.filter((r) => r.severity === 'info').length,
    },
    totalEstimatedSavingsUsd: Number(
      recs.reduce((s, r) => s + (r.estSavingsUsd ?? 0), 0).toFixed(2)
    ),
  };
  const recommendations: Record<string, unknown>[] = [];
  for (const recommendation of recs.slice(0, 20)) {
    let row = buildRecommendationContextRow(recommendation);
    let candidate = { ...summary, recommendations: [...recommendations, row] };
    if (
      recommendations.length === 0 &&
      JSON.stringify(candidate).length > MAX_RECOMMENDATION_CONTEXT_CHARS
    ) {
      row = buildRecommendationContextRow(recommendation, true);
      candidate = { ...summary, recommendations: [row] };
    }
    if (JSON.stringify(candidate).length > MAX_RECOMMENDATION_CONTEXT_CHARS) {
      break;
    }
    recommendations.push(row);
  }
  return { ...summary, recommendations };
}

function buildToolsContext(p: ToolsPayload): unknown {
  const aggregates = aggregateTools(p.toolData);
  const effectiveness: ToolEffectivenessRow[] = computeToolEffectiveness(
    p.toolData,
    p.apiErrors,
    p.timelines
  );

  const underperforming = [...effectiveness]
    .filter((r) => r.invocations >= 5)
    .sort((a, b) => a.effectivenessScore - b.effectivenessScore)
    .slice(0, 10)
    .map((r) => ({
      tool: r.tool,
      invocations: r.invocations,
      effectivenessScore: Number(r.effectivenessScore.toFixed(3)),
      followedByError: r.immediatelyFollowedByError,
      followedByRetry: r.immediatelyFollowedByRetry,
      followedByUndo: r.immediatelyFollowedByUndo,
    }));

  return {
    view: 'tools',
    totalUniqueTools: aggregates.length,
    totalInvocations: aggregates.reduce((s, a) => s + a.count, 0),
    topTools: aggregates.slice(0, 12).map((a) => ({
      tool: a.toolName,
      count: a.count,
      errorRate: Number(a.errorRate.toFixed(3)),
    })),
    underperformingTools: underperforming,
  };
}

function buildOverviewContext(p: OverviewPayload): unknown {
  const totalMessages = p.sessions.reduce((s, x) => s + x.messageCount, 0);
  const avgDurationMs =
    p.sessions.length === 0
      ? 0
      : p.sessions.reduce((s, x) => s + x.duration, 0) / p.sessions.length;
  const startTimes = p.sessions.map((s) => s.startTime).filter((t) => t > 0);
  const endTimes = p.sessions.map((s) => s.endTime).filter((t) => t > 0);

  const topProjects = [...p.projects]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5)
    .map((proj) => ({
      project: proj.projectShort || proj.project,
      sessions: proj.sessionCount,
      messages: proj.messageCount,
    }));

  const modelCounts = new Map<string, number>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  for (const t of p.tokenData) {
    totalInput += t.totalInputTokens;
    totalOutput += t.totalOutputTokens;
    totalCacheCreation += t.totalCacheCreationTokens;
    totalCacheRead += t.totalCacheReadTokens;
    if (t.model) modelCounts.set(t.model, (modelCounts.get(t.model) ?? 0) + 1);
  }
  const topModels = Array.from(modelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([model, count]) => ({ model, sessions: count }));

  return {
    view: 'overview',
    generatedAt: new Date().toISOString(),
    sessions: {
      total: p.sessions.length,
      earliest: isoOrUndef(startTimes.length ? Math.min(...startTimes) : undefined),
      latest: isoOrUndef(endTimes.length ? Math.max(...endTimes) : undefined),
      totalMessages,
      avgDurationMinutes: Math.round(avgDurationMs / 60000),
    },
    topProjects,
    tokens: {
      totalInput,
      totalOutput,
      totalCacheCreation,
      totalCacheRead,
      topModels,
    },
  };
}

export function buildContext(payload: ContextPayload): unknown {
  switch (payload.view) {
    case 'sessions':
      return buildSessionContext(payload.data);
    case 'projects':
      return buildProjectContext(payload.data);
    case 'recommendations':
      return buildRecommendationsContext(payload.data);
    case 'tools':
      return buildToolsContext(payload.data);
    case 'generic':
      return buildOverviewContext(payload.data);
  }
}

// ── quick prompts ───────────────────────────────────────────────────────────

export interface QuickPrompt {
  id: string;
  label: string;
  prompt: string;
  system?: string;
}

const SESSION_SYSTEM =
  'You are diagnosing a single Claude Code session from a JSON overview. Identify likely failure modes, surface concrete suggestions, and keep the answer scannable. Use Markdown with `###` section headings (e.g. "### What happened", "### Likely causes", "### Suggested fixes").';

const PROJECT_SYSTEM =
  'You are a Claude Code workflow coach suggesting CLAUDE.md additions for one project. Use the JSON snapshot to ground every suggestion in the project\'s actual tooling, git activity, and bash patterns. Return ready-to-paste Markdown snippets, each preceded by a one-line "why".';

const RECOMMENDATIONS_SYSTEM =
  'You are explaining a list of dashboard-generated recommendations to the user in plain English. Group, prioritise, and translate each item; keep the answer skimmable. Use Markdown.';

const TOOLS_SYSTEM =
  'You are advising on which Claude Code tools are worth pruning, based on an effectiveness summary. Recommend a short prune list with one-line justifications, plus tools that look fine. Use Markdown.';

const FREEFORM_SYSTEM =
  'You are reviewing a JSON snapshot of one user\'s Claude Code dashboard. Be concrete, cite numbers from the data, and keep suggestions actionable. Format with short Markdown sections when useful.';

export function quickPromptsFor(view: View): QuickPrompt[] {
  const freeform: QuickPrompt = {
    id: 'free',
    label: 'Free-form question',
    prompt: 'Ask anything about my Claude Code usage…',
    system: FREEFORM_SYSTEM,
  };
  switch (view) {
    case 'sessions':
      return [
        {
          id: 'diagnose-session',
          label: 'Diagnose this session',
          prompt:
            'Diagnose the session described in the JSON below. List likely failure modes, then concrete suggestions to avoid them next time.',
          system: SESSION_SYSTEM,
        },
        {
          id: 'why-cost',
          label: 'Explain this session’s cost',
          prompt:
            'Explain why this session cost what it did, citing the top tools, file targets, and any peak-context or compaction signals from the JSON below.',
          system: SESSION_SYSTEM,
        },
        {
          id: 'next-prompts',
          label: 'Suggest next prompts to try',
          prompt:
            'Given the session JSON below, suggest 3 concrete prompts I could try to either finish or refactor this session\'s work.',
          system: SESSION_SYSTEM,
        },
        freeform,
      ];
    case 'projects':
      return [
        {
          id: 'claude-md',
          label: 'Suggest CLAUDE.md additions',
          prompt:
            'Based on this project\'s tool usage and bash patterns from the JSON below, suggest concrete CLAUDE.md additions. Each suggestion should have a one-line "why" and a ready-to-paste Markdown block.',
          system: PROJECT_SYSTEM,
        },
        {
          id: 'audit-tools',
          label: 'Audit this project\'s tool habits',
          prompt:
            'Audit how I use Claude Code on this project. From the JSON below, call out anything I should change.',
          system: PROJECT_SYSTEM,
        },
        freeform,
      ];
    case 'recommendations':
      return [
        {
          id: 'explain-prioritize',
          label: 'Explain and prioritize these recommendations',
          prompt:
            'Translate the recommendation list in the JSON below into plain English, group similar items, and tell me what to act on first.',
          system: RECOMMENDATIONS_SYSTEM,
        },
        {
          id: 'savings-plan',
          label: 'Draft a cost-savings plan',
          prompt:
            'From the recommendations JSON below, draft a 3-step cost-savings plan I can execute this week.',
          system: RECOMMENDATIONS_SYSTEM,
        },
        freeform,
      ];
    case 'tools':
      return [
        {
          id: 'prune',
          label: 'Which tools should I prune?',
          prompt:
            'Looking at the tool-effectiveness JSON below, tell me which tools I should consider pruning or restricting and which look healthy.',
          system: TOOLS_SYSTEM,
        },
        {
          id: 'replace',
          label: 'Suggest native replacements',
          prompt:
            'Suggest native-tool replacements for any underperforming tools in the JSON below (e.g. swapping Bash patterns for Grep/Glob/Read).',
          system: TOOLS_SYSTEM,
        },
        freeform,
      ];
    default:
      return [
        {
          id: 'overview',
          label: 'Summarize my usage',
          prompt:
            'Summarize my Claude Code usage patterns from the JSON snapshot below and give 3 concrete suggestions I can act on this week.',
          system: FREEFORM_SYSTEM,
        },
        freeform,
      ];
  }
}
