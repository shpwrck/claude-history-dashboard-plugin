#!/usr/bin/env bash
# Probe the running dashboard for first-data latency.
# Usage: scripts/perf-probe.sh [URL]   (default http://127.0.0.1:5173)
set -euo pipefail

URL="${1:-http://127.0.0.1:5173}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

probe() {
  local label="$1"; shift
  local out="$TMP/$label.body"
  local hdr="$TMP/$label.hdr"
  curl -sS -D "$hdr" -o "$out" \
       -w "time_total=%{time_total}\nsize_download=%{size_download}\nhttp_code=%{http_code}\n" \
       "$@" "$URL/api/dataset.json"
  echo "--- $label headers ---"
  grep -i -E '^(X-Ingest|X-Source|ETag|Content-Length|Content-Encoding|Cache-Control|HTTP/)' "$hdr" || true
  echo
}

echo "## /api/dataset.json baseline probe @ $(date -Iseconds)"
echo

echo "### Hit 1 — identity"
probe identity -H "Accept-Encoding: "
echo
echo "### Hit 2 — brotli"
probe br -H "Accept-Encoding: br" --compressed
echo
ETAG=$(grep -i '^ETag:' "$TMP/br.hdr" | awk '{print $2}' | tr -d '\r')
echo "### Hit 3 — brotli + If-None-Match ($ETAG)"
probe inm -H "Accept-Encoding: br" -H "If-None-Match: $ETAG" --compressed
echo

echo "### Static index.html"
curl -sS -o /dev/null -w "time_total=%{time_total}\nsize_download=%{size_download}\n" "$URL/"
