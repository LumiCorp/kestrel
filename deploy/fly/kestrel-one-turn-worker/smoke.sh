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
