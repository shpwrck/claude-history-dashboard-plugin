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
 * gate, observed only through the public detector emission contract (`emitAll`
 * when present, otherwise `rule`; no 12-file sweep or private-constant export).
 *
 * Join key = finding id. We emit one `SUPPRESSED` receipt when a currently
 * surfaced (hook-stamped) lifecycle flips to marker-suppressed:
 *
 *   - Requires a prior `SURFACED` receipt for the finding id. A suppression with
 *     no prior surface is "organic / not attributed" — reported separately and
 *     excluded from the coached count (ADR 0005).
 *   - Idempotent while terminal: a finding whose latest lifecycle event is
 *     already `SUPPRESSED` emits nothing. A newer `SURFACED` receipt reopens it
 *     and makes the next real transition eligible again.
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
  /** New `SUPPRESSED` receipts to write — one per currently eligible lifecycle. */
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
  /** Finding ids whose latest lifecycle event is `SUPPRESSED` (idempotency). */
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
 * function is pure: it runs each detector's public emission path twice (real +
 * CLAUDE.md-blanked) and never touches the filesystem. The async signature is
 * only for the WebCrypto fingerprint.
 */
export async function computeSuppressionTransitions(
  input: RecommendationInput,
  prior: PriorReceipts,
  detectors: Detector[],
  now: number = Date.now()
): Promise<SuppressionTransitionResult> {
  const surfaced = new Set(prior.surfacedFindingIds);
  const currentlySuppressed = new Set(prior.suppressedFindingIds);
  const blankedInput = withClaudeMdBlanked(input);
  const mergedText = mergedClaudeMdText(input.liveConfig);

  const transitions: SuppressionTransition[] = [];
  const organic: OrganicSuppression[] = [];

  for (const d of detectors) {
    const emitted = (runInput: RecommendationInput): Recommendation[] => {
      if (d.emitAll) return d.emitAll(runInput, now);
      const rec = d.rule(runInput, now);
      return rec ? [rec] : [];
    };
    const realIds = new Set(emitted(input).map((rec) => rec.id));
    const seenBlankedIds = new Set<string>();

    // A finding can only flip via markers if blanking CLAUDE.md re-fires that
    // same finding id. Compare every emitted id independently so an unrelated
    // companion finding cannot mask the transition in a multi-emit detector.
    for (const blanked of emitted(blankedInput)) {
      const findingId = blanked.id;
      if (seenBlankedIds.has(findingId)) continue;
      seenBlankedIds.add(findingId);
      if (realIds.has(findingId)) continue;
      if (currentlySuppressed.has(findingId)) continue;
      if (!surfaced.has(findingId)) {
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
  }

  return { transitions, organic };
}
