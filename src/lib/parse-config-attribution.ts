/**
 * Config-attribution wedge (#892, epic #871 repo-map substrate).
 *
 * Every markdown config rule's impact is *asserted* but never *measured*. The
 * config says "use `npx vite build`, not `npm run build`" or "read REFERENCES.md
 * before the parsers" — but nothing connects "the config says X" to "sessions
 * actually did X". This module is the machine-checkable bridge: it maps a
 * {@link ConfigSection} (from the #888 explosion slice) to an **observable
 * behaviour signature** evaluated over the session signals the dashboard already
 * computes (`toolData` Bash commands + native Read/Grep/Glob calls), and reports
 * each section as **attributable**, **unattributable**, or **unfalsifiable**.
 *
 * Three signature classes are implemented (the grooming scope of #892):
 *  1. `build-command`  — a prescribed vs forbidden command in Bash `toolData`
 *                        (e.g. `npx vite build` prescribed, `npm run build`
 *                        forbidden).
 *  2. `native-tool`    — native `Read`/`Grep`/`Glob` vs Bash `cat`/`grep`/`find`,
 *                        scored from {@link nativeToolBypass}.
 *  3. `key-file-pin`   — a pinned key file (e.g. `REFERENCES.md`) read BEFORE the
 *                        files it governs (`src/lib/parse-*.ts`) in a session.
 *
 * ### Privacy / slice boundary
 * #888 deliberately does NOT persist section bodies — only the heading, a
 * structural hash, and typed references survive. So a signature CANNOT read the
 * prose "use npx vite build" out of a section. Instead the framework is split:
 *  - a generic **evaluator** (match a section → run a signature → classify), and
 *  - a small declarative **catalog** ({@link DEFAULT_SIGNATURES}) that encodes the
 *    specific prescribed/forbidden patterns and pin/governed file globs. New
 *    rules are catalog rows, not framework changes.
 * A section is matched to a signature by its scope / heading / references — the
 * privacy-safe fields #888 does keep.
 *
 * ### Evidence honesty (epic non-goal / #726)
 * Compliance here is **correlational** — "X% of build commands used the
 * prescribed form". That is NOT a causal savings claim. Every report is labelled
 * with the established {@link SavingsAttributionTier} vocabulary so #894 can
 * promote it and #726 can later upgrade it:
 *  - `tier-0-estimate`     = heuristic / correlational (the only tier emitted here),
 *  - `tier-1-before-after` = natural experiment (reserved for #726),
 *  - `tier-2-ablation`     = controlled ablation (reserved for #726).
 * No report ever carries a realized/causal savings figure — only a compliance
 * rate over observed events. Sections with no observable signature are reported
 * `unfalsifiable` rather than silently dropped, so the gap is visible.
 *
 * Pure by design (matches the repo's `parse-*.ts` convention): no I/O, tolerant
 * of any input. The join slice (#889) owns wiring the `repoMap` dataset key; the
 * recs-engine promotion (#894) owns surfacing these as first-class
 * recommendations. This slice owns only the signature framework + classification.
 */

import type { ConfigReferenceKind, ConfigSection } from './parse-config-sections';
import { nativeToolBypass, type ToolUsageData } from './parse-tools';
import type { SavingsAttributionTier } from './detectors/types';

// ── Public taxonomy ──────────────────────────────────────────────────────────

/** The three config-section behaviour classes #892 implements. */
export type AttributionClass = 'build-command' | 'native-tool' | 'key-file-pin';

/**
 * How well a config section's effect can be attributed from telemetry:
 *  - `attributable`   — a signature matched AND the corpus has events bearing on
 *                       compliance, so a compliance rate is reportable.
 *  - `unattributable` — a signature matched and is testable in principle, but the
 *                       corpus shows no relevant events (nothing to measure yet).
 *  - `unfalsifiable`  — no signature class matches the section: the rule governs
 *                       behaviour the current telemetry cannot observe at all.
 */
export type Attributability = 'attributable' | 'unattributable' | 'unfalsifiable';

