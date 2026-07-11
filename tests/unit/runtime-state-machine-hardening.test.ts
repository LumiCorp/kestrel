import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, stat, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import type { RuntimeWorkspaceCheckpointService, SessionRecord } from "../../src/kestrel/contracts/store.js";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { readActiveWaitState } from "../../src/runtime/waitState.js";
import { ManagedTaskWorktreeService } from "../../src/workspace/ManagedTaskWorktreeService.js";
import { registerAgentReferenceRuntime } from "../../agents/reference-react/src/register.js";
import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { buildAgentToolSuccessResult, unwrapAgentToolOutput } from "../../tools/toolResult.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

const execFileAsync = promisify(execFile);

function createRuntime(
  store: InMemorySessionStore,
  guardrails: Partial<{ maxStepsPerRun: number; maxStepVisits: number; maxModelCallsPerRun: number }> = {},
  options: {
    toolGateway?: ConstructorParameters<typeof Kestrel>[0]["toolGateway"] | undefined;
    workspaceCheckpointService?: RuntimeWorkspaceCheckpointService | undefined;
    managedTaskWorktreeService?: ManagedTaskWorktreeService | undefined;
  } = {},
) {
  return new Kestrel({
    store,
    toolGateway: options.toolGateway ?? {
      call: async () => null as never,
    },
    ...(options.workspaceCheckpointService !== undefined
      ? { workspaceCheckpointService: options.workspaceCheckpointService }
      : {}),
    ...(options.managedTaskWorktreeService !== undefined
      ? { managedTaskWorktreeService: options.managedTaskWorktreeService }
      : {}),
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      const metadata = request.metadata as Record<string, unknown> | undefined;
      const input = request.input as Record<string, unknown> | undefined;
      const reply = typeof input?.userReply === "string" ? input.userReply.toLowerCase() : "";
      if (metadata?.modelRole === "user_reply_intent") {
        if (reply.includes("approve")) {
          return {
            output: {
              kind: "approval_decision",
              decision: "approve",
              confidence: "high",
            },
          } as T;
        }
        if (reply.includes("continue") || reply.includes("go on")) {
          return {
            output: {
              kind: "continue",
              proceed: true,
              confidence: "high",
            },
          } as T;
        }
      }
      return { ok: true } as T;
    }),
    guardrails: {
      maxStepsPerRun: 50,
      maxStepVisits: 50,
      ...guardrails,
    },
  });
}

test("managed mutation tools capture pre/post workspace checkpoints and expose changed files", async () => {
  const store = new InMemorySessionStore();
  const captures: string[] = [];
  const checkpointService: RuntimeWorkspaceCheckpointService = {
    capture: async (input) => {
      const checkpointId = `cp-${captures.length + 1}`;
      captures.push(`${input.kind ?? "manual"}:${input.reason ?? ""}`);
      return {
        checkpoint: {
          checkpointId,
          sessionId: input.sessionId,
          workspaceRoot: "/tmp/kestrel-worktree",
          repoRoot: "/tmp/kestrel-worktree",
          label: input.label ?? checkpointId,
          isExplicitLabel: input.label !== undefined,
          reason: input.reason ?? "test",
          createdBy: input.createdBy ?? "test",
          createdAt: new Date(0).toISOString(),
          storageKind: "git_ref_v1",
          gitRef: `refs/kestrel/checkpoints/test/${checkpointId}`,
          kind: input.kind ?? "manual",
          retentionClass: input.kind ?? "manual",
          captureStatus: "CAPTURED",
          manifestHash: checkpointId,
          fileCount: 1,
          totalBytes: 12,
        },
        files: [],
      };
    },
    diff: async (input) => ({
      diffId: "diff-1",
      sessionId: input.sessionId,
      source: { kind: "checkpoint", checkpointId: input.source.checkpointId, label: "pre" },
      target: { kind: "working_tree", label: "working tree" },
      createdAt: new Date(0).toISOString(),
      fileCount: 1,
      files: [{ path: "app/page.tsx", status: "modified" }],
    }),
    restore: async (input) => ({
      restoreId: "restore-1",
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
      workspaceRoot: "/tmp/kestrel-worktree",
      repoRoot: "/tmp/kestrel-worktree",
      restoredBy: "test",
      reason: "test",
      validationMessages: [],
      status: "COMPLETED",
      createdAt: new Date(0).toISOString(),
      restoredAt: new Date(0).toISOString(),
    }),
  };
  const kestrel = createRuntime(store, {}, {
    workspaceCheckpointService: checkpointService,
    toolGateway: {
      call: async () => buildAgentToolSuccessResult({
        toolName: "dev.shell.run",
        input: {
          command: "printf '<section>Hero</section>' > app/page.tsx",
          workspaceRoot: ".",
        },
        output: { status: "completed" },
      }),
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const output = await io.useTool!("dev.shell.run", {
      command: "printf '<section>Hero</section>' > app/page.tsx",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: { shellOutput: output },
      },
    };
  });

  const initialSession = await store.ensureSession("checkpoint-tool-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "checkpoint-tool-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: "checkpoint-tool-session",
            sourceWorkspaceRoot: "/tmp/source",
            sourceRepoRoot: "/tmp/source",
            worktreeRoot: "/tmp/kestrel-worktree",
            baseHead: "abc123",
            triggeringTool: "dev.shell.run",
            boundAt: new Date(0).toISOString(),
          },
        },
      },
    },
  });

  await kestrel.run({
    id: "evt-checkpoint-tool",
    type: "user.message",
    sessionId: "checkpoint-tool-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        managedWorktree: true,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
      },
    },
  });

  const session = await store.getSession("checkpoint-tool-session");
  const shellOutput = unwrapAgentToolOutput((session?.state.agent as Record<string, unknown>).shellOutput) as Record<string, unknown>;
  assert.deepEqual(shellOutput.changedFiles, ["app/page.tsx"]);
  assert.equal((shellOutput.workspaceCheckpoint as Record<string, unknown>).preActionCheckpointId, "cp-1");
  assert.equal((shellOutput.workspaceCheckpoint as Record<string, unknown>).postActionCheckpointId, "cp-2");
  assert.deepEqual(captures, [
    "pre_mutation:Pre-action checkpoint for dev.shell.run",
    "pre_mutation:Post-action checkpoint for dev.shell.run",
  ]);
});

test("managed mutation tools fail fast when dev shell guard falls back to source-readonly mode", async () => {
  const store = new InMemorySessionStore();
  const checkpointService: RuntimeWorkspaceCheckpointService = {
    capture: async (input) => ({
      checkpoint: {
        checkpointId: "cp-guard-mode",
        sessionId: input.sessionId,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
        label: input.label ?? "cp-guard-mode",
        isExplicitLabel: input.label !== undefined,
        reason: input.reason ?? "test",
        createdBy: input.createdBy ?? "test",
        createdAt: new Date(0).toISOString(),
        storageKind: "git_ref_v1",
        gitRef: "refs/kestrel/checkpoints/test/cp-guard-mode",
        kind: input.kind ?? "manual",
        retentionClass: input.kind ?? "manual",
        captureStatus: "CAPTURED",
        manifestHash: "cp-guard-mode",
        fileCount: 0,
        totalBytes: 0,
      },
      files: [],
    }),
    diff: async (input) => ({
      diffId: "diff-guard-mode",
      sessionId: input.sessionId,
      source: { kind: "checkpoint", checkpointId: input.source.checkpointId, label: "pre" },
      target: { kind: "working_tree", label: "working tree" },
      createdAt: new Date(0).toISOString(),
      fileCount: 0,
      files: [],
    }),
    restore: async (input) => ({
      restoreId: "restore-guard-mode",
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
      workspaceRoot: "/tmp/kestrel-worktree",
      repoRoot: "/tmp/kestrel-worktree",
      restoredBy: "test",
      reason: "test",
      validationMessages: [],
      status: "COMPLETED",
      createdAt: new Date(0).toISOString(),
      restoredAt: new Date(0).toISOString(),
    }),
  };
  const kestrel = createRuntime(store, {}, {
    workspaceCheckpointService: checkpointService,
    toolGateway: {
      call: async () => buildAgentToolSuccessResult({
        toolName: "dev.shell.run",
        input: {
          command: "npm create vite@latest . -- --template react",
          workspaceRoot: ".",
        },
        output: {
          status: "COMPLETED",
          sourceWriteGuard: {
            enabled: true,
            mode: "source_readonly",
            finalCheckCompleted: true,
            unauthorizedSourceWrites: [],
          },
        },
      }),
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("dev.shell.run", {
      command: "npm create vite@latest . -- --template react",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: { shellOutput: { status: "unexpected" } },
      },
    };
  });

  const initialSession = await store.ensureSession("checkpoint-guard-mode-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "checkpoint-guard-mode-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: "checkpoint-guard-mode-session",
            sourceWorkspaceRoot: "/tmp/source",
            sourceRepoRoot: "/tmp/source",
            worktreeRoot: "/tmp/kestrel-worktree",
            baseHead: "abc123",
            triggeringTool: "dev.shell.run",
            boundAt: new Date(0).toISOString(),
          },
        },
      },
    },
  });

  const output = await kestrel.run({
    id: "evt-checkpoint-guard-mode",
    type: "user.message",
    sessionId: "checkpoint-guard-mode-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        managedWorktree: true,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
      },
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "MANAGED_WORKTREE_SOURCE_WRITE_GUARD_MODE_MISMATCH");
});

test("spoofed managed worktree payload does not enable checkpoint wrapping without a session binding", async () => {
  const store = new InMemorySessionStore();
  let captureCount = 0;
  const checkpointService: RuntimeWorkspaceCheckpointService = {
    capture: async () => {
      captureCount += 1;
      throw new Error("checkpoint should not be captured for spoofed worktree");
    },
    diff: async () => {
      throw new Error("diff should not run");
    },
    restore: async () => {
      throw new Error("restore should not run");
    },
  };
  const kestrel = createRuntime(store, {}, {
    workspaceCheckpointService: checkpointService,
    toolGateway: {
      call: async <T>() => ({ status: "completed" } as T),
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const output = await io.useTool!("dev.shell.run", {
      command: "printf '<section>Hero</section>' > app/page.tsx",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: { shellOutput: output },
      },
    };
  });

  await kestrel.run({
    id: "evt-spoofed-checkpoint-tool",
    type: "user.message",
    sessionId: "spoofed-checkpoint-tool-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        managedWorktree: true,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
      },
    },
  });

  assert.equal(captureCount, 0);
});

