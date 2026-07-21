import assert from "node:assert/strict";

import {
  KestrelChatRuntime,
  resolveDevShellServiceForProfile,
  type RunTurnInput,
  type RuntimeFactory,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { TuiProfile } from "../../cli/contracts.js";
import type { Kestrel, ProductTaskGraphStore, ThreadRuntime } from "../../src/index.js";
import { LocalDevShellService } from "../../src/devshell/LocalDevShellService.js";
import { TerminalBenchDevShellService } from "../../src/devshell/TerminalBenchDevShellService.js";
import { contractTest } from "../helpers/contract-test.js";


const profileWithDevShell: TuiProfile = {
  id: "dev-shell-profile",
  label: "Dev Shell Profile",
  agent: "reference-react",
  sessionPrefix: "dev-shell",
  devShell: {
    enabled: true,
    envMode: "inherit",
  },
};

contractTest("runtime.hermetic", "resolveDevShellServiceForProfile prefers the Terminal-Bench bridge when configured", () => {
  const service = resolveDevShellServiceForProfile(profileWithDevShell, {
    ...process.env,
    KESTREL_DEV_SHELL_BRIDGE_URL: "http://127.0.0.1:43123",
    DATABASE_URL: "",
  });

  assert.ok(service instanceof TerminalBenchDevShellService);
});

contractTest("runtime.hermetic", "resolveDevShellServiceForProfile falls back to the local dev shell service when no bridge is configured", () => {
  const service = resolveDevShellServiceForProfile(profileWithDevShell, {
    ...process.env,
    KESTREL_DEV_SHELL_BRIDGE_URL: "",
  });

  assert.ok(service instanceof LocalDevShellService);
});

contractTest("runtime.hermetic", "resolveDevShellServiceForProfile returns undefined when dev shell tools are disabled", () => {
  const service = resolveDevShellServiceForProfile({
    ...profileWithDevShell,
    devShell: {
      enabled: false,
      envMode: "inherit",
    },
  });

  assert.equal(service, undefined);
});

contractTest("runtime.hermetic", "KestrelChatRuntime injects active task graph id into ordinary thread turn metadata", async () => {
  const submittedTurns: Array<{ metadata?: Record<string, unknown> | undefined }> = [];
  const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
    activeTaskId: "task-active",
    submittedTurns,
  }));

  await runtime.runTurn({
    sessionId: "session-1",
    message: "continue",
    eventType: "user.message",
  });

  assert.equal(submittedTurns[0]?.metadata?.activeTaskId, "task-active");
});

contractTest("runtime.hermetic", "KestrelChatRuntime preserves explicit lineage activeTaskId over task graph activeTaskId", async () => {
  const submittedTurns: Array<{ metadata?: Record<string, unknown> | undefined }> = [];
  const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
    activeTaskId: "task-active",
    submittedTurns,
  }));

  await runtime.runTurn({
    sessionId: "session-child",
    message: "continue child",
    eventType: "user.message",
    metadata: {
      activeTaskId: "task-lineage",
      taskId: "task-lineage",
      parentTaskId: "task-parent",
      delegationDepth: 2,
    },
  });

  assert.equal(submittedTurns[0]?.metadata?.activeTaskId, "task-lineage");
  assert.equal(submittedTurns[0]?.metadata?.taskId, "task-lineage");
  assert.equal(submittedTurns[0]?.metadata?.parentTaskId, "task-parent");
});

contractTest("runtime.hermetic", "KestrelChatRuntime marks build-mode source workspaces as source workspace authority", async () => {
  const submittedTurns: SubmittedRuntimeTurn[] = [];
  const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
    activeTaskId: "task-active",
    submittedTurns,
  }));

  await runtime.runTurn({
    sessionId: "session-workspace",
    message: "build the app",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "full_auto",
    workspace: {
      workspaceId: "workspace-1",
      workspaceRoot: "/repo/app",
      appRoot: ".",
      commands: {},
    },
  });

  assert.equal(submittedTurns[0]?.interactionMode, "build");
  assert.equal(submittedTurns[0]?.actSubmode, "full_auto");
  const workspace = submittedTurns[0]?.metadata?.workspace as Record<string, unknown> | undefined;
  assert.equal(workspace?.managedWorktreeRequired, false);
  assert.equal(workspace?.sourceWorkspaceRoot, undefined);
  assert.deepEqual(workspace?.workspaceAuthority, {
    mode: "draft_workspace",
    label: "Source workspace",
    source: "runtime_mode",
  });
});

