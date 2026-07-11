import type { ConfigAttribution } from './parse-config-attribution';
import type { ConfigSection } from './parse-config-sections';
import type { ChurnStat } from './parse-files';
import type { FileRereadSummary } from './parse-file-reread';
import type { RepoFile, RepoMap, RepoSymbol } from './repo-map/types';

interface RecommendationLike {
  id: string;
  title: string;
  detail?: string;
  action: string;
  evidence?: string[];
  fix?: { snippet: string; note: string };
}

export interface RepoMapFileJoin {
  /** Repo-root-relative path from the structural map. */
  path: string;
  /** Host-captured source-file mtime. Absent on older/uploaded artifacts. */
  mtimeMs?: number;
  symbols: RepoSymbol[];
  imports: string[];
  reread?: {
    sessions: number;
    totalReads: number;
    totalEstimatedTokenWaste: number;
    maxPerSession: number;
  };
  churn?: ChurnStat;
  configSections: string[];
  recommendations: string[];
}

export interface RepoMapProjectJoin {
  root: string;
  generatedAtGitSha: string | null;
  fileCount: number;
  truncated: boolean;
  text: string;
  files: RepoMapFileJoin[];
  configSections: ConfigSection[];
  configAttribution: ConfigAttribution[];
}

export interface RepoMapDataset {
  projects: RepoMapProjectJoin[];
}

export interface BuildRepoMapDatasetInput {
  maps: RepoMap[];
  configSections?: ConfigSection[];
  configAttribution?: ConfigAttribution[];
  fileReread?: FileRereadSummary;
  churnFiles?: ChurnStat[];
  recommendations?: RecommendationLike[];
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function stripLeadingDot(path: string): string {
  return path.replace(/^\.\//, '');
}

function toRepoRelative(path: string, root: string): string | null {
  const p = normalizeSlashes(path);
  const r = normalizeSlashes(root).replace(/\/+$/, '');
  if (p === r) return '';
  if (p.startsWith(`${r}/`)) return stripLeadingDot(p.slice(r.length + 1));
  return stripLeadingDot(p);
}

function fileMatchesRef(file: RepoFile, target: string): boolean {
  const ref = stripLeadingDot(normalizeSlashes(target));
  return (
    ref === file.path ||
    ref.endsWith(`/${file.path}`) ||
    file.path.endsWith(`/${ref}`)
  );
}

function recommendationMentionsFile(rec: RecommendationLike, file: RepoFile): boolean {
  const haystack = [
    rec.title,
    rec.detail ?? '',
    rec.action,
    ...(rec.evidence ?? []),
    rec.fix?.snippet ?? '',
    rec.fix?.note ?? '',
  ].join('\n');
  return haystack.includes(file.path);
}

function projectSections(root: string, sections: ConfigSection[]): ConfigSection[] {
  const normalizedRoot = normalizeSlashes(root);
  return sections.filter((section) => {
    const scope = normalizeSlashes(section.sourceScope);
    return (
      !scope.startsWith('/') ||
      scope === normalizedRoot ||
      scope.startsWith(`${normalizedRoot}/`)
    );
  });
}

/** Build the server-only `repoMap` dataset key (#889).
 *
 * The output is a bounded structural join over already-computed signals. It
 * keeps repo-map privacy invariants intact: no source bodies and no full config
 * bodies, only paths, signatures, references, hashes, and aggregate counts.
 */
export function buildRepoMapDataset({
  maps,
  configSections = [],
  configAttribution = [],
  fileReread,
  churnFiles = [],
  recommendations = [],
}: BuildRepoMapDatasetInput): RepoMapDataset {
  const projects = (maps ?? []).map((map) => {
    const sections = projectSections(map.root, configSections);
    const reports = configAttribution.filter((report) =>
      sections.some((section) => section.id === report.sectionId)
    );

    const rereadByPath = new Map<string, RepoMapFileJoin['reread']>();
    for (const reread of fileReread?.repeats ?? []) {
      const rel = toRepoRelative(reread.path, map.root);
      if (!rel) continue;
      const existing = rereadByPath.get(rel) ?? {
        sessions: 0,
        totalReads: 0,
        totalEstimatedTokenWaste: 0,
        maxPerSession: 0,
      };
      existing.sessions += 1;
      existing.totalReads += reread.readCount;
      existing.totalEstimatedTokenWaste += reread.estimatedTokenWaste;
      existing.maxPerSession = Math.max(existing.maxPerSession, reread.readCount);
      rereadByPath.set(rel, existing);
    }

    const churnByPath = new Map<string, ChurnStat>();
    for (const churn of churnFiles) {
      const rel = toRepoRelative(churn.filePath, map.root);
      if (rel) churnByPath.set(rel, churn);
    }

    const files = map.files.map((file) => {
      const sectionIds = sections
        .filter((section) =>
          section.references.some(
            (ref) => ref.kind === 'file' && fileMatchesRef(file, ref.target)
          )
        )
        .map((section) => section.id);
      const recIds = recommendations
        .filter((rec) => recommendationMentionsFile(rec, file))
        .map((rec) => rec.id);
      return {
        path: file.path,
        ...(typeof file.mtimeMs === 'number' &&
        Number.isFinite(file.mtimeMs) &&
        file.mtimeMs >= 0
          ? { mtimeMs: file.mtimeMs }
          : {}),
        symbols: file.symbols,
        imports: file.imports,
        ...(rereadByPath.has(file.path)
          ? { reread: rereadByPath.get(file.path) }
          : {}),
        ...(churnByPath.has(file.path)
          ? { churn: churnByPath.get(file.path) }
          : {}),
        configSections: sectionIds,
        recommendations: recIds,
      };
    });

    return {
      root: map.root,
      generatedAtGitSha: map.generatedAtGitSha,
      fileCount: map.fileCount,
      truncated: map.truncated,
      text: map.text,
      files,
      configSections: sections,
      configAttribution: reports,
    };
  });

  return { projects };
}
