/**
 * Contained, symlink-refusing atomic writes for host-side generator scripts
 * (#3079, #3080).
 *
 * The read-side twin of this module is `src/lib/bounded-fs.ts`, which hardens
 * artifact *reads* (lstat + O_NOFOLLOW + inode identity). The producers that
 * write those artifacts had the mirror-image defect: each built a *predictable*
 * temp path (`<out>.tmp-<pid>`) and wrote it with `writeFileSync`, which follows
 * a symlink already sitting at that path and clobbers whatever it points at —
 * and none checked that the output directory itself stays inside the tree it is
 * supposed to write to. Patching each producer with its own copy would drift, so
 * the two guarantees live here and the producers call in.
 *
 *   1. `ensureContainedDirSync` — the destination directory must resolve to a
 *      real directory strictly beneath a declared root, with NO symlinked
 *      component along the way. A `..`/absolute output, or a repo-controlled
 *      symlink (`data -> /elsewhere`), is refused before a byte is written; a
 *      normal in-root destination is created (each missing level made with a
 *      plain, non-following `mkdir`).
 *   2. `atomicWriteFileExclusiveSync` — the temp file is created with `wx`
 *      (`O_WRONLY | O_CREAT | O_EXCL`), so an entry already present at the temp
 *      path — including a pre-seeded symlink — makes the open fail with `EEXIST`
 *      rather than redirecting the write through the link. The final mode is set
 *      on the descriptor (`fchmod`), never via a second path-based `chmod` that
 *      races a swap. Callers that want an unguessable temp omit `tempPath` and
 *      get a random one; callers that must keep a predictable name (so a
 *      pre-seeded symlink is provably refused) pass it explicitly.
 */
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** True when `child` is `root` itself or lies strictly beneath it (lexical). */
export function isPathInside(root, child) {
  const r = resolve(root);
  const c = resolve(child);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Validate and (safely) create a destination directory contained in `root`.
 *
 * Refuses:
 *   - a destination that lexically escapes `root` (e.g. via `..` or an absolute
 *     path outside it),
 *   - any existing symlinked component between `root` and the destination (a
 *     `data -> /elsewhere` redirect), and
 *   - a fully-resolved destination whose realpath lands outside the real `root`.
 *
 * Missing levels are created one at a time with a plain `mkdir` (never
 * `recursive` through an unchecked parent). Returns the validated destination
 * directory (the lexical path, so the caller's output path is preserved
 * verbatim); throws otherwise.
 */
export function ensureContainedDirSync(destDir, root) {
  const rootResolved = resolve(root);
  const destResolved = resolve(destDir);
  if (!isPathInside(rootResolved, destResolved)) {
    throw new Error(
      `refusing write: output directory ${destResolved} is outside root ${rootResolved}`
    );
  }
  // `root` must already exist as a real directory — it is the boundary.
  const rootStat = lstatSync(rootResolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`refusing write: root ${rootResolved} is not a real directory`);
  }
  const rel = relative(rootResolved, destResolved);
  let cur = rootResolved;
  if (rel !== '') {
    for (const segment of rel.split(sep)) {
      cur = join(cur, segment);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        // Parent is already verified real and non-symlink; create this level.
        mkdirSync(cur);
        continue;
      }
      if (st.isSymbolicLink()) {
        throw new Error(`refusing write: symlinked path component ${cur}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`refusing write: ${cur} exists and is not a directory`);
      }
    }
  }
  // Defence in depth: the resolved destination must still sit under the real
  // root even after canonicalization.
  const realRoot = realpathSync(rootResolved);
  const realDest = realpathSync(cur);
  if (!isPathInside(realRoot, realDest)) {
    throw new Error(
      `refusing write: output directory resolves outside root ${realRoot}`
    );
  }
  return destResolved;
}

/** An unguessable temp path beside `finalPath`, hidden and same-directory. */
function randomTempPath(finalPath) {
  return join(
    dirname(finalPath),
    `.${basename(finalPath)}.tmp-${randomBytes(12).toString('hex')}`
  );
}

/**
 * Atomically write `content` to `finalPath` through an exclusively-created temp
 * file, then rename.
 *
 * @param {string} finalPath      destination path (its directory must exist)
 * @param {string|Buffer} content bytes to write
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600]  creation mode for the temp descriptor
 * @param {number} [opts.finalMode]   if set, `fchmod` the descriptor to this
 *                                     before rename (race-free vs. path chmod)
 * @param {string} [opts.tempPath]    explicit (predictable) temp path; when
 *                                     omitted an unguessable one is used
 * @returns {string} `finalPath`
 */
export function atomicWriteFileExclusiveSync(
  finalPath,
  content,
  { mode = 0o600, finalMode, tempPath } = {}
) {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const temp = tempPath ?? randomTempPath(finalPath);
  let fd;
  try {
    // 'wx' == O_WRONLY | O_CREAT | O_EXCL: the create is atomic and refuses to
    // open anything already at `temp`, so a pre-seeded symlink fails with EEXIST
    // here rather than redirecting the write through the link.
    fd = openSync(temp, 'wx', mode);
  } catch (err) {
    // We never created `temp`; do NOT remove it — a pre-seeded symlink is state
    // we do not own, and unlinking it would still perturb the attacker's setup.
    throw err;
  }
  try {
    writeSync(fd, buf);
    if (finalMode !== undefined) fchmodSync(fd, finalMode);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    renameSync(temp, finalPath);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  return finalPath;
}
