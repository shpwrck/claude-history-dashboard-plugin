import { componentSubtree, ruleTopicSlug } from '../../config-rule-naming';
import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import { adherenceClean } from '../../parse-shadow-calls';
import type { AxisAggregate } from '../../parse-shadow-calls';
import { clearsShadowWinThresholds } from '../workflow/shadow-axis-wins';
import type { Detector, Recommendation } from '../types';

const DETECTOR_ID = 'context.over-scoped-config-section';
const MAX_EVIDENCE_FILES = 5;
const CONFIG_SCOPING_AXIS = 'config-scoping';

interface Candidate {
  project: RepoMapProjectJoin;
  section: ConfigSection;
  files: RepoMapFileJoin[];
  subtree: string;
  pathsGlob: string;
  rulePath: string;
  idSuffix: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function stripLeadingDot(path: string): string {
  return path.replace(/^\.\//, '');
}

function toRepoRelative(path: string, root: string): string {
  const normalized = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return stripLeadingDot(normalized.slice(normalizedRoot.length + 1));
  }
  return stripLeadingDot(normalized);
}

function isRootConfigSection(section: ConfigSection, projectRoot: string): boolean {
  const scope = toRepoRelative(section.sourceScope, projectRoot);
  return scope === 'AGENTS.md' || scope === 'CLAUDE.md';
}

// Rule-file naming (topic slug, component subtree) is shared with the atomizer
// codemod via ../../config-rule-naming so the prescribed rulePath and the file
// the codemod writes can never diverge (#1427).

function governedFiles(
  project: RepoMapProjectJoin,
  section: ConfigSection
): RepoMapFileJoin[] {
  return project.files.filter((file) => file.configSections.includes(section.id));
}

function overScopedCandidates(input: Parameters<Detector['rule']>[0]): Candidate[] {
  const repoMap = input.repoMap;
  if (!repoMap || repoMap.projects.length === 0) return [];

  const out: Candidate[] = [];
  for (const project of repoMap.projects) {
    for (const section of project.configSections) {
      if (section.level === 0 || section.heading.trim().length === 0) continue;
      if (!isRootConfigSection(section, project.root)) continue;

      const files = governedFiles(project, section);
      if (files.length === 0) continue;

      const subtrees = new Set<string>();
      for (const file of files) {
        const subtree = componentSubtree(file.path);
        if (!subtree) {
          subtrees.add('');
          continue;
        }
        subtrees.add(subtree);
      }
      if (subtrees.size !== 1 || subtrees.has('')) continue;

      const subtree = [...subtrees][0];
      const pathsGlob = `${subtree}/**`;
      const topic = ruleTopicSlug(section.heading);
      out.push({
        project,
        section,
        files,
        subtree,
        pathsGlob,
        rulePath: `.claude/rules/${topic}.md`,
        idSuffix: ruleTopicSlug(`${project.root}-${section.id}`),
      });
    }
  }

  return out.sort(
    (a, b) =>
      a.project.root.localeCompare(b.project.root) ||
      a.section.sourceScope.localeCompare(b.section.sourceScope) ||
      a.section.heading.localeCompare(b.section.heading)
  );
}

/**
 * The asymmetric graduation gate (#1270, epic #1264). The S1 rec graduates from advisory
 * to recommended ONLY when the `config-scoping` shadow axis (#1269) BOTH clears the
 * standard shadow-axis-wins evidence bar (≥5 samples, ≥3 decided, ≥60% win-rate) AND
 * certifies ZERO adherence regression with full coverage. The gate is asymmetric on
 * purpose: a cost/speed win that silently dropped even one rule must NOT graduate, and
 * absent/partial adherence data fails closed.
 */
function configScopingProof(
  input: Parameters<Detector['rule']>[0]
): AxisAggregate | null {
  const axis = input.shadowCalls?.byAxis.find((a) => a.axis === CONFIG_SCOPING_AXIS);
  if (!axis) return null;
  if (!clearsShadowWinThresholds(axis)) return null; // below the evidence bar -> advisory
  if (adherenceClean(axis) !== true) return null; // any/unknown regression -> advisory (hard gate)
  return axis;
}

function toRecommendation(
  candidate: Candidate,
  id: string,
  proof: AxisAggregate | null
): Recommendation {
  const { section, files, subtree, pathsGlob, rulePath, idSuffix } = candidate;
  const heading = section.heading;
  const evidenceFiles = files
    .slice(0, MAX_EVIDENCE_FILES)
    .map((file) => file.path)
    .join(', ');
  const proofDecided = proof ? proof.shadowWins + proof.mainWins : 0;

  return {
    id,
    category: 'context',
    severity: proof ? 'warning' : 'info',
    title: `Move "${heading}" into a ${subtree} rule`,
    detail:
      `Root ${section.sourceScope} section "${heading}" governs ${files.length} repo-map ` +
      `file(s), all under ${subtree}. Keeping it in always-loaded root config makes ` +
      'every session pay for guidance scoped to one component subtree.' +
      (proof
        ? ` Shadow experiments on the "${CONFIG_SCOPING_AXIS}" axis PROVED the atomized ` +
          `variation: it won ${proof.shadowWins}/${proofDecided} decided comparisons over ` +
          `${proof.samples} sample(s) with zero adherence regressions, so this is now a ` +
          'measured recommendation, not an estimate.'
        : ''),
    action:
      `Move this section into ${rulePath} with \`paths: ["${pathsGlob}"]\`, then remove ` +
      `the always-loaded root copy from ${section.sourceScope}.`,
    affected: files.length,
    view: 'context',
    evidence: [
      `${section.id} -> ${subtree}: ${evidenceFiles}${files.length > MAX_EVIDENCE_FILES ? ', ...' : ''}`,
      ...(proof
        ? [
            `${CONFIG_SCOPING_AXIS} axis: shadow ${proof.shadowWins} / main ${proof.mainWins} / ` +
              `tie ${proof.ties} over ${proof.samples} (${proof.live} live + ${proof.replay} replay); ` +
              `adherence regressions: 0 across ${proof.adherenceRegressionCount}/${proof.samples} judged`,
          ]
        : []),
    ],
    savingsAttribution: {
      interventionKey: `${DETECTOR_ID}:${idSuffix}`,
      signatureId: 'repo-map-config-section-single-subtree',
      tier: proof ? 'tier-1-before-after' : 'tier-0-estimate',
      confidence: proof ? 'high' : 'medium',
    },
    fix: {
      target: 'CLAUDE.md',
      fixKind: 'illustrative',
      label: 'Scaffold path-scoped rule',
      note:
        `Move the existing ${section.sourceScope} section body into ${rulePath}, then ` +
        'delete the root copy so it loads only for matching paths.',
      snippet: `## Split "${heading}" into a path-scoped rule

Create \`${rulePath}\`:

\`\`\`markdown
---
paths: ["${pathsGlob}"]
---
# ${heading}

[move the existing ${section.sourceScope} section body here]
\`\`\`

Then remove the always-loaded root section from \`${section.sourceScope}\`.`,
    },
    provenance: {
      observations: [
        {
          claim: `Root config section ${section.id} governs ${files.length} repo-map file(s)`,
          source: 'repoMap',
          field: 'projects[].files[].configSections',
          value: files.length,
        },
        {
          claim: `All governed files sit under ${subtree}`,
          source: 'repoMap',
          field: 'projects[].files[].path',
          value: subtree,
        },
        ...(proof
          ? [
              {
                claim:
                  `The "${CONFIG_SCOPING_AXIS}" shadow axis won ${proof.shadowWins} of ` +
                  `${proofDecided} decided comparisons with zero adherence regressions ` +
                  `across all ${proof.samples} sample(s)`,
                source: 'shadowCalls',
                field: 'byAxis[config-scoping]',
                value: proof.shadowWins,
              },
            ]
          : []),
      ],
      inference:
        'A root AGENTS.md/CLAUDE.md section whose governed files all live under one ' +
        'component subtree is over-scoped relative to path-scoped .claude/rules loading.' +
        (proof
          ? ' The config-scoping axis cleared the shadow-axis-wins evidence bar AND the ' +
            'zero-adherence-regression hard gate, so the recommendation graduates from ' +
            'a tier-0 estimate to a tier-1 before/after measurement (#1270).'
          : ''),
    },
  };
}

function emitAll(input: Parameters<Detector['rule']>[0]): Recommendation[] {
  const proof = configScopingProof(input);
  return overScopedCandidates(input).map((candidate) =>
    toRecommendation(candidate, `${DETECTOR_ID}:${candidate.idSuffix}`, proof)
  );
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'context',
  dataDeps: ['repoMap', 'shadowCalls'],
  rule(input) {
    const first = overScopedCandidates(input)[0];
    return first ? toRecommendation(first, DETECTOR_ID, configScopingProof(input)) : null;
  },
  emitAll,
};
