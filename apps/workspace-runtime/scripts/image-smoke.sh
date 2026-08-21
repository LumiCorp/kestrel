#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/lib/image-smoke.sh"

image="${1:?usage: image-smoke.sh IMAGE}"
container="kestrel-workspace-runtime-smoke-$$"
health_file="/tmp/kestrel-workspace-runtime-health-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$health_file"
}
trap cleanup EXIT

docker run --detach \
  --name "$container" \
  --publish "127.0.0.1::43104" \
  --env FLY_MACHINE_ID=workspace-smoke-machine \
  --env KESTREL_CONTROL_PLANE_URL=https://control.invalid \
  --env KESTREL_ENVIRONMENT_GATEWAY_URL=https://gateway.invalid \
  --env KESTREL_ENVIRONMENT_ID=environment-smoke \
  --env KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=workspace-smoke-public-key \
  --env KESTREL_ORGANIZATION_ID=organization-smoke \
  --env KESTREL_WORKSPACE_ID=workspace-smoke \
  --env KESTREL_WORKSPACE_SERVICE_TOKEN=workspace-smoke-token \
  "$image" >/dev/null

port="$(smoke_container_port "$container" 43104)"
smoke_wait_http "$container" "http://127.0.0.1:${port}/health" "$health_file"
health="$(<"$health_file")"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.ok !== true || health.runtimeContractRevision !== 3) {
    throw new Error("Workspace Runtime health contract failed");
  }
' "$health"

docker exec "$container" test -d /workspace/.kestrel/runner/store/pglite
expected_pnpm="$(docker exec "$container" node -p "require('/app/package.json').packageManager.split('@')[1].split('+')[0]")"
actual_pnpm="$(docker run --rm \
  --network none \
  --workdir /workspace \
  --entrypoint /bin/bash \
  "$image" \
  -lc 'pnpm --version')"
test "$actual_pnpm" = "$expected_pnpm"
docker exec "$container" node --input-type=module --eval \
  'await import("@kestrel-agents/files")'

docker exec "$container" node --input-type=module --eval '
  import assert from "node:assert/strict";
  import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
  import { createServer } from "node:net";
  import path from "node:path";
  import { WorkspaceApplicationRegistry } from "/app/apps/workspace-runtime/dist/applications.js";

  const root = await mkdtemp("/tmp/kestrel-image-application-");
  const pidPath = path.join(root, "application.pid");
  const scriptPath = path.join(root, "application.mjs");
  const port = 4174;
  let applicationPid = null;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await mkdir(path.join(root, ".kestrel"));
    await writeFile(scriptPath, [
      "import { writeFileSync } from \"node:fs\";",
      "import { createServer } from \"node:http\";",
      `const server = createServer((_request, response) => response.end("ok"));`,
      `server.listen(${port}, "127.0.0.1", () => writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)));`,
    ].join("\n"));
    const registry = new WorkspaceApplicationRegistry(root);
    const nestedCommand = `${JSON.stringify("/bin/sh")} -c ${JSON.stringify(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} & wait`,
    )} & wait`;
    const application = await registry.register({
      name: "Image smoke application",
      command: nestedCommand,
      port,
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && applicationPid === null) {
      applicationPid = Number(await readFile(pidPath, "utf8").catch(() => "0")) || null;
      if (applicationPid === null) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(applicationPid && alive(applicationPid));
    const stopped = await registry.stop(application.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(alive(applicationPid), false);
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  } finally {
    if (applicationPid && alive(applicationPid)) process.kill(applicationPid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
'

docker run --rm \
  --entrypoint node \
  "$image" \
  --input-type=module \
  --eval '
    const { ProfileStore } = await import("/app/dist/cli/config/ProfileStore.js");
    const store = new ProfileStore("/tmp/kestrel-profile-smoke");
    const profiles = await store.load();
    const profile = store.findById(profiles, "kestrel");
    const collaborationTools = (profile?.toolAllowlist ?? []).filter(
      (toolName) => toolName.startsWith("dialog.") || toolName.startsWith("delegate.") || toolName === "agent.spawn",
    );
    const expected = ["dialog.open", "dialog.send", "dialog.close"];
    if (
      profile?.id !== "kestrel" ||
      profile?.agentProfileId !== "kestrel" ||
      profile?.presetId !== "workspace_hosted" ||
      profile?.delegation?.allowAgentSpawn !== true ||
      profile?.toolAllowlist?.includes("desktop.host.open") === true ||
      JSON.stringify(collaborationTools) !== JSON.stringify(expected)
    ) {
      throw new Error(`Workspace Runtime Kestrel profile is invalid: ${JSON.stringify({ agentProfileId: profile?.agentProfileId, presetId: profile?.presetId, delegation: profile?.delegation, collaborationTools })}`);
    }
  '

docker stop --time 15 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = "0"

printf 'Workspace Runtime image smoke passed\n'
