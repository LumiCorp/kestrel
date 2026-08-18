import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relative: string) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("ordinary hosted runtime paths use the Environment Runtime Channel without image environment fallbacks", async () => {
  const [runtime, store, admin, backups, runtimeChannel] = await Promise.all([
    read("./process-runtime.ts"),
    read("./store.ts"),
    read("../admin/environments.ts"),
    read("./backups.ts"),
    read("./runtime-channel.ts"),
  ]);
  for (const source of [runtime, store, admin, backups]) {
    assert.doesNotMatch(
      source,
      /process\.env\.KESTREL_(?:ENVIRONMENT_ROUTER|WORKSPACE_RUNTIME)_IMAGE/u,
    );
  }
  assert.doesNotMatch(runtime, /requireCurrentEnvironmentRuntime/u);
  assert.match(runtime, /resolveEnvironmentUpdateImages/u);
  assert.match(runtime, /resolveAppliedEnvironmentImages/u);
  assert.match(runtime, /runtimeVersionId/u);
  assert.match(
    runtime,
    /version\?\.workspaceRuntimeImage !== images\.runtimeImage/u,
  );
  assert.match(
    runtime,
    /version\.environmentRouterImage !== images\.routerImage/u,
  );
  assert.match(store, /requireCurrentEnvironmentRuntime/u);
  assert.doesNotMatch(runtime, /flyImageReleaseTargets/u);
  assert.doesNotMatch(runtime, /flyImageReleaseComponents/u);
  assert.match(runtime, /type !== "environment\.delete"/u);
  assert.match(runtime, /type !== "workspace\.delete"/u);
  assert.doesNotMatch(admin, /requireCurrentEnvironmentRuntime/u);
  assert.doesNotMatch(admin, /updateAdminEnvironmentRuntime/u);
  assert.match(backups, /requireCurrentEnvironmentRuntime/u);
  assert.match(runtimeChannel, /RUNTIME_CHANNEL_UNAVAILABLE/u);
  assert.doesNotMatch(runtimeChannel, /getLegacyRuntimeChannel/u);
  assert.doesNotMatch(runtimeChannel, /process\.env\.KESTREL_(?:ENVIRONMENT_ROUTER|WORKSPACE_RUNTIME)_IMAGE/u);
});