contractTest("runtime.hermetic", "KestrelChatRuntime forces the Environment-managed Workspace when configured", async () => {
  const submittedTurns: SubmittedRuntimeTurn[] = [];
  const original = {
    required: process.env.KESTREL_REQUIRE_MANAGED_WORKTREE,
    workspaceId: process.env.KESTREL_WORKSPACE_ID,
    workspaceRoot: process.env.KESTREL_WORKSPACE_ROOT,
    isolation: process.env.KESTREL_MANAGED_WORKTREE_ISOLATION,
  };
  process.env.KESTREL_REQUIRE_MANAGED_WORKTREE = "true";
  process.env.KESTREL_WORKSPACE_ID = "environment-workspace";
  process.env.KESTREL_WORKSPACE_ROOT = "/workspace";
  process.env.KESTREL_MANAGED_WORKTREE_ISOLATION = "session";
  try {
    const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
      activeTaskId: "task-active",
      submittedTurns,
    }));

    await runtime.runTurn({
      sessionId: "session-environment-workspace",
      message: "build the app",
      eventType: "user.message",
      interactionMode: "build",
      actSubmode: "full_auto",
    });

    const workspace = submittedTurns[0]?.metadata?.workspace as Record<string, unknown> | undefined;
    assert.equal(workspace?.workspaceId, "environment-workspace");
    assert.equal(workspace?.workspaceRoot, "/workspace");
    assert.equal(workspace?.sourceWorkspaceRoot, "/workspace");
    assert.equal(workspace?.managedWorktreeRequired, true);
    assert.equal(workspace?.managedWorktreeIsolation, "session");
  } finally {
    restoreEnv("KESTREL_REQUIRE_MANAGED_WORKTREE", original.required);
    restoreEnv("KESTREL_WORKSPACE_ID", original.workspaceId);
    restoreEnv("KESTREL_WORKSPACE_ROOT", original.workspaceRoot);
    restoreEnv("KESTREL_MANAGED_WORKTREE_ISOLATION", original.isolation);
  }
});

contractTest("runtime.hermetic", "KestrelChatRuntime leaves plan-mode source workspaces read-only", async () => {
  const submittedTurns: Array<{ metadata?: Record<string, unknown> | undefined }> = [];
  const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
    activeTaskId: "task-active",
    submittedTurns,
  }));

  await runtime.runTurn({
    sessionId: "session-readonly",
    message: "inspect the app",
    eventType: "user.message",
    interactionMode: "plan",
    workspace: {
      workspaceId: "workspace-1",
      workspaceRoot: "/repo/app",
      appRoot: ".",
      commands: {},
    },
  });

  const workspace = submittedTurns[0]?.metadata?.workspace as Record<string, unknown> | undefined;
  assert.equal(workspace?.managedWorktreeRequired, undefined);
  assert.equal(workspace?.sourceWorkspaceRoot, undefined);
  assert.deepEqual(workspace?.workspaceAuthority, {
    mode: "read_only_workspace",
    label: "Read-only workspace",
    source: "runtime_mode",
  });
});

contractTest("runtime.hermetic", "KestrelChatRuntime preserves explicit non-managed build workspaces as source authority", async () => {
  const submittedTurns: Array<{ metadata?: Record<string, unknown> | undefined }> = [];
  const runtime = new KestrelChatRuntime(profileWithDevShell, createRuntimeFactory({
    activeTaskId: "task-active",
    submittedTurns,
  }));
  const inputWorkspace = {
    workspaceId: "workspace-1",
    workspaceRoot: "/repo/app",
    appRoot: ".",
    commands: {},
    managedWorktreeRequired: false,
  } as RunTurnInput["workspace"] & { managedWorktreeRequired: false };

  await runtime.runTurn({
    sessionId: "session-explicit-source",
    message: "run in the source workspace",
    eventType: "user.message",
    interactionMode: "build",
    workspace: inputWorkspace,
  });

  const workspace = submittedTurns[0]?.metadata?.workspace as Record<string, unknown> | undefined;
  assert.equal(workspace?.managedWorktreeRequired, false);
  assert.equal(workspace?.sourceWorkspaceRoot, undefined);
  assert.deepEqual(workspace?.workspaceAuthority, {
    mode: "draft_workspace",
    label: "Source workspace",
    source: "runtime_mode",
  });
});

interface SubmittedRuntimeTurn {
  interactionMode?: string | undefined;
  actSubmode?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createRuntimeFactory(input: {
  activeTaskId: string;
  submittedTurns: SubmittedRuntimeTurn[];
}): RuntimeFactory {
  return {
    create(_profile, onFinalize) {
      const session = {
        sessionId: "session-1",
        version: 0,
        state: {},
        updatedAt: new Date().toISOString(),
      };
      const kestrel = {
        async getSession() {
          return session;
        },
      } as unknown as Kestrel;
      const threadRuntime = {
        async ensureMainThreadForSession(request: { sessionId: string }) {
          return {
            threadId: `${request.sessionId}:main`,
            sessionId: request.sessionId,
            title: request.sessionId,
            metadata: {},
            createdAt: session.updatedAt,
            updatedAt: session.updatedAt,
          };
        },
        async getThreadStatus() {
          return null;
        },
        async submitTurn(turn: SubmittedRuntimeTurn) {
          input.submittedTurns.push({
            interactionMode: turn.interactionMode,
            actSubmode: turn.actSubmode,
            metadata: turn.metadata,
          });
          onFinalize({ ok: true });
          return {
            assistantText: "The runtime metadata test turn completed.",
            output: {
              status: "COMPLETED",
              text: "ok",
              events: [],
              errors: [],
            },
            finalizedPayload: { ok: true },
            session,
          };
        },
      } as unknown as ThreadRuntime;
      const taskGraphStore = {
        async getGraph() {
          return {
            version: 1,
            activeTaskId: input.activeTaskId,
            rootTaskIds: [input.activeTaskId],
            tasks: {},
          };
        },
      } as unknown as ProductTaskGraphStore;
      return {
        kestrel,
        threadRuntime,
        taskGraphStore,
        close: async () => {},
        entryStepAgent: "agent.loop",
      };
    },
  };
}
