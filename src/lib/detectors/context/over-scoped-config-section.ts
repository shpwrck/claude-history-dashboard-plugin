import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import type { Detector, Recommendation } from '../types';

const DETECTOR_ID = 'context.over-scoped-config-section';
const MAX_EVIDENCE_FILES = 5;

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

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s/-]/g, '')
    .trim()
    .replace(/[/\s_]+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

function componentSubtree(path: string): string | null {
  const parts = normalizePath(path).split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'src') {
    if (parts.length === 2) return 'src';
    return `src/${parts[1]}`;
  }
  if (parts[0] === 'tools' && parts.length >= 2) return `tools/${parts[1]}`;
  if (parts[0] === '.github' && parts[1] === 'workflows') return '.github/workflows';
  return parts[0];
}

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
      const topic = slugify(section.heading);
      out.push({
        project,
        section,
        files,
        subtree,
        pathsGlob,
        rulePath: `.claude/rules/${topic}.md`,
        idSuffix: slugify(`${project.root}-${section.id}`),
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

function toRecommendation(candidate: Candidate, id: string): Recommendation {
  const { section, files, subtree, pathsGlob, rulePath, idSuffix } = candidate;
  const heading = section.heading;
  const evidenceFiles = files
    .slice(0, MAX_EVIDENCE_FILES)
    .map((file) => file.path)
    .join(', ');

  return {
    id,
    category: 'context',
    severity: 'info',
    title: `Move "${heading}" into a ${subtree} rule`,
    detail:
      `Root ${section.sourceScope} section "${heading}" governs ${files.length} repo-map ` +
      `file(s), all under ${subtree}. Keeping it in always-loaded root config makes ` +
      'every session pay for guidance scoped to one component subtree.',
    action:
      `Move this section into ${rulePath} with \`paths: ["${pathsGlob}"]\`, then remove ` +
      `the always-loaded root copy from ${section.sourceScope}.`,
    affected: files.length,
    view: 'context',
    evidence: [
      `${section.id} -> ${subtree}: ${evidenceFiles}${files.length > MAX_EVIDENCE_FILES ? ', ...' : ''}`,
    ],
    savingsAttribution: {
      interventionKey: `${DETECTOR_ID}:${idSuffix}`,
      signatureId: 'repo-map-config-section-single-subtree',
      tier: 'tier-0-estimate',
      confidence: 'medium',
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
      ],
      inference:
        'A root AGENTS.md/CLAUDE.md section whose governed files all live under one ' +
        'component subtree is over-scoped relative to path-scoped .claude/rules loading.',
    },
  };
}

function emitAll(input: Parameters<Detector['rule']>[0]): Recommendation[] {
  return overScopedCandidates(input).map((candidate) =>
    toRecommendation(candidate, `${DETECTOR_ID}:${candidate.idSuffix}`)
  );
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'context',
  dataDeps: ['repoMap'],
  rule(input) {
    const first = overScopedCandidates(input)[0];
    return first ? toRecommendation(first, DETECTOR_ID) : null;
  },
  emitAll,
};
