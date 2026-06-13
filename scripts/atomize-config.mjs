// Atomizer codemod (#1268, epic #1264): split a monolithic CLAUDE.md/AGENTS.md
// into path-scoped .claude/rules/<topic>.md files.
//
// The over-scope rec (context.over-scoped-config-section, #1267) tells the user
// to move a root config section into a path-scoped rule, but until now the
// split was manual. This CLI performs it:
//
//   node scripts/atomize-config.mjs --dry-run <file>              # plan only
//   node scripts/atomize-config.mjs --map mapping.json <file>     # detector-fed
//   node scripts/atomize-config.mjs --section "Build=src/lib" <file>
//   node scripts/atomize-config.mjs --infer <file>                # accept inference
//   node scripts/atomize-config.mjs --revert <file>               # undo
//
// Section -> subtree mapping comes from one of two places:
//   1. Explicit (`--map <json>` / repeatable `--section <key>=<subtree>`): the
//      detector's section->subtree mapping. Keys may be a full section id
//      (`CLAUDE.md#build-deploy`), a bare slug (`build-deploy`), or the exact
//      heading text (`Build & deploy`).
//   2. Inferred (when no mapping is given): mirror of the detector's
//      single-subtree rule, but over the section's OWN path-like references
//      (the CLI has no repo-map join): a section whose file references all live
//      under one component subtree is proposed for that subtree. Because that
//      is WEAKER evidence than the detector's repo-map join, inference is
//      preview-only by default: `--dry-run` shows the inferred plan, but
//      WRITING inferred moves requires an explicit `--infer` (#1427).
//
// Each moved section becomes `.claude/rules/<topic>.md` with
// `paths: ["<subtree>/**"]` frontmatter; the monolith keeps a one-line marker
// comment (`<!-- atomized: .claude/rules/<topic>.md -->`) at the cut point so
// the split is exactly reversible (`--revert` round-trips byte-identical).
//
// @import semantics are preserved: relative `@path` imports in a moved body are
// rewritten for the rule file's depth (`@AGENTS.md` -> `@../../AGENTS.md`),
// fence-aware (example imports inside code fences are left verbatim), and the
// rewrite is inverted on revert.
//
// Naming and ids are NOT mirrored (#1427):
//   - Section ids/slugs come from the REAL parser: splitSections() zips
//     parse-config-sections.ts ids onto its own byte-preserving sections, so a
//     detector-emitted --map key always resolves. The codemod keeps only the
//     byte-level splitter the parser deliberately omits (it is privacy-scoped
//     to never return section BODIES — that scoping covers bodies, not slug/id
//     logic). A vitest parity test pins the split boundaries (CRLF/BOM/fence)
//     against drift.
//   - Rule FILENAMES come from the same config-rule-naming helpers the
//     detector uses for its prescribed rulePath, so adoption tracking keyed on
//     that path sees the codemod's output.
// Both imports are dependency-free modules with no further imports, so plain
// `node scripts/atomize-config.mjs` resolves them via Node's native type
// stripping — the same substrate the repo's register-ts loader rides on — with
// no loader hook needed (and none registered when vitest imports this module).

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
import { parseConfigSections } from '../src/lib/parse-config-sections.ts';
import {
  componentSubtree,
  createRuleTopicDisambiguator,
  ruleTopicSlug,
} from '../src/lib/config-rule-naming.ts';

export { componentSubtree, createRuleTopicDisambiguator, ruleTopicSlug };

// -- Section model (byte-preserving splitter; ids delegated to the parser) ----

const FRONTMATTER_RE = /^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n?/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Stateful ``` / ~~~ code-fence tracker (the one fence state machine — used by
 * the splitter, the reference scanner, and the import rewriter).
 */
function createFenceTracker() {
  let open = null;
  return {
    /** Returns true when the line is a fence toggle (and consumes it). */
    feed(line) {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (!m) return false;
      const char = m[1][0];
      if (open === null) open = char;
      else if (open === char) open = null;
      return true;
    },
    get inFence() {
      return open !== null;
    },
  };
}

/**
 * Split a document into heading-bounded sections, fence-aware, preserving
 * every byte: the sections partition the line array exactly, so
 * `sections.flatMap((s) => s.lines).join('\n') === content`.
 *
 * Differences from the parser's splitSections are reconstruction-driven only:
 * the leading frontmatter is KEPT (as preamble lines, never movable) instead of
 * stripped, and an all-blank preamble is kept (slugless) instead of dropped,
 * because the codemod must be able to write the file back.
 *
 * Slug/id assignment is NOT re-implemented here: the same content goes through
 * the real parseConfigSections and its ids are zipped onto the sections, so
 * `sec.slug` is by construction the slug the detector emits in --map keys. A
 * count/heading mismatch between the two splitters means the byte-preserving
 * boundary model drifted from the parser — that fails loudly rather than
 * silently mis-keying sections.
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
  const fence = createFenceTracker();

  lines.forEach((line, i) => {
    if (i < fmLines) {
      current.lines.push(line);
      return;
    }
    if (fence.feed(line)) {
      current.lines.push(line);
      return;
    }
    const headingMatch = fence.inFence ? null : line.match(HEADING_RE);
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

  // The parser drops a content-less preamble (after stripping frontmatter);
  // those sections stay here for reconstruction but carry no slug. Everything
  // else aligns 1:1, in order, with the parser's records.
  const hasParserRecord = (sec, idx) => {
    if (sec.level > 0) return true;
    const bodyLines = idx === 0 ? sec.lines.slice(fmLines) : sec.lines;
    return bodyLines.some((l) => l.trim() !== '');
  };
  const withContent = sections.filter(hasParserRecord);
  const parsed = parseConfigSections({ scope: '', content });
  if (parsed.length !== withContent.length) {
    throw new Error(
      `section model drift: parse-config-sections found ${parsed.length} section(s), ` +
        `the codemod splitter found ${withContent.length}`
    );
  }
  withContent.forEach((sec, i) => {
    if (parsed[i].heading !== sec.heading || parsed[i].level !== sec.level) {
      throw new Error(
        `section model drift at "${sec.heading}" (parser saw "${parsed[i].heading}")`
      );
    }
    sec.slug = parsed[i].id.slice(1); // ids are `#<slug>` under the '' scope
  });
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

