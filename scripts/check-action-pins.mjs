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
//             for a `docker://` image. In every recipe declared by
//             `container-images.json`, and in deploy/arc/runner-image/, base
//             images (Dockerfile `FROM`, BuildConfig `from.name`) must carry a
//             digest.
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
//   STAMP   — every container image in the ARC scale-set values, and the
//             BuildConfig output tag that produces it, names either a digest or a
//             VERSION-STAMPED tag (`v<YYYY>-<MM>-<DD>-<hex>`, the hex derived from
//             the recipe's CONTENT — never from a commit, which cannot contain
//             its own SHA and would not survive a squash); AND a stamped
//             image is one this repo actually BUILDS, in the repository the
//             BuildConfig publishes to; AND producer and consumers all name the
//             SAME stamp. All three halves are load-bearing, because each covers
//             a state the others report as success: two well-formed stamps that
//             disagree split the pool across stale tooling; a stamp on a
//             repository nothing here builds (`ghcr.io/attacker/chd-ci-runner`)
//             redirects privileged runners while looking perfectly valid; and a
//             stamp with no producer can only ever be checked against itself.
//             See #3340 below for why this rung is weaker than PIN, and what it
//             does still buy.
//
// #3340 — WHY THE RUNNER POOL GETS A WEAKER RULE THAN EVERYTHING ELSE
//
//   The four scale-set values files all ran `chd-ci-runner:latest`. That tag is
//   the BuildConfig's own output target, so EVERY `oc start-build` silently
//   replaced the code executed by pods that run as root, carry a privileged
//   Docker sidecar, and receive workflow credentials — with no reviewed diff
//   anywhere. That is the defect.
//
//   The finding asked for `@sha256:` digests, and that is NOT implementable at
//   this seam: `chd-ci-runner` is an OpenShift ImageStream in each cluster's OWN
//   internal registry, so its digest is produced at build time and DIFFERS
//   between hub and spoke. One committed digest cannot be correct for both, and a
//   placeholder breaks CI. So the digest rung is unavailable, not skipped.
//
//   A version-stamped tag is the next rung down, and the honest claim for it is
//   narrow: it is NOT immutable — someone with push access can still move it. What
//   it removes is the AUTOMATIC mover. `:latest` was reassigned by any rebuild,
//   incidentally and invisibly; `v2026-08-03-5a29159a` is only reassigned by
//   someone deliberately re-pointing that exact name. Rebuilding from a changed
//   recipe now requires editing the stamp in this repo, which makes the runner
//   image change a REVIEWED diff — which is the property #3340 actually lost.
//
//   Stated plainly so nobody later mistakes this for digest pinning: this rung
//   buys review, not immutability.
//
//   THE ABSENT-`image:` CASE IS ALSO COVERED (#3493): the per-line rules above
//   check the references that are PRESENT, but if a container's `image:` line
//   were deleted outright, the gha-runner-scale-set chart substitutes its own
//   default (`ghcr.io/actions/actions-runner:latest`) — the same defect reached
//   by absence rather than by a bad value. `containerImageAbsences` closes that
//   with a structural read of the `template.spec.containers`/`initContainers`
//   lists: every entry must DECLARE an image. It is a minimal indentation reader
//   over the four known-shape values files (no block scalars there), so no YAML
//   parser is added to this gate's node-builtin-only path.
//
// SCOPE: .github/workflows/, .github/actions/, every published-image recipe in
// `container-images.json`, deploy/arc/runner-image/, and the deploy/arc ARC
// scale-set values (flat = spoke, hub/ = hub). The publisher workflow is itself
// byte-equality checked against the manifest compiler, so unknown build
// mechanisms in that workflow are workflow drift rather than undiscovered
// scope. Every other direct workflow must carry an explicit permissions ceiling,
// cannot mention the reserved packages capability, and may reference only its
// inventoried secret names; a second unknown-mechanism publisher therefore
// cannot borrow the built-in package-write token or a new credential pairing
// without changing this reviewed policy (#3513).
// The runner-image directory is included deliberately — #3306 was fixed by
// deleting the workflow-side gh installer and relying on the baked runner image,
// so the image build is where that responsibility LANDED. The scale-set values
// are included for the mirror-image reason: they are where the built image is
// finally SELECTED, and a gate that checked only how the image is built would
// miss a pod pointed at a mutable tag.
//
// There is deliberately no exception list. An unpinnable dependency is a design
// decision that should be argued in review, not silenced by an entry here.
//
// Run: node scripts/check-action-pins.mjs

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONTAINER_PUBLISH_WORKFLOW,
  inspectContainerImageManifest,
  publisherWorkflowDriftReasons,
} from './container-image-manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Existing external-credential seams, by direct workflow.
 *
 * A new workflow cannot borrow one of these credentials merely by naming it:
 * that workflow/secret pairing must become a reviewed policy diff here. This is
 * defense in depth around the stronger built-in-token boundary below; it does
 * not claim an existing allowlisted credential has no capabilities beyond its
 * documented use.
 */
const WORKFLOW_SECRET_ALLOWLIST = Object.freeze({
  '.github/workflows/agent-cross-review.yml': ['ANTHROPIC_API_KEY', 'CODEX_TRIGGER_PAT'],
  '.github/workflows/stage-b-target-agent-cross-review.yml': ['ANTHROPIC_API_KEY', 'CODEX_TRIGGER_PAT'],
  '.github/workflows/docker-publish.yml': ['GITHUB_TOKEN'],
  '.github/workflows/pages-publish-plugin.yml': ['ACTIONS_DEPLOY_KEY_PLUGIN'],
  '.github/workflows/pages-publish-stable.yml': ['ACTIONS_DEPLOY_KEY'],
});

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

