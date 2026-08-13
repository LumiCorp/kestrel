#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

docker run --rm --entrypoint sh "$image" -c \
  'test -f /app/control-worker.cjs
   test -f /app/verify-control-worker-readiness.cjs
   output="$(node /app/control-worker.cjs 2>&1)" && {
     printf "%s\n" "control worker unexpectedly started without runtime configuration" >&2
     exit 1
   }
   case "$output" in
     *"Hosted Environment configuration is incomplete"*) ;;
     *) printf "%s\n" "$output" >&2; exit 1 ;;
   esac'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

if [[ -n "${EXPECTED_CONTROL_WORKER_FINGERPRINT:-}" ]]; then
  fingerprint="$(docker inspect --format '{{ index .Config.Labels "org.kestrel.control-worker.fingerprint" }}' "$image")"
  [[ "$fingerprint" == "$EXPECTED_CONTROL_WORKER_FINGERPRINT" ]]
fi

printf 'control worker image smoke passed\n'
