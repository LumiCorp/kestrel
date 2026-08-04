#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

docker run --rm --entrypoint sh "$image" -c \
  'test -f /workspace/apps/web/scripts/turn-worker.ts && test -f /workspace/apps/web/package.json && pnpm --filter @kestrel/kestrel-one exec tsx --version >/dev/null'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'turn worker image smoke passed\n'