test("managed worktree approval binds resumed mutation runs before tool context is scoped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-managed-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const proposal = await managedTaskWorktreeService.prepare({
    sessionId: "managed-bind-session",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
  });
  const initialSession = await store.ensureSession("managed-bind-session", "agent.exec.dispatch");
  const initialReact = (initialSession.state.agent ?? {}) as Record<string, unknown>;
  await store.patchSessionState?.({
    sessionId: "managed-bind-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        ...initialReact,
        exec: {
          ...((initialReact.exec ?? {}) as Record<string, unknown>),
          pendingApproval: {
            approvalId: "approval-1",
            purpose: "managed_worktree",
            toolName: "fs.write_text",
            request: {
              sessionId: "managed-bind-session",
              sourceWorkspaceRoot: proposal.sourceWorkspaceRoot,
              sourceRepoRoot: proposal.sourceRepoRoot,
              worktreeRoot: proposal.worktreeRoot,
              baseHead: proposal.baseHead,
              taskKey: "add-hero",
              triggeringTool: "fs.write_text",
            },
          },
        },
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: {
            path: "app/page.tsx",
            content: "<section>Hero</section>",
          },
        },
      },
    },
  });
  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: string[] = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string) => {
        toolCalls.push(name);
        return { ok: true } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("fs.write_text", {
      path: "app/page.tsx",
      content: "<section>Hero</section>",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  await kestrel.run({
    id: "evt-approval",
    type: "user.approval",
    sessionId: "managed-bind-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      message: "approve",
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  const workspace = preRunWorkspaces[0];
  const realRepo = await realpath(repo);
  assert.equal(workspace?.managedWorktree, true);
  assert.notEqual(workspace?.workspaceRoot, repo);
  assert.equal(workspace?.sourceWorkspaceRoot, realRepo);
  assert.deepEqual(toolCalls, ["fs.write_text"]);
  await stat(String(workspace?.workspaceRoot));

  const session = await store.getSession("managed-bind-session");
  const binding = ((((session?.state.agent as Record<string, unknown>)?.exec as Record<string, unknown>) ?? {})
    .managedWorktreeBinding ?? {}) as Record<string, unknown>;
  const pendingApproval = (((session?.state.agent as Record<string, unknown>)?.exec as Record<string, unknown>) ?? {})
    .pendingApproval;
  assert.equal(binding.status, "bound");
  assert.equal(binding.sourceWorkspaceRoot, realRepo);
  assert.equal(binding.worktreeRoot, workspace?.workspaceRoot);
  assert.equal(pendingApproval, undefined);
});

test("filesystem mutation tools auto-provision managed worktree before tool context is scoped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-fs-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-fs-worktree-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-fs-worktree-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: {
            path: "app/page.tsx",
            content: "<section>Hero</section>",
          },
        },
      },
    },
  });

  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const preRunBindings: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: string[] = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
        const agent = (context.session.state.agent ?? {}) as Record<string, unknown>;
        const exec = (agent.exec ?? {}) as Record<string, unknown>;
        preRunBindings.push((exec.managedWorktreeBinding ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string) => {
        toolCalls.push(name);
        return { ok: true } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("fs.write_text", {
      path: "app/page.tsx",
      content: "<section>Hero</section>",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-fs-worktree",
    type: "system.resume",
    sessionId: "auto-fs-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.deepEqual(toolCalls, ["fs.write_text"]);
  assert.equal(preRunWorkspaces.length, 3);
  assert.equal(preRunBindings[0], undefined);

  const refreshedWorkspace = preRunWorkspaces[2];
  const refreshedBinding = preRunBindings[2];
  const realRepo = await realpath(repo);
  assert.equal(refreshedWorkspace?.managedWorktree, true);
  assert.equal(refreshedWorkspace?.sourceWorkspaceRoot, realRepo);
  assert.notEqual(refreshedWorkspace?.workspaceRoot, repo);
  assert.equal(refreshedBinding?.status, "bound");
  assert.equal(refreshedBinding?.sourceWorkspaceRoot, realRepo);

  const persistedSession = await store.getSession("auto-fs-worktree-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  const binding = (persistedExec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
  assert.equal(binding.status, "bound");
  assert.equal(binding.sourceWorkspaceRoot, realRepo);
  assert.equal(binding.worktreeRoot, refreshedWorkspace?.workspaceRoot);
  assert.equal(persistedExec.pendingApproval, undefined);

  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("managed_worktree.auto_requested"));
  assert.ok(eventTypes.includes("managed_worktree.created"));
  assert.ok(eventTypes.includes("managed_worktree.bound"));
  assert.equal(eventTypes.includes("managed_worktree.approval_requested"), false);
});

test("filesystem mutation batches auto-provision managed worktree before tool context is scoped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-fs-batch-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-fs-batch-worktree-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-fs-batch-worktree-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool_batch",
          items: [
            {
              name: "fs.read_text",
              input: { path: "app/page.tsx" },
            },
            {
              name: "fs.write_text",
              input: {
                path: "app/page.tsx",
                content: "<section>Hero</section>",
              },
            },
          ],
        },
      },
    },
  });

  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const preRunBindings: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: string[] = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
        const agent = (context.session.state.agent ?? {}) as Record<string, unknown>;
        const exec = (agent.exec ?? {}) as Record<string, unknown>;
        preRunBindings.push((exec.managedWorktreeBinding ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string) => {
        toolCalls.push(name);
        return { ok: true } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("fs.write_text", {
      path: "app/page.tsx",
      content: "<section>Hero</section>",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-fs-batch-worktree",
    type: "system.resume",
    sessionId: "auto-fs-batch-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.deepEqual(toolCalls, ["fs.write_text"]);
  assert.equal(preRunWorkspaces.length, 3);
  assert.equal(preRunBindings[0], undefined);

  const refreshedWorkspace = preRunWorkspaces[2];
  const refreshedBinding = preRunBindings[2];
  const realRepo = await realpath(repo);
  assert.equal(refreshedWorkspace?.managedWorktree, true);
  assert.equal(refreshedWorkspace?.sourceWorkspaceRoot, realRepo);
  assert.notEqual(refreshedWorkspace?.workspaceRoot, repo);
  assert.equal(refreshedBinding?.status, "bound");
  assert.equal(refreshedBinding?.sourceWorkspaceRoot, realRepo);

  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("managed_worktree.auto_requested"));
  assert.ok(eventTypes.includes("managed_worktree.created"));
  assert.ok(eventTypes.includes("managed_worktree.bound"));
  assert.equal(eventTypes.includes("managed_worktree.approval_requested"), false);
});

test("dev shell tools auto-provision managed worktree before tool context is scoped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-worktree-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-worktree-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const preRunBindings: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
        const agent = (context.session.state.agent ?? {}) as Record<string, unknown>;
        const exec = (agent.exec ?? {}) as Record<string, unknown>;
        preRunBindings.push((exec.managedWorktreeBinding ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { stdout: "/managed/worktree\n" } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-worktree",
    type: "system.resume",
    sessionId: "auto-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.shell.run");
  assert.equal(preRunWorkspaces.length, 3);
  assert.equal(preRunBindings[0], undefined);

  const refreshedWorkspace = preRunWorkspaces[2];
  const refreshedBinding = preRunBindings[2];
  const realRepo = await realpath(repo);
  assert.equal(refreshedWorkspace?.managedWorktree, true);
  assert.equal(refreshedWorkspace?.sourceWorkspaceRoot, realRepo);
  assert.notEqual(refreshedWorkspace?.workspaceRoot, repo);
  assert.equal(refreshedBinding?.status, "bound");
  assert.equal(refreshedBinding?.sourceWorkspaceRoot, realRepo);
  assert.equal(refreshedBinding?.worktreeRoot, refreshedWorkspace?.workspaceRoot);

  const persistedSession = await store.getSession("auto-worktree-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  const binding = (persistedExec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
  assert.equal(binding.status, "bound");
  assert.equal(binding.sourceWorkspaceRoot, realRepo);
  assert.equal(binding.worktreeRoot, refreshedWorkspace?.workspaceRoot);
  await stat(String(binding.worktreeRoot));
  assert.equal(
    await realpath(await git(String(binding.worktreeRoot), ["rev-parse", "--show-toplevel"])),
    await realpath(String(binding.worktreeRoot)),
  );

  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("managed_worktree.auto_requested"));
  assert.ok(eventTypes.includes("managed_worktree.created"));
  assert.ok(eventTypes.includes("managed_worktree.bound"));
});

test("dev shell auto-provision refreshes registry context at invocation time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-registry-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-registry-worktree-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-registry-worktree-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "/managed/worktree\n",
            text: "/managed/worktree\n",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: {
      refresh: async () => ({
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      }),
      assertHealthy: async () => {},
      callTool: async () => {
        throw new Error("unexpected MCP tool call");
      },
      close: async () => {},
    },
  });
  await registry.refresh();

  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: registry,
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-registry-worktree",
    type: "system.resume",
    sessionId: "auto-registry-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(execInputs.length, 1);
  assert.equal(execInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
    approvalGrants: [],
  });
  assert.notEqual(execInputs[0]?.workspaceRoot, repo);
  assert.equal(typeof execInputs[0]?.workspaceRoot, "string");
});

test("terminal managed worktree runs emit fan-in candidates for changed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-worktree-fanin-candidate-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-worktree-fanin-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-worktree-fanin-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "touch fan-in.txt",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      call: async <T>() => ({ stdout: "ok\n" }) as T,
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (ctx, io) => {
    const workspace = (ctx.event.payload.workspace ?? {}) as Record<string, unknown>;
    await writeFile(path.join(String(workspace.workspaceRoot), "fan-in.txt"), "ready\n", "utf8");
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-worktree-fanin",
    type: "system.resume",
    sessionId: "auto-worktree-fanin-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  const fanInEvent = store.getRunEvents().find((event) => event.type === "managed_worktree.fan_in_candidate");
  assert.notEqual(fanInEvent, undefined);
  assert.equal(fanInEvent?.level, "INFO");
  assert.deepEqual(fanInEvent?.metadata?.changedFiles, ["fan-in.txt"]);
  assert.equal(fanInEvent?.metadata?.applyStatus, "ready");
  assert.equal(typeof fanInEvent?.metadata?.candidateFingerprint, "string");
});

