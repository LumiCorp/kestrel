#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/../../.." && pwd)"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/kestrel-browser-image-smoke.XXXXXX")"
worker_name="kestrel-browser-image-smoke-${PPID}-$$"
network_name="${worker_name}-network"
worker_container=""
gateway_container=""
preview_container=""
relay_container=""

cleanup() {
  if [[ -n "$worker_container" ]]; then
    docker rm --force "$worker_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$gateway_container" ]]; then
    docker rm --force "$gateway_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$preview_container" ]]; then
    docker rm --force "$preview_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$relay_container" ]]; then
    docker rm --force "$relay_container" >/dev/null 2>&1 || true
  fi
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -f -- \
    "$smoke_dir/capability-private.pem" \
    "$smoke_dir/capability-public.pem"
  rmdir "$smoke_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

engine="$(docker run --rm --platform linux/amd64 --read-only --entrypoint /opt/kestrel/browser-runtime/agent-browser "$image" --version)"
chrome="$(docker run --rm --platform linux/amd64 --read-only --entrypoint /opt/kestrel/browser-runtime/chrome/chrome "$image" --version)"
engine="${engine%"${engine##*[![:space:]]}"}"
chrome="${chrome%"${chrome##*[![:space:]]}"}"
if [[ "$engine" != "agent-browser 0.35.0" ]]; then
  printf 'hosted Browser worker agent-browser revision mismatch\n' >&2
  exit 1
fi
if [[ "$chrome" != "Google Chrome for Testing 152.0.7977.54" ]]; then
  printf 'hosted Browser worker Chrome revision mismatch\n' >&2
  exit 1
fi

pnpm --dir "$repository_root" exec tsx \
  "$script_dir/image-smoke-client.ts" keygen "$smoke_dir"
effective_allowlist_revision="$(pnpm --dir "$repository_root" exec tsx \
  "$script_dir/image-smoke-client.ts" revision)"
if [[ ! "$effective_allowlist_revision" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'hosted Browser image smoke revision is invalid\n' >&2
  exit 1
fi
capability_public_key="$(<"$smoke_dir/capability-public.pem")"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
if [[ ! "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf 'hosted Browser worker image ID is not an immutable sha256 digest\n' >&2
  exit 1
fi
worker_image_identity="registry.fly.io/kestrel-one-browser-worker@${image_id}"

docker network create "$network_name" >/dev/null
preview_container="$(docker run --detach \
  --platform linux/amd64 \
  --network "$network_name" \
  --network-alias browser-smoke-preview.internal \
  --read-only \
  --entrypoint node \
  "$image" --input-type=module --eval '
    import { createServer } from "node:http";
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Kestrel Browser image smoke</title><main>ready</main>");
    }).listen(43106, "::");
  ')"
gateway_container="$(docker run --detach \
  --platform linux/amd64 \
  --network "$network_name" \
  --network-alias gateway-machine-1.vm.browser-workers.internal \
  --read-only \
  --entrypoint node \
  "$image" --input-type=module --eval '
    import { createServer, request as forward } from "node:http";
    const expected = `Basic ${Buffer.from("kestrel-browser-smoke:kestrel-browser-smoke-secret").toString("base64")}`;
    createServer((incoming, response) => {
      try {
        const target = new URL(incoming.url);
        if (incoming.headers["proxy-authorization"] !== expected ||
            target.protocol !== "http:" ||
            target.hostname !== "browser-smoke-preview.internal" ||
            target.port !== "43106") throw new Error("denied");
        const upstream = forward({
          host: target.hostname,
          port: 43106,
          method: incoming.method,
          path: `${target.pathname}${target.search}`,
          headers: { host: target.host },
        }, (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        });
        incoming.pipe(upstream);
      } catch {
        response.writeHead(403, { connection: "close" });
        response.end("BROWSER_DESTINATION_BLOCKED");
      }
    }).listen(43109, "::");
    createServer((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("unauthorized-gateway-port");
    }).listen(43110, "::");
  ')"
preview_address="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$preview_container")"
gateway_address="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$gateway_container")"
if [[ ! "$preview_address" =~ ^[0-9]+(\.[0-9]+){3}$ ||
      ! "$gateway_address" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  printf 'hosted Browser image smoke fixture addresses are invalid\n' >&2
  exit 1
fi
worker_container="$(docker run --detach \
  --platform linux/amd64 \
  --name "$worker_name" \
  --network "$network_name" \
  --cap-add NET_ADMIN \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --shm-size 256m \
  --env KESTREL_BROWSER_SESSION_ID=browser-image-smoke-session \
  --env KESTREL_BROWSER_GENERATION=1 \
  --env KESTREL_BROWSER_ORGANIZATION_ID=browser-image-smoke-org \
  --env KESTREL_BROWSER_ENVIRONMENT_ID=browser-image-smoke-environment \
  --env KESTREL_BROWSER_PROJECT_ID=browser-image-smoke-project \
  --env KESTREL_BROWSER_USER_ID=browser-image-smoke-user \
  --env KESTREL_BROWSER_THREAD_ID=browser-image-smoke-thread \
  --env "KESTREL_BROWSER_EFFECTIVE_ALLOWLIST_REVISION=$effective_allowlist_revision" \
  --env "KESTREL_BROWSER_WORKER_IMAGE_DIGEST=$worker_image_identity" \
  --env "KESTREL_BROWSER_CAPABILITY_PUBLIC_KEY=$capability_public_key" \
  --env KESTREL_BROWSER_EGRESS_GATEWAY_HOST=gateway-machine-1.vm.browser-workers.internal \
  --env KESTREL_BROWSER_EGRESS_GATEWAY_PORT=43109 \
  --env "KESTREL_BROWSER_SMOKE_GATEWAY_ADDRESS=$gateway_address" \
  --env "KESTREL_BROWSER_SMOKE_PREVIEW_ADDRESS=$preview_address" \
  --env PORT=43105 \
  "$image")"

# The entrypoint installs the namespace firewall before dropping every
# capability and starting the fixed nonroot worker process.
worker_ready=false
for _attempt in {1..50}; do
  if [[ "$(docker container inspect --format '{{.State.Running}}' "$worker_container")" != "true" ]]; then
    break
  fi
  if docker exec "$worker_container" awk '$1 == "Uid:" && $2 == "10001" { found = 1 } END { exit !found }' /proc/1/status; then
    worker_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$worker_ready" != "true" ]]; then
  docker logs "$worker_container" >&2 || true
  printf 'hosted Browser worker exited during egress firewall initialization\n' >&2
  exit 1
fi
docker exec "$worker_container" node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const status = readFileSync("/proc/1/status", "utf8");
  if (!/^Uid:\s+10001\s+10001\s+10001\s+10001$/mu.test(status) ||
      !/^Gid:\s+10001\s+10001\s+10001\s+10001$/mu.test(status) ||
      !/^CapEff:\s+0+$/mu.test(status) ||
      !/^NoNewPrivs:\s+1$/mu.test(status)) {
    throw new Error("hosted Browser worker did not drop to the fixed unprivileged runtime");
  }
'

# A non-Chrome process cannot reach the public Internet, another Machine, or
# the Gateway without the exact proxy credential.
docker exec "$worker_container" node --input-type=module --eval '
  import { Resolver } from "node:dns/promises";
  import { request } from "node:http";
  import { connect } from "node:net";
  const mustFail = (host, port) => new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 800);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error(`direct connection unexpectedly reached ${host}:${port}`)); });
    socket.on("error", () => { clearTimeout(timer); resolve(); });
  });
  await mustFail(process.env.KESTREL_BROWSER_SMOKE_PREVIEW_ADDRESS, 43106);
  await mustFail("1.1.1.1", 443);
  await mustFail(process.env.KESTREL_BROWSER_SMOKE_GATEWAY_ADDRESS, 43110);
  const resolver = new Resolver();
  resolver.setServers(["127.0.0.11"]);
  let resolved = false;
  const dns = resolver.resolve4("example.com").then(() => { resolved = true; }).catch(() => {});
  await Promise.race([dns, new Promise((resolve) => setTimeout(resolve, 800))]);
  resolver.cancel();
  await dns;
  if (resolved) throw new Error("steady-state Browser worker DNS unexpectedly succeeded");
  await new Promise((resolve, reject) => {
    const requestValue = request({
      host: process.env.KESTREL_BROWSER_SMOKE_GATEWAY_ADDRESS,
      port: 43109,
      path: "http://browser-smoke-preview.internal:43106/",
    }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode === 403 ? resolve() : reject(new Error("gateway accepted missing credentials")));
    });
    requestValue.on("error", reject);
    requestValue.end();
  });
