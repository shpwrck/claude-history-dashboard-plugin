#!/usr/bin/env bash
#
# Push image refs (read from stdin, one per line) with bounded retries, to ride
# out transient GHCR push failures.
#
# Why this exists: docker-publish builds four images with the classic builder and
# pushes each tag with a plain `docker push`. GHCR intermittently fails a push
# mid-stream with errors like "unknown blob" or "blob upload unknown" — the
# registry briefly reports a layer (often a base layer shared with a
# sibling image and cross-mounted) as absent while its upload settles. It is a
# registry-side race, not a build error: re-running the push re-checks and
# re-uploads the missing blob and then succeeds. A single flake currently fails
# the whole publish, leaving :latest/:sha tags partially pushed.
#
# Usage:
#   printf '%s\n' "$TAGS" | scripts/docker-push-retry.sh
# Env:
#   PUSH_ATTEMPTS  max attempts per ref (default 5)
#   PUSH_BACKOFF   base backoff seconds, linear: n*BACKOFF (default 10)
set -uo pipefail

attempts="${PUSH_ATTEMPTS:-5}"
backoff="${PUSH_BACKOFF:-10}"
rc=0

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  n=1
  while true; do
    if docker push "$ref"; then
      break
    fi
    if [ "$n" -ge "$attempts" ]; then
      echo "::error::docker push ${ref} failed after ${attempts} attempts"
      rc=1
      break
    fi
    delay=$(( n * backoff ))
    echo "::warning::docker push ${ref} failed (attempt ${n}/${attempts}); retrying in ${delay}s"
    sleep "$delay"
    n=$(( n + 1 ))
  done
done

exit "$rc"