/**
 * A container base image pinned to a manifest digest.
 *
 * END-ANCHORED deliberately. Unanchored, `image@sha256:<64 hex>:latest` matches,
 * so a malformed reference that no registry can resolve would be accepted as
 * "digest-pinned" and skip every further check — the gate reporting success for
 * a reference that would leave pods in ImagePullBackOff. A digest must consume
 * the WHOLE reference to count as one.
 */
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/** A registry image reference: has a dotted registry host before the first `/`. */
const REGISTRY_REF_RE = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/\S+$/i;

/**
 * A version-stamped tag: `v<YYYY>-<MM>-<DD>-<7..40 hex>` — the ISO date of the
 * build and a hash of the recipe's CONTENT (`sha256sum
 * deploy/arc/runner-image/Dockerfile | cut -c1-8`), NOT a commit: a commit
 * cannot contain its own SHA and the value must survive a squash. The general
 * grammar accepts 7..40 hex; the cross-file runner rule below additionally
 * requires the exact eight-hex content suffix for `chd-ci-runner`.
 *
 * This is an ALLOWLIST on purpose. Rejecting a denylist of known-mutable names
 * (`latest`, `main`, `stable`, ...) would keep passing the next mutable name
 * somebody invents, and would pass a bare untagged reference — which Docker
 * resolves to `:latest`, the exact defect, spelled invisibly. Requiring a shape
 * that a moving tag cannot accidentally have makes the mistake unrepresentable
 * rather than merely discouraged.
 */
const STAMPED_TAG_RE = /^v\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/;

/**
 * An `image:` key in a Helm values file, with whatever follows it on the line.
 *
 * The capture is deliberately `\S*` (possibly EMPTY) rather than `\S+`. YAML lets
 * a scalar sit on the following line, so `image:` alone is a legal way to write a
 * reference this line scanner cannot see — which would be a one-newline bypass of
 * the whole rule. Matching the empty case lets it be reported rather than
 * skipped. Requiring `(?:^|\s)` before the key keeps sibling keys that merely END
 * in `image` (`runnerImage:`, `dindImage:`) from matching.
 */
const VALUES_IMAGE_RE = /(?:^|\s)image:\s*(.*?)\s*$/;

/**
 * YAML spellings this line scanner cannot resolve to a single image reference.
 *
 * The capture above is `.*?` rather than `\S*` for the same reason the empty
 * case is reported: with `\S*`, a value the regex could not consume produced NO
 * match at all, so the line was skipped in silence. `image: !!str foo:latest` is
 * valid YAML, resolves to a mutable tag, and slipped through exactly that way —
 * verified before this was written, not assumed.
 *
 * Anything that is not a bare or simply-quoted scalar is therefore REPORTED
 * rather than skipped. A tag, anchor, alias or block indicator has no business
 * in a runner image reference, so refusing to guess costs nothing real and keeps
 * "cannot parse" from reading as "verified".
 */
export function unparseableImageValue(value) {
  if (/\s/.test(value)) {
    return `\`${value}\` is not a single image reference, so it cannot be checked here`;
  }
  if (/^[!&*|>]/.test(value)) {
    return `\`${value}\` uses a YAML tag, anchor or block indicator this gate does not resolve`;
  }
  return null;
}

/**
 * An OpenShift ImageStreamTag reference (`<stream>:<tag>`) in a bare YAML
 * `name:`. Registry references are handled separately by REGISTRY_REF_RE; a
 * `name:` with no colon is an ordinary Kubernetes object name, not an image.
 */
const IMAGE_STREAM_TAG_RE = /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][\w.-]*$/;

/**
 * The tag of an image reference, or null when it carries none.
 *
 * Split at the LAST `/` first: a registry host may carry a port
 * (`...svc:5000/arc-runners/chd-ci-runner:latest`), and that colon must not be
 * mistaken for the tag separator.
 */
export function imageRefTag(ref) {
  const lastSlash = ref.lastIndexOf('/');
  const nameAndTag = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const colon = nameAndTag.indexOf(':');
  return colon === -1 ? null : nameAndTag.slice(colon + 1);
}

/**
 * Strip one layer of YAML quoting.
 *
 * `name: "chd-ci-runner:latest"` is valid YAML and means exactly the same thing
 * as the bare form, but a raw `\S+` capture keeps the quotes, so every pattern
 * below fails to match and the reference slips through unchecked. Quoting must
 * not be a way to opt out of the gate.
 */
export function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * The image NAME of a reference — the last path segment, minus any tag or
 * digest. `.../arc-runners/chd-ci-runner:v2026-08-03-5a29159a` and the
 * BuildConfig's own `chd-ci-runner:latest` both yield `chd-ci-runner`, which is
 * what lets the producer and its consumers be recognised as the same image
 * across files that spell it at different lengths.
 */
export function imageRefName(ref) {
  const lastSlash = ref.lastIndexOf('/');
  const nameAndTag = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const at = nameAndTag.indexOf('@');
  const base = at === -1 ? nameAndTag : nameAndTag.slice(0, at);
  const colon = base.indexOf(':');
  return colon === -1 ? base : base.slice(0, colon);
}

