#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

if output="$(docker run --rm "$image" 2>&1)"; then
  printf 'control worker unexpectedly started without configuration\n' >&2
  exit 1
fi

if [[ "$output" != *"Kestrel One Environment lifecycle worker failed to start: control-worker configuration is incomplete"* ]]; then
  printf 'control worker did not report the expected invalid-configuration startup failure\n%s\n' "$output" >&2
  exit 1
fi

printf 'control worker image smoke passed\n'
