#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

if output="$(docker run --rm "$image" 2>&1)"; then
  printf 'turn worker unexpectedly started without a database\n' >&2
  exit 1
fi

if [[ "$output" != *"Kestrel One durable turn worker failed to start: turn-worker configuration is incomplete"* ]]; then
  printf 'turn worker did not report the expected invalid-configuration startup failure\n%s\n' "$output" >&2
  exit 1
fi

printf 'turn worker image smoke passed\n'

if [[ -n "${KESTREL_ONE_APP_URL:-}" && -n "${KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY:-}" ]]; then
  canary_output="$(docker run --rm \
    --env KESTREL_ONE_APP_URL \
    --env KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY \
    --entrypoint node \
    "$image" \
    --import tsx \
    /workspace/apps/web/scripts/turn-worker-attachment-canary.mjs)"
  node -e '
    const evidence = JSON.parse(process.argv[1]);
    if (evidence.ok !== true || evidence.buildId !== process.argv[2]) {
      throw new Error("turn worker attachment canary evidence is invalid");
    }
  ' "$canary_output" "${image##*:}"
  printf '%s\n' "$canary_output"
  printf 'turn worker live attachment image canary passed\n'
fi
