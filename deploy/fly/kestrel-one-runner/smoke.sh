#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"
container="kestrel-one-runner-smoke-$$"
port="${KESTREL_RUNNER_SMOKE_PORT:-18080}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:8080" \
  --env KESTREL_HOME=/data/.kestrel \
  --env KESTREL_RUNNER_SERVICE_TOKEN=runner-smoke-token \
  --env KESTREL_STORE_DRIVER=sqlite \
  --env KESTREL_SQLITE_PATH=/data/runtime.db \
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
  if (health.version !== "runner-health-v1" || health.ok !== true) {
    throw new Error("runner health contract failed");
  }
' "$health"

response="$(curl --fail --silent \
  --header 'authorization: Bearer runner-smoke-token' \
  --header 'content-type: application/json' \
  --data '{"id":"image-smoke","type":"runner.ping","metadata":{"actor":{"actorId":"image-smoke","actorType":"service"}},"payload":{"nonce":"image-smoke"}}' \
  "http://127.0.0.1:${port}/commands")"
node -e '
  const response = JSON.parse(process.argv[1]);
  if (response.type !== "runner.pong" || response.payload?.nonce !== "image-smoke") {
    throw new Error("authenticated runner ping failed");
  }
' "$response"

docker exec "$container" test ! -e /app/.env
docker exec "$container" test -f /app/cli/runtime/gateway-credential-broker.ts
docker exec "$container" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let packageRoot = path.dirname(require.resolve("@electric-sql/pglite"));
  while (!fs.existsSync(path.join(packageRoot, "package.json"))) {
    packageRoot = path.dirname(packageRoot);
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  ).version;
  if (version !== "0.4.6") {
    throw new Error(`runner image has incompatible PGlite ${version}`);
  }
'
docker exec "$container" node -e '
  const fs = require("node:fs");
  const resolved = fs.realpathSync("/app/node_modules/@kestrel-agents/protocol");
  if (!resolved.startsWith("/app/")) {
    throw new Error(`protocol dependency escaped image root: ${resolved}`);
  }
'

if [[ -n "${EXPECTED_GIT_SHA:-}" ]]; then
  revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$revision" == "$EXPECTED_GIT_SHA" ]]
fi

printf 'runner image smoke passed\n'