test("managed worktree auto-provision uses session isolation when requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-worktree-session-isolation-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      call: async <T>() => ({ stdout: "ok\n" }) as T,
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
        },
      },
    };
  });

  for (const sessionId of ["session-isolated-1", "session-isolated-2"]) {
    const session = await store.ensureSession(sessionId, "agent.exec.dispatch");
    await store.patchSessionState?.({
      sessionId,
      expectedVersion: session.version,
      statePatch: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "dev.shell.run",
            input: {
              command: "pwd",
              workspaceRoot: ".",
            },
          },
        },
      },
    });
    const output = await kestrel.run({
      id: `evt-${sessionId}`,
      type: "system.resume",
      sessionId,
      stepAgent: "agent.exec.dispatch",
      payload: {
        workspace: {
          workspaceRoot: repo,
          managedWorktreeRequired: true,
          managedWorktreeIsolation: "session",
        },
      },
    });
    assert.equal(output.status, "COMPLETED");
  }

  const firstBinding = ((await store.getSession("session-isolated-1"))?.state.agent as Record<string, unknown> | undefined)?.exec as Record<string, unknown> | undefined;
  const secondBinding = ((await store.getSession("session-isolated-2"))?.state.agent as Record<string, unknown> | undefined)?.exec as Record<string, unknown> | undefined;
  const firstWorktree = (firstBinding?.managedWorktreeBinding as Record<string, unknown> | undefined)?.worktreeRoot;
  const secondWorktree = (secondBinding?.managedWorktreeBinding as Record<string, unknown> | undefined)?.worktreeRoot;
  assert.equal(typeof firstWorktree, "string");
  assert.equal(typeof secondWorktree, "string");
  assert.notEqual(firstWorktree, secondWorktree);
  assert.deepEqual((firstBinding?.managedWorktreeBinding as Record<string, unknown> | undefined)?.scope, {
    kind: "sessionId",
    value: "session-isolated-1",
  });
});

test("dev shell tools do not auto-provision managed worktrees unless requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-no-auto-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { stdout: `${repo}\n` } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-no-auto-worktree",
    type: "system.resume",
    sessionId: "no-auto-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.shell.run");
  assert.equal(preRunWorkspaces.length, 2);
  assert.equal(preRunWorkspaces[0]?.managedWorktree, undefined);
  assert.equal(preRunWorkspaces[0]?.workspaceRoot, repo);
  assert.equal(preRunWorkspaces[1]?.managedWorktree, undefined);
  assert.equal(preRunWorkspaces[1]?.workspaceRoot, repo);
  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.equal(eventTypes.includes("managed_worktree.auto_requested"), false);
});

test("dev shell auto-provision reuses workspace-scoped worktrees across new sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-workspace-scoped-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>() => ({ stdout: "ok\n" }) as T,
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  for (const sessionId of ["workspace-session-a", "workspace-session-b"]) {
    const initialSession = await store.ensureSession(sessionId, "agent.exec.dispatch");
    await store.patchSessionState?.({
      sessionId,
      expectedVersion: initialSession.version,
      statePatch: {
        agent: {
          nextAction: {
            kind: "tool",
            name: "dev.shell.run",
            input: {
              command: "pwd",
              workspaceRoot: ".",
            },
          },
        },
      },
    });

    const output = await kestrel.run({
      id: `evt-${sessionId}`,
      type: "system.resume",
      sessionId,
      stepAgent: "agent.exec.dispatch",
      payload: {
        workspace: {
          workspaceId: repo,
          workspaceRoot: repo,
          managedWorktreeRequired: true,
        },
      },
    });
    assert.equal(output.status, "COMPLETED");
  }

  const managedWorkspaces = preRunWorkspaces.filter(
    (workspace): workspace is Record<string, unknown> => workspace?.managedWorktree === true,
  );
  assert.equal(managedWorkspaces.length, 4);
  assert.equal(new Set(managedWorkspaces.map((workspace) => workspace.workspaceRoot)).size, 1);
  assert.notEqual(managedWorkspaces[0]?.workspaceRoot, repo);

  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("managed_worktree.created"));
  assert.ok(eventTypes.includes("managed_worktree.reused"));
});

test("dev process tools auto-provision managed worktree before tool context is scoped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-process-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-process-worktree-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-process-worktree-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.process.start",
          input: {
            command: "npm run dev",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const preRunBindings: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
        const agent = (context.session.state.agent ?? {}) as Record<string, unknown>;
        const exec = (agent.exec ?? {}) as Record<string, unknown>;
        preRunBindings.push((exec.managedWorktreeBinding ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { processId: "proc-1", status: "running" } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.process.start", {
      command: "npm run dev",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-process-worktree",
    type: "system.resume",
    sessionId: "auto-process-worktree-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.process.start");
  assert.equal(preRunWorkspaces.length, 3);
  assert.equal(preRunBindings[0], undefined);

  const refreshedWorkspace = preRunWorkspaces[2];
  const refreshedBinding = preRunBindings[2];
  const realRepo = await realpath(repo);
  assert.equal(refreshedWorkspace?.managedWorktree, true);
  assert.equal(refreshedWorkspace?.sourceWorkspaceRoot, realRepo);
  assert.notEqual(refreshedWorkspace?.workspaceRoot, repo);
  assert.equal(refreshedBinding?.status, "bound");
  assert.equal(refreshedBinding?.sourceWorkspaceRoot, realRepo);
  assert.equal(refreshedBinding?.worktreeRoot, refreshedWorkspace?.workspaceRoot);

  const persistedSession = await store.getSession("auto-process-worktree-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  const binding = (persistedExec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
  assert.equal(binding.status, "bound");
  assert.equal(binding.sourceWorkspaceRoot, realRepo);
  assert.equal(binding.worktreeRoot, refreshedWorkspace?.workspaceRoot);
  await stat(String(binding.worktreeRoot));

  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("managed_worktree.auto_requested"));
  assert.ok(eventTypes.includes("managed_worktree.created"));
  assert.ok(eventTypes.includes("managed_worktree.bound"));
});

test("dev shell tools reuse valid persisted managed worktree bindings without auto-provisioning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-existing-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await managedTaskWorktreeService.provision({
    sessionId: "auto-existing-session",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-existing",
    triggeringTool: "dev.shell.run",
  });

  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-existing-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-existing-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: provisioned.binding,
        },
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const preRunWorkspaces: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      preRun: async (context) => {
        preRunWorkspaces.push((context.event.payload.workspace ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { stdout: `${provisioned.binding.worktreeRoot}\n` } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-existing",
    type: "system.resume",
    sessionId: "auto-existing-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.shell.run");
  assert.equal(preRunWorkspaces.length, 2);
  assert.equal(preRunWorkspaces[0]?.managedWorktree, true);
  assert.equal(preRunWorkspaces[0]?.workspaceRoot, provisioned.binding.worktreeRoot);
  assert.equal(preRunWorkspaces[0]?.sourceWorkspaceRoot, await realpath(repo));
  assert.equal(preRunWorkspaces[1]?.managedWorktree, true);
  assert.equal(preRunWorkspaces[1]?.workspaceRoot, provisioned.binding.worktreeRoot);
  assert.equal(preRunWorkspaces[1]?.sourceWorkspaceRoot, await realpath(repo));

  const runEventTypes = store.getRunEvents().filter((event) => event.runId === output.runId).map((event) => event.type);
  assert.equal(runEventTypes.includes("managed_worktree.auto_requested"), false);
  assert.equal(runEventTypes.includes("managed_worktree.created"), false);
  assert.equal(runEventTypes.includes("managed_worktree.bound"), false);
});

test("cancelActiveRun releases persisted managed worktree leases and records terminal events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-cancel-managed-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await managedTaskWorktreeService.provision({
    sessionId: "cancel-managed-session",
    runId: "run-cancel-managed",
    sourceWorkspaceRoot: repo,
    taskKey: "cancel-managed",
    triggeringTool: "dev.shell.run",
  });

  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("cancel-managed-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "cancel-managed-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: provisioned.binding,
        },
      },
    },
  });
  await store.startRun("run-cancel-managed", {
    id: "evt-cancel-managed",
    type: "system.resume",
    sessionId: "cancel-managed-session",
    stepAgent: "agent.exec.dispatch",
    payload: {},
  });
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
  });

  const result = await kestrel.cancelActiveRun("cancel-managed-session");

  assert.equal(result.runId, "run-cancel-managed");
  const retry = await managedTaskWorktreeService.provision({
    sessionId: "cancel-managed-session-next",
    runId: "run-after-cancel-managed",
    sourceWorkspaceRoot: repo,
    taskKey: "cancel-managed",
    triggeringTool: "dev.shell.run",
  });
  assert.equal(retry.disposition, "reused");
  const runEventTypes = store.getRunEvents().filter((event) => event.runId === "run-cancel-managed").map((event) => event.type);
  assert.equal(runEventTypes.includes("managed_worktree.released"), true);
  assert.equal(runEventTypes.includes("run.cancelled"), true);
  assert.equal(runEventTypes.includes("run.failed"), true);
  assert.equal(runEventTypes.includes("terminal.normalized"), true);
});

test("dev shell tools clear missing persisted managed worktree bindings before auto-provisioning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-missing-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await managedTaskWorktreeService.provision({
    sessionId: "auto-missing-session",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-missing",
    triggeringTool: "dev.shell.run",
  });
  await rm(provisioned.binding.worktreeRoot, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"]);

  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-missing-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-missing-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: provisioned.binding,
        },
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const preRunBindings: Array<Record<string, unknown> | undefined> = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      preRun: async (context) => {
        const agent = (context.session.state.agent ?? {}) as Record<string, unknown>;
        const exec = (agent.exec ?? {}) as Record<string, unknown>;
        preRunBindings.push((exec.managedWorktreeBinding ?? undefined) as Record<string, unknown> | undefined);
      },
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { stdout: `${provisioned.binding.worktreeRoot}\n` } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    const result = await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {
        agent: {
          ...((_ctx.session.state.agent ?? {}) as Record<string, unknown>),
          result,
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-missing",
    type: "system.resume",
    sessionId: "auto-missing-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      metadata: {
        taskKey: "auto-missing",
      },
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.shell.run");
  assert.equal(preRunBindings.length, 3);
  assert.equal(preRunBindings[0], undefined);
  assert.equal(preRunBindings[2]?.status, "bound");
  assert.equal(preRunBindings[2]?.worktreeRoot, provisioned.binding.worktreeRoot);

  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  const blocked = runEvents.find((event) => event.type === "managed_worktree.blocked");
  assert.equal(blocked?.metadata?.reason, "missing");
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.auto_requested"), true);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.created"), true);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.bound"), true);

  const persistedSession = await store.getSession("auto-missing-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  const binding = (persistedExec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
  assert.equal(binding.status, "bound");
  assert.equal(binding.worktreeRoot, provisioned.binding.worktreeRoot);
  await stat(String(binding.worktreeRoot));
});

