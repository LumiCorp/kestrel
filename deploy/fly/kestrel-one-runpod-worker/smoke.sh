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
    *"runpod-worker configuration is incomplete"*) ;;
    *)
      printf "%s\n" "$output" >&2
      exit 1
      ;;
  esac
'

printf 'RunPod worker image smoke passed\n'