/**
 * The full repository of a reference — everything except the tag or digest.
 *
 * The basename alone is NOT an identity. `ghcr.io/attacker/chd-ci-runner` and
 * the in-cluster `.../arc-runners/chd-ci-runner` share a basename, so matching
 * producers to consumers on the last path segment would let a values file keep a
 * perfectly valid stamp while redirecting the pool to a repository this cluster
 * never builds — a gate-approved swap of the image that privileged, credential-
 * bearing runners execute. Identity has to be the whole repository.
 */
export function imageRefRepository(ref) {
  const at = ref.indexOf('@');
  const base = at === -1 ? ref : ref.slice(0, at);
  const lastSlash = base.lastIndexOf('/');
  const nameAndTag = lastSlash === -1 ? base : base.slice(lastSlash + 1);
  const colon = nameAndTag.indexOf(':');
  const name = colon === -1 ? nameAndTag : nameAndTag.slice(0, colon);
  return lastSlash === -1 ? name : `${base.slice(0, lastSlash)}/${name}`;
}

/**
 * The one namespace the in-cluster BuildConfig publishes into, on both clusters.
 *
 * Pinned as a constant on purpose: it is a deployment invariant, and if it ever
 * legitimately changes, this gate SHOULD fail until the change is reviewed here.
 */
const INTERNAL_REGISTRY_NAMESPACE =
  'image-registry.openshift-image-registry.svc:5000/arc-runners';

/** Is this image reference immutable (digest) or at least review-gated (stamp)? */
export function imageRefProblem(ref) {
  if (IMAGE_DIGEST_RE.test(ref)) return null; // strongest rung; always acceptable
  const tag = imageRefTag(ref);
  if (tag === null) {
    return `\`${ref}\` names no tag, so it resolves to the mutable \`:latest\``;
  }
  if (!STAMPED_TAG_RE.test(tag)) {
    return `\`${ref}\` uses the mutable tag \`${tag}\``;
  }
  return null;
}

