import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopWorkspaceGitSnapshot } from "../src/contracts.js";
import { runDesktopWorkspaceGit } from "../src/workspaceGit.js";

const candidateFingerprint = `sha256:${"a".repeat(64)}`;
const context = {
  actorRole: "operator" as const,
  actorId: "desktop",
  tenantId: "local",
};
const snapshot: DesktopWorkspaceGitSnapshot = {
  sessionId: "session-1",
  threadId: "thread-1",
  workspaceRoot: "/workspace",
  repoRoot: "/workspace",
  candidateFingerprint,
  validationReadiness: "ready",
  deliveryReady: true,
  deliveryReadinessMessage: "Ready",
  branch: "main",
  headSha: "abc",
  relation: "untracked",
  pushState: "not_pushed",
  ahead: 0,
  behind: 0,
  files: [],
  branches: ["main"],
  remotes: [],
  recentCommits: [],
  github: { available: false, authenticated: false },
  audits: [],
  notifications: [],
  generatedAt: new Date().toISOString(),
};

test("Desktop workspace Git forwards explicit typed delivery actions", async () => {
  const commands: unknown[] = [];
  const adapter = {
    sendControl: async (command: { type: string }) => {
      commands.push(command);
      return {
        type: "workspace.git" as const,
        payload: {
          sessionId: "session-1",
          threadId: "thread-1",
          operation: "action" as const,
          snapshot,
        },
        timestamp: new Date().toISOString(),
        commandId: "command-1",
      };
    },
  };
  await runDesktopWorkspaceGit({
    adapter,
    operation: "action",
    request: {
      sessionId: "session-1",
      threadId: "thread-1",
      candidateFingerprint,
      expectedHeadSha: "abc",
      action: {
        kind: "push",
        remote: "origin",
        branch: "feature",
        setUpstream: true,
      },
    },
    context,
  });
  assert.deepEqual(commands, [
    {
      type: "workspace.git.action",
      sessionId: "session-1",
      threadId: "thread-1",
      candidateFingerprint,
      expectedHeadSha: "abc",
      action: {
        kind: "push",
        remote: "origin",
        branch: "feature",
        setUpstream: true,
      },
    },
  ]);
});

test("Desktop workspace Git rejects incomplete actions before transport", async () => {
  const adapter = {
    sendControl: async () => {
      throw new Error("must not send");
    },
  };
  await assert.rejects(
    runDesktopWorkspaceGit({
      adapter,
      operation: "action",
      request: {
        sessionId: "session-1",
        threadId: "thread-1",
        candidateFingerprint,
        action: { kind: "commit", message: "message", paths: [] },
      },
      context,
    }),
    /paths are invalid/u,
  );
});
