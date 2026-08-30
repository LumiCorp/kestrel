#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_dir/../../.." && pwd)"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/kestrel-browser-image-smoke.XXXXXX")"
worker_name="kestrel-browser-image-smoke-${PPID}-$$"
network_name="${worker_name}-network"
worker_container=""

cleanup() {
  if [[ -n "$worker_container" ]]; then
    docker rm --force "$worker_container" >/dev/null 2>&1 || true
  fi
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -f -- \
    "$smoke_dir/capability-private.pem" \
    "$smoke_dir/capability-public.pem"
  rmdir "$smoke_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
if [[ "$user" != "10001:10001" ]]; then
  printf 'hosted Browser worker image does not run as the fixed nonroot user\n' >&2
  exit 1
fi

engine="$(docker run --rm --read-only --entrypoint /opt/kestrel/browser-runtime/agent-browser "$image" --version)"
chrome="$(docker run --rm --read-only --entrypoint /opt/kestrel/browser-runtime/chrome/chrome "$image" --version)"
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

docker network create --internal "$network_name" >/dev/null
worker_container="$(docker run --detach \
  --name "$worker_name" \
  --network "$network_name" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m \
  --shm-size 256m \
  --publish 127.0.0.1::43105 \
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
  --env PORT=43105 \
  "$image")"

# The QA fixture stays on loopback inside the worker's network namespace. The
# internal Docker network proves Browser startup needs no public connection.
docker exec --detach "$worker_container" node --input-type=module --eval '
  import { createServer } from "node:http";
  createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Kestrel Browser image smoke</title><main>ready</main>");
  }).listen(43106, "::");
'
docker exec "$worker_container" node --input-type=module --eval '
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch("http://[::1]:43106/");
      if (response.ok) process.exit(0);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("hosted Browser image loopback fixture did not start");
'

published_address="$(docker port "$worker_container" 43105/tcp)"
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

docker stop --time 10 "$worker_container" >/dev/null
exit_code="$(docker container inspect --format '{{.State.ExitCode}}' "$worker_container" 2>/dev/null || true)"
if [[ "$exit_code" != "0" ]]; then
  printf 'hosted Browser worker did not terminate cleanly after browser.close\n' >&2
  docker logs "$worker_container" >&2 || true
  exit 1
fi

printf 'hosted Browser worker image smoke passed\n'