'

# Chrome cannot bypass the proxy to another Machine or a public origin. The
# command can render a Chrome network-error page with exit code zero, so the
# assertion is based on the absence of the protected destination contents.
docker exec --user 10001:10001 "$worker_container" bash -ceu '
  set +e
  private_output="$(timeout 8 /opt/kestrel/browser-runtime/chrome/chrome --headless --no-sandbox --disable-gpu --user-data-dir=/tmp/direct-private --proxy-server=direct:// --dump-dom "http://${KESTREL_BROWSER_SMOKE_PREVIEW_ADDRESS}:43106/" 2>/dev/null)"
  private_status=$?
  set -e
  [[ "$private_status" == "124" ]]
  [[ "$private_output" != *"<main>ready</main>"* ]]
  set +e
  public_output="$(timeout 8 /opt/kestrel/browser-runtime/chrome/chrome --headless --no-sandbox --disable-gpu --user-data-dir=/tmp/direct-public --proxy-server=direct:// --dump-dom https://1.1.1.1/ 2>/dev/null)"
  public_status=$?
  set -e
  [[ "$public_status" == "124" ]]
  [[ -z "$public_output" || "$public_output" == *"ERR_"* ]]
'

# The worker listener remains reachable inbound. Authorized Browser navigation
# is proved below and can reach the preview only through the authenticated
# Gateway proxy.
docker exec "$worker_container" node --input-type=module --eval '
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:43105/");
      if (response.status > 0) process.exit(0);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("hosted Browser image loopback fixture did not start");
