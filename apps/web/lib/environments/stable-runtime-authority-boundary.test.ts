import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relative: string) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("ordinary hosted runtime paths use the stable release without image environment fallbacks", async () => {
  const [runtime, admin, backups, releaseStore] = await Promise.all([
    read("./process-runtime.ts"),
    read("../admin/environments.ts"),
    read("./backups.ts"),
    read("../releases/store.ts"),
  ]);
  for (const source of [runtime, admin, backups]) {
    assert.doesNotMatch(
      source,
      /process\.env\.KESTREL_(?:ENVIRONMENT_ROUTER|WORKSPACE_RUNTIME)_IMAGE/u,
    );
  }
  assert.match(runtime, /requireStableFlyEnvironmentImages/u);
  assert.match(runtime, /flyImageReleaseTargets\.findFirst/u);
  assert.match(runtime, /flyImageReleaseComponents\.findMany/u);
  assert.match(runtime, /type !== "environment\.delete"/u);
  assert.match(runtime, /type !== "workspace\.delete"/u);
  assert.match(admin, /requireStableFlyEnvironmentImages/u);
  assert.match(backups, /requireStableFlyEnvironmentImages/u);
  assert.match(releaseStore, /STABLE_FLY_RUNTIME_BUNDLE_UNAVAILABLE/u);
});
