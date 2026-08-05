/**
 * fs-free leaf: the session-registry entry shape and the pure attribution
 * analyser, shared by the server-side registry parser
 * (`parse-session-registry.ts`) and the browser-bundled `report-card.ts`
 * (#3639, the #3613 extraction pattern).
 *
 * This lives in its OWN dependency-free leaf — NOT in
 * `parse-session-registry.ts` — on purpose: that module imports `node:fs`
 * (via `bounded-fs`, which `parseSessionRegistryDir` needs), and in the SPA
 * build `node:fs` resolves to an empty stub that throws at module scope. A
 * value import of `analyzeAttribution` from the fs-touching module dragged
 * the fs graph into the AgentReportCardPf view chunk and white-screened it on
 * load. Browser code imports the analyser from here; the dir parser stays
 * behind with the fs graph.
 *
 * CRITICAL CAVEAT: sessions report kind:"interactive" even when
 * entrypoint:"sdk-cli". ALL attribution logic MUST key on `entrypoint`,
 * NEVER on `kind`. The kind field is unreliable for automation detection.
 */

/** One entry from ~/.claude/sessions/<pid>.json */
export interface SessionRegistryEntry {
  /** OS process ID (the JSON filename without extension, also present inside) */
  pid: number;
  /** Session UUID — join key to transcript files and debug/<sessionId>.txt */
  sessionId: string;
  /** Absolute working directory of the CLI process — primary grouping key */
  cwd: string;
  /** Unix epoch ms — when the session was started */
  startedAt: number;
  /**
   * Kernel process-start counter (monotonic; used to detect PID reuse).
   * Present as a string in the artifact.
   */
  procStart: string;
  /** CLI version string, e.g. "2.1.161" */
  version: string;
  /** IPC protocol version number */
  peerProtocol: number;
  /**
   * Session kind reported by the CLI.
   * WARNING: this is "interactive" even for sdk-cli sessions.
   * Use `entrypoint` for automation attribution, not `kind`.
   */
  kind: string;
  /**
   * The true launch entrypoint: "cli" (interactive), "sdk-cli", "sdk-py", etc.
   * This is the ONLY reliable field for attribution of automated vs interactive
   * sessions. Do NOT use `kind` — it consistently mis-tags sdk-cli as interactive.
   */
  entrypoint: string;
}

// ---------------------------------------------------------------------------
// Attribution analysis — output shapes
// ---------------------------------------------------------------------------

/** Attribution classification for a project (keyed by cwd). */
export type AttributionBucket = 'committed' | 'split' | 'low-signal';

/**
 * Per-entrypoint count within a project, sorted descending by count.
 */
export interface EntrypointCount {
  entrypoint: string;
  count: number;
  /** Integer percentage share (0–100) */
  pct: number;
}

/**
 * CLI-version timeline entry: first-seen date per version for a project.
 */
export interface VersionTimelineEntry {
  version: string;
  /** ISO date string of the first session seen with this version */
  firstSeenAt: string;
  count: number;
}

/**
 * Per-project attribution analysis, ready for the #572 Agent Report Card to join.
 */
export interface ProjectAttribution {
  /**
   * Absolute working directory — primary key; join on this for cross-artifact
   * rollup. The report card also accepts sessionId-level joins via rawEntries.
   */
  cwd: string;
  /** Total session files seen for this project */
  sessionCount: number;

  /**
   * Attribution classification:
   * - "committed"  : one entrypoint holds >= 70% of sessions
   * - "split"      : no entrypoint holds >= 70% (ambiguous; cost untrustworthy)
   * - "low-signal" : <= 2 sessions total (insufficient evidence)
   *
   * ALWAYS derived from `entrypoint`, NEVER from `kind`.
   */
  attributionBucket: AttributionBucket;

  /** Dominant entrypoint name (highest share). Empty string when no sessions. */
  dominantEntrypoint: string;
  /** Integer percentage share of the dominant entrypoint (0–100) */
  dominantShare: number;

  /**
   * Entrypoint breakdown, sorted descending by count.
   * Used by the report card to render split-bars.
   */
  entrypointMatrix: EntrypointCount[];

  /**
   * CLI version adoption timeline for this project, sorted by first-seen.
   * Used by the report card to render a version adoption strip.
   */
  versionTimeline: VersionTimelineEntry[];

  /**
   * Number of sessions where kind !== entrypoint (specifically:
   * entrypoint="sdk-cli" but kind="interactive").
   *
   * This count is AUDITABLE evidence for the attribution caveat. The report
   * card MUST surface it so the user can verify that automation was correctly
   * attributed on entrypoint despite the kind mis-tag.
   *
   * A non-zero value here is expected and normal; it is NOT an error.
   */
  kindEntrypointAnomalyCount: number;

  /**
   * The raw per-session entries for this project, kept so the #572 report card
   * can join on sessionId against telemetry and debug artifacts.
   * Each entry retains the full SessionRegistryEntry shape.
   */
  rawEntries: SessionRegistryEntry[];
}

/**
 * Top-level result of analyzeAttribution.
 */