/** Return directory entries only when the directory itself is not a symlink. */
function regularDirectoryEntries(absolute) {
  try {
    if (!lstatSync(absolute).isDirectory()) return [];
    return readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every recipe declared by the canonical container publisher (#3064, #3513).
 * Manifest validation owns path containment and symlink refusal; an invalid
 * inventory returns no scannable files and scopedInputReasons() reports why.
 */
export function listPublishedImageFiles(root = REPO_ROOT) {
  const inspected = inspectContainerImageManifest(root);
  if (inspected.reasons.length) return [];
  const found = inspected.entries.map((entry) => join(root, ...entry.recipe.split('/')));
  // perf-index-contract: published-recipe-order always-consumed: every caller receives this complete deterministic recipe list
  return found.sort();
}

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
 * Secret-context references inside GitHub expressions.
 *
 * Only literal dot/bracket references are inventoryable. `secrets: inherit`,
 * `toJSON(secrets)`, or a computed `secrets[matrix.name]` exposes a capability
 * this static policy cannot bind to one reviewed name, so it is ambiguous and
 * fails closed.
 */
export function workflowSecretReferences(source) {
  const references = [];
  let ambiguous = /^\s*secrets\s*:\s*inherit(?:\s*#.*)?$/im.test(source);
  const expressionPattern = /\$\{\{([\s\S]*?)\}\}/g;
  const literalReferencePattern =
    /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/gi;
  for (const expression of source.matchAll(expressionPattern)) {
    if (!/\bsecrets\b/i.test(expression[1])) continue;
    const remainder = expression[1].replace(
      literalReferencePattern,
      (_match, dottedName, _quote, bracketName) => {
        references.push((dottedName ?? bracketName).toUpperCase());
        return '';
      }
    );
    if (/\bsecrets\b/i.test(remainder)) ambiguous = true;
  }
  return { references, ambiguous };
}

/**
 * Repo-wide publisher capability boundary (#3513).
 *
 * The canonical generated workflow is the only direct workflow allowed to
 * mention GitHub's `packages` permission. Every other workflow must declare an
 * explicit top-level `permissions:` block and must not contain the reserved
 * `packages` token at all. The denial is deliberately lexical and conservative:
 * it may reject benign prose, but it does not try to recognize `make`, bazel,
 * wrappers, composite actions, or any other build syntax. With an explicit
 * permissions ceiling, the built-in token cannot gain package-write authority
 * even if the repository's mutable default permission changes later.
 *
 * Secret references are separately bound to the current workflow/name pairs.
 * That prevents a new shadow workflow from borrowing an existing PAT or deploy
 * key, while making no stronger claim about the scopes of an already allowlisted
 * credential or a pre-authenticated runner.
 */
export function publisherCapabilityReasons(root = REPO_ROOT) {
  const reasons = [];
  for (const pathname of ['.github', '.github/workflows']) {
    const absolute = join(root, ...pathname.split('/'));
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        reasons.push(`${pathname} is a symbolic link; direct workflows must be reviewed bytes`);
        return reasons;
      }
      if (!stat.isDirectory()) {
        reasons.push(`${pathname} is not a directory`);
        return reasons;
      }
    } catch {
      reasons.push(`${pathname} was not found`);
      return reasons;
    }
  }

  const workflowDirectory = join(root, '.github', 'workflows');
  const isYaml = (name) => name.endsWith('.yml') || name.endsWith('.yaml');
  // perf-index-contract: publisher-capability-order always-consumed: every direct workflow is policy-checked once in deterministic path order before the gate can pass
  const entries = readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => isYaml(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const file = `.github/workflows/${entry.name}`;
    const absolute = join(workflowDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      reasons.push(`${file} is a symbolic link; direct workflows must be reviewed bytes`);
      continue;
    }
    if (!entry.isFile()) {
      reasons.push(`${file} is not a regular workflow file`);
      continue;
    }

    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      reasons.push(`${file} could not be read`);
      continue;
    }

    if (file !== CONTAINER_PUBLISH_WORKFLOW) {
      const permissionDeclarations = source
        .split(/\r?\n/)
        .map((line) => /^(\s*)permissions\s*:\s*([^#]*)(?:#.*)?$/.exec(line))
        .filter(Boolean);
      if (!permissionDeclarations.some((match) => match[1] === '')) {
        reasons.push(
          `${file} has no explicit top-level permissions: declaration; noncanonical workflows ` +
            'must not inherit mutable repository token defaults'
        );
      }
      for (const declaration of permissionDeclarations) {
        const scalar = declaration[2].trim();
        if (scalar !== '' && scalar !== '{}' && scalar !== 'read-all') {
          reasons.push(
            `${file} uses unsupported permissions scalar ${scalar}; use a mapping, {}, or read-all ` +
              'so write-all cannot grant implicit package authority'
          );
        }
      }
      if (/\bpackages\b/.test(source)) {
        reasons.push(
          `${file} mentions the reserved packages capability; only ${CONTAINER_PUBLISH_WORKFLOW} ` +
            'may request package authority'
        );
      }
      if (/"[^"\r\n]*\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|U[0-9a-f]{8})[^"\r\n]*"/i.test(source)) {
        reasons.push(
          `${file} contains a double-quoted escape this lexical capability boundary cannot ` +
            'resolve; spell workflow keys and values literally'
        );
      }
    }

    const observed = workflowSecretReferences(source);
    if (observed.ambiguous) {
      reasons.push(`${file} uses a dynamic or inherited secrets context that cannot be inventory-bound`);
    }
    const allowed = WORKFLOW_SECRET_ALLOWLIST[file] ?? [];
    for (const secret of observed.references) {
      if (!allowed.includes(secret)) {
        reasons.push(`${file} references unapproved secret ${secret}`);
      }
    }
    for (const secret of allowed) {
      if (!observed.references.includes(secret)) {
        reasons.push(`${file} no longer references allowlisted secret ${secret}; remove the stale policy entry`);
      }
    }
  }

  return reasons;
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
  for (const entry of regularDirectoryEntries(directory)) {
    if (entry.isFile()) found.push(join(directory, entry.name));
  }
  return found.sort();
}

/**
 * The ARC scale-set values — where the built runner image is finally SELECTED.
 *
 * Flat `deploy/arc/*.yaml` are the spoke installs and `deploy/arc/hub/*.yaml`
 * mirror them on the hub. `runner-image/` is deliberately excluded: it is scanned
 * by listRunnerImageFiles with the stricter base-image rules.
 *
 * Enumerated by DIRECTORY rather than by a list of the four known filenames, so a
 * fifth scale set added later is scanned the day it lands instead of the day
 * somebody remembers to add it here.
 */
export function listRunnerPoolFiles(root = REPO_ROOT) {
  const found = [];
  const isYaml = (name) => name.endsWith('.yml') || name.endsWith('.yaml');
  for (const directory of [join(root, 'deploy', 'arc'), join(root, 'deploy', 'arc', 'hub')]) {
    for (const entry of regularDirectoryEntries(directory)) {
      if (entry.isFile() && isYaml(entry.name)) found.push(join(directory, entry.name));
    }
  }
  // perf-index-contract: runner-pool-order always-consumed: every caller receives this complete deterministic pool-file list
  return found.sort();
}

/**
 * One fail-closed policy for the three image-input walker families (#3506).
 *
 * The walkers refuse symlinks rather than following targets outside the
 * reviewed worktree. Every skipped symlink in a scanned shape is named here so
 * `main()` exits non-zero instead of turning "not checked" into "checked clean".
 */
export function scopedInputReasons(root = REPO_ROOT) {
  const reasons = [
    ...publisherWorkflowDriftReasons(root),
    ...publisherCapabilityReasons(root),
  ];
  const relativePath = (absolute) => relative(root, absolute).split(sep).join('/');
  const refuse = (absolute) => {
    reasons.push(
      `scoped input ${relativePath(absolute)} is a symbolic link; this gate only checks ` +
        'regular files inside the reviewed worktree'
    );
  };

  const runnerDirectory = join(root, 'deploy', 'arc', 'runner-image');
  try {
    if (lstatSync(runnerDirectory).isSymbolicLink()) refuse(runnerDirectory);
    else {
      for (const entry of regularDirectoryEntries(runnerDirectory)) {
        if (entry.isSymbolicLink()) refuse(join(runnerDirectory, entry.name));
      }
    }
  } catch {
    // The existing inertness check reports an absent runner-image directory.
  }

  const isYaml = (name) => name.endsWith('.yml') || name.endsWith('.yaml');
  for (const directory of [join(root, 'deploy', 'arc'), join(root, 'deploy', 'arc', 'hub')]) {
    try {
      if (lstatSync(directory).isSymbolicLink()) {
        refuse(directory);
        continue;
      }
      for (const entry of regularDirectoryEntries(directory)) {
        if (entry.isSymbolicLink() && isYaml(entry.name)) refuse(join(directory, entry.name));
      }
    } catch {
      // The existing inertness check reports an absent pool directory.
    }
  }

  // perf-index-contract: scoped-input-reason-order always-consumed: every caller receives all unique refusal reasons in deterministic order
  return [...new Set(reasons)].sort();
}

/**
 * Scale-set values: every container image must be digest-pinned or
 * version-stamped (#3340).
 */
export function poolViolationsIn(source) {
  const problems = [];
  for (const { number, text } of logicalLines(source)) {
    const imageMatch = VALUES_IMAGE_RE.exec(text);
    if (!imageMatch) continue;
    const raw = imageMatch[1];
    const ref = unquote(raw);
    if (ref === '') {
      // Fail closed: the reference is legal YAML on the next line, but this
      // scanner cannot see it, and "cannot verify" must not read as "verified".
      problems.push({
        line: number,
        rule: 'STAMP',
        detail: 'the `image:` value is not on the same line, so it cannot be checked here',
      });
      continue;
    }
    const unparseable = unparseableImageValue(ref);
    if (unparseable) {
      problems.push({ line: number, rule: 'STAMP', detail: unparseable });
      continue;
    }
    const detail = imageRefProblem(ref);
    if (detail) problems.push({ line: number, rule: 'STAMP', detail });
  }
  return problems;
}

/**
 * Every container and initContainer under a `template.spec` must DECLARE an
 * `image:` (#3493).
 *
 * `poolViolationsIn` above is a line scanner: it can only judge the image
 * references that are PRESENT, so a container whose `image:` line is deleted
 * outright has nothing for it to flag. That case is not benign — the
 * gha-runner-scale-set chart substitutes its own default,
 * `ghcr.io/actions/actions-runner:latest`, for any container that omits
 * `template.spec.containers[].image`. So an ABSENT line reintroduces the #3340
 * defect (a mutable upstream tag on a privileged, credential-bearing runner)
 * reached by absence rather than by a bad value, and the line scan stays green.
 *
 * The four scale-set values files are known-shape Helm values with no block
 * scalars in the container region, so a minimal indentation reader is enough —
 * no YAML parser is added to this gate's node-builtin-only path (the constraint
 * #3493 sets, so a gate that cries wolf on valid files never gets disabled).
 * Returns the STARTING line of any container list item that declares no image.
 */
const CONTAINER_KEYS = new Set(['containers', 'initContainers']);

export function containerImageAbsences(source) {
  const problems = [];
  const lines = source.split(/\r?\n/);
  const indentOf = (s) => s.length - s.trimStart().length;

  // A lightweight indentation path of plain `key:` mappings, so a `containers:`
  // key is only acted on when it sits at `template.spec.containers` (not, say,
  // some unrelated `containers:` elsewhere in a values file).
  const stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = indentOf(raw);
    const trimmed = raw.trim();
    // List items (`- ...`) do not move the mapping path; they are handled by
    // the sequence scan below.
    const keyMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (!CONTAINER_KEYS.has(key) || rest.trim() !== '') continue;
    const path = stack.map((e) => e.key).join('.');
    if (!path.endsWith(`template.spec.${key}`)) continue;
    collectSequenceImageAbsences(lines, i + 1, indent, key, problems);
  }
  return problems;
}

/**
 * Scan the block sequence that follows a `containers:`/`initContainers:` key at
 * `keyIndent`, appending a problem for every list item that declares no `image:`
 * at the item's own key indentation. Markers nested deeper than the item level
 * (an `env:`/`args:` sub-sequence) are data, not new container entries.
 */
function collectSequenceImageAbsences(lines, start, keyIndent, containerKind, problems) {
  const indentOf = (s) => s.length - s.trimStart().length;
  let markerIndent = null;
  let itemStartLine = null;
  let itemKeyIndent = null;
  let itemHasImage = false;

  const flush = () => {
    if (itemStartLine !== null && !itemHasImage) {
      problems.push({
        line: itemStartLine,
        rule: 'STAMP',
        detail:
          `a \`${containerKind}\` entry declares no \`image:\`, so the gha-runner-scale-set ` +
          'chart substitutes its mutable `ghcr.io/actions/actions-runner:latest` default',
      });
    }
  };

  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = indentOf(raw);
    if (indent <= keyIndent) break; // dedent out of the sequence (sibling key)
    const trimmed = raw.trim();
    const isMarker = trimmed === '-' || /^-\s/.test(trimmed);

    if (isMarker && (markerIndent === null || indent === markerIndent)) {
      if (markerIndent === null) markerIndent = indent;
      flush(); // close the previous item
      itemStartLine = i + 1;
      itemKeyIndent = indent + 2; // past the `- `
      itemHasImage = false;
      const afterDash = trimmed.replace(/^-\s*/, '');
      const inlineKey = /^([A-Za-z0-9_.-]+):/.exec(afterDash);
      if (inlineKey && inlineKey[1] === 'image') itemHasImage = true;
      continue;
    }
    // A direct key of the current item (not a nested sub-map/sequence).
    if (itemStartLine !== null && indent === itemKeyIndent) {
      const k = /^([A-Za-z0-9_.-]+):/.exec(trimmed);
      if (k && k[1] === 'image') itemHasImage = true;
    }
  }
  flush();
}

/**
 * Every non-digest image reference in a values file, with its line.
 *
 * Digest-pinned references are skipped: a digest already names exact bytes, so
 * there is no stamp for it to agree with.
 */
export function poolImageRefsIn(source) {
  const refs = [];
  for (const { number, text } of logicalLines(source)) {
    const match = VALUES_IMAGE_RE.exec(text);
    if (!match || match[1] === '') continue;
    const ref = unquote(match[1]);
    // Reported by poolViolationsIn; never counted as a verified consumer.
    if (ref === '' || unparseableImageValue(ref)) continue;
    if (IMAGE_DIGEST_RE.test(ref)) continue;
    refs.push({
      line: number,
      ref,
      name: imageRefName(ref),
      repository: imageRefRepository(ref),
      tag: imageRefTag(ref),
    });
  }
  return refs;
}

/** Image-bearing BuildConfig paths this gate understands structurally. */
const BUILD_CONFIG_IMAGE_PATHS = Object.freeze({
  'spec.output.to.name': 'output',
  'spec.strategy.dockerStrategy.from.name': 'from',
});

/**
 * Resolve only image-bearing BuildConfig `name:` fields (#3509).
 *
 * A context-free `name:` scan cannot distinguish these fields from
 * `metadata.name`. The indentation path makes that distinction, while alternate
 * YAML spellings the reader cannot safely resolve become explicit findings.
 */
export function buildConfigImageFieldsIn(source) {
  const fields = [];
  const problems = [];
  const stack = [];
  let blockScalarIndent = null;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;

    // The BuildConfig inlines the whole Dockerfile under `dockerfile: |`. Its
    // contents are DATA, not structure, so they must not move the path stack.
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }

    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;

    // Plain `key:` mappings only. A `- name:` list entry is not on this path,
    // and treating it as one is how an input gets mistaken for the output.
    const keyMatch = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(trimmed);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });

    const rawValue = (rest ?? '').replace(/\s+#.*$/, '').trim();
    if (/^[|>]/.test(rawValue)) blockScalarIndent = indent;
    if (key !== 'name') continue;
    const path = stack.map((entry) => entry.key).join('.');
    const kind = BUILD_CONFIG_IMAGE_PATHS[path];
    if (!kind) continue;

    const rule = kind === 'output' ? 'STAMP' : 'PIN';
    if (rawValue === '') {
      problems.push({
        line: index + 1,
        rule,
        detail: `BuildConfig ${path} is not on the same line, so it cannot be checked here`,
      });
      continue;
    }
    const value = unquote(rawValue);
    const unparseable = unparseableImageValue(value);
    if (unparseable) {
      problems.push({
        line: index + 1,
        rule,
        detail: `BuildConfig ${path} ${unparseable}`,
      });
      continue;
    }
    fields.push({ line: index + 1, path, kind, value });
  }
  return { fields, problems };
}

