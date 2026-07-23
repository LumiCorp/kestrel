#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-workspace-runtime-smoke-$$"
port="${KESTREL_WORKSPACE_RUNTIME_SMOKE_PORT:-18104}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:43104" \
  --env FLY_MACHINE_ID=workspace-smoke-machine \
  --env KESTREL_CONTROL_PLANE_URL=https://control.invalid \
  --env KESTREL_ENVIRONMENT_GATEWAY_URL=https://gateway.invalid \
  --env KESTREL_ENVIRONMENT_ID=environment-smoke \
  --env KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=workspace-smoke-public-key \
  --env KESTREL_ORGANIZATION_ID=organization-smoke \
  --env KESTREL_WORKSPACE_ID=workspace-smoke \
  --env KESTREL_WORKSPACE_SERVICE_TOKEN=workspace-smoke-token \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null; then
    break
  fi
  sleep 1
done

health="$(curl --fail --silent "http://127.0.0.1:${port}/health")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.ok !== true || health.runtimeContractRevision !== 2) {
    throw new Error("Workspace Runtime health contract failed");
  }
' "$health"

docker exec "$container" test -d /workspace/.kestrel/runner/store/pglite

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'Workspace Runtime image smoke passed\n'
