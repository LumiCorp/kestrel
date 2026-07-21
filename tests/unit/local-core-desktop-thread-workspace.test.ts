import assert from "node:assert/strict";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { syncDesktopThreadWorkspace } from "../../src/localCore/desktopThreadWorkspace.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "Desktop workspace registration bootstraps restored conversations into Local Core authority", async () => {
  const store = new InMemorySessionStore();
  const sessionId = "desktop-restored-session";
  const threadId = `thread-main:${sessionId}`;
  const workspace = {
    workspaceId: "local:project-a",
    workspaceRoot: "/workspace/project-a",
    sourceWorkspaceRoot: "/workspace/project-a",
    launchCwd: "/workspace/project-a",
    appRoot: ".",
    commands: {},
    label: "Project A",
    managedWorktreeRequired: false,
  };

  const thread = await syncDesktopThreadWorkspace(store, { sessionId, threadId, workspace });

  assert.equal((await store.getSession(sessionId))?.sessionId, sessionId);
  assert.equal((await store.getThread(threadId))?.threadId, threadId);
  assert.deepEqual(thread.metadata?.workspace, workspace);
  await assert.rejects(
    () => syncDesktopThreadWorkspace(store, {
      sessionId,
      threadId,
      workspace: { ...workspace, workspaceRoot: "/workspace/project-b" },
    }),
    /different authoritative workspace/u,
  );
});