/**
 * The BuildConfig OUTPUT ImageStreamTag — the tag this cluster build actually
 * produces, and therefore the one every consumer has to be naming.
 */
export function producerTagsIn(source) {
  const produced = [];
  for (const field of buildConfigImageFieldsIn(source).fields) {
    if (field.kind !== 'output') continue;
    if (REGISTRY_REF_RE.test(field.value) || !IMAGE_STREAM_TAG_RE.test(field.value)) continue;
    produced.push({ line: field.line, name: imageRefName(field.value), tag: imageRefTag(field.value) });
  }
  return produced;
}

/**
 * Cross-file rule: producer and consumers must name ONE shared stamp (#3340).
 *
 * Checking each reference in isolation is not enough, and the gap is not
 * theoretical: bumping the BuildConfig to a new stamp while leaving one runner
 * or init container on the old one produces two individually well-formed
 * references, so a per-line rule passes both. The cluster outcome is a pool
 * split across stale tooling, or a pod pointed at a tag that was never built —
 * ImagePullBackOff. deploy/arc/README.md tells operators the gate catches a
 * missed update, so the gate has to actually catch it.
 *
 * The producer is the anchor when one exists, because its tag is the one that
 * will exist in the registry. With no producer in the tree, consumers must at
 * least agree with each other.
 */
