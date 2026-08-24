import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TuiProfile } from "../../cli/contracts.js";
import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import { createLocalCoreRunnerRuntimeFactory } from "../../src/localCore/executionRuntime.js";
import { resolveKestrelCoreHome } from "../../src/localCore/home.js";
import { resolveRuntimeProfileSelection } from "../../src/profile/runtimeProfile.js";
import { createSessionStoreFromEnv } from "../../src/store/createSessionStore.js";

const execFileAsync = promisify(execFile);

export async function runLocalCoreManagedWorktreeJobRegression(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-local-core-job-worktree-"));
  const repo = path.join(root, "repo");
  const kestrelHome = path.join(root, "home");
  const managedWorktreeHome = resolveKestrelCoreHome({ KESTREL_HOME: kestrelHome }).homePath;
  const fakeModel = await startManagedWorktreeFakeModel();
  const storeHandle = createSessionStoreFromEnv({
    driver: "sqlite",
    sqlitePath: path.join(managedWorktreeHome, "runtime.db"),
  });
  const store = storeHandle.store;
  const events: Array<{ type: string; payload: unknown }> = [];
  let host: RunnerHost | undefined;

  try {
    await storeHandle.ready();
    await initializeCommittedRepo(repo);
    const runtimeEnv = {
      KESTREL_HOME: path.join(root, "different-runtime-home"),
    };
    const modelEnv = {
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: fakeModel.url,
      OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    };
    const runtimeFactory = createLocalCoreRunnerRuntimeFactory(store, {
      runtimeEnvironmentResolver: {
        resolve: ({ modelProvider, model }) => ({
          modelProvider,
          model,
          runtimeEnv,
          modelEnv,
          internetEnv: {},
          mcpEnv: {},
        }),
      },
      homePath: managedWorktreeHome,
    });
    host = new RunnerHost(
      {
        emit(type, payload) {
          events.push({ type, payload });
        },
      },
      runtimeFactory,
    );
    const resolvedRuntime = resolveRuntimeProfileSelection({
      shellKind: "cli",
      presetId: "cli_safe_local",
    });
    const profile: TuiProfile = {
      id: "local-core-managed-worktree-job",
      label: "Local Core managed worktree job",
      agent: "kestrel",
      sessionPrefix: "local-core-worktree",
      modelProvider: "openrouter",
      model: "openai/gpt-5.2-chat",
      defaultInteractionMode: "build",
      defaultActSubmode: "full_auto",
      ...resolvedRuntime,
    };
    const scenarios = [
      { sessionId: "local-core-worktree-session-1", fileName: "session-one.txt" },
      { sessionId: "local-core-worktree-session-2", fileName: "session-two.txt" },
    ];

    await Promise.all(scenarios.map((scenario, index) =>
      host!.jobRun(`local-core-worktree-command-${index + 1}`, {
        input: {
          version: "job_input_v1",
          profile,
          turn: {
            sessionId: scenario.sessionId,
            message: `Create ${scenario.fileName} with deterministic managed-worktree content.`,
            eventType: "job.run",
            interactionMode: "build",
            actSubmode: "full_auto",
            stepAgent: "agent.loop",
            workspace: {
              workspaceId: "managed-worktree-job-fixture",
              workspaceRoot: repo,
              sourceWorkspaceRoot: repo,
              managedWorktreeRequired: true,
              managedWorktreeIsolation: "session",
              managedWorktreeBaseRef: "HEAD",
              appRoot: ".",
              commands: {},
            },
          },
        },
      }),
    ));

    const completed = events.filter((event) => event.type === "job.completed");
    assert.equal(completed.length, scenarios.length);
    const runIdsBySession = new Map<string, string>();
    const resultHandlesBySession = new Map<string, {
      version?: string;
      kind?: string;
      worktreePath?: string;
      sourceWorkspaceRoot?: string;
      baseRevision?: string;
      candidateRevision?: string;
      changedFiles?: string[];
      promotionId?: string;
    }>();
    for (const event of completed) {
      const payload = event.payload as {
        output?: {
          runId?: string;
          sessionId?: string;
          status?: string;
          resultHandle?: {
            version?: string;
            kind?: string;
            worktreePath?: string;
            sourceWorkspaceRoot?: string;
            baseRevision?: string;
            candidateRevision?: string;
            changedFiles?: string[];
            promotionId?: string;
          };
        };
      };
      assert.equal(payload.output?.status, "COMPLETED");
      assert.equal(typeof payload.output?.sessionId, "string");
      assert.equal(typeof payload.output?.runId, "string");
      runIdsBySession.set(payload.output!.sessionId!, payload.output!.runId!);
      assert.equal(payload.output?.resultHandle?.version, "job_managed_result_handle_v1");
      assert.equal(payload.output?.resultHandle?.kind, "managed_worktree");
      assert.equal(payload.output?.resultHandle?.sourceWorkspaceRoot, await realpath(repo));
      assert.equal(payload.output?.resultHandle?.baseRevision, await git(repo, ["rev-parse", "HEAD"]));
      assert.equal(typeof payload.output?.resultHandle?.candidateRevision, "string");
      assert.equal(typeof payload.output?.resultHandle?.promotionId, "string");
      resultHandlesBySession.set(
        payload.output!.sessionId!,
        payload.output!.resultHandle!,
      );
    }

    assert.equal(await git(repo, ["status", "--porcelain"]), "");
    for (const scenario of scenarios) {
      await assert.rejects(access(path.join(repo, scenario.fileName)));
    }

    const worktreeRoots: string[] = [];
    for (const scenario of scenarios) {
      const session = await store.getSession(scenario.sessionId);
      const agent = (session?.state.agent ?? {}) as Record<string, unknown>;
      const exec = (agent.exec ?? {}) as Record<string, unknown>;
      const binding = (exec.managedWorktreeBinding ?? {}) as Record<string, unknown>;
      assert.deepEqual(binding.scope, {
        kind: "sessionId",
        value: scenario.sessionId,
      });
      assert.equal(typeof binding.worktreeRoot, "string");
      const worktreeRoot = String(binding.worktreeRoot);
      const resultHandle = resultHandlesBySession.get(scenario.sessionId);
      assert.equal(resultHandle?.worktreePath, worktreeRoot);
      assert.deepEqual(resultHandle?.changedFiles, [scenario.fileName]);
      assert.equal(
        path.relative(path.join(managedWorktreeHome, "worktrees"), worktreeRoot).startsWith(".."),
        false,
      );
      worktreeRoots.push(worktreeRoot);
      assert.equal(
        await readFile(path.join(worktreeRoot, scenario.fileName), "utf8"),
        "managed worktree content\n",
      );

      const runId = runIdsBySession.get(scenario.sessionId);
      assert.equal(typeof runId, "string");
      const replayEvents = (await store.getReplayStream({
        sessionId: scenario.sessionId,
        limit: 1_000,
      }))
        .filter((event) => event.sessionId === scenario.sessionId);
      const eventTypes = replayEvents.map((event) => event.type);
      assert.equal(eventTypes.includes("managed_worktree.auto_requested"), true);
      assert.equal(eventTypes.includes("managed_worktree.created"), true);
      assert.equal(eventTypes.includes("managed_worktree.bound"), true);
      assert.equal(
        replayEvents.some(
          (event) => event.type === "workspace.promotion_recorded" && event.runId === runId,
        ),
        true,
      );
      assert.equal(
        replayEvents.filter(
          (event) => event.type === "managed_worktree.released" && event.runId === runId,
        ).length,
        1,
      );
      const metadata = JSON.parse(
        await readFile(`${worktreeRoot}.binding.json`, "utf8"),
      ) as {
        currentLease?: { kind?: string; runId?: string } | undefined;
        activeProcesses?: Array<{ runId?: string }> | undefined;
        latestPromotionId?: string | undefined;
      };
      assert.equal(metadata.currentLease?.kind, "promotion");
      assert.equal(metadata.currentLease?.runId, metadata.latestPromotionId);
      assert.notEqual(metadata.currentLease?.runId, runId);
      assert.equal(
        metadata.activeProcesses?.some((process) => process.runId === runId) ?? false,
        false,
      );
      assert.equal(
        replayEvents.some((event) => event.runId === `workspace:${scenario.sessionId}`),
        false,
      );
      assert.equal(eventTypes.includes("managed_worktree.approval_requested"), false);
      assert.equal(eventTypes.includes("managed_worktree.promotion_blocked"), false);
    }
    assert.notEqual(worktreeRoots[0], worktreeRoots[1]);
  } finally {
    await host?.close();
    await fakeModel.close();
    await storeHandle.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function initializeCommittedRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "kestrel-test@example.com"]);
  await git(repo, ["config", "user.name", "Kestrel Test"]);
  await writeFile(path.join(repo, "README.md"), "# Managed worktree fixture\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initialize fixture"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function startManagedWorktreeFakeModel(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const requestCounts = new Map<string, number>();
  const server = createHttpServer((request, response) => {
    void respondToManagedWorktreeModelRequest(request, response, requestCounts);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to start managed-worktree fake model server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function respondToManagedWorktreeModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestCounts: Map<string, number>,
): Promise<void> {
  const rawBody = await readRequestBody(request);
  const body = JSON.parse(rawBody) as { stream?: boolean | undefined };
  const fileName = rawBody.includes("session-one.txt")
    ? "session-one.txt"
    : rawBody.includes("session-two.txt")
      ? "session-two.txt"
      : undefined;
  if (fileName === undefined) {
    throw new Error("Managed-worktree fake model request did not identify a scenario file.");
  }
  const requestCount = requestCounts.get(fileName) ?? 0;
  requestCounts.set(fileName, requestCount + 1);
  const action = {
    fileName,
    kind: requestCount === 0 ? "mutate" as const : "finalize" as const,
  };
  const toolCall = action.kind === "mutate"
    ? {
        id: `call-create-${action.fileName}`,
        type: "function",
        function: {
          name: "fs_create_text",
          arguments: JSON.stringify({
            path: action.fileName,
            content: "managed worktree content\n",
            assistantProgress: `Creating ${action.fileName} in the managed worktree.`,
          }),
        },
      }
    : {
        id: `call-finalize-${action.fileName}`,
        type: "function",
        function: {
          name: "kestrel_finalize",
          arguments: JSON.stringify({
            status: "goal_satisfied",
            message: `Created ${action.fileName}.`,
            assistantProgress: "The managed-worktree mutation is complete.",
          }),
        },
      };
  const payload = {
    model: "openai/gpt-5.2-chat",
    choices: [{
      message: {
        content: JSON.stringify({
          reason: action.kind === "mutate"
            ? "Create the requested deterministic file."
            : "The requested file was created successfully.",
        }),
        tool_calls: [toolCall],
      },
    }],
  };

  if (body.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(
      `data: ${JSON.stringify({
        model: payload.model,
        choices: [{ delta: payload.choices[0]!.message }],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
