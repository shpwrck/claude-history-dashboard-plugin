#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLAUDE_DIR="${HOME}/.claude"
PUB="${PROJECT_DIR}/public"

echo "Syncing Claude Code data..."
mkdir -p "${PUB}"

# 1. Symlink history.jsonl (top-level metadata)
if [ -f "${CLAUDE_DIR}/history.jsonl" ]; then
  ln -sf "${CLAUDE_DIR}/history.jsonl" "${PUB}/history.jsonl"
  echo "  Linked history.jsonl"
else
  echo "  Warning: ${CLAUDE_DIR}/history.jsonl not found"
fi

# 2. For each session, write a SINGLE combined JSONL into public/projects/<proj>/<sessionUUID>.jsonl
#    that concatenates the top-level session file with every subagent file under
#    <proj>/<sessionUUID>/subagents/*.jsonl. The dashboard's parsers run once per
#    file and dedup by sessionId, so pre-merging is what makes subagent activity
#    (Explore, general-purpose, Plan, etc.) get counted toward the parent session's
#    token/tool/cost stats instead of being dropped.
if [ -d "${CLAUDE_DIR}/projects" ]; then
  # Fresh state — prevents stale combined files if upstream sessions are deleted.
  rm -rf "${PUB}/projects"
  mkdir -p "${PUB}/projects"

  MANIFEST="${PUB}/sessions-manifest.json"
  : > "${MANIFEST}.tmp"
  session_count=0
  subagent_lines_total=0
  first=1

  printf '[\n' > "${MANIFEST}.tmp"
  for proj_dir in "${CLAUDE_DIR}/projects/"*/; do
    [ -d "${proj_dir}" ] || continue
    proj_name="$(basename "${proj_dir}")"
    mkdir -p "${PUB}/projects/${proj_name}"

    shopt -s nullglob
    for jsonl in "${proj_dir}"*.jsonl; do
      session_id="$(basename "${jsonl}" .jsonl)"
      out="${PUB}/projects/${proj_name}/${session_id}.jsonl"
      cat "${jsonl}" > "${out}"

      sa_dir="${proj_dir}${session_id}/subagents"
      if [ -d "${sa_dir}" ]; then
        for sa in "${sa_dir}"/*.jsonl; do
          [ -f "${sa}" ] || continue
          subagent_lines_total=$(( subagent_lines_total + $(wc -l < "${sa}") ))
          cat "${sa}" >> "${out}"
        done
      fi

      url_path="/projects/${proj_name}/${session_id}.jsonl"
      [ $first -eq 1 ] || printf ',\n' >> "${MANIFEST}.tmp"
      first=0
      printf '  {"name": "%s", "project": "%s", "path": "%s"}' \
        "${session_id}.jsonl" "${proj_name}" "${url_path}" >> "${MANIFEST}.tmp"
      session_count=$((session_count + 1))
    done
    shopt -u nullglob
  done
  printf '\n]\n' >> "${MANIFEST}.tmp"
  mv "${MANIFEST}.tmp" "${MANIFEST}"

  echo "  Indexed ${session_count} session(s), merged ${subagent_lines_total} subagent line(s)"
else
  echo "  Warning: ${CLAUDE_DIR}/projects/ not found"
fi

echo
echo "Done. To pick up changes:"
echo "  npx vite build && systemctl --user restart claude-history-dashboard"
