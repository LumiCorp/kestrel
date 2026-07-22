#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-environment-router-smoke-$$"
port="${KESTREL_ENVIRONMENT_ROUTER_SMOKE_PORT:-18080}"
health_file="/tmp/kestrel-environment-router-health-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$health_file"
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:8080" \
  --env KESTREL_CONTROL_PLANE_URL=https://control.invalid \
  --env KESTREL_ENVIRONMENT_APP_NAME=environment-smoke-app \
  --env KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN=gateway-smoke-token \
  --env KESTREL_ENVIRONMENT_ID=environment-smoke \
  --env KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=gateway-smoke-public-key \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  status="$(curl --silent --output "$health_file" --write-out '%{http_code}' "http://127.0.0.1:${port}/health" || true)"
  if [[ "$status" == "503" ]]; then
    break
  fi
  sleep 1
done

health="$(<"$health_file")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.runtimeContractRevision !== 2 || health.configurationReady !== false) {
    throw new Error("Environment Router health contract failed");
  }
' "$health"

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'Environment Router image smoke passed\n'
