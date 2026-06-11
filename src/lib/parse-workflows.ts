/**
 * Parser for Workflow-tool run manifests (#435).
 *
 * Completed Workflow-tool runs write a self-contained manifest at
 * `~/.claude/projects/<slug>/<sessionId>/workflows/wf_*.json`. The server
 * (`GET /api/workflows`, in `scripts/server.mjs`) walks those files, projects
 * each to the ledger fields, and returns them newest-first; this module shapes
 * the raw projection into a {@link WorkflowRun} the Workflow view renders.
 *
 * Tolerant by design: `workflowProgress` mixes phase markers
 * (`type: 'workflow_phase'`) with agent rows (`type: 'workflow_agent'`), and on
 * cached / in-flight agents many fields are absent. Everything coalesces to
 * `null` rather than throwing or zero-filling, so a partial run still renders.
 */

/** One agent within a workflow run (a `workflow_agent` progress entry). */
export interface WorkflowAgent {
  index: number | null;
  label: string | null;
  phaseIndex: number | null;
  phaseTitle: string | null;
  model: string | null;
  state: string | null;
  agentType: string | null;
  startedAt: number | null;
  durationMs: number | null;
  tokens: number | null;
  toolCalls: number | null;
  promptPreview: string | null;
  resultPreview: string | null;
}

/** A declared phase of a workflow (from the manifest's `phases[]`). */
export interface WorkflowPhase {
  title: string;
  detail: string;
}

/** A single completed workflow run, normalized for the ledger. */
export interface WorkflowRun {
  runId: string;
  workflowName: string;
  status: string;
  startTime: number | null;
  durationMs: number | null;
  agentCount: number | null;
  totalTokens: number | null;
  totalToolCalls: number | null;
  defaultModel: string | null;
  /** Parent session whose dir holds this run's `workflows/` folder. */
  sessionId: string;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
}