'

# A credential-free TCP relay exposes only the control listener on loopback;
# it grants the worker no outbound route.
relay_container="$(docker run --detach \
  --platform linux/amd64 \
  --network bridge \
  --publish 127.0.0.1::43108 \
  --read-only \
  --env "WORKER_HOST=$worker_name" \
  --entrypoint node \
  "$image" --input-type=module --eval '
    import { createConnection, createServer } from "node:net";
    createServer((incoming) => {
      const upstream = createConnection({
        host: process.env.WORKER_HOST,
        port: 43105,
      });
      incoming.pipe(upstream).pipe(incoming);
      upstream.on("error", () => incoming.destroy());
    }).listen(43108, "::");
  ')"
docker network connect "$network_name" "$relay_container"

published_address="$(docker port "$relay_container" 43108/tcp)"
published_address="${published_address%%$'\n'*}"
published_port="${published_address##*:}"
if [[ ! "$published_port" =~ ^[0-9]+$ ]]; then
  printf 'hosted Browser worker listener was not published for smoke control\n' >&2
  exit 1
fi
pnpm --dir "$repository_root" exec tsx \
  "$script_dir/image-smoke-client.ts" run \
  "http://127.0.0.1:$published_port" \
  "$smoke_dir/capability-private.pem"

# Gateway loss stays closed. Neither the worker process nor the already-used
# Browser namespace gains a direct fallback after its only permitted peer is
# gone.
docker stop --time 2 "$gateway_container" >/dev/null
docker exec "$worker_container" node --input-type=module --eval '
  import { connect } from "node:net";
  const mustFail = (host, port) => new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 800);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error(`connection unexpectedly reached ${host}:${port}`)); });
    socket.on("error", () => { clearTimeout(timer); resolve(); });
  });
  await mustFail(process.env.KESTREL_BROWSER_SMOKE_GATEWAY_ADDRESS, 43109);
  await mustFail(process.env.KESTREL_BROWSER_SMOKE_PREVIEW_ADDRESS, 43106);
  await mustFail("1.1.1.1", 443);
'

# A successful close response is returned only after DesktopBrowserService has
# removed the owned runtime/profile. In this PID-1 container the exited daemon
# may remain visible briefly as an authenticated zombie; it must never remain
# live, and a different live process must not satisfy cleanup.
docker exec "$worker_container" node --input-type=module --eval '
  import { existsSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  const runtimePath = "/tmp/kb/browser/runtime/browser-image-smoke-session";
  if (existsSync(runtimePath)) {
    throw new Error("hosted Browser close retained its owned runtime/profile");
  }
  const processes = execFileSync("/bin/ps", ["-axo", "state=,command="], { encoding: "utf8" });
  for (const line of processes.split("\n")) {
    const match = line.match(/^\s*(\S+)\s+(.+?)\s*$/u);
    if (match && !match[1].startsWith("Z") &&
        match[2] === "/opt/kestrel/browser-runtime/agent-browser") {
      throw new Error("hosted Browser close retained its owned daemon");
    }
  }
'

docker stop --time 10 "$worker_container" >/dev/null
exit_code="$(docker container inspect --format '{{.State.ExitCode}}' "$worker_container" 2>/dev/null || true)"
if [[ "$exit_code" != "0" ]]; then
  printf 'hosted Browser worker did not terminate cleanly after browser.close\n' >&2
  docker logs "$worker_container" >&2 || true
  exit 1
fi

printf 'hosted Browser worker image smoke passed\n'
