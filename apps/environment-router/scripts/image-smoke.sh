#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/lib/image-smoke.sh"

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-environment-router-smoke-$$"
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

docker run --detach \
  --name "$container" \
  --publish "127.0.0.1::8080" \
  --volume "$fixture_file:/tmp/control-fixture.mjs:ro" \
  --env KESTREL_CONTROL_PLANE_URL=http://127.0.0.1:18081 \
  --env KESTREL_ENVIRONMENT_APP_NAME=environment-smoke-app \
  --env KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN=gateway-smoke-token \
  --env KESTREL_ENVIRONMENT_ID=environment-smoke \
  --env KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=gateway-smoke-public-key \
  --entrypoint /bin/sh \
  "$image" -c 'node /tmp/control-fixture.mjs & fixture=$!; for i in $(seq 1 50); do node -e '\''const net=require("node:net");const s=net.connect(18081,"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))'\'' && exec node apps/environment-router/dist/server.js; kill -0 "$fixture" 2>/dev/null || exit 1; sleep .1; done; exit 1' >/dev/null

port="$(smoke_container_port "$container" 8080)"
smoke_wait_http "$container" "http://127.0.0.1:${port}/health" "$health_file"

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
    throw new Error(`Environment Router health contract failed: ${JSON.stringify(health)}`);
  }
' "$health"

printf 'Environment Router image smoke passed\n'
