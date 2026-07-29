#!/usr/bin/env node
// Gate: CI cannot execute code it did not review (#3306, #3307).
//
// Two v0.6 audit findings were the same defect wearing different clothes — a
// workflow step running bytes chosen by somebody else, after review, with the
// repo's tokens in the environment:
//
//   #3307  every external `uses:` named a MUTABLE major tag (actions/checkout@v6,
//          anthropics/claude-code-action@v1, ...). Whoever owns that tag can
//          retarget it and run changed code under our credentials. The
//          cross-review workflow is the sharp end: it hands the action an API
//          key and a write-capable GitHub token.
//   #3306  `.github/actions/ensure-gh` resolved the gh CLI's `releases/latest`
//          at run time and piped the tarball straight into `tar`, with no
//          version pin and no checksum. A compromised release, a hijacked
//          redirect, or just a new upstream release put different executables
//          on PATH for every later step.
//
// Both were fixed by removing the capability rather than by using it carefully,
// and this gate is what stops either from growing back. Review is not a control
// that survives contact with a `git pull`; a failing check is.
//
// WHAT THIS GATE CLAIMS, EXACTLY
//
//   PIN     — every non-local `uses:` in .github/ resolves to an immutable ref:
//             a 40-character commit SHA for an action repo, or @sha256:<64 hex>
//             for a `docker://` image. In deploy/arc/runner-image/, base images
//             (Dockerfile `FROM`, BuildConfig `from.name`) must carry a digest.
//             It does NOT claim the pinned commit is trustworthy — only that it
//             cannot change under us. Reviewing what a SHA points at is still a
//             human job, and pinning without an update process goes stale, which
//             is why .github/dependabot.yml raises the bumps.
//   FETCH   — no step pipes `curl`/`wget` output into an extractor or
//             interpreter (tar, sh, bash, python, node, unzip, ...). Fetching
//             DATA is untouched: `curl ... | jq` is fine, because reading release
//             metadata is not executing it. It is a recurrence guard for the
//             fetch-and-run idiom, NOT a proof that no other path reaches
//             unreviewed code.
//
// SCOPE: .github/workflows/, .github/actions/, and deploy/arc/runner-image/.
// That last directory is included deliberately — #3306 was fixed by deleting the
// workflow-side gh installer and relying on the baked runner image, so the image
// build is where that responsibility LANDED. Leaving it unscanned would let the
// same defect reappear one layer down and call itself fixed.
//
// There is deliberately no exception list. An unpinnable dependency is a design
// decision that should be argued in review, not silenced by an entry here.
//
// Run: node scripts/check-action-pins.mjs

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** An action repo ref pinned to a full commit SHA: `owner/repo[/subpath]@<40 hex>`. */
const PINNED_ACTION_RE = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

/** A container ref pinned to a manifest digest: `docker://image@sha256:<64 hex>`. */
const PINNED_DOCKER_RE = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;

/**
 * `curl`/`wget` output piped into something that runs or unpacks it.
 *
 * The gap between the fetch and the pipe excludes `;`, `&` and `|` so the match
 * cannot span a statement boundary: without that, a `curl … -o file;` on one
 * line and an unrelated `printf … | bash script.sh` later in the SAME `\`
 * continuation chain would join into one logical line and read as a violation.
 * That false positive would fire on the safe download-then-verify-then-extract
 * shape this gate is meant to encourage, so the rule is anchored to a single
 * command.
 */
const FETCH_EXEC_RE =
  /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:tar|sh|bash|zsh|dash|ksh|python3?|node|ruby|perl|unzip|gunzip|zcat|openssl)\b/;

/** A container base image pinned to a manifest digest. */
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}/;

/** A registry image reference: has a dotted registry host before the first `/`. */
const REGISTRY_REF_RE = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/\S+$/i;

/** Workflow and composite-action definitions — everything CI will execute. */
export function listWorkflowFiles(root = REPO_ROOT) {
  const found = [];
  const isYaml = (name) => name.endsWith('.yml') || name.endsWith('.yaml');
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return; // directory absent in this checkout
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && isYaml(entry.name)) found.push(child);
    }
  };
  walk(join(root, '.github', 'workflows'));
  walk(join(root, '.github', 'actions'));
  return found.sort();
}

/**
 * The CI runner image build. Scanned because removing #3306's workflow-side
 * installer moved that responsibility HERE — if the fetch-and-run idiom were
 * allowed to reappear in the image build, the finding would simply have been
 * relocated one layer down rather than fixed.
 */
export function listRunnerImageFiles(root = REPO_ROOT) {
  const found = [];
  const directory = join(root, 'deploy', 'arc', 'runner-image');
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile()) found.push(join(directory, entry.name));
  }
  return found.sort();
}

/**
 * Drop comment-only lines and strip trailing ` # ...` comments, then join shell
 * line-continuations so a pipeline split across lines is scanned as one command
 * (the #3306 `curl ... \` / `  | tar -xz` shape).
 *
 * Deliberately conservative: a `#` inside a quoted string would be truncated
 * here. That can only cause the scanner to see LESS text, never to invent a
 * violation, so it cannot produce a false failure.
 */
