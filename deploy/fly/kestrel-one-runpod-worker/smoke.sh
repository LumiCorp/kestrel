#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

docker run --rm --entrypoint sh "$image" -c '
  test -f /workspace/apps/web/scripts/managed-runpod-worker.ts
  test -f /workspace/apps/web/package.json
  output="$(node --conditions=react-server --import tsx scripts/managed-runpod-worker.ts 2>&1)" && {
    echo "RunPod worker unexpectedly started without a database" >&2
    exit 1
  }
  case "$output" in
    *"DATABASE_URL or POSTGRES_URL is required"*) ;;
    *)
      printf "%s\n" "$output" >&2
      exit 1
      ;;
  esac
'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'RunPod worker image smoke passed\n'