export function crossFileStampOffenders(producers, consumers) {
  const offenders = [];
  const names = new Set(consumers.map((consumer) => consumer.name));
  for (const name of names) {
    const group = consumers.filter((consumer) => consumer.name === name);
    const matching = producers.filter((candidate) => candidate.name === name);
    const producer = matching[0];

    // Ambiguous producers: two build outputs for one image naming different
    // tags. Picking the first would make the anchor depend on file order, so
    // whichever one the consumers happened to match would report success.
    if (new Set(matching.map((candidate) => candidate.tag)).size > 1) {
      for (const consumer of group) {
        offenders.push({
          file: consumer.file,
          line: consumer.line,
          rule: 'STAMP',
          detail:
            `\`${name}\` has more than one build output tag ` +
            `(${matching.map((candidate) => `\`${candidate.tag}\``).join(', ')}), so there is no ` +
            'single stamp to verify against',
        });
      }
      continue;
    }

    // No local producer means nothing in this repo builds the image, so a stamp
    // asserts nothing and there is no tag to agree with. Anchoring on the first
    // consumer instead would only prove the consumers agree with each other —
    // success reported for a state the rule claims to reject. An image this repo
    // does not build has the digest rung available and must use it.
    if (!producer) {
      for (const consumer of group) {
        offenders.push({
          file: consumer.file,
          line: consumer.line,
          rule: 'STAMP',
          detail:
            `no BuildConfig in this repo produces \`${name}\`, so its stamp cannot be ` +
            'verified against anything. Pin an externally built image by digest instead',
        });
      }
      continue;
    }

    const expected = `${INTERNAL_REGISTRY_NAMESPACE}/${name}`;
    for (const consumer of group) {
      if (consumer.repository !== expected) {
        offenders.push({
          file: consumer.file,
          line: consumer.line,
          rule: 'STAMP',
          detail:
            `\`${consumer.repository}\` is not the repository the BuildConfig publishes to ` +
            `(\`${expected}\`). A matching basename and a valid stamp do not make it the same ` +
            'image',
        });
        continue;
      }
      if (consumer.tag !== producer.tag) {
        offenders.push({
          file: consumer.file,
          line: consumer.line,
          rule: 'STAMP',
          detail:
            `\`${name}:${consumer.tag}\` does not match the build output tag in ` +
            `${producer.file} (\`${producer.tag}\`). Producer and every consumer must name ` +
            'one shared stamp',
        });
      }
    }
  }
  return offenders;
}

