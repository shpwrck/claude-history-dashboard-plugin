/**
 * Adoption scorecard — the read-side join behind the Adoption Card + Scorecard
 * view (issue #577, ADR 0005 "Demo artifact"). Given the append-only adoption
 * receipts (`SURFACED` / `SUPPRESSED`, from #575) and the live config bundle, it
 * derives one per-finding row a viewer reads in 10 seconds plus the index header
 * metrics.
 *
 * Load-bearing honesty rules carried verbatim from ADR 0005:
 *  - The MARKER-CONFIRMED row's CLAUDE.md hunk is rendered from `liveConfig` **at
 *    render time, never stored** — we extract it here from the merged CLAUDE.md text by
 *    the receipt's `markerHeading`, we do NOT read it from the receipt.
 *  - `M/N` is a **lower bound** — strict-AND markers undercount prose adoptions.
 *  - "no recurrence for N sessions" is **non-causal** — a deleted CLAUDE.md
 *    section also reads as quiet.
 *  - A `SUPPRESSED` record with no prior `SURFACED` for the same finding is
 *    "organic / not attributed" and excluded from the coached (`M`) count. Until
 *    the hook-side surfaced write (#581) lands, such transitions render labeled
 *    "attribution pending".
 */
import type { LiveConfig } from '../types';
import { claudeMdMarksApplied, mergedClaudeMdText } from './detectors/shared';
import { RETIRED_SUPPRESSION_MARKER_CATALOG } from './detectors/applied-markers';
import type { AppliedMarkers } from './detectors/types';
import type {
  AdoptionReceipt,
  SurfacedReceipt,
  SuppressedReceipt,
} from './adoption-receipts';

export type AdoptionStatus = 'SURFACED' | 'MARKER-CONFIRMED' | 'SUPPRESSED';

export interface AdoptionScorecardRow {
  /** Stable finding id — the join key, e.g. `reliability.rate-limits`. */
  findingId: string;
  status: AdoptionStatus;
  /** First `SURFACED` receipt in this finding's current lifecycle, when present. */
  surfaced: SurfacedReceipt | null;
  /** Terminal `SUPPRESSED` receipt in the current lifecycle, when present. */
  suppressed: SuppressedReceipt | null;
  /**
   * The matching CLAUDE.md hunk rendered live from `liveConfig`. For a
   * SUPPRESSED finding it is resolved by the suppression record's
   * `markerHeading`; for a SURFACED-only finding it is resolved from the
   * finding's detector markers in the catalog (#1785). `null` when no live
   * section matches (e.g. the user deleted it), the markers are not yet present,
   * no marker catalog was supplied, or the finding is treatment-scoped and its
   * finding-level receipts cannot identify which treatment owns the hunk.
   */
  liveHunk: string | null;
  /**
   * Whole days from the current lifecycle's first surface to its terminal
   * suppression, when both are present. Feeds the median-days-to-adopt metric.
   */
  daysToAdopt: number | null;
  /**
   * True when a suppression transition has no prior surface to attribute it to.
   * Per ADR 0005 these render "attribution pending" until the hook-side
   * surfaced write (#581) lands, and are excluded from the coached count.
   */
  attributionPending: boolean;
}

export interface AdoptionScorecardHeader {
  /** Distinct findings that were ever surfaced. */
  surfacedCount: number;
  /**
   * Distinct findings whose current lifecycle surfaced AND later suppressed
   * (the coached `M`). A lower bound: prose adoptions that miss strict-AND
   * markers undercount.
   */
  adoptedCount: number;
  /** Median whole-days-to-adopt across attributed adoptions, or `null`. */
  medianDaysToAdopt: number | null;
}

export interface AdoptionScorecard {
  header: AdoptionScorecardHeader;
  rows: AdoptionScorecardRow[];
}