test("auto-provisioned dev tools block on invalid deterministic worktree collisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-collision-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const proposal = await managedTaskWorktreeService.prepare({
    sessionId: "auto-collision-session",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-collision",
    triggeringTool: "dev.shell.run",
  });
  await mkdir(proposal.worktreeRoot, { recursive: true });
  await writeFile(path.join(proposal.worktreeRoot, "not-a-worktree.txt"), "x", "utf8");

  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-collision-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-collision-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      call: async () => {
        throw new Error("tool should not run after managed worktree collision");
      },
    },
  });
  let executed = false;
  kestrel.registerStep("agent.exec.dispatch", async () => {
    executed = true;
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-collision",
    type: "system.resume",
    sessionId: "auto-collision-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      metadata: {
        taskKey: "auto-collision",
      },
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "MANAGED_WORKTREE_PATH_COLLISION");
  assert.equal(executed, false);

  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.auto_requested"), true);
  const blocked = runEvents.find((event) => event.type === "managed_worktree.blocked");
  assert.equal(blocked?.metadata?.reason, "path_collision");
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.bound"), false);

  const persistedSession = await store.getSession("auto-collision-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  assert.equal(persistedExec.managedWorktreeBinding, undefined);
});

test("auto-provisioned dev tools reclaim orphaned deterministic worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-orphan-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await managedTaskWorktreeService.provision({
    sessionId: "orphan-session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-orphan",
    triggeringTool: "dev.shell.run",
  });
  const gitDirPointer = await readFile(path.join(provisioned.binding.worktreeRoot, ".git"), "utf8");
  const gitDir = path.resolve(provisioned.binding.worktreeRoot, gitDirPointer.replace(/^gitdir:\s*/u, "").trim());
  await rm(gitDir, { recursive: true, force: true });

  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("auto-orphan-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-orphan-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      call: async <T>(name: string, input: unknown) => {
        toolCalls.push({ name, input });
        return { stdout: `${provisioned.binding.worktreeRoot}\n` } as T;
      },
    },
  });
  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("dev.shell.run", {
      command: "pwd",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-orphan",
    type: "system.resume",
    sessionId: "auto-orphan-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      metadata: {
        taskKey: "auto-orphan",
      },
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(toolCalls[0]?.name, "dev.shell.run");

  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.orphan_detected"), true);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.orphan_reclaimed"), true);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.created"), true);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.bound"), true);

  const persistedSession = await store.getSession("auto-orphan-session");
  const persistedAgent = (persistedSession?.state.agent ?? {}) as Record<string, unknown>;
  const persistedExec = (persistedAgent.exec ?? {}) as Record<string, unknown>;
  const binding = (persistedExec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
  assert.equal(binding.worktreeRoot, provisioned.binding.worktreeRoot);
});

test("auto-provisioned dev tools block orphan reclaim while the previous run lease owner is still active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-auto-orphan-active-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const managedTaskWorktreeService = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await managedTaskWorktreeService.provision({
    sessionId: "orphan-session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-orphan-active",
    triggeringTool: "dev.shell.run",
  });
  const gitDirPointer = await readFile(path.join(provisioned.binding.worktreeRoot, ".git"), "utf8");
  const gitDir = path.resolve(provisioned.binding.worktreeRoot, gitDirPointer.replace(/^gitdir:\s*/u, "").trim());
  await rm(gitDir, { recursive: true, force: true });

  const store = new InMemorySessionStore();
  await store.ensureSession("orphan-session-1", "agent.exec.dispatch");
  await store.startRun("run-1", {
    id: "evt-live-orphan-owner",
    type: "system.resume",
    sessionId: "orphan-session-1",
    stepAgent: "agent.exec.dispatch",
    payload: {},
  });
  const initialSession = await store.ensureSession("auto-orphan-active-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "auto-orphan-active-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command: "pwd",
            workspaceRoot: ".",
          },
        },
      },
    },
  });

  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService,
    toolGateway: {
      call: async () => {
        throw new Error("tool should not run while the previous orphan lease owner is still active");
      },
    },
  });
  let executed = false;
  kestrel.registerStep("agent.exec.dispatch", async () => {
    executed = true;
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-auto-orphan-active",
    type: "system.resume",
    sessionId: "auto-orphan-active-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      metadata: {
        taskKey: "auto-orphan-active",
      },
      workspace: {
        workspaceRoot: repo,
        managedWorktreeRequired: true,
      },
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "MANAGED_WORKTREE_LEASE_BLOCKED");
  assert.equal(executed, false);

  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.auto_requested"), true);
  const blocked = runEvents.find((event) => event.type === "managed_worktree.lease_blocked");
  assert.equal(blocked?.metadata?.reason, "active_lease");
  assert.equal(runEvents.some((event) => event.type === "managed_worktree.orphan_reclaimed"), false);
});

test("approval resume rejects corrupted persisted nextAction before executing the resumed step", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("corrupt-approval-session", "agent.exec.dispatch");
  store.unsafeOverwriteSessionStateForTest({
    sessionId: "corrupt-approval-session",
    currentStepAgent: "agent.exec.dispatch",
    state: {
      runtime: {
        schemaVersion: 1,
      },
      agent: {
        observations: [],
        exec: {
          pendingApproval: {
            approvalId: "approval-corrupt",
            purpose: "managed_worktree",
            request: {
              sessionId: "corrupt-approval-session",
              sourceWorkspaceRoot: "/tmp/source",
              triggeringTool: "fs.write_text",
            },
          },
        },
        nextAction: "[Circular]",
      },
    },
  });
  const kestrel = createRuntime(store);
  let executed = false;
  kestrel.registerStep("agent.exec.dispatch", async () => {
    executed = true;
    return {
      status: "COMPLETED",
      nextStepAgent: "done",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-corrupt-approval",
    type: "user.approval",
    sessionId: "corrupt-approval-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      message: "approve",
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "RUNTIME_STATE_INVALID");
  assert.equal(executed, false);
  const events = await store.getReplayStream({ runId: output.runId });
  const blocked = events.find((event) => event.type === "runtime.resume_blocked");
  assert.equal(blocked?.metadata?.invalidStatePath, "state.agent.nextAction");
});

test("approval resume rejects malformed pendingApproval before executing the resumed step", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("bad-approval-session", "agent.exec.dispatch");
  store.unsafeOverwriteSessionStateForTest({
    sessionId: "bad-approval-session",
    currentStepAgent: "agent.exec.dispatch",
    state: {
      runtime: {
        schemaVersion: 1,
      },
      agent: {
        observations: [],
        waitingFor: {
          kind: "approval",
          eventType: "user.approval",
          reason: "approval wait",
          resumeInstruction: "Resume when approval is received.",
          resumeStepAgent: "agent.exec.dispatch",
          metadata: {
            reason: "managed_worktree_approval",
          },
        },
        exec: {
          pendingApproval: "bad",
        },
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: {
            path: "app/page.tsx",
            content: "<section>Hero</section>",
          },
        },
      },
    },
  });
  const kestrel = createRuntime(store);
  let executed = false;
  kestrel.registerStep("agent.exec.dispatch", async () => {
    executed = true;
    return {
      status: "COMPLETED",
      nextStepAgent: "done",
      statePatch: {},
    };
  });

  const output = await kestrel.run({
    id: "evt-bad-approval",
    type: "user.approval",
    sessionId: "bad-approval-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      message: "approve",
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "RUNTIME_STATE_INVALID");
  assert.equal(executed, false);
  const events = await store.getReplayStream({ runId: output.runId });
  const blocked = events.find((event) => event.type === "runtime.resume_blocked");
  assert.equal(blocked?.metadata?.invalidStatePath, "state.agent.exec.pendingApproval");
  assert.equal(blocked?.metadata?.waitSource, "waitingFor");
  assert.equal(blocked?.metadata?.waitEventType, "user.approval");
  assert.equal(blocked?.metadata?.resumeStepAgent, "agent.exec.dispatch");
});

test("reference-react registration uses source filesystem mutations from runtime service by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-runtime-managed-registration-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initGitRepo(repo);
  const store = new InMemorySessionStore();
  const initialSession = await store.ensureSession("managed-registration-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "managed-registration-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        nextAction: {
          kind: "tool",
          name: "fs.write_text",
          input: { path: "app/page.tsx", content: "<section>Hero</section>" },
        },
      },
    },
  });

  let toolCalled = false;
  const kestrel = createRuntime(store, {}, {
    managedTaskWorktreeService: new ManagedTaskWorktreeService({ homeDir: home }),
    toolGateway: {
      call: async <T>() => {
        toolCalled = true;
        return { ok: true } as T;
      },
    },
  });
  registerAgentReferenceRuntime(kestrel);

  const output = await kestrel.run({
    id: "evt-managed-registration",
    type: "system.resume",
    sessionId: "managed-registration-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        workspaceRoot: repo,
      },
    },
  });

  assert.equal(output.status, "FAILED");
  assert.equal(output.waitFor, undefined);
  assert.equal(toolCalled, true);
  assert.equal(output.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  const eventTypes = store.getRunEvents().map((event) => event.type);
  assert.equal(eventTypes.includes("managed_worktree.auto_requested"), false);
  assert.equal(eventTypes.includes("managed_worktree.bound"), false);
  assert.equal(eventTypes.includes("managed_worktree.approval_requested"), false);
});

