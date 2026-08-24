#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"

matrix_output="$(docker run --rm \
  --entrypoint node \
  "$image" \
  /workspace/packages/attachments/scripts/extraction-matrix.mjs \
  /workspace/packages/attachments/dist/index.js \
  /workspace/packages/attachments/tests/fixtures)"
node -e '
  const evidence = JSON.parse(process.argv[1]);
  if (evidence.ok !== true) throw new Error("control worker extraction matrix evidence is invalid");
' "$matrix_output"

knowledge_output="$(docker run --rm \
  --entrypoint node \
  "$image" \
  --import tsx \
  /workspace/apps/web/scripts/knowledge-pdf-image-smoke.mjs)"
node -e '
  const evidence = JSON.parse(process.argv[1]);
  if (evidence.ok !== true) throw new Error("control worker Knowledge PDF evidence is invalid");
' "$knowledge_output"
printf 'control worker attachment and Knowledge PDF matrices passed\n'

if output="$(docker run --rm "$image" 2>&1)"; then
  printf 'control worker unexpectedly started without configuration\n' >&2
  exit 1
fi

if [[ "$output" != *"Kestrel One Control Worker failed to start: control-worker configuration is incomplete"* ]]; then
  printf 'control worker did not report the expected invalid-configuration startup failure\n%s\n' "$output" >&2
  exit 1
fi

printf 'control worker image smoke passed\n'