export interface AttributionAnalysis {
  /** Total number of session files processed */
  totalSessions: number;
  /** Total number of distinct projects (unique cwd values) */
  totalProjects: number;
  /** All CLI versions seen across all sessions, sorted */
  allVersions: string[];
  /** Total kind!=entrypoint anomalies across all sessions */
  totalKindAnomalies: number;
  /** Per-project analysis, sorted descending by sessionCount */
  projects: ProjectAttribution[];
}

// ---------------------------------------------------------------------------
// Attribution analyser
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): number => (d > 0 ? Math.round((100 * n) / d) : 0);

/**
 * Analyse attribution from a flat array of SessionRegistryEntry.
 *
 * CRITICAL: classification uses `entrypoint` exclusively.
 * The `kind` field is captured only to compute the anomaly count
 * (sessions where kind="interactive" but entrypoint="sdk-cli").
 *
 * Thresholds (from P7 prototype and #572 blend matrix):
 *   - "committed"  : dominant entrypoint share >= 70%  AND sessionCount > 2
 *   - "split"      : no entrypoint >= 70%              AND sessionCount > 2
 *   - "low-signal" : sessionCount <= 2
 *
 * @param entries  Array returned by parseSessionRegistryDir (may be empty)
 */
export function analyzeAttribution(entries: SessionRegistryEntry[]): AttributionAnalysis {
  // Group by cwd (project)
  // perf-index-contract: attribution-by-project always-consumed: iterated by the per-project loop below on every call; the function has no other exit
  const byProject = new Map<string, SessionRegistryEntry[]>();
  for (const entry of entries) {
    const bucket = byProject.get(entry.cwd) ?? [];
    bucket.push(entry);
    byProject.set(entry.cwd, bucket);
  }

  // perf-index-contract: attribution-all-versions always-consumed: drained into the returned allVersions list at the end of every call
  const allVersionsSet = new Set<string>();
  let totalKindAnomalies = 0;

  const projects: ProjectAttribution[] = [];

  for (const [cwd, projectEntries] of byProject) {
    const sessionCount = projectEntries.length;

    // Entrypoint tally — attribute on entrypoint, NEVER kind
    // perf-index-contract: attribution-project-tallies always-consumed: the three tallies below are drained into entrypointMatrix/versionTimeline for every project
    const entrypointCounts = new Map<string, number>();
    const versionFirstSeen = new Map<string, number>(); // version -> earliest startedAt
    const versionCounts = new Map<string, number>();
    let anomalyCount = 0;

    for (const e of projectEntries) {
      // Entrypoint matrix
      entrypointCounts.set(e.entrypoint, (entrypointCounts.get(e.entrypoint) ?? 0) + 1);

      // Version timeline
      if (e.version) {
        allVersionsSet.add(e.version);
        const prev = versionFirstSeen.get(e.version);
        if (prev === undefined || e.startedAt < prev) {
          versionFirstSeen.set(e.version, e.startedAt);
        }
        versionCounts.set(e.version, (versionCounts.get(e.version) ?? 0) + 1);
      }

      // Anomaly: kind!=entrypoint, specifically sdk-cli reported as interactive
      if (e.entrypoint === 'sdk-cli' && e.kind === 'interactive') {
        anomalyCount++;
      }
    }

    totalKindAnomalies += anomalyCount;

    // Build entrypoint matrix sorted descending
    // perf-index-contract: attribution-project-tallies always-consumed: the sorted matrix is stored on the returned ProjectAttribution unconditionally
    const entrypointMatrix: EntrypointCount[] = Array.from(entrypointCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([entrypoint, count]) => ({ entrypoint, count, pct: pct(count, sessionCount) }));

    const dominantEntrypoint = entrypointMatrix[0]?.entrypoint ?? '';
    const dominantShare = entrypointMatrix[0]?.pct ?? 0;
    const dominantCount = entrypointMatrix[0]?.count ?? 0;

    // Attribution bucket — always from entrypoint, never kind
    let attributionBucket: AttributionBucket;
    if (sessionCount <= 2) {
      attributionBucket = 'low-signal';
    } else if (dominantCount / sessionCount >= 0.70) {
      attributionBucket = 'committed';
    } else {
      attributionBucket = 'split';
    }

    // Version timeline sorted by first-seen ascending
    // perf-index-contract: attribution-project-tallies always-consumed: the sorted timeline is stored on the returned ProjectAttribution unconditionally
    const versionTimeline: VersionTimelineEntry[] = Array.from(versionFirstSeen.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([version, firstMs]) => ({
        version,
        firstSeenAt: new Date(firstMs).toISOString(),
        count: versionCounts.get(version) ?? 0,
      }));

    projects.push({
      cwd,
      sessionCount,
      attributionBucket,
      dominantEntrypoint,
      dominantShare,
      entrypointMatrix,
      versionTimeline,
      kindEntrypointAnomalyCount: anomalyCount,
      rawEntries: projectEntries,
    });
  }

  // Sort projects descending by sessionCount
  // perf-index-contract: attribution-project-order always-consumed: the sorted list IS the returned projects field
  projects.sort((a, b) => b.sessionCount - a.sessionCount);

  // perf-index-contract: attribution-all-versions always-consumed: the sorted list IS the returned allVersions field
  const allVersions = Array.from(allVersionsSet).sort();

  return {
    totalSessions: entries.length,
    totalProjects: byProject.size,
    allVersions,
    totalKindAnomalies,
    projects,
  };
}
