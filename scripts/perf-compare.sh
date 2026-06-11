#!/usr/bin/env bash
# Compare /api/dataset.json TTFB across two URLs (baseline vs PR build).
# Usage: scripts/perf-compare.sh URL_BASELINE URL_PR
set -euo pipefail

BASE="${1:?baseline URL}"
PR="${2:?PR URL}"

probe() {
  local url="$1"
  # 5 cold-ish hits — server side ingest re-runs each time because 1-2 live
  # transcripts mtime-bump constantly, so this is a fair "first data" measure.
  local times=()
  for _ in 1 2 3 4 5; do
    local t
    t=$(curl -sS -o /dev/null -H "Accept-Encoding: br" --compressed \
         -w "%{time_total}" "$url/api/dataset.json")
    times+=("$t")
  done
  IFS=$'\n' sorted=($(printf "%s\n" "${times[@]}" | sort -n))
  unset IFS
  local med="${sorted[2]}"
  echo "$med"
}

base_med=$(probe "$BASE")
pr_med=$(probe "$PR")

awk -v b="$base_med" -v p="$pr_med" 'BEGIN {
  delta = b - p
  pct = (b > 0) ? (delta / b * 100) : 0
  printf "baseline median: %.3f s\n", b
  printf "PR       median: %.3f s\n", p
  printf "delta          : %+.3f s (%+.1f%%)\n", delta, pct
}'
