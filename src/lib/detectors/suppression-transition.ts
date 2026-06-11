/**
 * Engine-loop suppression-transition emit (#576, epic #573).
 *
 * ADR 0005 ("Emit once in the engine run loop, not in 12 detectors") makes the
 * `claudeMdMarksApplied()` FIRING→SUPPRESSED transition the primary adoption
 * signal. `claudeMdMarksApplied` is a pure boolean with no chokepoint, so rather
 * than route all 12 marker-gated detectors' `return null` through a shared
 * emitter, we compute the transition ONCE here, over the detector catalog, by
 * diffing two pure engine runs:
 *
 *   - the real run (current `liveConfig`), and
 *   - a counterfactual run with the merged CLAUDE.md text blanked.
 *
 * A finding that is null in the real run but fires in the blanked run is being
 * suppressed *by its CLAUDE.md markers* — exactly the `claudeMdMarksApplied`
 * gate, observed only through the public `Detector.rule` contract (no 12-file
 * sweep, no private-constant export).
 *
 * Join key = finding id. We emit exactly one `SUPPRESSED` receipt the FIRST time
 * a previously-*surfaced* (hook-stamped) finding flips to marker-suppressed:
 *
 *   - Requires a prior `SURFACED` receipt for the finding id. A suppression with
 *     no prior surface is "organic / not attributed" — reported separately and
 *     excluded from the coached count (ADR 0005).
 *   - Idempotent: a finding that already has a prior `SUPPRESSED` receipt emits
 *     nothing on re-run.
 *
 * This module computes the records; it does NOT write them. The server route
 * (#575's allowlist-drop, killswitch-aware `appendAdoptionReceipt`) persists
 * each returned record. Keeping the transition pure preserves the engine's
 * no-I/O contract and makes "fires once / idempotent / organic excluded"
 * unit-testable without a filesystem.
 */
import type { Detector } from './types';
import type { Recommendation, RecommendationInput } from './types';
import type { LiveConfig } from '../../types';
import { mergedClaudeMdText } from './shared';

/** A `SUPPRESSED` receipt body, ready for #575's writer. Matches the allowlist
 *  in `src/lib/adoption-receipts.ts` (`SuppressedReceipt`, minus `ts`, which the
 *  writer stamps). */
export interface SuppressionTransition {
  kind: 'SUPPRESSED';
  /** Finding id that flipped FIRING→SUPPRESSED (the engine join key). */
  findingId: string;
  /** The CLAUDE.md heading the fix's markers matched against (allowlisted). */
  markerHeading: string;
  /** `sha256:<hex>` digest of the merged CLAUDE.md prose — never the raw body. */
  contentFingerprint: string;
}

/** A marker-suppression with NO prior `SURFACED` receipt. Labeled, not hidden:
 *  reported so the card can show "organic / not attributed", but excluded from
 *  the coached (surfaced→suppressed) count. */
export interface OrganicSuppression {
  findingId: string;
}

export interface SuppressionTransitionResult {
  /** New `SUPPRESSED` receipts to write — one per finding's FIRST attributed flip. */
  transitions: SuppressionTransition[];
  /** Marker-suppressed findings with no prior surface (excluded from the count). */
  organic: OrganicSuppression[];
}

/** Prior adoption receipts the transition diff needs, narrowed to the two
 *  fields it reads. Callers pass the parsed receipt log (server-side); the
 *  fields mirror `SurfacedReceipt`/`SuppressedReceipt` in adoption-receipts.ts. */
export interface PriorReceipts {
  /** Finding ids that have at least one prior hook-stamped `SURFACED` entry. */
  surfacedFindingIds: Iterable<string>;
  /** Finding ids that already have a prior `SUPPRESSED` entry (idempotency). */
  suppressedFindingIds: Iterable<string>;
}

