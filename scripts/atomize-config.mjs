// Atomizer codemod (#1268, epic #1264): split a monolithic CLAUDE.md/AGENTS.md
// into path-scoped .claude/rules/<topic>.md files.
//
// The over-scope rec (context.over-scoped-config-section, #1267) tells the user
// to move a root config section into a path-scoped rule, but until now the
// split was manual. This CLI performs it:
//
//   node scripts/atomize-config.mjs --dry-run <file>              # plan only
//   node scripts/atomize-config.mjs <file>                        # apply
//   node scripts/atomize-config.mjs --map mapping.json <file>     # detector-fed
//   node scripts/atomize-config.mjs --section "Build=src/lib" <file>
//   node scripts/atomize-config.mjs --revert <file>               # undo
//
// Section -> subtree mapping comes from one of two places:
//   1. Explicit (`--map <json>` / repeatable `--section <key>=<subtree>`): the
//      detector's section->subtree mapping. Keys may be a full section id
//      (`CLAUDE.md#build-deploy`), a bare slug (`build-deploy`), or the exact
//      heading text (`Build & deploy`).
//   2. Inferred (default when no mapping is given): mirror of the detector's
//      single-subtree rule, but over the section's OWN path-like references
//      (the CLI has no repo-map join): a section whose file references all live
//      under one component subtree is proposed for that subtree.
//
// Each moved section becomes `.claude/rules/<slug>.md` with
// `paths: ["<subtree>/**"]` frontmatter; the monolith keeps a one-line marker
// comment (`<!-- atomized: .claude/rules/<slug>.md -->`) at the cut point so
// the split is exactly reversible (`--revert` round-trips byte-identical).
//
// @import semantics are preserved: relative `@path` imports in a moved body are
// rewritten for the rule file's depth (`@AGENTS.md` -> `@../../AGENTS.md`),
// fence-aware (example imports inside code fences are left verbatim), and the
// rewrite is inverted on revert.
//
// Zero-dependency Node by repo convention for runtime scripts. The section
// model (fence-aware heading splitting, frontmatter stripping, slug/id
// assignment) deliberately MIRRORS src/lib/parse-config-sections.ts rather than
// importing it: that parser is privacy-scoped to never return section BODIES,
// which is exactly what a codemod needs, and importing TS would force the
// register-ts loader onto the acceptance command. A vitest parity test pins the
// two against drift.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// -- Section model (mirrors src/lib/parse-config-sections.ts) ----------------

const FRONTMATTER_RE = /^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n?/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** FNV-1a 32-bit hash -> 8-char hex (mirror of the parser's hash). */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Heading slug (mirror of the parser's slugify). */
export function slugify(heading) {
  const slug = heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug || 'section';
}

/** True for a ``` / ~~~ code-fence toggle line; returns the fence char. */
function fenceToggle(line) {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  return m ? m[1][0] : null;
}

/**
 * Split a document into heading-bounded sections, fence-aware, preserving
 * every byte: the sections partition the line array exactly, so
 * `sections.flatMap((s) => s.lines).join('\n') === content`.
 *
 * Differences from the parser's splitSections are reconstruction-driven only:
 * the leading frontmatter is KEPT (as preamble lines, never movable) instead of
 * stripped, and an all-blank preamble is kept (marked `empty`) instead of
 * dropped, because the codemod must be able to write the file back.
 */
