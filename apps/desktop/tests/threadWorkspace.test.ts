import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveDesktopThreadWorkspace } from "../src/threadWorkspace.js";

test("desktop project threads use the registered project as their workspace and launch cwd", () => {
  const projectPath = path.join(path.sep, "workspace", "project-a");
  const workspace = resolveDesktopThreadWorkspace({
    projectPath,
    projects: [{ path: projectPath, label: "Project A" }],
    defaultKestrelRoot: path.join(path.sep, "kestrel"),
  });

  assert.equal(workspace.workspaceRoot, projectPath);
  assert.equal(workspace.launchCwd, projectPath);
  assert.equal(workspace.appRoot, ".");
  assert.equal(workspace.label, "Project A");
  assert.equal(workspace.sourceWorkspaceRoot, projectPath);
  assert.equal(workspace.managedWorktreeRequired, true);
  assert.equal(workspace.managedWorktreeIsolation, "session");
  assert.match(workspace.workspaceId, /^local:[a-f0-9]{16}$/u);
});

test("desktop unscoped threads use the default Kestrel folder instead of the app bundle", () => {
  const defaultKestrelRoot = path.join(path.sep, "Users", "person", "Library", "Application Support", "Kestrel");
  const workspace = resolveDesktopThreadWorkspace({
    projects: [],
    defaultKestrelRoot,
  });

  assert.equal(workspace.workspaceRoot, defaultKestrelRoot);
  assert.equal(workspace.launchCwd, defaultKestrelRoot);
  assert.equal(workspace.label, "Kestrel");
  assert.equal(workspace.managedWorktreeRequired, undefined);
});

test("desktop thread workspaces reject unregistered project paths", () => {
  assert.throws(
    () => resolveDesktopThreadWorkspace({
      projectPath: path.join(path.sep, "workspace", "forged"),
      projects: [{ path: path.join(path.sep, "workspace", "project-a"), label: "Project A" }],
      defaultKestrelRoot: path.join(path.sep, "kestrel"),
    }),
    {
      name: "DesktopError",
      code: "desktop.unregistered_project_root",
    },
  );
});
