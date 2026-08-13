#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

if output="$(docker run --rm "$image" 2>&1)"; then
  printf 'turn worker unexpectedly started without a database\n' >&2
  exit 1
fi

if [[ "$output" != *"Kestrel One durable turn worker failed to start: DATABASE_URL or POSTGRES_URL is required"* ]]; then
  printf 'turn worker did not report the expected missing-database startup failure\n%s\n' "$output" >&2
  exit 1
fi

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'turn worker image smoke passed\n'