export function splitSections(content) {
  const lines = content.split('\n');

  // Frontmatter span: heading detection is suppressed inside it (the parser
  // strips it before splitting; we keep the bytes but mirror the boundary).
  let fmLines = 0;
  const fm = content.match(FRONTMATTER_RE);
  if (fm) {
    fmLines = fm[0].split('\n').length;
    if (fm[0].endsWith('\n')) fmLines -= 1;
  }

  const sections = [];
  let current = { heading: '', level: 0, lines: [] };
  let fence = null;

  lines.forEach((line, i) => {
    if (i < fmLines) {
      current.lines.push(line);
      return;
    }
    const toggle = fenceToggle(line);
    if (toggle) {
      if (fence === null) fence = toggle;
      else if (fence === toggle) fence = null;
      current.lines.push(line);
      return;
    }
    const headingMatch = fence === null ? line.match(HEADING_RE) : null;
    if (headingMatch) {
      sections.push(current);
      current = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        lines: [line],
      };
    } else {
      current.lines.push(line);
    }
  });
  sections.push(current);

  // Mirror the parser's two-pass stable-id assignment: colliding DISTINCT
  // headings disambiguate by a heading-text hash; identical headings take a
  // positional -N suffix.
  const withContent = sections.filter(
    (sec) => sec.level > 0 || sec.lines.some((l) => l.trim() !== '')
  );
  const baseOf = (sec) => (sec.level === 0 ? '__preamble__' : slugify(sec.heading));
  const distinctByBase = new Map();
  for (const sec of withContent) {
    const base = baseOf(sec);
    const set = distinctByBase.get(base) ?? new Set();
    set.add(sec.heading);
    distinctByBase.set(base, set);
  }
  const usedCounts = new Map();
  for (const sec of withContent) {
    const base = baseOf(sec);
    const collides = (distinctByBase.get(base)?.size ?? 0) > 1;
    const candidate = collides ? `${base}-${fnv1a(sec.heading).slice(0, 4)}` : base;
    const n = (usedCounts.get(candidate) ?? 0) + 1;
    usedCounts.set(candidate, n);
    sec.slug = n === 1 ? candidate : `${candidate}-${n}`;
  }
  return sections;
}

/** Public view of a document's sections (ids match parse-config-sections). */
export function listSections(content, scope) {
  return splitSections(content)
    .filter((sec) => sec.slug !== undefined)
    .map((sec) => ({
      id: `${scope}#${sec.slug}`,
      slug: sec.slug,
      heading: sec.heading,
      level: sec.level,
    }));
}

// -- Subtree inference (mirrors the over-scoped detector's single-subtree rule)

