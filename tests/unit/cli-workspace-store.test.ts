import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceStore, parseWorkspacesFile } from "../../cli/workspace/WorkspaceStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseWorkspacesFile rejects unsupported catalog versions", () => {
  assert.throws(() => parseWorkspacesFile(JSON.stringify({
    version: 2,
    workspaces: [
      {
        workspaceId: "ws-1",
        rootPath: "/tmp/project",
        discoveredAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    ],
  })), /version must be 3/u);
});

contractTest("runtime.hermetic", "WorkspaceStore persists v3 catalog entries with automation state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-store-"));
  const store = new WorkspaceStore(root);
  const file = await store.load();
  const next = store.upsert(file, {
    workspaceId: "ws-2",
    rootPath: "/tmp/project-two",
    label: "Project Two",
    automationEnabled: true,
    automationEnabledAt: "2026-03-19T00:00:00.000Z",
    discoveredAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
  });
  await store.save(next);

  const raw = await readFile(path.join(root, "workspaces.json"), "utf8");
  assert.match(raw, /"version": 3/u);
  assert.match(raw, /"automationEnabled": true/u);
});