/**
 * The chd-ci-runner stamp must name the exact reviewed recipe bytes (#3498,
 * #3504), not merely resemble a stamp. The eight-hex suffix is the first eight
 * characters of the Dockerfile SHA-256, matching the documented operator
 * command and remaining computable before a squash merge.
 */
export function runnerRecipeStampOffenders(recipeSource, producers) {
  const expectedHex = createHash('sha256')
    .update(recipeSource)
    .digest('hex')
    .slice(0, 8);
  const offenders = [];
  for (const producer of producers) {
    if (producer.name !== 'chd-ci-runner') continue;
    const match = /^v\d{4}-\d{2}-\d{2}-([0-9a-f]{8})$/u.exec(
      producer.tag ?? ''
    );
    if (match?.[1] === expectedHex) continue;
    offenders.push({
      file: producer.file,
      line: producer.line,
      rule: 'STAMP',
      detail:
        `\`${producer.tag}\` does not identify the runner recipe content; ` +
        `the committed Dockerfile requires the eight-hex suffix \`${expectedHex}\``,
    });
  }
  return offenders;
}

function inlinedRunnerRecipe(source) {
  const lines = source.split(/\r?\n/u);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)dockerfile:\s*\|\s*$/u.exec(lines[index]);
    if (match) starts.push({ index, indent: match[1].length });
  }
  if (starts.length !== 1) return null;
  const [{ index, indent }] = starts;
  const block = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    block.push(line);
  }
  const contentIndent = indent + 2;
  if (
    !block.some((line) => line.trim() !== '') ||
    block.some(
      (line) =>
        line.trim() !== '' &&
        line.length - line.trimStart().length < contentIndent
    )
  ) {
    return null;
  }
  return {
    line: index + 1,
    source: block
      .map((line) => (line.trim() === '' ? '' : line.slice(contentIndent)))
      .join('\n') + '\n',
  };
}

/**
 * OpenShift builds spec.source.dockerfile, so the committed Dockerfile can be a
 * stamp source only when every byte is the same after removing the YAML block's
 * two-space structural indentation. This deliberately preserves comments,
 * heredoc contents, and all recipe whitespace.
 */