// Path-like token (mirror of the parser's RE_PATH).
const RE_PATH = /(?:^|[\s(`'"])([\w@.-]+(?:\/[\w@.-]+)+\.[\w]+)/g;

/** Component subtree of a repo-relative path (mirror of the detector's rule). */
export function componentSubtree(path) {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'src') {
    if (parts.length === 2) return 'src';
    return `src/${parts[1]}`;
  }
  if (parts[0] === 'tools' && parts.length >= 2) return `tools/${parts[1]}`;
  if (parts[0] === '.github' && parts[1] === 'workflows') return '.github/workflows';
  return parts[0];
}

/** Remove fenced code blocks before reference scanning (mirror of the parser). */
function stripFences(lines) {
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const toggle = fenceToggle(line);
    if (toggle) {
      if (fence === null) fence = toggle;
      else if (fence === toggle) fence = null;
      continue;
    }
    if (fence === null) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Infer a section -> subtree mapping: a section whose path-like references all
 * live under ONE component subtree is proposed for that subtree (the CLI-side
 * mirror of the detector's repo-map governed-files rule).
 */
export function inferMapping(sections) {
  const mapping = new Map();
  for (const sec of sections) {
    if (sec.level === 0 || sec.heading.trim().length === 0) continue;
    if (sec.lines.some((line) => MARKER_RE.test(line))) continue;
    const text = stripFences(sec.lines);
    const subtrees = new Set();
    let refs = 0;
    for (const m of text.matchAll(RE_PATH)) {
      refs += 1;
      subtrees.add(componentSubtree(m[1]) ?? '');
    }
    if (refs === 0 || subtrees.size !== 1 || subtrees.has('')) continue;
    mapping.set(sec.slug, [...subtrees][0]);
  }
  return mapping;
}

// -- @import rewriting (fence-aware, exactly invertible) ----------------------

// `@path` import directive (mirror of the parser's RE_IMPORT).
const RE_IMPORT = /(^|[\s(])@([\w./-]+\.[\w]+|[\w./-]*\/[\w./-]+)/g;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapUnfencedLines(text, fn) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const toggle = fenceToggle(line);
      if (toggle) {
        if (fence === null) fence = toggle;
        else if (fence === toggle) fence = null;
        return line;
      }
      return fence === null ? fn(line) : line;
    })
    .join('\n');
}

/**
 * Rewrite relative `@path` imports for a body moving `prefix` deeper (e.g.
 * `../../` for `.claude/rules/`). Absolute (`@/...`) imports and anything
 * inside a code fence are left verbatim.
 */
export function rewriteImports(text, prefix) {
  if (!prefix) return text;
  return mapUnfencedLines(text, (line) =>
    line.replace(RE_IMPORT, (full, pre, target) => {
      if (target.startsWith('/')) return full;
      return `${pre}@${prefix}${target}`;
    })
  );
}

/** Exact inverse of {@link rewriteImports}: strip the added prefix. */
export function unrewriteImports(text, prefix) {
  if (!prefix) return text;
  const re = new RegExp(`(^|[\\s(])@${escapeRegex(prefix)}`, 'g');
  return mapUnfencedLines(text, (line) => line.replace(re, '$1@'));
}

// -- Planning -----------------------------------------------------------------

const MARKER_RE = /^<!-- atomized: (.+?) -->$/;

function markerLine(rulePathRel) {
  return `<!-- atomized: ${rulePathRel} -->`;
}

function normalizeSubtree(subtree) {
  return subtree.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathsGlobFor(subtree) {
  const clean = normalizeSubtree(subtree);
  return clean.includes('*') ? clean : `${clean}/**`;
}

/**
 * Resolve a user/detector mapping ({key -> subtree}) against the parsed
 * sections. Keys may be a full id (`<scope>#<slug>`), a bare slug, or the
 * exact heading text. Unresolved keys are returned (warn-and-skip keeps a
 * re-run after apply idempotent: moved sections no longer resolve).
 */
export function resolveMapping(sections, scope, rawMapping) {
  const resolved = new Map();
  const unresolved = [];
  for (const [key, subtree] of rawMapping) {
    const section = sections.find(
      (sec) =>
        sec.slug !== undefined &&
        sec.level > 0 &&
        (`${scope}#${sec.slug}` === key || sec.slug === key || sec.heading === key)
    );
    if (section) resolved.set(section.slug, subtree);
    else unresolved.push(key);
  }
  return { resolved, unresolved };
}

/**
 * Build the atomization plan: which sections move, the rule files to write
 * (frontmatter + import-rewritten body), and the trimmed monolith.
 */
export function buildPlan({ content, scope, mapping, rulesDirRel = '.claude/rules' }) {
  const sections = splitSections(content);
  const importPrefix = `${rulesDirRel.replace(/\/+$/, '').split('/').map(() => '..').join('/')}/`;

  const moves = [];
  const skipped = [];
  const trimmedParts = [];
  for (const sec of sections) {
    const subtree = sec.slug !== undefined && sec.level > 0 ? mapping.get(sec.slug) : undefined;
    if (subtree === undefined) {
      trimmedParts.push(...sec.lines);
      continue;
    }
    // A section that already carries an atomized marker must stay in the
    // monolith: moving it would bury the marker inside a rule file where
    // --revert (which scans the monolith) could never find it.
    if (sec.lines.some((line) => MARKER_RE.test(line))) {
      skipped.push({ slug: sec.slug, heading: sec.heading, reason: 'contains-atomized-marker' });
      trimmedParts.push(...sec.lines);
      continue;
    }
    const rulePathRel = `${rulesDirRel}/${sec.slug}.md`;
    const glob = pathsGlobFor(subtree);
    const body = rewriteImports(sec.lines.join('\n'), importPrefix);
    const ruleContent = `---\npaths: ["${glob}"]\natomized-from: ${scope}\n---\n${body}`;
    moves.push({
      id: `${scope}#${sec.slug}`,
      slug: sec.slug,
      heading: sec.heading,
      subtree: normalizeSubtree(subtree),
      pathsGlob: glob,
      rulePathRel,
      ruleContent,
    });
    trimmedParts.push(markerLine(rulePathRel));
  }

  return {
    scope,
    rulesDirRel,
    importPrefix,
    moves,
    skipped,
    trimmedContent: trimmedParts.join('\n'),
  };
}

// -- Apply / revert (filesystem) ----------------------------------------------

/**
 * Atomize one monolith on disk. Options:
 *   mapping  Map<key, subtree> | null  (null -> infer)
 *   dryRun   plan + print, write nothing
 *   rulesDirRel  where rule files go, relative to the monolith's directory
 * Returns { plan, unresolved, written }.
 */
export function atomizeFile(filePath, { mapping = null, dryRun = false, rulesDirRel = '.claude/rules', log = console.log, warn = console.error } = {}) {
  const abs = resolve(filePath);
  const dir = dirname(abs);
  const scope = basename(abs);
  const content = readFileSync(abs, 'utf8');
  const sections = splitSections(content);

  let resolvedMapping;
  let unresolved = [];
  if (mapping === null) {
    resolvedMapping = inferMapping(sections);
  } else {
    const res = resolveMapping(sections, scope, mapping);
    resolvedMapping = res.resolved;
    unresolved = res.unresolved;
  }
  for (const key of unresolved) {
    warn(`warn: mapping key "${key}" matched no section in ${scope} (already atomized?) - skipped`);
  }

  const plan = buildPlan({ content, scope, mapping: resolvedMapping, rulesDirRel });
  for (const skip of plan.skipped) {
    warn(`warn: section "${skip.heading}" contains an atomized marker - left in place`);
  }

  if (plan.moves.length === 0) {
    log(`${scope}: nothing to atomize (no mapped/inferable sections).`);
    return { plan, unresolved, written: false };
  }

  if (dryRun) {
    log(`Plan for ${scope}: ${plan.moves.length} section(s) -> ${rulesDirRel}/\n`);
    for (const move of plan.moves) {
      log(`-- would write ${move.rulePathRel} (paths: ${move.pathsGlob}) --`);
      log(move.ruleContent);
      log('');
    }
    log(`-- trimmed ${scope} --`);
    log(plan.trimmedContent);
    log('\n(dry-run: nothing written)');
    return { plan, unresolved, written: false };
  }

  for (const move of plan.moves) {
    const rulePath = join(dir, move.rulePathRel);
    if (existsSync(rulePath)) {
      const existing = readFileSync(rulePath, 'utf8');
      if (existing !== move.ruleContent) {
        throw new Error(`refusing to overwrite ${move.rulePathRel}: it exists with different content`);
      }
      continue;
    }
    mkdirSync(dirname(rulePath), { recursive: true });
    writeFileSync(rulePath, move.ruleContent);
    log(`wrote ${move.rulePathRel} (paths: ${move.pathsGlob})`);
  }
  writeFileSync(abs, plan.trimmedContent);
  log(`trimmed ${scope}: moved ${plan.moves.length} section(s)`);
  return { plan, unresolved, written: true };
}

const RULE_HEADER_RE = /^---\n[\s\S]*?\n---\n/;

/**
 * Revert a previous atomization: each `<!-- atomized: ... -->` marker is
 * replaced by its rule file's body (imports un-rewritten) and the rule file is
 * deleted. Byte-identical inverse of {@link atomizeFile}.
 */
export function revertFile(filePath, { dryRun = false, log = console.log, warn = console.error } = {}) {
  const abs = resolve(filePath);
  const dir = dirname(abs);
  const scope = basename(abs);
  const content = readFileSync(abs, 'utf8');

  const restoredLines = [];
  const consumedRuleFiles = [];
  for (const line of content.split('\n')) {
    const m = line.match(MARKER_RE);
    if (!m) {
      restoredLines.push(line);
      continue;
    }
    const rulePathRel = m[1];
    const rulePath = join(dir, rulePathRel);
    // A marker is untrusted input (it rides in the monolith being reverted):
    // never follow it outside the monolith's own directory, or --revert would
    // splice in and then DELETE whatever file a hostile marker points at.
    const containment = relative(dir, rulePath);
    if (
      isAbsolute(rulePathRel) ||
      containment === '' ||
      containment === '..' ||
      containment.startsWith(`..${sep}`) ||
      isAbsolute(containment)
    ) {
      warn(`warn: marker path ${rulePathRel} escapes the config directory - leaving marker in place`);
      restoredLines.push(line);
      continue;
    }
    if (!existsSync(rulePath)) {
      warn(`warn: marker references missing ${rulePathRel} - leaving marker in place`);
      restoredLines.push(line);
      continue;
    }
    const ruleText = readFileSync(rulePath, 'utf8');
    const header = ruleText.match(RULE_HEADER_RE);
    if (!header || !header[0].includes(`atomized-from: ${scope}`)) {
      warn(`warn: ${rulePathRel} is not an atomized rule for ${scope} - leaving marker in place`);
      restoredLines.push(line);
      continue;
    }
    const rulesDirRel = dirname(rulePathRel).replace(/\\/g, '/');
    const importPrefix = `${rulesDirRel.split('/').map(() => '..').join('/')}/`;
    const body = unrewriteImports(ruleText.slice(header[0].length), importPrefix);
    restoredLines.push(...body.split('\n'));
    consumedRuleFiles.push(rulePath);
  }

  const restored = restoredLines.join('\n');
  if (consumedRuleFiles.length === 0) {
    log(`${scope}: no atomized markers found - nothing to revert.`);
    return { restored, written: false, reverted: 0 };
  }

  if (dryRun) {
    log(`-- restored ${scope} (${consumedRuleFiles.length} section(s)) --`);
    log(restored);
    log('\n(dry-run: nothing written)');
    return { restored, written: false, reverted: consumedRuleFiles.length };
  }

  writeFileSync(abs, restored);
  for (const rulePath of consumedRuleFiles) {
    unlinkSync(rulePath);
    // Prune now-empty rule directories (best effort).
    let parent = dirname(rulePath);
    for (let i = 0; i < 2; i++) {
      try {
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  log(`restored ${scope}: merged ${consumedRuleFiles.length} section(s) back`);
  return { restored, written: true, reverted: consumedRuleFiles.length };
}

// -- CLI ------------------------------------------------------------------------

const USAGE = `Usage: node scripts/atomize-config.mjs [options] <CLAUDE.md|AGENTS.md>

Split monolithic agent config into path-scoped .claude/rules/<topic>.md files.

Options:
  --dry-run             Print planned rule files + trimmed monolith; write nothing.
  --revert              Merge previously atomized sections back (inverse of apply).
  --map <file.json>     Section->subtree mapping (JSON object). Keys: section id
                        ("CLAUDE.md#build-deploy"), slug, or exact heading text.
  --section <key=tree>  Single mapping entry (repeatable). Same keys as --map.
  --rules-dir <dir>     Rule-file dir relative to the monolith (default .claude/rules).
  --help                Show this help.

With no --map/--section, sections whose file references all live under one
component subtree are inferred (mirror of the over-scoped-config detector).`;

function parseArgs(argv) {
  const opts = { dryRun: false, revert: false, mapping: null, rulesDirRel: '.claude/rules', file: null };
  const entries = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--revert') opts.revert = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--map') {
      const file = argv[++i];
      if (!file) throw new Error('--map requires a JSON file argument');
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, subtree] of Object.entries(parsed)) entries.push([key, subtree]);
    } else if (arg === '--section') {
      const spec = argv[++i];
      const eq = spec ? spec.indexOf('=') : -1;
      if (eq <= 0) throw new Error('--section requires <key>=<subtree>');
      entries.push([spec.slice(0, eq), spec.slice(eq + 1)]);
    } else if (arg === '--rules-dir') {
      const dir = argv[++i];
      if (!dir) throw new Error('--rules-dir requires a directory argument');
      opts.rulesDirRel = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (opts.file === null) {
      opts.file = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  if (entries.length > 0) opts.mapping = new Map(entries);
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.file) {
    console.log(USAGE);
    return opts.help ? 0 : 1;
  }
  if (!existsSync(opts.file)) {
    console.error(`error: no such file: ${opts.file}`);
    return 1;
  }
  if (opts.revert) {
    revertFile(opts.file, { dryRun: opts.dryRun });
    return 0;
  }
  atomizeFile(opts.file, {
    mapping: opts.mapping,
    dryRun: opts.dryRun,
    rulesDirRel: opts.rulesDirRel,
  });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