/**
 * Finding ids where ONE id spans MULTIPLE distinct treatments whose adoption is
 * per-treatment (#2842). `workflow.shadow-prompt` is the first: it re-fires for a
 * different winning prompt variation once an earlier one is adopted, so its
 * GENERIC CLAUDE.md marker ("## Winning prompt framing") certifies only that
 * SOME treatment was adopted — never that THIS finding is adopted.
 *
 * For these, the SURFACED-only marker-based MARKER-CONFIRMED inference is disabled: a
 * treatment-scoped finding stays SURFACED until the engine's real FIRING→
 * SUPPRESSED transition (the detector stops firing entirely = every qualifying
 * treatment is adopted). This keeps a later, different, still-unadopted treatment
 * from being reported as adopted, and keeps the earlier treatment's hunk from
 * being resolved as the new one's adoption evidence. (The finding still reaches
 * SUPPRESSED via a genuine suppression receipt.)
 */
export const TREATMENT_SCOPED_FINDING_IDS: ReadonlySet<string> = new Set([
  'workflow.shadow-prompt',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isSurfaced(r: AdoptionReceipt): r is SurfacedReceipt {
  return r.kind === 'SURFACED';
}

function isSuppressed(r: AdoptionReceipt): r is SuppressedReceipt {
  return r.kind === 'SUPPRESSED';
}

/** Parse an ISO timestamp to epoch ms, or `null` when unparseable. */
function ts(value: string): number | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Extract the markdown section under the heading whose text matches
 * `markerHeading` from the merged CLAUDE.md text. The receipt stores only the
 * heading text (e.g. `Rate-limit hygiene`); we walk the live text and return
 * the heading line plus its body up to (not including) the next heading of the
 * same or shallower depth. Returns `null` when no heading matches.
 *
 * Matching is case-insensitive on the trimmed heading text and tolerant of the
 * `#` depth, so an author who promoted `### Foo` to `## Foo` still resolves.
 */
const SECTION_HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Extract the markdown section that STARTS at line `startIdx` (a heading of
 * depth `depth`): the heading line plus its body up to (not including) the next
 * heading of the same or shallower depth, trailing blank lines trimmed. Walking
 * by line index — not by heading text — lets callers disambiguate several
 * sections that share one heading string (#1915).
 */
function sectionFrom(lines: string[], startIdx: number, depth: number): string {
  const out: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = SECTION_HEADING_RE.exec(lines[i]);
    if (m && m[1].length <= depth) break;
    out.push(lines[i]);
  }
  while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

export function liveClaudeMdHunk(
  liveConfig: LiveConfig | null | undefined,
  markerHeading: string
): string | null {
  const wanted = markerHeading.trim().toLowerCase();
  if (!wanted) return null;
  const text = mergedClaudeMdText(liveConfig);
  if (!text) return null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_HEADING_RE.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === wanted) {
      return sectionFrom(lines, i, m[1].length);
    }
  }
  return null;
}

/**
 * Resolve the live CLAUDE.md hunk for a finding from its detector's declared
 * markers (#1785). Used for the SURFACED-only MARKER-CONFIRMED path, and preferred over
 * the receipt's stored heading on the SUPPRESSED path (#1915). Returns a hunk
 * ONLY when the strict-AND markers are actually present in the merged CLAUDE.md
 * (a partial/absent fix stays SURFACED) and a heading regex resolves a concrete
 * section to render; `null` otherwise.
 *
 * Disambiguation (#1915): several findings can legitimately share one heading —
 * the settings/hook findings (#1783) all key on `## Claude Coach Adopted
 * Recommendations`, and adopting each appends its own copy of that section. So
 * we don't return the FIRST heading-matching section blindly; we prefer the
 * matching section whose body actually contains this finding's body phrases (its
 * title), and only fall back to the first match when none qualifies. For a
 * unique-heading prose finding exactly one section matches and it contains the
 * phrase, so behaviour is unchanged.
 */
function liveHunkFromMarkers(
  liveConfig: LiveConfig | null | undefined,
  markers: AppliedMarkers | undefined
): string | null {
  if (!markers) return null;
  if (!claudeMdMarksApplied(liveConfig, markers)) return null;
  const text = mergedClaudeMdText(liveConfig);
  const headings = markers.headings ?? [];
  if (!text || headings.length === 0) return null;
  const lines = text.split('\n');
  const phrases = (markers.bodyPhrases ?? []).map((p) => p.toLowerCase());
  let firstMatch: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_HEADING_RE.exec(lines[i]);
    if (!m || !headings.some((re) => re.test(lines[i]))) continue;
    // Extract by line index, so two sections sharing one heading string resolve
    // to different hunks (#1915) rather than both to the first occurrence.
    const hunk = sectionFrom(lines, i, m[1].length);
    if (firstMatch === null) firstMatch = hunk;
    const lower = hunk.toLowerCase();
    if (phrases.length === 0 || phrases.every((p) => lower.includes(p))) {
      return hunk;
    }
  }
  return firstMatch;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Join `SURFACED` + `SUPPRESSED` receipts on finding id and derive the
 * per-finding scorecard rows plus the index header. Events are ordered by
 * timestamp, with receipt-array order breaking equal timestamps. A surface
 * after a terminal suppression starts a new lifecycle; repeated surfaces in an
 * active lifecycle retain its first surface, and its first suppression closes
 * it. The row exposes only that latest lifecycle pair.
 */
export function buildAdoptionScorecard(
  receipts: AdoptionReceipt[],
  liveConfig: LiveConfig | null | undefined,
  /**
   * Finding-id → CLAUDE.md marker signature (#1785). Lets a SURFACED-only
   * finding resolve its live hunk and reach MARKER-CONFIRMED before any suppression
   * receipt exists. Client/route callers MUST pass the client-safe
   * `FINDING_MARKER_CATALOG` from `detectors/applied-markers` — NOT
   * `findingMarkerCatalog()` from the `detectors` barrel, which pulls the whole
   * recs engine into the chunk and trips the bundle-budget gate (#1909).
   * Optional: when omitted (e.g. a build with no catalog wired), surfaced-only
   * findings keep the prior behaviour and stay SURFACED.
   */
  findingMarkers?: ReadonlyMap<string, AppliedMarkers>
): AdoptionScorecard {
  type LifecycleEvent =
    | {
        kind: 'SURFACED';
        receipt: SurfacedReceipt;
        timestamp: number;
        ordinal: number;
      }
    | {
        kind: 'SUPPRESSED';
        receipt: SuppressedReceipt;
        timestamp: number;
        ordinal: number;
      };
  const eventsByFinding = new Map<string, LifecycleEvent[]>();
  const everSurfacedFindingIds = new Set<string>();
  const addEvent = (findingId: string, event: LifecycleEvent): void => {
    const events = eventsByFinding.get(findingId) ?? [];
    events.push(event);
    eventsByFinding.set(findingId, events);
  };
  receipts.forEach((receipt, ordinal) => {
    // The server read path already applies the future-skew trust boundary. The
    // browser must only require a syntactically usable time: comparing trusted
    // receipts with the viewer's clock can discard valid server events.
    const timestamp = ts(receipt.ts);
    if (timestamp === null) return;
    if (isSurfaced(receipt)) {
      for (const findingId of receipt.findingIds) {
        everSurfacedFindingIds.add(findingId);
        addEvent(findingId, { kind: 'SURFACED', receipt, timestamp, ordinal });
      }
    } else if (isSuppressed(receipt)) {
      addEvent(receipt.findingId, {
        kind: 'SUPPRESSED',
        receipt,
        timestamp,
        ordinal,
      });
    }
  });

  const rows: AdoptionScorecardRow[] = [];
  const adoptDays: number[] = [];

  for (const [findingId, unorderedEvents] of eventsByFinding) {
    const events = [...unorderedEvents].sort(
      (a, b) => a.timestamp - b.timestamp || a.ordinal - b.ordinal
    );
    let surfaced: SurfacedReceipt | null = null;
    let suppressed: SuppressedReceipt | null = null;
    for (const event of events) {
      if (event.kind === 'SURFACED') {
        if (surfaced === null || suppressed !== null) {
          surfaced = event.receipt;
          suppressed = null;
        }
      } else if (suppressed === null) {
        suppressed = event.receipt;
      }
    }
    const attributionPending = suppressed !== null && surfaced === null;

    // Treatment scoping affects only generic marker-based MARKER-CONFIRMED inference.
    // Lifecycle recency itself is universal: any newer surface reopens a closed
    // finding id, while per-treatment rows remain the follow-up in #2850.
    const isTreatmentScoped = TREATMENT_SCOPED_FINDING_IDS.has(findingId);

    let liveHunk: string | null = null;
    if (suppressed && !isTreatmentScoped) {
      // Prefer marker-based resolution (#1915): the stored `markerHeading` can
      // be shared by several findings. A retired suppression-only signature
      // keeps historical receipts disambiguated without making a new SURFACED
      // finding look adopted (#2642). When a signature is known but absent live,
      // return null rather than falling back to the first same-heading section.
      const markers =
        findingMarkers?.get(findingId) ??
        RETIRED_SUPPRESSION_MARKER_CATALOG.get(findingId);
      liveHunk = markers
        ? liveHunkFromMarkers(liveConfig, markers)
        : liveClaudeMdHunk(liveConfig, suppressed.markerHeading);
    } else if (surfaced && !isTreatmentScoped) {
      // SURFACED-only: no stored markerHeading, so resolve the finding's markers
      // from the live detector catalog and read the hunk live (#1785). A
      // non-null hunk means the fix's markers landed in CLAUDE.md before any
      // suppression receipt — "fix landed, awaiting quiet" → MARKER-CONFIRMED below.
      //
      // Skipped for a TREATMENT-SCOPED finding (#2842): its generic marker can be
      // present because a DIFFERENT treatment was adopted, so config-state marker
      // presence must NOT mark it MARKER-CONFIRMED here — it stays SURFACED until a genuine
      // FIRING→SUPPRESSED transition (every treatment adopted) is recorded.
      liveHunk = liveHunkFromMarkers(liveConfig, findingMarkers?.get(findingId));
    }

    let daysToAdopt: number | null = null;
    if (surfaced && suppressed) {
      const a = ts(surfaced.ts);
      const b = ts(suppressed.ts);
      if (a !== null && b !== null && b >= a) {
        daysToAdopt = Math.round((b - a) / MS_PER_DAY);
        adoptDays.push(daysToAdopt);
      }
    }

    let status: AdoptionStatus;
    if (suppressed) {
      status = 'SUPPRESSED';
    } else if (liveHunk !== null) {
      // Surfaced and the marker section is present live, but no suppression
      // record has been emitted yet — the fix has landed but the engine hasn't
      // confirmed it quiet. Treat as MARKER-CONFIRMED (config-state evidence).
      status = 'MARKER-CONFIRMED';
    } else {
      status = 'SURFACED';
    }

    rows.push({
      findingId,
      status,
      surfaced,
      suppressed,
      liveHunk,
      daysToAdopt,
      attributionPending,
    });
  }

  // Stable sort: SUPPRESSED, then MARKER-CONFIRMED, then SURFACED; ties by finding id.
  const statusRank: Record<AdoptionStatus, number> = {
    SUPPRESSED: 0,
    'MARKER-CONFIRMED': 1,
    SURFACED: 2,
  };
  rows.sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      a.findingId.localeCompare(b.findingId)
  );

  // M = distinct findings currently in the attributed adopted (SUPPRESSED) state
  // with a prior surface. Status-aware so a treatment-scoped finding that has
  // re-fired (now SURFACED again, #2842) is not double-counted as adopted, and
  // attribution-pending suppressions (no prior surface) are excluded.
  const adoptedCount = rows.filter(
    (r) => r.status === 'SUPPRESSED' && r.surfaced !== null
  ).length;

  return {
    header: {
      surfacedCount: everSurfacedFindingIds.size,
      adoptedCount,
      medianDaysToAdopt: median(adoptDays),
    },
    rows,
  };
}
