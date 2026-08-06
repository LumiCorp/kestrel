import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeRolloutContractSchema } from "./contracts";

const root = path.resolve(import.meta.dirname, "../../../../");

test("rolling runtime contract carries current and previous revisions", async () => {
  const [rollout, compatibility] = await Promise.all([
    readJson("deploy/fly/runtime-rollout.json"),
    readJson("deploy/fly/runtime-compatibility.json"),
  ]);
  assert.equal(runtimeRolloutContractSchema.parse(rollout).mode, "rolling");
  for (const component of ["environmentRouter", "workspaceRuntime"] as const) {
    const entry = compatibility[component] as {
      current: number;
      supported: number[];
    };
    assert.deepEqual(entry.supported, [entry.current - 1, entry.current]);
  }
});

test("revision-2 Workspace backup export remains compatible during revision-3 rollout", async () => {
  const backupService = await readFile(
    path.join(root, "apps/web/lib/environments/backups.ts"),
    "utf8",
  );
  assert.match(backupService, /response\.status === 404/u);
  assert.match(
    backupService,
    /status === 403 && code === "ENVIRONMENT_CAPABILITY_DENIED"/u,
  );
});

async function readJson(relativePath: string) {
  return JSON.parse(
    await readFile(path.join(root, relativePath), "utf8"),
  ) as Record<string, unknown>;
}