export function runnerRecipeParityOffenders(
  dockerfileSource,
  buildConfigSource
) {
  const inline = inlinedRunnerRecipe(buildConfigSource);
  if (inline && inline.source === dockerfileSource) {
    return [];
  }
  return [
    {
      file: 'deploy/arc/runner-image/buildconfig.yaml',
      line: inline?.line ?? 1,
      rule: 'STAMP',
      detail:
        'the authoritative BuildConfig inline recipe does not match the hashed Dockerfile shadow copy',
    },
  ];
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
  const parsedBuildConfig = buildConfigImageFieldsIn(source);
  const problems = [...parsedBuildConfig.problems];
  for (const { number, text } of logicalLines(source)) {
    const fromMatch = /(?:^|\s)FROM\s+(\S+)/.exec(text);
    const fromValue = fromMatch ? unquote(fromMatch[1]) : null;
    if (fromValue && fromValue !== 'scratch' && !IMAGE_DIGEST_RE.test(fromValue)) {
      problems.push({
        line: number,
        rule: 'PIN',
        detail: `base image \`${fromValue}\` is not pinned to an image digest`,
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

  for (const { line, value } of parsedBuildConfig.fields) {
    if (REGISTRY_REF_RE.test(value) && !IMAGE_DIGEST_RE.test(value)) {
      problems.push({
        line,
        rule: 'PIN',
        detail: `image reference \`${value}\` is not pinned to an image digest`,
      });
    }

    // The BuildConfig output is the other half of #3340: a mutable local tag
    // keeps a moving producer alive even when every consumer is stamped.
    if (
      !REGISTRY_REF_RE.test(value) &&
      IMAGE_STREAM_TAG_RE.test(value) &&
      !STAMPED_TAG_RE.test(imageRefTag(value) ?? '')
    ) {
      problems.push({
        line,
        rule: 'STAMP',
        detail: `local ImageStream reference \`${value}\` names a mutable tag`,
      });
    }
  }
  return problems;
}

/**
 * Self-check: the gate must be able to SEE what it claims to check.
 *
 * Both directory walkers swallow a missing directory and return an empty list,
 * which is right for a reusable scanner but dangerous for a control: with no
 * files found there is nothing to report, so the gate prints success and exits 0
 * having verified nothing. The cross-file rule degrades the same way one step
 * further in — with no producer found, the anchor silently falls back to the
 * first consumer, so the "producer and consumers agree" claim becomes "the
 * consumers agree with themselves".
 *
 * Both are the green-but-inert failure this gate exists to prevent elsewhere, so
 * the real-repo entry point asserts its own inputs are present. Kept out of
 * scanRepository, which is deliberately reusable against synthetic roots that
 * hold only the files a given test cares about.
 */
export function inertnessReasons(root = REPO_ROOT) {
  const reasons = scopedInputReasons(root);
  if (listWorkflowFiles(root).length === 0) {
    reasons.push('no workflow or composite-action files were found under .github/');
  }
  if (listPublishedImageFiles(root).length === 0) {
    reasons.push('no required root published-image recipes were found');
  }
  if (listRunnerImageFiles(root).length === 0) {
    reasons.push('no runner-image build files were found under deploy/arc/runner-image/');
  }
  const poolFiles = listRunnerPoolFiles(root);
  if (poolFiles.length === 0) {
    reasons.push('no ARC scale-set values files were found under deploy/arc/');
    return reasons;
  }

  const producers = listRunnerImageFiles(root).flatMap((absolute) =>
    producerTagsIn(readFileSync(absolute, 'utf8'))
  );
  const consumers = poolFiles.flatMap((absolute) => poolImageRefsIn(readFileSync(absolute, 'utf8')));
  const anchored = consumers.some((consumer) =>
    producers.some((producer) => producer.name === consumer.name)
  );
  if (!anchored) {
    reasons.push(
      'no scale-set image matched a BuildConfig output tag, so the producer-to-consumer ' +
        'stamp check had nothing to anchor on and verified nothing'
    );
  }
  return reasons;
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
  for (const absolute of listPublishedImageFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    for (const problem of imageViolationsIn(readFileSync(absolute, 'utf8'))) {
      offenders.push({ file, ...problem });
    }
  }
  for (const absolute of listRunnerPoolFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    const source = readFileSync(absolute, 'utf8');
    for (const problem of poolViolationsIn(source)) {
      offenders.push({ file, ...problem });
    }
    // #3493: a container whose `image:` line is absent takes the chart default
    // (`:latest`) — the line scan above cannot see a missing line, so check the
    // container list structurally.
    for (const problem of containerImageAbsences(source)) {
      offenders.push({ file, ...problem });
    }
  }

  // Cross-file: one shared stamp across producer and every consumer (#3340).
  const producers = [];
  for (const absolute of listRunnerImageFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    for (const produced of producerTagsIn(readFileSync(absolute, 'utf8'))) {
      producers.push({ file, ...produced });
    }
  }
  const consumers = [];
  for (const absolute of listRunnerPoolFiles(root)) {
    const file = relative(root, absolute).split(sep).join('/');
    for (const consumed of poolImageRefsIn(readFileSync(absolute, 'utf8'))) {
      consumers.push({ file, ...consumed });
    }
  }
  offenders.push(...crossFileStampOffenders(producers, consumers));
  try {
    const recipe = readFileSync(
      join(root, 'deploy', 'arc', 'runner-image', 'Dockerfile'),
      'utf8'
    );
    const buildConfig = readFileSync(
      join(root, 'deploy', 'arc', 'runner-image', 'buildconfig.yaml'),
      'utf8'
    );
    offenders.push(...runnerRecipeParityOffenders(recipe, buildConfig));
    offenders.push(...runnerRecipeStampOffenders(recipe, producers));
  } catch {
    // The existing inertness check reports an absent runner recipe/build file.
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
  STAMP:
    'Use a version-stamped tag `v<YYYY>-<MM>-<DD>-<hex>`, deriving the hex from the RECIPE CONTENT ' +
    'and NOT from the commit that introduces the bump — a commit cannot contain its own SHA, so ' +
    'that is not an instruction anyone can follow. Compute it with `sha256sum ' +
    'deploy/arc/runner-image/Dockerfile | cut -c1-8`, prefixed by the UTC date, e.g. ' +
    '`image-registry.openshift-image-registry.svc:5000/arc-runners/chd-ci-runner:v2026-07-30-11fcdc8c`. ' +
    'A digest would be stronger but is not available here: chd-ci-runner is an ImageStream in each ' +
    "cluster's own internal registry, so its digest differs hub vs spoke and no single committed " +
    'value is correct for both. Bump the stamp in deploy/arc/runner-image/buildconfig.yaml AND in ' +
    'every scale-set values file in the same reviewed change, then rebuild and `helm upgrade` — see ' +
    'deploy/arc/README.md "Rebuilding the runner image" (#3340).',
};

function main() {
  // Fail closed if the gate cannot see its own inputs — a control that verified
  // nothing must not report success.
  const inert = inertnessReasons();
  for (const reason of inert) {
    console.error(`::error::[INERT] ${reason}. The gate cannot pass without checking something.`);
  }
  if (inert.length) {
    process.exit(1);
  }

  const offenders = scanRepository();
  for (const { file, line, rule, detail } of offenders) {
    console.error(`::error file=${file},line=${line}::[${rule}] ${detail}. ${REMEDY[rule]}`);
  }
  if (offenders.length) {
    process.exit(1);
  }
  const published = listPublishedImageFiles();
  const scanned =
    listWorkflowFiles().length + published.length + listRunnerImageFiles().length + listRunnerPoolFiles().length;
  console.log(
    `Action pins OK: ${scanned} scoped file(s), including published recipes ` +
      `[${published.map((absolute) => relative(REPO_ROOT, absolute)).join(', ')}] — every external ` +
      '`uses:` and scanned base image is pinned to an immutable ref, every runner-pool image ' +
      'is digest-pinned or version-stamped, no step pipes a download into an interpreter, and ' +
      'only the canonical generated workflow can request package authority.'
  );
}

// Resolve through symlinks before comparing (the house pattern, see
// check-shell-quote.mjs). A gate whose main() silently fails to fire exits 0 and
// reports nothing — green CI proving nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