export function logicalLines(source) {
  const kept = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) return;
    const withoutComment = raw.replace(/\s+#.*$/, '');
    kept.push({ number: index + 1, text: withoutComment });
  });

  const joined = [];
  for (const line of kept) {
    const continues = /\\$/.test(line.text.trimEnd());
    const body = continues ? line.text.trimEnd().replace(/\\$/, ' ') : line.text;
    const previous = joined[joined.length - 1];
    if (previous?.open) {
      previous.text += ` ${body.trim()}`;
      previous.open = continues;
    } else {
      joined.push({ number: line.number, text: body, open: continues });
    }
  }
  return joined;
}

/** Every rule violation in one workflow/action file. */
export function violationsIn(source) {
  const problems = [];
  for (const { number, text } of logicalLines(source)) {
    const usesMatch = /(?:^|\s)uses:\s*(\S+)/.exec(text);
    if (usesMatch) {
      const ref = usesMatch[1].replace(/^['"]|['"]$/g, '');
      // A `./...` ref is this repository's own tree at this commit — it is
      // reviewed by the very diff that changes it, so there is nothing mutable
      // to pin.
      const isLocal = ref.startsWith('./') || ref.startsWith('.\\');
      const isDocker = ref.startsWith('docker://');
      if (!isLocal) {
        const pinned = isDocker ? PINNED_DOCKER_RE.test(ref) : PINNED_ACTION_RE.test(ref);
        if (!pinned) {
          problems.push({
            line: number,
            rule: 'PIN',
            detail: isDocker
              ? `\`${ref}\` is not pinned to an image digest`
              : `\`${ref}\` is not pinned to a 40-character commit SHA`,
          });
        }
      }
    }

    if (FETCH_EXEC_RE.test(text)) {
      problems.push({
        line: number,
        rule: 'FETCH',
        detail: 'downloaded bytes are piped straight into an interpreter or archive extractor',
      });
    }
  }
  return problems;
}

/**
 * Runner-image build files: the same FETCH rule, plus base images pinned by
 * digest. `uses:` has no meaning here, so the action-pin rule does not apply.
 */
export function imageViolationsIn(source) {
  const problems = [];
  for (const { number, text } of logicalLines(source)) {
    const fromMatch = /(?:^|\s)FROM\s+(\S+)/.exec(text);
    if (fromMatch && fromMatch[1] !== 'scratch' && !IMAGE_DIGEST_RE.test(fromMatch[1])) {
      problems.push({
        line: number,
        rule: 'PIN',
        detail: `base image \`${fromMatch[1]}\` is not pinned to an image digest`,
      });
    }

    // OpenShift BuildConfig names its base image in `from: { name: ... }`.
    const nameMatch = /^\s*name:\s*(\S+)\s*$/.exec(text);
    if (nameMatch && REGISTRY_REF_RE.test(nameMatch[1]) && !IMAGE_DIGEST_RE.test(nameMatch[1])) {
      problems.push({
        line: number,
        rule: 'PIN',
        detail: `image reference \`${nameMatch[1]}\` is not pinned to an image digest`,
      });
    }

    if (FETCH_EXEC_RE.test(text)) {
      problems.push({
        line: number,
        rule: 'FETCH',
        detail: 'downloaded bytes are piped straight into an interpreter or archive extractor',
      });
    }
  }
  return problems;
}

export function scanRepository(root = REPO_ROOT) {
  const offenders = [];
  for (const absolute of listWorkflowFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    for (const problem of violationsIn(readFileSync(absolute, 'utf8'))) {
      offenders.push({ file, ...problem });
    }
  }
  for (const absolute of listRunnerImageFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    for (const problem of imageViolationsIn(readFileSync(absolute, 'utf8'))) {
      offenders.push({ file, ...problem });
    }
  }
  return offenders;
}

const REMEDY = {
  PIN:
    'Pin it to the full commit SHA the tag currently points at and keep the version in a ' +
    'trailing comment, e.g. `uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6`. ' +
    'Resolve one with: gh api repos/<owner>/<repo>/git/ref/tags/<tag> -q .object.sha ' +
    '(dereference .object.sha again when .object.type is "tag"). A mutable tag lets its owner ' +
    "run changed code with this repository's tokens (#3307).",
  FETCH:
    'Do not fetch-and-run inside CI. Prefer a dependency already baked into the reviewed runner ' +
    'image (deploy/arc/runner-image/) and fail closed when it is absent, as .github/actions/require-gh ' +
    'does. If a download is truly unavoidable, pin an exact version, download to a file, verify a ' +
    'committed SHA-256 with `sha256sum -c`, and only then extract (#3306).',
};

function main() {
  const offenders = scanRepository();
  for (const { file, line, rule, detail } of offenders) {
    console.error(`::error file=${file},line=${line}::[${rule}] ${detail}. ${REMEDY[rule]}`);
  }
  if (offenders.length) {
    process.exit(1);
  }
  const scanned = listWorkflowFiles().length + listRunnerImageFiles().length;
  console.log(
    `Action pins OK: ${scanned} workflow/action/runner-image file(s) — every external \`uses:\` and ` +
      'base image is pinned to an immutable ref, and no step pipes a download into an interpreter.'
  );
}

// Resolve through symlinks before comparing (the house pattern, see
// check-shell-quote.mjs). A gate whose main() silently fails to fire exits 0 and
// reports nothing — green CI proving nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
