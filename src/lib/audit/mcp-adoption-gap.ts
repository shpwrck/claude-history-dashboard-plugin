/**
 * Tier-3 audit: MCP adoption gap (#605 / #740).
 *
 * Surfaces an MCP server this workload would BENEFIT from but has NOT installed
 * — an *adoption* gap. This is the inverse of the cost-of-MCP-already-in-use
 * concern (replay D7/#599): here we look for unmet capability needs that a
 * not-yet-configured server would cover, and we EXPLICITLY exclude every server
 * that is already installed (those belong to the cost concern, not adoption).
 *
 * Deterministic seed: coarse, EXPLAINABLE capability signals aggregated from
 * tool-usage history (e.g. heavy WebFetch/WebSearch -> a fetch/web capability;
 * many `gh ...` Bash invocations -> a GitHub MCP). Each signal carries its
 * evidence string and a weight, and is ranked by weight. Any signal whose
 * capability is already covered by an installed server is DROPPED (case-
 * insensitive name match against the capability's known server names). Weak
 * signals (below a support floor) never fire, and the survivors are capped.
 *
 * Judge step: route each surviving capability gap through the judge to confirm a
 * NOT-installed MCP server would genuinely help (vs. noise / a one-off / work
 * already covered another way) and emit a finding naming the candidate server +
 * the evidence pattern. Per-candidate judge failures are isolated so one bad
 * call can't drop the rest.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness). The
 * installed-MCP baseline comes from `ds.liveConfig.mcpServers` (a
 * {@link import('../../types').LiveMcpServer}[] keyed by `id`); the usage
 * signals are aggregated server-side from `ds.toolData`.
 *
 * NOTE on adapted inputs (#740 spec drift): the issue referenced a
 * `scripts/ingest.mjs` `readMcpServers` reader, which does not exist as a
 * server-input helper, and called the installed set `name`-keyed. The real
 * baseline is `ds.liveConfig.mcpServers` (each entry keyed by `id`), and the
 * tool-usage source is `ds.toolData` (the same source the other audits use)
 * rather than `parse-timeline`. Same intent, real surfaces.
 */
import type { AuditFinding } from './types';
import type { JudgeFn } from './judge';

/**
 * One coarse, explainable capability signal aggregated from history. `weight` is
 * the support behind it (e.g. how many calls matched); `evidence` is the
 * human-readable pattern (e.g. "WebFetch used 40 time(s)") the judge and the
 * finding both quote.
 */
export interface ToolUsageSignal {
  /** Capability key from {@link CAPABILITY_MAP}, e.g. `web-fetch`, `github`. */
  capability: string;
  /** Human-readable evidence pattern behind the signal. */
  evidence: string;
  /** Support weight — higher means a stronger, more recurring need. */
  weight: number;
}

/**
 * One known capability and the MCP server(s) that provide it. The map is small,
 * fixed, and documented on purpose: every gap we can surface must trace to an
 * EXPLAINABLE tool-usage pattern and a concretely-named candidate server, and
 * the `servers` list is what we match an installed server's name against to
 * exclude an already-covered capability.
 */
export interface CapabilityDef {
  /** One-line description of the unmet capability the pattern implies. */
  label: string;
  /**
   * Candidate MCP server names that provide this capability. The FIRST entry is
   * the one we name in the finding; ALL entries are matched (case-insensitively,
   * as substrings either way) against installed server ids to decide whether the
   * capability is already covered.
   */
  servers: string[];
}

/**
 * The fixed capability -> candidate-server map. Keep this small and explainable:
 * each key is a capability we can infer from a recurring tool/command pattern,
 * and each value names the real MCP server(s) that would cover it. Used both to
 * label findings and to exclude already-installed coverage.
 */
export const CAPABILITY_MAP: Record<string, CapabilityDef> = {
  'web-fetch': {
    label: 'fetching and searching the web',
    servers: ['fetch', 'web', 'brave-search', 'web-search'],
  },
  github: {
    label: 'GitHub repository, issue, and pull-request operations',
    servers: ['github'],
  },
  database: {
    label: 'querying a SQL database directly',
    servers: ['postgres', 'sqlite', 'database', 'mysql'],
  },
  browser: {
    label: 'driving a real browser (navigation, clicks, snapshots)',
    servers: ['playwright', 'puppeteer', 'browser'],
  },
  filesystem: {
    label: 'structured filesystem access beyond a single working tree',
    servers: ['filesystem'],
  },
};

/** A capability gap that survived the installed-coverage and support filters. */
export interface CapabilityGap {
  /** Capability key (a {@link CAPABILITY_MAP} key). */
  capability: string;
  /** The candidate server we name in the finding (first of the def's servers). */
  candidateServer: string;
  /** Human-readable capability description (the def's label). */
  label: string;
  /** Combined evidence behind the gap (signals merged for this capability). */
  evidence: string;
  /** Combined support weight across the capability's signals. */
  weight: number;
}

