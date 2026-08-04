#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

docker run --rm --entrypoint sh "$image" -c \
  'test -f /workspace/apps/web/scripts/managed-runpod-worker.ts && test -f /workspace/apps/web/package.json && node --import tsx --eval "import(\"./apps/web/scripts/managed-runpod-worker.ts\").catch((error) => { if (!String(error).includes(\"DATABASE_URL\")) process.exitCode = 1; })"'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'RunPod worker image smoke passed\n'