/**
 * Evidence strength, reusing the established {@link SavingsAttributionTier}
 * vocabulary (#726 contract) rather than a parallel synonym. This slice only
 * ever emits `tier-0-estimate` (heuristic/correlational); the stronger tiers are
 * reserved for the before/after (#726) and ablation work.
 */
export type EvidenceTier = SavingsAttributionTier;

/** The observed compliance measure for an attributable signature. */
export interface AttributionObservation {
  /** Events consistent with the rule (prescribed command, native tool, pin-first). */
  compliant: number;
  /** Events violating the rule (forbidden command, Bash bypass, governed-without-pin). */
  violating: number;
  /**
   * `compliant / (compliant + violating)` in `[0, 1]`, or `null` when the
   * denominator is 0 (which is the `unattributable` case — no observation).
   */
  complianceRate: number | null;
  /** Distinct sessions that contributed at least one relevant event. */
  sessions: number;
}

/** One config section's attribution report. */
export interface ConfigAttribution {
  /** The {@link ConfigSection.id} being attributed. */
  sectionId: string;
  sourceScope: string;
  heading: string;
  /** The matched signature's id, or `null` when unfalsifiable. */
  signatureId: string | null;
  /** The matched behaviour class, or `null` when unfalsifiable. */
  signatureClass: AttributionClass | null;
  /** Human-readable description of the signature (or why none applied). */
  signature: string;
  attributability: Attributability;
  /** Evidence strength — always `tier-0-estimate` (heuristic) in this slice. */
  evidence: EvidenceTier;
  /** The compliance measure, or `null` for unattributable / unfalsifiable. */
  observation: AttributionObservation | null;
  /** One-line note explaining the classification. */
  note: string;
}

export interface ConfigAttributionSummary {
  reports: ConfigAttribution[];
  attributable: number;
  unattributable: number;
  unfalsifiable: number;
}

/** Inputs the signatures evaluate against — existing dashboard session signals. */
export interface AttributionInputs {
  /** Per-session tool calls (see {@link ToolUsageData}). */
  toolData: ToolUsageData[];
}

// ── Signature catalog (declarative; privacy-safe section matching) ────────────

interface SectionMatch {
  /** Section governs one of these scopes (regex over `sourceScope`). */
  scope?: RegExp;
  /** Section heading matches (regex over `heading`). */
  heading?: RegExp;
  /** Section carries a reference of this kind whose target matches. */
  reference?: { kind: ConfigReferenceKind; target: RegExp };
}

interface BuildCommandParams {
  class: 'build-command';
  /** Command form the config prescribes (matched against Bash `command`). */
  prescribed: RegExp;
  /** Command form the config forbids. */
  forbidden: RegExp;
}

interface NativeToolParams {
  class: 'native-tool';
}

interface KeyFilePinParams {
  class: 'key-file-pin';
  /** The key file that should be read first (regex over `file_path`). */
  pin: RegExp;
  /** The files it governs (regex over `file_path`). */
  governed: RegExp;
}

type SignatureParams = BuildCommandParams | NativeToolParams | KeyFilePinParams;

/** A declarative attribution signature: which sections it covers + how to score. */
export interface AttributionSignature {
  /** Stable signature id (also the `signatureId` on the report). */
  id: string;
  /** Human-readable description for the report + UI. */
  describe: string;
  /** Which config sections this signature applies to (ALL listed fields must match). */
  match: SectionMatch;
  params: SignatureParams;
}

/**
 * The built-in catalog for this repo. Each row encodes a real documented rule
 * from `AGENTS.md`/`CLAUDE.md`. The prescribed/forbidden/pin/governed patterns
 * live here (not in the section, whose body #888 dropped) so the framework stays
 * generic. Order matters: the first matching signature wins per section.
 */