test("managed failed mutation tools roll back changed files to the pre-action checkpoint", async () => {
  const store = new InMemorySessionStore();
  const restoredCheckpointIds: string[] = [];
  const checkpointService: RuntimeWorkspaceCheckpointService = {
    capture: async (input) => ({
      checkpoint: {
        checkpointId: "cp-before-failure",
        sessionId: input.sessionId,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
        label: input.label ?? "pre",
        isExplicitLabel: input.label !== undefined,
        reason: input.reason ?? "test",
        createdBy: input.createdBy ?? "runtime",
        createdAt: new Date(0).toISOString(),
        storageKind: "git_ref_v1",
        gitRef: "refs/kestrel/checkpoints/test/cp-before-failure",
        kind: input.kind ?? "pre_mutation",
        retentionClass: input.kind ?? "pre_mutation",
        captureStatus: "CAPTURED",
        manifestHash: "pre",
        fileCount: 1,
        totalBytes: 12,
      },
      files: [],
    }),
    diff: async (input) => ({
      diffId: "diff-failed",
      sessionId: input.sessionId,
      source: { kind: "checkpoint", checkpointId: input.source.checkpointId, label: "pre" },
      target: { kind: "working_tree", label: "working tree" },
      createdAt: new Date(0).toISOString(),
      fileCount: 1,
      files: [{ path: "app/page.tsx", status: "modified" }],
    }),
    restore: async (input) => {
      restoredCheckpointIds.push(input.checkpointId);
      return {
        restoreId: "restore-failed-mutation",
        sessionId: input.sessionId,
        checkpointId: input.checkpointId,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
        restoredBy: "runtime",
        reason: "rollback",
        validationMessages: [],
        status: "COMPLETED",
        createdAt: new Date(0).toISOString(),
        restoredAt: new Date(0).toISOString(),
      };
    },
  };
  const kestrel = createRuntime(store, {}, {
    workspaceCheckpointService: checkpointService,
    toolGateway: {
      call: async () => {
        throw new Error("parse error near &&");
      },
    },
  });

  kestrel.registerStep("agent.exec.dispatch", async (_ctx, io) => {
    await io.useTool!("dev.shell.run", {
      command: "printf '<section>Hero</section>' > app/page.tsx &&",
      workspaceRoot: ".",
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "react.done",
      statePatch: {},
    };
  });

  const initialSession = await store.ensureSession("checkpoint-failed-tool-session", "agent.exec.dispatch");
  await store.patchSessionState?.({
    sessionId: "checkpoint-failed-tool-session",
    expectedVersion: initialSession.version,
    statePatch: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: "checkpoint-failed-tool-session",
            sourceWorkspaceRoot: "/tmp/source",
            sourceRepoRoot: "/tmp/source",
            worktreeRoot: "/tmp/kestrel-worktree",
            baseHead: "abc123",
            triggeringTool: "dev.shell.run",
            boundAt: new Date(0).toISOString(),
          },
        },
      },
    },
  });

  const output = await kestrel.run({
    id: "evt-checkpoint-failed-tool",
    type: "user.message",
    sessionId: "checkpoint-failed-tool-session",
    stepAgent: "agent.exec.dispatch",
    payload: {
      workspace: {
        managedWorktree: true,
        workspaceRoot: "/tmp/kestrel-worktree",
        repoRoot: "/tmp/kestrel-worktree",
      },
    },
  });

  assert.equal(output.status, "FAILED");
  assert.deepEqual(restoredCheckpointIds, ["cp-before-failure"]);
});

class StaleContinuationGrantStore extends InMemorySessionStore {
  private readonly staleSessions = new Map<string, SessionRecord>();
  private readonly staleReads = new Set<string>();

  override async commitStep(input: Parameters<InMemorySessionStore["commitStep"]>[0]) {
    const previous = await super.getSession(input.sessionId);
    const result = await super.commitStep(input);
    const message =
      typeof input.event.payload.message === "string" ? input.event.payload.message : undefined;
    if (
      input.event.type !== "user.reply" ||
      message !== "go on" ||
      previous === null
    ) {
      return result;
    }

    this.staleSessions.set(input.sessionId, previous);
    this.staleReads.add(input.sessionId);
    return result;
  }

  override async getSession(sessionId: string) {
    if (this.staleReads.has(sessionId)) {
      this.staleReads.delete(sessionId);
      return this.staleSessions.get(sessionId) ?? null;
    }
    return super.getSession(sessionId);
  }
}

class CorruptedContinuationWaitMetadataStore extends InMemorySessionStore {
  private readonly corruptedReads = new Set<string>();

  override async commitStep(input: Parameters<InMemorySessionStore["commitStep"]>[0]) {
    const result = await super.commitStep(input);
    const statePatch = input.statePatch ?? {};
    const react = ((statePatch as Record<string, unknown>).react ?? {}) as Record<string, unknown>;
    const wait = (react.wait ?? {}) as Record<string, unknown>;
    const metadata = (wait.metadata ?? {}) as Record<string, unknown>;
    if (metadata.reason === "max_steps_continuation") {
      this.corruptedReads.add(input.sessionId);
    }
    return result;
  }

  override async getSession(sessionId: string) {
    const session = await super.getSession(sessionId);
    if (session === null || this.corruptedReads.has(sessionId) === false) {
      return session;
    }

    this.corruptedReads.delete(sessionId);
    const react = ((session.state.agent ?? {}) as Record<string, unknown>);
    const wait = ((react.wait ?? {}) as Record<string, unknown>);
    return {
      ...session,
      state: {
        ...session.state,
        agent: {
          ...react,
          wait: {
            ...wait,
            metadata: "[Circular]",
          },
        },
      },
    };
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

function stableHash(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function buildLoopFingerprintForTest(
  stepName: string,
  reactPatch: Record<string, unknown>,
): string {
  const nextAction =
    typeof reactPatch.nextAction === "object" &&
    reactPatch.nextAction !== null &&
    Array.isArray(reactPatch.nextAction) === false
      ? (reactPatch.nextAction as Record<string, unknown>)
      : undefined;

  return JSON.stringify({
    stepName,
    actionSignature: JSON.stringify({
      kind: typeof nextAction?.kind === "string" ? nextAction.kind : "",
      name:
        typeof nextAction?.name === "string"
          ? nextAction.name
          : typeof nextAction?.type === "string"
            ? nextAction.type
            : "",
      input: sortValue(nextAction?.input),
      items: Array.isArray(nextAction?.items) ? sortValue(nextAction?.items) : undefined,
    }),
    requiredCapabilities: stableHash(reactPatch.requiredCapabilities),
    capabilityEvidence: stableHash(reactPatch.capabilityEvidence),
    waitToken: "",
    waitEventType: "",
  });
}

test("WAITING transitions persist normalized react.wait envelope and replay waiting/resumed events", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.wait_user", async (ctx) => ({
    status: "WAITING",
    nextStepAgent: "agent.exec.wait_user",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        prompt: "Need clarification",
      },
    },
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          resumeStepAgent: "agent.exec.wait_user",
        },
      },
    },
  }));

  const first = await kestrel.run({
    id: "evt-wait-1",
    type: "user.message",
    sessionId: "wait-session",
    payload: {},
    stepAgent: "agent.exec.wait_user",
  });

  assert.equal(first.status, "WAITING");
  const session = await store.getSession("wait-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const wait = (react.waitingFor ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  assert.equal(wait.kind, "user");
  assert.equal(wait.resumeStepAgent, "agent.exec.wait_user");
  assert.equal(wait.eventType, "user.reply");
  assert.equal(typeof wait.resumeToken, "string");
  assert.equal(terminal.status, "WAITING");

  await kestrel.run({
    id: "evt-wait-2",
    type: "user.reply",
    sessionId: "wait-session",
    payload: {
      message: "Here is more detail",
    },
  });

  const replay = await store.getReplayStream({
    sessionId: "wait-session",
  });
  assert.equal(replay.some((event) => event.type === "run.waiting"), true);
  assert.equal(replay.some((event) => event.type === "run.resumed"), true);
  assert.equal(replay.some((event) => event.type === "terminal.normalized"), true);
});

test("reference-react transitions keep working plan without narration memory", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.wait_approval", async (ctx) => ({
    status: "WAITING",
    nextStepAgent: "agent.exec.wait_approval",
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        prompt: "Approve fs.write_text?",
      },
    },
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        commandProcessor: {
          lastCheckpoint: {
            substate: "wait_approval",
            currentStepAgent: "agent.exec.wait_approval",
            nextStepAgent: "agent.exec.wait_approval",
            updatedAtStepIndex: ctx.stepIndex,
          },
        },
        workingPlan: {
          currentChunk: "waiting for approval",
          status: "waiting",
          expectedNextCommand: "agent.exec.wait_approval",
          waitReason: "Approve fs.write_text?",
          blocker: "Approve fs.write_text?",
        },
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-reference-react-narration",
    type: "user.message",
    sessionId: "reference-react-working-plan-session",
    payload: {},
    stepAgent: "agent.exec.wait_approval",
  });

  assert.equal(output.status, "WAITING");
  const session = await store.getSession("reference-react-working-plan-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const workingPlan = (react.workingPlan ?? {}) as Record<string, unknown>;
  const memory = (session?.state.memory ?? {}) as Record<string, unknown>;
  const working = (memory.working ?? {}) as Record<string, unknown>;
  assert.equal(workingPlan.currentChunk, "waiting for approval");
  assert.equal(workingPlan.expectedNextCommand, "agent.exec.wait_approval");
  assert.equal(workingPlan.blocker, "Approve fs.write_text?");
  assert.equal(Object.hasOwn(working, "latestAgentNarration"), false);
  assert.equal(Object.hasOwn(working, "agentNarrationMemory"), false);
});

test("COMPLETED transitions normalize react.terminal and force phase DONE", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.finalize", async () => ({
    status: "COMPLETED",
    emitEvents: [
      {
        type: "agent.completed",
        payload: {},
      },
    ],
    statePatch: {
      agent: {
        phase: "ACT",
        finalOutput: {
          message: "done",
        },
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-finalize",
    type: "user.message",
    sessionId: "final-session",
    payload: {},
    stepAgent: "agent.exec.finalize",
  });

  assert.equal(output.status, "COMPLETED");
  const session = await store.getSession("final-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const terminal = (react.terminal ?? {}) as Record<string, unknown>;
  assert.equal(react.phase, "DONE");
  assert.equal(terminal.status, "COMPLETED");
  assert.equal(terminal.finalStepAgent, "agent.exec.finalize");
  assert.equal(terminal.outputRef, "agent.finalOutput");
});

