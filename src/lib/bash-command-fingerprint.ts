/**
 * Stable FNV-1a fingerprint stored alongside stripped Bash command previews.
 * The length suffix makes truncation detectable; the hash makes same-length
 * newline flattening detectable.
 */
export function bashCommandFingerprint(command: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < command.length; i += 1) {
    hash ^= command.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}:${command.length}`;
}
