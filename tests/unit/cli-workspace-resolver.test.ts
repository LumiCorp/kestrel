import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import {
  initializeWorkspaceAtRoot,
  resolveWorkspaceFromBinding,
  resolveWorkspaceFromCwd,
} from "../../cli/workspace/WorkspaceResolver.js";

const execFileAsync = promisify(execFile);

test("workspace resolver registers the nearest git root without writing project files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-resolver-"));
  const home = path.join(root, "home");
  const workspaceRoot = path.join(root, "project");
  const nested = path.join(workspaceRoot, "src", "feature");
  await mkdir(nested, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  const expectedWorkspaceRoot = await realpath(workspaceRoot);
  const expectedLaunchCwd = await realpath(nested);

  const store = new WorkspaceStore(home);
  const resolved = await resolveWorkspaceFromCwd(nested, store);

  assert.equal(resolved.workspace?.rootPath, expectedWorkspaceRoot);
  assert.equal(resolved.workspace?.runtimeContext.workspaceRoot, expectedWorkspaceRoot);
  assert.equal(resolved.workspace?.runtimeContext.launchCwd, expectedLaunchCwd);
  assert.equal(resolved.workspace?.runtimeContext.appRoot, ".");
  assert.deepEqual(resolved.workspace?.runtimeContext.commands, {});

  const file = await store.load();
  assert.equal(file.workspaces.length, 1);
  assert.equal(file.workspaces[0]?.rootPath, expectedWorkspaceRoot);
  assert.equal(file.workspaces[0]?.automationEnabled, false);
});

test("workspace resolver uses cwd for non-git folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-nongit-"));
  const home = path.join(root, "home");
  const workspaceRoot = path.join(root, "folder");
  await mkdir(workspaceRoot, { recursive: true });
  const expectedWorkspaceRoot = await realpath(workspaceRoot);

  const store = new WorkspaceStore(home);
  const resolved = await resolveWorkspaceFromCwd(workspaceRoot, store);

  assert.equal(resolved.workspace?.rootPath, expectedWorkspaceRoot);
  assert.equal(resolved.workspace?.runtimeContext.launchCwd, expectedWorkspaceRoot);
});

test("workspace resolver resolves explicit catalog bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-binding-"));
  const home = path.join(root, "home");
  const workspaceRoot = path.join(root, "project");
  await mkdir(workspaceRoot, { recursive: true });
  const store = new WorkspaceStore(home);
  const initialized = await initializeWorkspaceAtRoot(workspaceRoot, store);

  const resolved = await resolveWorkspaceFromBinding({
    workspaceId: initialized.manifest.workspaceId,
  }, store);

  assert.equal(resolved.workspace?.manifest.workspaceId, initialized.manifest.workspaceId);
  assert.equal(resolved.notices.length, 0);
});
