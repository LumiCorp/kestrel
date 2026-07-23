#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-preview-edge-smoke-$$"
public_port="${KESTREL_PREVIEW_EDGE_SMOKE_PORT:-18082}"
health_port="${KESTREL_PREVIEW_EDGE_HEALTH_SMOKE_PORT:-18083}"
health_file="/tmp/kestrel-preview-edge-health-$$"
public_file="/tmp/kestrel-preview-edge-public-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$health_file" "$public_file"
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container" \
  --publish "127.0.0.1:${public_port}:8080" \
  --publish "127.0.0.1:${health_port}:8081" \
  --env KESTREL_CONTROL_PLANE_URL=https://127.0.0.1 \
  --env KESTREL_PREVIEW_EDGE_SERVICE_TOKEN=preview-edge-smoke-token \
  --env KESTREL_PREVIEW_HOST_SUFFIX=preview.kestrelagents.dev \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${health_port}/health" >"$health_file"; then
    break
  fi
  sleep 1
done

health="$(<"$health_file")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (
    health.ok !== true ||
    health.service !== "preview-edge" ||
    health.runtimeContractRevision !== 1
  ) {
    throw new Error("Preview Edge health contract failed");
  }
' "$health"

status="$(
  curl --silent \
    --header "Host: p-0123456789abcdef0123456789abcdef.preview.kestrelagents.dev" \
    --output "$public_file" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:${public_port}/health"
)"
[[ "$status" == "503" ]]
node -e '
  const result = JSON.parse(process.argv[1]);
  if (result?.error?.code !== "PREVIEW_ROUTE_UNAVAILABLE") {
    throw new Error("Preview Edge public health-path isolation failed");
  }
' "$(<"$public_file")"

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'Preview Edge image smoke passed\n'