test("fresh user turns clear stale finalized control state before routing", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("fresh-turn-session", "agent.loop");

  const staleReactState = {
    observations: [
      {
        summary: "Previous turn already finalized.",
        goalMet: true,
      },
    ],
    capabilityEvidence: {},
    plan: {
      intent: "Old turn plan",
      successCriteria: ["Old turn succeeded"],
    },
    workingPlan: {
      currentChunk: "Keep polishing the old landing page copy.",
      commandNames: ["fs.read_text"],
    },
    planDocument: {
      exists: true,
      path: "~/.kestrel/sessions/fresh-turn-session/session-note.md",
      content: "# Old Note\n\nKeep editing the stale landing page.",
    },
    contextCache: {
      rollingSummary: "Old turn summary",
      updatedAt: "2026-03-15T01:21:29.000Z",
    },
    observerJudgment: {
      kind: "finalize_ready",
      summary: "Old turn was ready to finalize.",
      handoffNote: "Finalize the old turn.",
      finalizeReason: "goal_satisfied",
    },
    observerStatus: "ready",
    observerHandoff: {
      summary: "Stale handoff from retired observer state.",
    },
    observerConvergence: {
      shouldFinalize: true,
      evidenceSufficiency: "high",
      confidence: 0.92,
      rationale: "Old convergence decision.",
      missingEvidence: [],
    },
    requiredCapabilities: ["fs.read"],
    toolIntent: {
      version: "v3",
      execution: {
        objective: "Read README",
        candidateTools: ["fs.read_text"],
      },
      confidence: 0.91,
    },
    compiledIntent: {
      version: "compiled_v1",
      source: "draft_intent",
      execution: {
        objective: "Read README",
        candidateTools: ["fs.read_text"],
      },
      confidence: 0.91,
      candidateTools: [
        {
          name: "fs.read_text",
          allowlisted: true,
          capabilityClasses: ["fs.read"],
          executionClass: "read_only",
        },
      ],
      allowlistedCandidates: ["fs.read_text"],
      operationCompatibleCandidates: ["fs.read_text"],
      usableCandidates: ["fs.read_text"],
      requiredCapabilities: ["fs.read"],
      concreteToolName: "fs.read_text",
      isAmbiguous: false,
      nextStep: "planner",
      issues: [],
    },
    activeExecutableIntent: {
      lineage: {
        sourceRunId: "seed-stale-turn",
        sourceEventId: "seed-stale-turn",
        sourceStepIndex: 0,
      },
      executionIntent: {
        objective: "Read README",
        candidateTools: ["fs.read_text"],
      },
      requiredCapabilities: ["fs.read"],
    },
    evidenceLedger: [
      {
        id: "ev_previous_success",
        kind: "artifact_verification",
        status: "passed",
        summary: "Prior turn verified an artifact.",
      },
    ],
    workItem: {
      version: "v1",
      phase: "finalize",
      objective: "Finalize prior turn.",
      reason: "goal_satisfied",
      supportEvidenceIds: ["ev_previous_success"],
    },
    exec: {
      substate: "finalize",
    },
    nextAction: {
      kind: "finalize",
      input: {
        message: "old answer",
      },
    },
    commandBatch: {
      batchId: "stale-command-batch",
      status: "ready",
      commands: [
        {
          commandId: "stale-command-batch-0",
          kind: "tool",
          commandClass: "read",
          name: "fs.read_text",
          input: {
            path: "README.md",
          },
        },
      ],
    },
    finalOutput: {
      message: "old answer",
    },
    lastAction: {
      kind: "tool",
      name: "fs.read_text",
    },
    lastActionResult: {
      kind: "tool",
      name: "fs.read_text",
      output: {
        text: "old file",
      },
    },
    postToolVerification: {
      status: "passed",
      summary: "Old verification passed.",
    },
    wait: {
      kind: "user",
      eventType: "user.reply",
      resumeStepAgent: "agent.loop",
      resumeToken: "stale",
    },
    terminal: {
      status: "COMPLETED",
      reasonCode: "goal_satisfied",
      finalStepAgent: "agent.loop",
      finalizedAt: "2026-03-15T01:21:29.000Z",
      outputRef: "agent.finalOutput",
    },
    finalized: true,
    goalMet: true,
    phase: "DONE",
  } satisfies Record<string, unknown>;
  const staleFingerprint = buildLoopFingerprintForTest("agent.loop", staleReactState);
  await store.commitStep({
    runId: "seed-stale-turn",
    event: {
      id: "seed-stale-turn",
      type: "user.message",
      sessionId: "fresh-turn-session",
      payload: {
        message: "old question",
      },
    },
    sessionId: "fresh-turn-session",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        ...staleReactState,
        loopGuard: {
          history: Array.from({ length: 2 }, () => ({
            fingerprint: staleFingerprint,
            evidenceHash: stableHash(staleReactState.capabilityEvidence),
            observationMarker: "Previous turn already finalized.",
            waitToken: "",
            pendingExecutionHash: stableHash({
              exec: staleReactState.exec,
              pendingApproval: undefined,
              pendingEffectKey: undefined,
              pendingEffectType: undefined,
              pendingToolBatch: undefined,
              pendingToolCall: undefined,
              waitingForUser: undefined,
            }),
            actionSignature: JSON.stringify({
              kind: "finalize",
              name: "",
              input: {
                message: "old answer",
              },
              items: undefined,
            }),
            cycleKind: "",
            toolActionName: "",
            toolActionInputHash: "",
            toolActionSourceCluster: "",
            toolActionLowYield: false,
          })),
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  const kestrel = createRuntime(store);
  let observedRouteReact: Record<string, unknown> | undefined;
  kestrel.registerStep("agent.loop", async (ctx) => {
    observedRouteReact = (ctx.session.state.agent ?? {}) as Record<string, unknown>;
    return {
      status: "RUNNING",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...observedRouteReact,
          goal: String(ctx.event.payload.message ?? ""),
        },
      },
    };
  });
  kestrel.registerStep("agent.loop", async (ctx) => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        nextAction: {
          kind: "finalize",
          input: {
            message: `fresh:${String(ctx.event.payload.message ?? "")}`,
          },
        },
        finalOutput: {
          message: `fresh:${String(ctx.event.payload.message ?? "")}`,
        },
        finalized: true,
        goalMet: true,
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-fresh-turn",
    type: "user.message",
    sessionId: "fresh-turn-session",
    payload: {
      message: "hello",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.errors.length, 0);
  assert.equal(observedRouteReact?.workItem, undefined);
  assert.equal(observedRouteReact?.evidenceLedger, undefined);
  assert.equal(observedRouteReact?.plan, undefined);
  assert.equal(observedRouteReact?.workingPlan, undefined);
  assert.equal(observedRouteReact?.planDocument, undefined);
  assert.equal(observedRouteReact?.contextCache, undefined);
  assert.equal(observedRouteReact?.observerJudgment, undefined);
  assert.equal(observedRouteReact?.observerStatus, undefined);
  assert.equal(observedRouteReact?.observerHandoff, undefined);
  assert.equal(observedRouteReact?.observerConvergence, undefined);
  assert.equal(observedRouteReact?.lastAction, undefined);
  assert.equal(observedRouteReact?.lastActionResult, undefined);
  assert.equal(observedRouteReact?.postToolVerification, undefined);
  assert.equal(observedRouteReact?.commandBatch, undefined);

  const session = await store.getSession("fresh-turn-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal((react.finalOutput as Record<string, unknown>).message, "fresh:hello");
  assert.equal((react.terminal as Record<string, unknown>).status, "COMPLETED");
  assert.equal((react.waitingFor ?? null), null);
  assert.equal((react.toolIntent ?? null), null);
  assert.equal((react.compiledIntent ?? null), null);
  assert.equal((react.requiredCapabilities ?? null), null);
  assert.equal((react.activeExecutableIntent ?? null), null);
  assert.equal((react.commandBatch ?? null), null);
});

test("fresh turn reset preserves executable intent state for explicit blocked-resume lineage", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("fresh-turn-resume-session", "agent.loop");

  await store.commitStep({
    runId: "seed-resume-turn",
    event: {
      id: "seed-resume-turn",
      type: "user.message",
      sessionId: "fresh-turn-resume-session",
      payload: {
        message: "seed",
      },
    },
    sessionId: "fresh-turn-resume-session",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        goal: "Write poem.txt",
        plan: {
          intent: "Resume the approved poem write.",
          successCriteria: ["poem.txt is written"],
        },
        lastActionResult: {
          kind: "tool",
          name: "fs.read_text",
          output: {
            text: "seed evidence",
          },
        },
        requiredCapabilities: ["fs.write"],
        toolIntent: {
          version: "v3",
          execution: {
            objective: "Write poem.txt",
            candidateTools: ["fs.write_text"],
            operationIntent: {
              kind: "write_file",
            },
          },
          confidence: 0.96,
        },
        compiledIntent: {
          version: "compiled_v1",
          source: "draft_intent",
          execution: {
            objective: "Write poem.txt",
            candidateTools: ["fs.write_text"],
            operationIntent: {
              kind: "write_file",
            },
          },
          confidence: 0.96,
          candidateTools: [
            {
              name: "fs.write_text",
              allowlisted: true,
              capabilityClasses: ["fs.write"],
              executionClass: "sandboxed_only",
            },
          ],
          allowlistedCandidates: ["fs.write_text"],
          operationCompatibleCandidates: ["fs.write_text"],
          usableCandidates: ["fs.write_text"],
          requiredCapabilities: ["fs.write"],
          concreteToolName: "fs.write_text",
          isAmbiguous: false,
          nextStep: "planner",
          issues: [],
        },
        activeExecutableIntent: {
          lineage: {
            sourceRunId: "seed-resume-turn",
            sourceEventId: "seed-resume-turn",
            sourceStepIndex: 0,
            blockedWaitReason: "planner_mode_blocked",
            resumeEventType: "user.reply",
          },
          executionIntent: {
            objective: "Write poem.txt",
            candidateTools: ["fs.write_text"],
            operationIntent: {
              kind: "write_file",
            },
          },
          requiredCapabilities: ["fs.write"],
        },
        workItem: {
          version: "v1",
          phase: "derive_artifact",
          objective: "Write poem.txt from the approved intent.",
          artifact: {
            target: "poem.txt",
            requirements: [
              {
                id: "poem-file-written",
                expectation: "poem.txt is written in the workspace.",
              },
            ],
          },
          sourceEvidenceIds: ["ev_seed"],
          derivationMethod: "Use the approved write-file intent.",
        },
        wait: {
          kind: "user",
          eventType: "user.reply",
          resumeStepAgent: "agent.loop",
          resumeToken: "resume-token",
          metadata: {
            reason: "planner_mode_blocked",
            prompt: "Switch to Build and continue.",
          },
        },
        terminal: {
          status: "WAITING",
          reasonCode: "planner_mode_blocked",
          finalStepAgent: "agent.loop",
          finalizedAt: "2026-03-15T01:21:29.000Z",
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  let observedReact: Record<string, unknown> | undefined;
  const kestrel = createRuntime(store);
  kestrel.registerStep("agent.loop", async (ctx) => {
    observedReact = ((ctx.session.state.agent ?? {}) as Record<string, unknown>);
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          ...observedReact,
          finalOutput: {
            message: "resumed",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-fresh-turn-resume",
    type: "user.message",
    sessionId: "fresh-turn-resume-session",
    payload: {
      message: "continue",
      resumeBlockedRun: true,
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.deepEqual((observedReact?.requiredCapabilities as unknown[] | undefined) ?? [], ["fs.write"]);
  assert.notEqual(observedReact?.toolIntent, undefined);
  assert.notEqual(observedReact?.compiledIntent, undefined);
  assert.notEqual(observedReact?.activeExecutableIntent, undefined);
  assert.equal(observedReact?.plan, undefined);
  assert.deepEqual(observedReact?.lastActionResult, {
    kind: "tool",
    name: "fs.read_text",
    output: {
      text: "seed evidence",
    },
  });
  assert.deepEqual(observedReact?.workItem, {
    version: "v1",
    phase: "derive_artifact",
    objective: "Write poem.txt from the approved intent.",
    artifact: {
      target: "poem.txt",
      requirements: [
        {
          id: "poem-file-written",
          expectation: "poem.txt is written in the workspace.",
        },
      ],
    },
    sourceEvidenceIds: ["ev_seed"],
    derivationMethod: "Use the approved write-file intent.",
  });
});

test("fresh turn reset clears stale pending continuation offers and canonical plan handoff wait state", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("fresh-turn-stale-offer-session", "agent.loop");

  await store.commitStep({
    runId: "seed-stale-offer",
    event: {
      id: "seed-stale-offer",
      type: "user.message",
      sessionId: "fresh-turn-stale-offer-session",
      payload: {
        message: "seed",
      },
    },
    sessionId: "fresh-turn-stale-offer-session",
    expectedVersion: 0,
    nextStepAgent: "agent.loop",
    statePatch: {
      agent: {
        pendingContinuationOffer: {
          version: "continuation_offer_v1",
          kind: "implementation",
          objective: "Create a Python Pong game.",
          requiredToolClass: "sandboxed_only",
          requiredCapabilities: ["workspace.write"],
          requiredMode: "build",
          sourceRunId: "seed-stale-offer",
          resumeMessage: "Create the Pong game.",
        },
        finalOutput: {
          message: "I can build this next.",
        },
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "plan_handoff",
          resumeInstruction: "Resume after the user confirms the plan handoff.",
          resumeStepAgent: "agent.exec.wait_user",
          resumeToken: "plan-handoff-token",
          metadata: {
            reason: "plan_handoff",
          },
        },
        wait: {
          kind: "user",
          eventType: "user.reply",
          resumeStepAgent: "agent.exec.wait_user",
          resumeToken: "plan-handoff-token",
          metadata: {
            reason: "plan_handoff",
          },
        },
        resumableFollowUp: undefined,
        finalized: true,
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  let observedReact: Record<string, unknown> | undefined;
  const kestrel = createRuntime(store);
  kestrel.registerStep("agent.loop", async (ctx) => {
    observedReact = ((ctx.session.state.agent ?? {}) as Record<string, unknown>);
    return {
      status: "COMPLETED",
      statePatch: {
        agent: {
          ...observedReact,
          finalOutput: {
            message: "fresh",
          },
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-fresh-turn-stale-offer",
    type: "user.message",
    sessionId: "fresh-turn-stale-offer-session",
    payload: {
      message: "build it",
    },
    stepAgent: "agent.loop",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(observedReact?.pendingContinuationOffer, undefined);
  assert.equal(readActiveWaitState(observedReact), undefined);
  assert.equal(observedReact?.resumableFollowUp, undefined);
});

test("legacy execution sessions are normalized to react.exec.* steps at run start", async () => {
  const store = new InMemorySessionStore();
  const legacyStep = ["react", "acter"].join(".");
  await store.ensureSession("legacy-session", legacyStep);
  await store.commitStep({
    runId: "seed-run",
    event: {
      id: "seed-event",
      type: "user.message",
      sessionId: "legacy-session",
      payload: {},
    },
    sessionId: "legacy-session",
    expectedVersion: 0,
    nextStepAgent: legacyStep,
    statePatch: {
      agent: {
        nextAction: {
          kind: "finalize",
          finalizeReason: "goal_satisfied",
          input: {
            message: "seed",
          },
        },
      },
    },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });

  const kestrel = createRuntime(store);
  kestrel.registerStep("agent.exec.finalize", async () => ({
    status: "COMPLETED",
    emitEvents: [
      {
        type: "agent.completed",
        payload: {},
      },
    ],
    statePatch: {
      agent: {
        finalOutput: {
          message: "normalized",
        },
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-legacy",
    type: "user.message",
    sessionId: "legacy-session",
    payload: {},
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.finalStep, "agent.exec.finalize");
});

test("repeated non-blocked wait tokens trip LOOP_GUARD_TRIGGERED before max steps", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.wait_user", async (ctx) => ({
    status: "WAITING",
    nextStepAgent: "agent.exec.wait_user",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "extractor_clarification",
        prompt: "Need clarification",
      },
    },
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          resumeStepAgent: "agent.exec.wait_user",
        },
      },
    },
  }));

  const first = await kestrel.run({
    id: "evt-loop-wait-1",
    type: "user.message",
    sessionId: "loop-wait-session",
    payload: {},
    stepAgent: "agent.exec.wait_user",
  });
  assert.equal(first.status, "WAITING");

  const second = await kestrel.run({
    id: "evt-loop-wait-2",
    type: "user.reply",
    sessionId: "loop-wait-session",
    payload: {
      message: "still not enough",
    },
  });

  assert.equal(second.status, "FAILED");
  assert.equal(second.errors[0]?.code, "LOOP_GUARD_TRIGGERED");
  assert.equal(second.errors[0]?.details?.guardType, "REPEATED_WAIT_LOOP");
});

test("repeated mode-blocked waits stay waiting instead of tripping the loop guard", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.wait_user", async (ctx) => ({
    status: "WAITING",
    nextStepAgent: "agent.exec.wait_user",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "planner_mode_blocked",
        requiredToolClass: "sandboxed_only",
        question: "You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
        resumeReply: "switch to build",
        resumeCommand: "/mode build",
        prompt: [
          "Question: You're in 'Plan'. Can I switch to 'Build' so I can use a sandboxed tool?",
          "Reply naturally to approve the switch or run: `/mode build`",
          "The run will resume automatically.",
        ].join("\n"),
      },
    },
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        exec: {
          waitingForUser: undefined,
        },
      },
    },
  }));

  const first = await kestrel.run({
    id: "evt-mode-blocked-wait-1",
    type: "user.message",
    sessionId: "mode-blocked-wait-session",
    payload: {},
    stepAgent: "agent.exec.wait_user",
  });
  assert.equal(first.status, "WAITING");

  const second = await kestrel.run({
    id: "evt-mode-blocked-wait-2",
    type: "user.reply",
    sessionId: "mode-blocked-wait-session",
    payload: {
      message: "switch to build",
      resumeBlockedRun: true,
    },
  });

  assert.equal(second.status, "WAITING");
  assert.equal(second.errors.length, 0);
  assert.equal((second.waitFor?.metadata as Record<string, unknown> | undefined)?.reason, "planner_mode_blocked");
});

test("MAX_STEPS_EXCEEDED becomes a continuation wait on first exhaustion", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 2 });

  kestrel.registerStep("loop.step", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "loop.step",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} iterations.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-cont-1",
    type: "user.message",
    sessionId: "continuation-session",
    payload: {},
    stepAgent: "loop.step",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.continuation?.outcome, "requested");
  assert.equal(output.continuation?.extraStepsRequested, 50);
  assert.equal(output.continuation?.continuationCount, 0);
  assert.equal(output.waitFor?.eventType, "user.reply");
  const metadata = (output.waitFor?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.reason, "max_steps_continuation");
  assert.equal(metadata.extraStepsRequested, 50);
  assert.equal(Array.isArray(metadata.completedSoFar), true);
  const session = await store.getSession("continuation-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const continuation = (react.continuation ?? {}) as Record<string, unknown>;
  assert.equal(continuation.continuationCount, 0);
  assert.equal(((continuation.pendingContinuationRequest ?? {}) as Record<string, unknown>).resumeStepAgent, "loop.step");
  const persistedStateEvents = store.getRunEvents().filter((event) =>
    event.runId === output.runId && event.type === "runtime.state_persisted"
  );
  const continuationRequestEvent = persistedStateEvents.at(-1);
  assert.equal(continuationRequestEvent?.metadata?.stepAgent, "loop.step");
  assert.equal(continuationRequestEvent?.metadata?.nextStepAgent, "loop.step");
});

