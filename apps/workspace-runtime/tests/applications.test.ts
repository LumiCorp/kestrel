import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseRegistration,
  WorkspaceApplicationRegistry,
} from "../src/applications.js";

test("application registration accepts private sandbox ports and bounded paths", () => {
  assert.deepEqual(
    parseRegistration(
      { name: "Preview", command: "pnpm dev", workingDirectory: "app", port: 3000 },
      "/workspace"
    ),
    { name: "Preview", command: "pnpm dev", workingDirectory: "app", port: 3000 }
  );
});

test("application registration reserves Workspace service ports", () => {
  assert.throws(() =>
    parseRegistration({ name: "Bad", command: "serve", port: 43_104 }, "/workspace")
  );
});

test("desired applications restart when a sleeping Workspace wakes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    await writeFile(
      path.join(root, ".kestrel", "applications.json"),
      JSON.stringify([
        {
          id: "app-1",
          name: "Preview",
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
          workingDirectory: "",
          port: 3000,
          desiredState: "running",
          status: "stopped",
          processId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
    );
    const registry = new WorkspaceApplicationRegistry(root);
    await registry.restore();
    assert.equal(registry.get("app-1")?.status, "running");
    assert.ok(registry.get("app-1")?.processId);
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application lifecycle controls persist the desired state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-apps-lifecycle-"));
  try {
    await mkdir(path.join(root, ".kestrel"));
    const registry = new WorkspaceApplicationRegistry(root);
    const application = await registry.register({
      name: "Preview",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      port: 3000,
    });
    assert.equal(application.desiredState, "running");
    assert.equal(application.status, "running");

    const stopped = await registry.stop(application.id);
    assert.equal(stopped.desiredState, "stopped");
    assert.equal(stopped.status, "running");

    await registry.stopAll();
    assert.equal(registry.get(application.id)?.status, "stopped");
    const restarted = await registry.start(application.id);
    assert.equal(restarted.desiredState, "running");
    assert.equal(restarted.status, "running");
    await registry.stopAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
