#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-environment-router-smoke-$$"
port="${KESTREL_ENVIRONMENT_ROUTER_SMOKE_PORT:-18080}"
health_file="/tmp/kestrel-environment-router-health-$$"
fixture_file="/tmp/kestrel-environment-router-control-$$.mjs"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$health_file"
  rm -f "$fixture_file"
}
trap cleanup EXIT

cat >"$fixture_file" <<'EOF'
import { createServer } from "node:http";
createServer((request, response) => {
  if (request.headers.authorization !== "Bearer gateway-smoke-token") {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    version: 3,
    environmentId: "environment-smoke",
    revision: "smoke-v3",
    workspaces: [],
    previews: [],
    modelGrants: [],
    appGrants: []
  }));
}).listen(18081, "127.0.0.1");
EOF

docker run --rm --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:8080" \
  --volume "$fixture_file:/tmp/control-fixture.mjs:ro" \
  --env KESTREL_CONTROL_PLANE_URL=http://127.0.0.1:18081 \
  --env KESTREL_ENVIRONMENT_APP_NAME=environment-smoke-app \
  --env KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN=gateway-smoke-token \
  --env KESTREL_ENVIRONMENT_ID=environment-smoke \
  --env KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=gateway-smoke-public-key \
  --entrypoint /bin/sh \
  "$image" -c 'node /tmp/control-fixture.mjs & exec node apps/environment-router/dist/server.js' >/dev/null

for _ in $(seq 1 30); do
  status="$(curl --silent --output "$health_file" --write-out '%{http_code}' "http://127.0.0.1:${port}/health" || true)"
  if [[ "$status" == "200" ]]; then
    break
  fi
  sleep 1
done

health="$(<"$health_file")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (
    health.ok !== true ||
    health.runtimeContractRevision !== 2 ||
    health.configurationReady !== true ||
    health.gatewayConfig?.activeVersion !== 3 ||
    !health.gatewayConfig?.acceptedVersions?.includes(3)
  ) {
    throw new Error("Environment Router health contract failed");
  }
' "$health"

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'Environment Router image smoke passed\n'