test("MAX_MODEL_CALLS_EXCEEDED becomes a continuation wait instead of a terminal fresh-turn failure", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, { maxModelCallsPerRun: 1 });

  kestrel.registerStep("loop.model", async (ctx, io) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    if (count >= 2) {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: {
            ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
            finalOutput: {
              message: "continued from model-call budget",
            },
          },
        },
      };
    }
    await io.useModel({ model: "mock", input: { prompt: "step once" } });
    return {
      status: "RUNNING",
      nextStepAgent: "loop.model",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} model-backed steps.` }],
          capabilityEvidence: {},
          lastActionResult: {
            toolName: "dev.shell.run",
          },
          exec: {
            devShell: {
              processes: {
                "proc-install": {
                  command: "npm install",
                  status: "COMPLETED",
                  exitCode: 0,
                  updatedAt: "2026-07-06T18:00:00.000Z",
                },
                "proc-build": {
                  command: "npm run build",
                  status: "FAILED",
                  exitCode: 1,
                  updatedAt: "2026-07-06T18:01:00.000Z",
                },
                "proc-stop": {
                  command: "pnpm dev",
                  status: "STOPPED",
                  exitCode: 130,
                  updatedAt: "2026-07-06T17:59:00.000Z",
                },
                "proc-lost": {
                  command: "node server.js",
                  status: "LOST",
                  updatedAt: "2026-07-06T17:58:00.000Z",
                },
              },
            },
          },
          toolEvidenceSummary: {
            successfulCalls: [{ toolName: "dev.shell.run", count: 2 }],
            failedCalls: [{ toolName: "dev.shell.run", count: 1 }],
          },
          runtimeEvidenceSummary: {
            supportedTokens: [
              "file:src/lib/actions.ts",
              "file:prisma/schema.prisma",
              "check:npm run build",
            ],
          },
        },
      },
    };
  });

  const first = await kestrel.run({
    id: "evt-model-cont-1",
    type: "user.message",
    sessionId: "model-continuation-session",
    payload: {
      message: "start",
    },
    stepAgent: "loop.model",
  });

  assert.equal(first.status, "WAITING");
  assert.equal(first.continuation?.outcome, "requested");
  assert.equal(first.waitFor?.eventType, "user.reply");
  const metadata = (first.waitFor?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.reason, "max_model_calls_continuation");
  assert.equal(metadata.budget, "model_calls");
  assert.match(String(metadata.prompt), /model-call budget/u);
  assert.deepEqual(metadata.completedSoFar, [
    "Completed 1 model-backed steps.",
    "Dev shell process state: 1 completed, 1 failed, 1 stopped, 1 lost.",
    "Latest dev shell command failed: npm run build (exit 1).",
  ]);
  assert.match(
    String(metadata.partialAnswer),
    /Dev shell process state: 1 completed, 1 failed, 1 stopped, 1 lost/u,
  );
  assert.doesNotMatch(String(metadata.partialAnswer), /Used dev\.shell\.run\.$/u);
  const waitingSession = await store.getSession("model-continuation-session");
  const waitingReact = (waitingSession?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(
    ((waitingReact.terminal ?? {}) as Record<string, unknown>).reasonCode,
    "max_model_calls_continuation",
  );

  const resumed = await kestrel.run({
    id: "evt-model-cont-2",
    type: "user.reply",
    sessionId: "model-continuation-session",
    payload: {
      message: "continue",
    },
  });

  assert.equal(resumed.status, "COMPLETED");
  assert.equal(resumed.continuation?.outcome, "granted");
  assert.equal(resumed.continuation?.extraModelCallsRequested, 50);
  assert.equal(resumed.continuation?.extraModelCallsGranted, 50);
  const session = await store.getSession("model-continuation-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(((react.finalOutput ?? {}) as Record<string, unknown>).message, "continued from model-call budget");
  const continuation = (react.continuation ?? {}) as Record<string, unknown>;
  assert.equal(continuation.grantedExtraModelCalls, 50);
  assert.equal(continuation.modelCallsConsumed, 1);
});

test("model-call continuation approval preserves cumulative model-call accounting", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, {
    maxModelCallsPerRun: 1,
    maxStepsPerRun: 100,
    maxStepVisits: 100,
  });

  kestrel.registerStep("loop.model", async (ctx, io) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    if (count >= 52) {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: {
            ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
            finalOutput: {
              message: "unexpected fresh model-call budget",
            },
          },
        },
      };
    }
    await io.useModel({ model: "mock", input: { prompt: "step once" } });
    return {
      status: "RUNNING",
      nextStepAgent: "loop.model",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} model-backed steps.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  const first = await kestrel.run({
    id: "evt-model-cont-cumulative-1",
    type: "user.message",
    sessionId: "model-continuation-cumulative-session",
    payload: {
      message: "start",
    },
    stepAgent: "loop.model",
  });

  assert.equal(first.status, "WAITING");
  assert.equal(((first.waitFor?.metadata ?? {}) as Record<string, unknown>).reason, "max_model_calls_continuation");

  const resumed = await kestrel.run({
    id: "evt-model-cont-cumulative-2",
    type: "user.reply",
    sessionId: "model-continuation-cumulative-session",
    payload: {
      message: "continue",
    },
  });

  assert.equal(resumed.status, "WAITING");
  assert.equal(((resumed.waitFor?.metadata ?? {}) as Record<string, unknown>).reason, "max_model_calls_continuation");
  const session = await store.getSession("model-continuation-cumulative-session");
  assert.equal(session?.state.count, 51);
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  const continuation = (react.continuation ?? {}) as Record<string, unknown>;
  assert.equal(continuation.grantedExtraModelCalls, 50);
  assert.equal(continuation.modelCallsConsumed, 51);
});

test("continuation approval resumes and completes with cumulative step counting", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 2 });

  kestrel.registerStep("loop.step", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    if (count >= 3) {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: {
            ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
            finalOutput: {
              message: "done",
            },
          },
        },
      };
    }
    return {
      status: "RUNNING",
      nextStepAgent: "loop.step",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} iterations.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  const first = await kestrel.run({
    id: "evt-cont-2a",
    type: "user.message",
    sessionId: "continuation-resume-session",
    payload: {
      message: "start",
    },
    stepAgent: "loop.step",
  });
  assert.equal(first.status, "WAITING");

  const resumed = await kestrel.run({
    id: "evt-cont-2b",
    type: "user.reply",
    sessionId: "continuation-resume-session",
    payload: {
      message: "go on",
    },
  });
  assert.equal(resumed.status, "COMPLETED");
  assert.equal(resumed.continuation?.outcome, "granted");
  assert.equal(resumed.continuation?.extraStepsRequested, 50);
  assert.equal(resumed.continuation?.extraStepsGranted, 50);
  assert.equal(resumed.continuation?.continuationCount, 1);
  const session = await store.getSession("continuation-resume-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(((react.finalOutput ?? {}) as Record<string, unknown>).message, "done");
  assert.equal(react.waitingFor, undefined);
  assert.equal(react.wait, undefined);
  assert.equal(readActiveWaitState(react), undefined);
  const continuation = (react.continuation ?? {}) as Record<string, unknown>;
  assert.equal(continuation.grantedExtraSteps, 50);
  assert.equal(continuation.continuationCount, 1);
  assert.equal(
    ((continuation.pendingContinuationRequest ?? {}) as Record<string, unknown>).resumeStepAgent,
    undefined,
  );
});

test("continuation decline leaves terminal session without stale active wait", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 1 });

  kestrel.registerStep("loop.step", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "loop.step",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} iterations.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  const first = await kestrel.run({
    id: "evt-cont-decline-1",
    type: "user.message",
    sessionId: "continuation-decline-session",
    payload: {
      message: "start",
    },
    stepAgent: "loop.step",
  });
  assert.equal(first.status, "WAITING");

  const declined = await kestrel.run({
    id: "evt-cont-decline-2",
    type: "user.reply",
    sessionId: "continuation-decline-session",
    payload: {
      message: "not now",
    },
  });

  assert.equal(declined.status, "COMPLETED");
  const session = await store.getSession("continuation-decline-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(react.waitingFor, undefined);
  assert.equal(react.wait, undefined);
  assert.equal(readActiveWaitState(react), undefined);
});

test("continuation approval tolerates corrupted wait metadata when terminal reason is preserved", async () => {
  const store = new CorruptedContinuationWaitMetadataStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 2 });

  kestrel.registerStep("loop.step", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    if (count >= 2) {
      return {
        status: "COMPLETED",
        statePatch: {
          agent: {
            ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
            finalOutput: {
              message: "done",
            },
          },
        },
      };
    }
    return {
      status: "RUNNING",
      nextStepAgent: "loop.step",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} iterations.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  const first = await kestrel.run({
    id: "evt-cont-corrupt-1",
    type: "user.message",
    sessionId: "continuation-corrupt-session",
    payload: {
      message: "start",
    },
    stepAgent: "loop.step",
  });
  assert.equal(first.status, "WAITING");

  const resumed = await kestrel.run({
    id: "evt-cont-corrupt-2",
    type: "user.reply",
    sessionId: "continuation-corrupt-session",
    payload: {
      message: "continue",
    },
  });
  assert.equal(resumed.status, "COMPLETED");
  assert.equal(resumed.continuation?.outcome, "granted");

  const session = await store.getSession("continuation-corrupt-session");
  const react = (session?.state.agent ?? {}) as Record<string, unknown>;
  assert.equal(((react.finalOutput ?? {}) as Record<string, unknown>).message, "done");
});

test("continuation requests continue past the former third-grant cap", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 1 });

  kestrel.registerStep("loop.forever", async (ctx) => {
    const count = typeof ctx.session.state.count === "number" ? (ctx.session.state.count as number) : 0;
    return {
      status: "RUNNING",
      nextStepAgent: "loop.forever",
      statePatch: {
        count: count + 1,
        agent: {
          ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
          observations: [{ summary: `Completed ${count + 1} iterations.` }],
          capabilityEvidence: {},
          exec: {},
        },
      },
    };
  });

  let output = await kestrel.run({
    id: "evt-cont-cap-1",
    type: "user.message",
    sessionId: "continuation-cap-session",
    payload: { message: "start" },
    stepAgent: "loop.forever",
  });
  assert.equal(output.status, "WAITING");

  for (const id of ["2", "3", "4"]) {
    output = await kestrel.run({
      id: `evt-cont-cap-${id}`,
      type: "user.reply",
      sessionId: "continuation-cap-session",
      payload: { message: "continue" },
    });
    assert.equal(output.status, "WAITING");
  }

  const final = await kestrel.run({
    id: "evt-cont-cap-5",
    type: "user.reply",
    sessionId: "continuation-cap-session",
    payload: { message: "continue" },
  });
  assert.equal(final.status, "WAITING");
  assert.equal(final.continuation?.outcome, "requested");
  const metadata = (final.waitFor?.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.reason, "max_steps_continuation");
  assert.equal(metadata.continuationCount, 4);
});

test("continuation approval fails hard when committed continuation state is stale", async () => {
  const store = new StaleContinuationGrantStore();
  const kestrel = createRuntime(store, { maxStepsPerRun: 2 });

  kestrel.registerStep("loop.step", async (ctx) => ({
    status: "RUNNING",
    nextStepAgent: "loop.step",
    statePatch: {
      count: ((ctx.session.state.count as number | undefined) ?? 0) + 1,
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        observations: [{ summary: "Completed another iteration." }],
        capabilityEvidence: {},
        exec: {},
      },
    },
  }));

  const first = await kestrel.run({
    id: "evt-cont-stale-1",
    type: "user.message",
    sessionId: "continuation-stale-session",
    payload: { message: "start" },
    stepAgent: "loop.step",
  });
  assert.equal(first.status, "WAITING");

  const resumed = await kestrel.run({
    id: "evt-cont-stale-2",
    type: "user.reply",
    sessionId: "continuation-stale-session",
    payload: { message: "go on" },
  });
  assert.equal(resumed.status, "FAILED");
  assert.equal(resumed.errors[0]?.code, "CONTINUATION_GRANT_STATE_INVALID");
});

test("run-scoped historical state reconstructs the target run snapshot", async () => {
  const store = new InMemorySessionStore();
  const kestrel = createRuntime(store);

  kestrel.registerStep("agent.exec.finalize", async (ctx) => ({
    status: "COMPLETED",
    statePatch: {
      agent: {
        ...((ctx.session.state.agent ?? {}) as Record<string, unknown>),
        goal: ctx.event.type,
        finalOutput: {
          message: ctx.event.type,
        },
      },
    },
  }));

  await kestrel.run({
    id: "evt-history-1",
    type: "user.message",
    sessionId: "history-session",
    payload: {},
    stepAgent: "agent.exec.finalize",
  });
  await kestrel.run({
    id: "evt-history-2",
    type: "user.reply",
    sessionId: "history-session",
    payload: {},
    stepAgent: "agent.exec.finalize",
  });

  const runs = await store.listRuns({ sessionId: "history-session" });
  assert.equal(runs.length, 2);
  const firstRun = runs.find((run) => run.eventType === "user.message");
  const secondRun = runs.find((run) => run.eventType === "user.reply");
  const firstRunState = await store.getRunState(firstRun!.runId);
  const secondRunState = await store.getRunState(secondRun!.runId);

  assert.equal(
    ((firstRunState?.state.agent ?? {}) as Record<string, unknown>).goal,
    "user.message",
  );
  assert.equal(
    ((secondRunState?.state.agent ?? {}) as Record<string, unknown>).goal,
    "user.reply",
  );
});

async function initGitRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "kestrel@example.test"]);
  await git(repo, ["config", "user.name", "Kestrel Test"]);
  await writeFile(path.join(repo, "app.txt"), "clean\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}
