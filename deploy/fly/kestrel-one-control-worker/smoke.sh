#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

docker run --rm --entrypoint sh "$image" -c \
  'test -f /workspace/apps/web/scripts/control-worker.ts
   test -f /workspace/apps/web/lib/runtime/worker-health.ts
   test -f /workspace/apps/web/lib/runtime/process-contracts.ts'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'control worker image smoke passed\n'