export const DEFAULT_SIGNATURES: AttributionSignature[] = [
  {
    id: 'build-command/vite-not-tsc',
    describe:
      'Build with `npx vite build`, not `npm run build` (which runs `tsc -b` and trips on pre-existing type errors).',
    match: { scope: /AGENTS\.md|CLAUDE\.md/i, heading: /build|deploy/i },
    params: {
      class: 'build-command',
      // `npx vite build` (or `vite build`) is prescribed.
      prescribed: /\b(?:npx\s+)?vite\s+build\b/,
      // `npm run build` / a bare `tsc -b` build is forbidden.
      forbidden: /\bnpm\s+run\s+build\b|\btsc\s+-b\b/,
    },
  },
  {
    id: 'native-tool/prefer-native',
    describe:
      'Prefer native Read/Grep/Glob over Bash cat/grep/find — cheaper and permission-integrated.',
    match: { heading: /native tool|prefer.*(read|grep|glob)|bash command|dedicated tool/i },
    params: { class: 'native-tool' },
  },
  {
    id: 'key-file-pin/references-before-parsers',
    describe:
      'Read REFERENCES.md (the artifact→parser map) before reverse-engineering a `parse-*.ts`.',
    match: {
      reference: { kind: 'file', target: /REFERENCES\.md/i },
    },
    params: {
      class: 'key-file-pin',
      pin: /REFERENCES\.md/i,
      governed: /(?:^|\/)(?:src\/lib\/)?parse-[\w-]+\.ts$/,
    },
  },
];

// ── Section ↔ signature matching ──────────────────────────────────────────────

function sectionMatches(section: ConfigSection, m: SectionMatch): boolean {
  if (m.scope && !m.scope.test(section.sourceScope)) return false;
  if (m.heading && !m.heading.test(section.heading)) return false;
  if (m.reference) {
    const hit = section.references.some(
      (r) => r.kind === m.reference!.kind && m.reference!.target.test(r.target),
    );
    if (!hit) return false;
  }
  return true;
}

function findSignature(
  section: ConfigSection,
  signatures: AttributionSignature[],
): AttributionSignature | null {
  return signatures.find((s) => sectionMatches(section, s.match)) ?? null;
}

// ── Signal helpers ────────────────────────────────────────────────────────────

/** Pull the Bash `command` string out of a call, or null if not a Bash call. */
function bashCommand(call: ToolUsageData['calls'][number]): string | null {
  if (call.toolName !== 'Bash') return null;
  const cmd = call.input.command;
  if (typeof cmd === 'string' && cmd.length > 0) return cmd;
  return typeof call.commandPreview === 'string' && call.commandPreview.length > 0
    ? call.commandPreview
    : null;
}

// ── Per-class evaluators ──────────────────────────────────────────────────────

function evaluateBuildCommand(
  params: BuildCommandParams,
  inputs: AttributionInputs,
): AttributionObservation {
  let compliant = 0;
  let violating = 0;
  const sessions = new Set<string>();
  for (const session of inputs.toolData) {
    let hit = false;
    for (const call of session.calls) {
      const cmd = bashCommand(call);
      if (cmd === null) continue;
      if (params.prescribed.test(cmd)) {
        compliant += 1;
        hit = true;
      }
      if (params.forbidden.test(cmd)) {
        violating += 1;
        hit = true;
      }
    }
    if (hit) sessions.add(session.sessionId);
  }
  return finishObservation(compliant, violating, sessions.size);
}

function evaluateNativeTool(inputs: AttributionInputs): AttributionObservation {
  // Global compliant/violating from the canonical bypass detector.
  const global = nativeToolBypass(inputs.toolData);
  const compliant = global.grepRatio.native + global.findRatio.native;
  const catCount =
    global.categories.find((c) => c.category === 'cat')?.count ?? 0;
  const violating = global.grepRatio.bash + global.findRatio.bash + catCount;

  // Per-session contribution count (a session counts if it has any native
  // Grep/Glob or any grep/find/cat bypass).
  let sessions = 0;
  for (const session of inputs.toolData) {
    const s = nativeToolBypass([session]);
    const sCat = s.categories.find((c) => c.category === 'cat')?.count ?? 0;
    const relevant =
      s.grepRatio.native +
      s.findRatio.native +
      s.grepRatio.bash +
      s.findRatio.bash +
      sCat;
    if (relevant > 0) sessions += 1;
  }
  return finishObservation(compliant, violating, sessions);
}