/**
 * A shallow copy of `input` with the merged CLAUDE.md text blanked, so no
 * `claudeMdMarksApplied` marker can match. Only `liveConfig.claudeMd` is
 * rewritten; every other field is shared by reference (the detectors are pure
 * and never mutate their input, and the WeakMap memo keys on identity, which a
 * fresh object intentionally bypasses for this counterfactual run).
 */
function withClaudeMdBlanked(input: RecommendationInput): RecommendationInput {
  const live = input.liveConfig;
  if (!live) return input;
  const blanked: LiveConfig = {
    ...live,
    claudeMd: { global: null, perProject: {} },
  };
  return { ...input, liveConfig: blanked };
}

/**
 * Cheap, dependency-free sha-256 → `sha256:<hex>`. We persist only this digest
 * of the merged CLAUDE.md prose, never the raw body (ADR 0005 allowlist). Uses
 * the platform `crypto.subtle` when present (browser + Node ≥ 16) and falls
 * back to a stable non-cryptographic digest in the rare environment without it,
 * so the field is always populated and the writer's length bound is respected.
 */
async function fingerprintText(text: string): Promise<string> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await g.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  }
  // Deterministic fallback (FNV-1a 32-bit) when WebCrypto is unavailable.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

/**
 * The CLAUDE.md heading the fix's markers matched against. Returns the first
 * heading line in the merged text that matches one of the fix's heading regexes;
 * falls back to the fix label (then the rule title) so the field is always a
 * meaningful, allowlist-safe string and never a raw prose paragraph.
 */
function resolveMarkerHeading(rec: Recommendation, mergedText: string): string {
  const headings = rec.fix?.appliedMarkers?.headings ?? [];
  if (headings.length > 0 && mergedText) {
    const headingLines = mergedText
      .split('\n')
      .filter((line) => /^#{1,6}\s+/.test(line));
    for (const line of headingLines) {
      if (headings.some((re) => re.test(line))) {
        // Strip the leading `#`s + whitespace to store the heading text only.
        return line.replace(/^#{1,6}\s+/, '').trim();
      }
    }
  }
  return rec.fix?.label ?? rec.title;
}

/**
 * Compute the FIRING→SUPPRESSED transitions for one engine run.
 *
 * `detectors` defaults to the full catalog; tests inject a small subset. The
 * function is pure: it runs each detector's `rule` twice (real + CLAUDE.md-
 * blanked) and never touches the filesystem. The async signature is only for
 * the WebCrypto fingerprint.
 */
export async function computeSuppressionTransitions(
  input: RecommendationInput,
  prior: PriorReceipts,
  detectors: Detector[],
  now: number = Date.now()
): Promise<SuppressionTransitionResult> {
  const surfaced = new Set(prior.surfacedFindingIds);
  const alreadySuppressed = new Set(prior.suppressedFindingIds);
  const blankedInput = withClaudeMdBlanked(input);
  const mergedText = mergedClaudeMdText(input.liveConfig);

  const transitions: SuppressionTransition[] = [];
  const organic: OrganicSuppression[] = [];

  for (const d of detectors) {
    // A finding can only flip via markers if blanking CLAUDE.md re-fires it.
    const real = d.rule(input, now);
    if (real) continue; // still firing — not suppressed.
    const blanked = d.rule(blankedInput, now);
    if (!blanked) continue; // null with markers AND without — not a marker flip.
    // `blanked` fired but `real` is null ⇒ suppressed by CLAUDE.md markers.
    const findingId = blanked.id;
    if (alreadySuppressed.has(findingId)) continue; // already emitted — idempotent.
    if (!surfaced.has(findingId)) {
      // Marker-suppressed but never hook-surfaced ⇒ organic / not attributed.
      organic.push({ findingId });
      continue;
    }
    transitions.push({
      kind: 'SUPPRESSED',
      findingId,
      markerHeading: resolveMarkerHeading(blanked, mergedText),
      contentFingerprint: await fingerprintText(mergedText),
    });
  }

  return { transitions, organic };
}