export interface DetectOptions {
  /**
   * A capability's combined weight must clear this to be a gap — keeps weak,
   * one-off usage (a single WebFetch) from proposing a whole server.
   */
  minWeight: number;
  /** Keep only the top-N gaps after ranking by weight desc. */
  topN: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minWeight: 5,
  topN: 5,
};

/** Lower-cased substring containment, either direction (server-id vs known name). */
function nameMatches(installedId: string, knownServer: string): boolean {
  const a = installedId.toLowerCase();
  const b = knownServer.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/**
 * True when an installed server already covers the capability (so the gap must
 * be dropped — already-covered is the cost concern, not adoption). Matches each
 * installed id against the capability's known server names case-insensitively,
 * as a substring either way (so `claude_ai_GitHub`-style namespaced ids and bare
 * `github` both match the `github` capability).
 */
function isCovered(def: CapabilityDef, installedLower: string[]): boolean {
  return installedLower.some((id) =>
    def.servers.some((known) => nameMatches(id, known))
  );
}

/**
 * Collapse per-signal usage into ranked capability gaps. PURE and deterministic
 * — unit-tested without the judge.
 *
 * Pipeline: sum each capability's signal weights and merge their evidence ->
 * DROP any capability already covered by an installed server -> DROP any whose
 * combined weight is below `minWeight` -> rank by weight desc (ties by
 * capability key for stable ordering) -> cap at `topN`. Signals whose capability
 * is not in {@link CAPABILITY_MAP} are ignored (we can only propose a server we
 * can name).
 */
export function detectCapabilityGaps(
  installedServers: string[],
  usage: ToolUsageSignal[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS
): CapabilityGap[] {
  const { minWeight, topN } = options;
  const installedLower = installedServers.map((s) => s.toLowerCase());

  // Merge signals per capability (weight summed, evidence concatenated).
  const merged = new Map<string, { weight: number; evidence: string[] }>();
  for (const sig of usage) {
    const def = CAPABILITY_MAP[sig.capability];
    if (!def) continue; // unknown capability -> no server we can name -> skip
    if (sig.weight <= 0) continue;
    const entry = merged.get(sig.capability) ?? { weight: 0, evidence: [] };
    entry.weight += sig.weight;
    if (sig.evidence) entry.evidence.push(sig.evidence);
    merged.set(sig.capability, entry);
  }

  const gaps: CapabilityGap[] = [];
  for (const [capability, { weight, evidence }] of merged) {
    const def = CAPABILITY_MAP[capability];
    // Already-installed coverage is OUT of scope (the cost concern) -> drop.
    if (isCovered(def, installedLower)) continue;
    if (weight < minWeight) continue;
    gaps.push({
      capability,
      candidateServer: def.servers[0],
      label: def.label,
      evidence: evidence.join('; '),
      weight,
    });
  }

  gaps.sort(
    (a, b) => b.weight - a.weight || a.capability.localeCompare(b.capability)
  );
  return gaps.slice(0, topN);
}

/**
 * Judge each surviving capability gap: would adopting the named NOT-installed
 * MCP server genuinely help, given the evidence pattern? Emits a finding per
 * confirmed gap (domain `workflow` — an adoption gap is a way-of-working fix).
 * Per-candidate failures are isolated so one bad judge call can't drop the rest.
 * Returns [] when there are no gaps (insufficient signal) or none are confirmed.
 */
export async function runMcpAdoptionGapAudit(
  candidates: CapabilityGap[],
  judge: JudgeFn
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const c of candidates) {
    let verdict;
    // Isolate per-candidate failures: a transient judge error (network, rate
    // limit) skips just this candidate, keeping findings accumulated so far.
    try {
      verdict = await judge({
        system:
          'You audit a coding-agent workload for MCP adoption gaps. You are given ' +
          'a recurring tool-usage pattern and a NOT-installed MCP server that ' +
          'would cover the implied capability (already-installed servers have ' +
          'been excluded). Decide whether adopting that server would genuinely ' +
          'help this workload (the need is real and recurring, and an MCP server ' +
          'is a fit) vs. being noise, a one-off, or better served another way. ' +
          'Reply ONLY with JSON: ' +
          '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}. ' +
          'isFinding = true means the workload would benefit from adopting it.',
        user:
          `Capability not currently served by an installed MCP server: ` +
          `${c.label}. Candidate server to adopt: "${c.candidateServer}". ` +
          `Evidence pattern (support weight ${c.weight}): ${c.evidence}. ` +
          'Would adopting this MCP server genuinely benefit the workload?',
      });
    } catch {
      continue;
    }
    if (verdict.isFinding) {
      findings.push({
        id: `mcp-adoption-gap:${c.candidateServer}`,
        domain: 'workflow',
        summary:
          `Adoption gap: the "${c.candidateServer}" MCP server is not installed ` +
          `but would cover ${c.label} (evidence: ${c.evidence}).`,
        evidenceRefs: [
          `capability:${c.capability}`,
          `candidate-server:${c.candidateServer}`,
        ],
        judgeRationale: verdict.rationale,
        confidence: verdict.confidence,
      });
    }
  }
  return findings;
}