function evaluateKeyFilePin(
  params: KeyFilePinParams,
  inputs: AttributionInputs,
): AttributionObservation {
  let compliant = 0;
  let violating = 0;
  const sessions = new Set<string>();

  for (const session of inputs.toolData) {
    // Collect timestamped Read events for pin + governed files.
    let earliestPin: string | null = null;
    let earliestGoverned: string | null = null;
    for (const call of session.calls) {
      if (call.toolName !== 'Read') continue;
      const fp = call.input.file_path;
      const ts = call.timestamp;
      if (typeof fp !== 'string' || !fp || !ts) continue;
      if (params.pin.test(fp)) {
        if (earliestPin === null || ts < earliestPin) earliestPin = ts;
      } else if (params.governed.test(fp)) {
        if (earliestGoverned === null || ts < earliestGoverned) {
          earliestGoverned = ts;
        }
      }
    }
    // Only sessions that actually touched a governed file can be scored.
    if (earliestGoverned === null) continue;
    sessions.add(session.sessionId);
    if (earliestPin !== null && earliestPin < earliestGoverned) {
      compliant += 1; // pin read before the first governed read
    } else {
      violating += 1; // governed read with no prior pin read
    }
  }
  return finishObservation(compliant, violating, sessions.size);
}

function finishObservation(
  compliant: number,
  violating: number,
  sessions: number,
): AttributionObservation {
  const total = compliant + violating;
  return {
    compliant,
    violating,
    complianceRate: total === 0 ? null : compliant / total,
    sessions,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attribute each config section to a behaviour signature and classify it.
 *
 * @param sections   Section records from {@link parseConfigSet} (#888).
 * @param inputs     Existing session signals to evaluate against.
 * @param signatures Signature catalog; defaults to {@link DEFAULT_SIGNATURES}.
 */
export function attributeConfigSections(
  sections: ConfigSection[],
  inputs: AttributionInputs,
  signatures: AttributionSignature[] = DEFAULT_SIGNATURES,
): ConfigAttribution[] {
  // Tolerant of partial input, matching the repo's pure parse-* convention.
  const safeInputs: AttributionInputs = { toolData: inputs?.toolData ?? [] };
  return (sections ?? []).map((section) => {
    const sig = findSignature(section, signatures);

    if (!sig) {
      return {
        sectionId: section.id,
        sourceScope: section.sourceScope,
        heading: section.heading,
        signatureId: null,
        signatureClass: null,
        signature: 'No observable behaviour signature for this section.',
        attributability: 'unfalsifiable',
        evidence: 'tier-0-estimate',
        observation: null,
        note: 'Unfalsifiable: the current telemetry cannot observe this rule.',
      };
    }

    let observation: AttributionObservation;
    switch (sig.params.class) {
      case 'build-command':
        observation = evaluateBuildCommand(sig.params, safeInputs);
        break;
      case 'native-tool':
        observation = evaluateNativeTool(safeInputs);
        break;
      case 'key-file-pin':
        observation = evaluateKeyFilePin(sig.params, safeInputs);
        break;
    }

    const hasEvents = observation.complianceRate !== null;
    return {
      sectionId: section.id,
      sourceScope: section.sourceScope,
      heading: section.heading,
      signatureId: sig.id,
      signatureClass: sig.params.class,
      signature: sig.describe,
      attributability: hasEvents ? 'attributable' : 'unattributable',
      // Correlational only — never a causal/realized savings claim (#726).
      evidence: 'tier-0-estimate',
      observation: hasEvents ? observation : null,
      note: hasEvents
        ? `Attributable (heuristic): ${observation.compliant}/${
            observation.compliant + observation.violating
          } compliant events across ${observation.sessions} session(s).`
        : 'Unattributable: signature is testable but no relevant events were observed.',
    };
  });
}

/** Roll the per-section reports up into a headline count by attributability. */
export function summarizeConfigAttribution(
  reports: ConfigAttribution[],
): ConfigAttributionSummary {
  let attributable = 0;
  let unattributable = 0;
  let unfalsifiable = 0;
  for (const r of reports) {
    if (r.attributability === 'attributable') attributable += 1;
    else if (r.attributability === 'unattributable') unattributable += 1;
    else unfalsifiable += 1;
  }
  return { reports, attributable, unattributable, unfalsifiable };
}