// ── Raw shapes returned by GET /api/workflows (server-projected) ────────────
export interface RawWorkflowProgress {
  type?: string | null;
  index?: number | null;
  label?: string | null;
  phaseIndex?: number | null;
  phaseTitle?: string | null;
  model?: string | null;
  state?: string | null;
  agentType?: string | null;
  startedAt?: number | null;
  durationMs?: number | null;
  tokens?: number | null;
  toolCalls?: number | null;
  promptPreview?: string | null;
  resultPreview?: string | null;
  title?: string | null;
}
export interface RawWorkflowRun {
  runId?: string | null;
  workflowName?: string | null;
  status?: string | null;
  startTime?: number | null;
  durationMs?: number | null;
  agentCount?: number | null;
  totalTokens?: number | null;
  totalToolCalls?: number | null;
  defaultModel?: string | null;
  sessionId?: string | null;
  phases?: { title?: string | null; detail?: string | null }[] | null;
  workflowProgress?: RawWorkflowProgress[] | null;
}
export interface WorkflowsResponse {
  runs: RawWorkflowRun[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toAgent(e: RawWorkflowProgress): WorkflowAgent {
  return {
    index: num(e.index),
    label: str(e.label),
    phaseIndex: num(e.phaseIndex),
    phaseTitle: str(e.phaseTitle),
    model: str(e.model),
    state: str(e.state),
    agentType: str(e.agentType),
    startedAt: num(e.startedAt),
    durationMs: num(e.durationMs),
    tokens: num(e.tokens),
    toolCalls: num(e.toolCalls),
    promptPreview: str(e.promptPreview),
    resultPreview: str(e.resultPreview),
  };
}

/** Normalize one raw run; returns null if it has no usable identity. */
export function parseWorkflowRun(raw: RawWorkflowRun): WorkflowRun | null {
  const runId = str(raw.runId);
  if (!runId) return null;
  const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
  const agents = progress
    .filter((e) => (e?.type ?? 'workflow_agent') === 'workflow_agent')
    .map(toAgent)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const phases = (Array.isArray(raw.phases) ? raw.phases : []).map((p) => ({
    title: str(p?.title) ?? '',
    detail: str(p?.detail) ?? '',
  }));
  return {
    runId,
    workflowName: str(raw.workflowName) ?? runId,
    status: str(raw.status) ?? 'unknown',
    startTime: num(raw.startTime),
    durationMs: num(raw.durationMs),
    agentCount: num(raw.agentCount),
    totalTokens: num(raw.totalTokens),
    totalToolCalls: num(raw.totalToolCalls),
    defaultModel: str(raw.defaultModel),
    sessionId: str(raw.sessionId) ?? '',
    phases,
    agents,
  };
}

/** Parse the raw `/api/workflows` response into runs, newest-first. */
export function parseWorkflows(
  resp: WorkflowsResponse | null | undefined
): WorkflowRun[] {
  const runs = resp?.runs ?? [];
  return runs
    .map(parseWorkflowRun)
    .filter((r): r is WorkflowRun => r !== null)
    .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
}

/** Group a run's agents by their phase title (preserving first-seen order). */
export function agentsByPhase(
  run: WorkflowRun
): { phase: string; agents: WorkflowAgent[] }[] {
  const order: string[] = [];
  const byPhase = new Map<string, WorkflowAgent[]>();
  for (const a of run.agents) {
    const key = a.phaseTitle ?? 'Unphased';
    if (!byPhase.has(key)) {
      byPhase.set(key, []);
      order.push(key);
    }
    byPhase.get(key)!.push(a);
  }
  return order.map((phase) => ({ phase, agents: byPhase.get(phase)! }));
}

/** A phase with its agents plus token-sum and wall-clock-span aggregates (#437). */
export interface PhaseAggregate {
  phase: string;
  agents: WorkflowAgent[];
  /** Sum of non-null agent `tokens` in this phase. */
  tokenSum: number;
  /** Earliest `startedAt` across the phase's agents, or null if none timed. */
  startMin: number | null;
  /** Latest `startedAt + durationMs`, or null if none timed. */
  endMax: number | null;
  /** `endMax - startMin`, or null when timing is unavailable. */
  spanMs: number | null;
}

/**
 * Per-phase aggregates for the run-detail tree (#437): token sum + wall-clock
 * span. Timing is best-effort — agents with null `startedAt`/`durationMs` are
 * skipped for the span (never zero-filled), so `spanMs` is null when no agent
 * in the phase carries timing.
 */
export function phaseAggregates(run: WorkflowRun): PhaseAggregate[] {
  return agentsByPhase(run).map(({ phase, agents }) => {
    let tokenSum = 0;
    let startMin: number | null = null;
    let endMax: number | null = null;
    for (const a of agents) {
      if (a.tokens != null) tokenSum += a.tokens;
      if (a.startedAt != null) {
        startMin = startMin == null ? a.startedAt : Math.min(startMin, a.startedAt);
        // Only extend the end when BOTH start and duration are known — a known
        // start with an unknown duration must not zero-fill the span to the
        // start instant (that would render "0s" instead of "—" / unknown).
        if (a.durationMs != null) {
          const end = a.startedAt + a.durationMs;
          endMax = endMax == null ? end : Math.max(endMax, end);
        }
      }
    }
    const spanMs = startMin != null && endMax != null ? endMax - startMin : null;
    return { phase, agents, tokenSum, startMin, endMax, spanMs };
  });
}

/** One agent's bar in the run timeline (#437). */
export interface TimelineBar {
  agent: WorkflowAgent;
  /** ms from the run's first agent start; 0 when timing is unknown. */
  offsetMs: number;
  /** Bar width in ms; 0 when `durationMs` is unknown. */
  durationMs: number;
  /** False when `startedAt` is null — render as "no timing", not a zero bar. */
  hasTiming: boolean;
  /** Lane to stack the bar in — `phaseIndex` (1-based) or 0. */
  laneIndex: number;
}
export interface RunTimeline {
  bars: TimelineBar[];
  /** Total wall-clock span the bars are scaled against (>= 1 to avoid /0). */
  totalSpanMs: number;
  /** Reference start (min agent `startedAt`, or `run.startTime`, or 0). */
  startRef: number;
}

/**
 * Build the Gantt/timeline model (#437): one bar per agent, offset from the
 * run's earliest agent start, width = duration. Implied concurrency only — DAG
 * edges are not stored. Untimed agents (`startedAt` null) get `hasTiming:false`
 * so the UI can render them as unknown rather than a bar pinned at 0.
 */
export function runTimeline(run: WorkflowRun): RunTimeline {
  const timed = run.agents.filter((a) => a.startedAt != null);
  const startRef =
    timed.length > 0
      ? Math.min(...timed.map((a) => a.startedAt as number))
      : run.startTime ?? 0;
  let endMax = startRef;
  for (const a of timed) {
    endMax = Math.max(endMax, (a.startedAt as number) + (a.durationMs ?? 0));
  }
  const totalSpanMs = Math.max(1, endMax - startRef);
  const bars: TimelineBar[] = run.agents.map((agent) => {
    const hasTiming = agent.startedAt != null;
    return {
      agent,
      offsetMs: hasTiming ? (agent.startedAt as number) - startRef : 0,
      durationMs: hasTiming ? agent.durationMs ?? 0 : 0,
      hasTiming,
      laneIndex: agent.phaseIndex ?? 0,
    };
  });
  return { bars, totalSpanMs, startRef };
}