/** Remove fenced code blocks before reference scanning (mirror of the parser). */
function stripFences(lines) {
  const kept = [];
  const fence = createFenceTracker();
  for (const line of lines) {
    if (fence.feed(line)) continue;
    if (!fence.inFence) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Infer a section -> subtree mapping: a section whose path-like references all
 * live under ONE component subtree is proposed for that subtree (the CLI-side
 * mirror of the detector's repo-map governed-files rule). This needs section
 * BODIES, which the privacy-scoped parser never returns, so it stays CLI-side.
 * It is weaker evidence than the detector's repo-map join — see atomizeFile's
 * `infer` gate.
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
  const fence = createFenceTracker();
  return text
    .split('\n')
    .map((line) => {
      if (fence.feed(line)) return line;
      return fence.inFence ? line : fn(line);
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

/** Relative `@import` prefix for a body moving into `rulesDirRel` (`../../` etc). */
function importPrefixFor(rulesDirRel) {
  const clean = rulesDirRel.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${clean.split('/').map(() => '..').join('/')}/`;
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
 * (frontmatter + import-rewritten body), and the trimmed monolith. Callers
 * that already split the content can pass `sections` to avoid re-parsing.
 */
export function buildPlan({
  content,
  scope,
  mapping,
  rulesDirRel = '.claude/rules',
  sections = null,
}) {
  const secs = sections ?? splitSections(content);
  const importPrefix = importPrefixFor(rulesDirRel);

  const moves = [];
  const skipped = [];
  const trimmedParts = [];
  // Rule FILENAMES use the detector's topic disambiguator
  // (config-rule-naming), NOT the section-id slug, so the file written here is
  // exactly the rulePath the detector's recommendation prescribes (#1427).
  const nextRuleTopic = createRuleTopicDisambiguator();
  for (const sec of secs) {
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
    const topic = nextRuleTopic(sec.heading);
    const rulePathRel = `${rulesDirRel}/${topic}.md`;
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
 *   infer    allow WRITING inferred moves (without it, a null mapping is
 *            preview-only: dry-run works, apply throws) (#1427)
 *   dryRun   plan + print, write nothing
 *   rulesDirRel  where rule files go, relative to the monolith's directory
 * Returns { plan, unresolved, written }.
 */
export function atomizeFile(filePath, { mapping = null, infer = false, dryRun = false, rulesDirRel = '.claude/rules', log = console.log, warn = console.error } = {}) {
  if (mapping === null && !infer && !dryRun) {
    throw new Error(
      'no section mapping given: pass --map/--section (detector mapping), or --infer to ' +
        'accept CLI-inferred moves; --dry-run previews inference without writing'
    );
  }

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

  const plan = buildPlan({ content, scope, mapping: resolvedMapping, rulesDirRel, sections });
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
    if (mapping === null) {
      log('(inferred mapping: re-run with --infer to apply, or --map/--section for the detector mapping)');
    }
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
    const importPrefix = importPrefixFor(dirname(rulePathRel));
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
    // Prune now-empty rule directories (best effort) for ANY --rules-dir
    // depth: walk parents up to, but never including, the monolith's own
    // directory; stop at the first non-empty one.
    let parent = dirname(rulePath);
    while (parent !== dir && parent.startsWith(`${dir}${sep}`)) {
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
  --infer               Write CLI-inferred moves when no --map/--section is given.
  --rules-dir <dir>     Rule-file dir relative to the monolith (default .claude/rules).
  --help                Show this help.

With no --map/--section, sections whose file references all live under one
component subtree are inferred (mirror of the over-scoped-config detector, but
WITHOUT its repo-map join — weaker evidence). Inference is therefore
preview-only: --dry-run shows the inferred plan, while applying it requires an
explicit --infer.`;

function parseArgs(argv) {
  const opts = { dryRun: false, revert: false, infer: false, mapping: null, rulesDirRel: '.claude/rules', file: null };
  const entries = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--revert') opts.revert = true;
    else if (arg === '--infer') opts.infer = true;
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
    infer: opts.infer,
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
