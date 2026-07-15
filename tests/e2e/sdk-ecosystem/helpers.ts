import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TuiProfile } from "../../../cli/contracts.js";
import type { RunnerServiceOptions } from "../../../cli/runner/RunnerService.js";
import type { RunnerRuntime } from "../../../cli/runner/RunnerHost.js";
import type { KestrelMemorySnapshot } from "../../../packages/sdk/src/index.js";
import type { ProductTaskGraph } from "../../../src/index.js";
import type { DelegationTaskUpdate } from "../../../src/orchestration/DelegationSupervisor.js";
import type { ProgressUpdateV1, ReasoningUpdateV1, RunLogEntry } from "../../../src/kestrel/contracts/events.js";


export const sdkE2eProfile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

export const sdkE2eContext = {
  actor: {
    actorId: "sdk-e2e-user",
    actorType: "end_user" as const,
    displayName: "SDK E2E User",
    tenantId: "acme",
  },
  tenantId: "acme",
};

export function createProfileProvider() {
  return {
    async listProfiles() {
      return [sdkE2eProfile];
    },
    async getProfile(profileId: string) {
      return profileId === sdkE2eProfile.id ? sdkE2eProfile : undefined;
    },
  };
}

export interface SdkE2eRuntimeFactoryOptions {
  onAbort?: ((sessionId: string) => void) | undefined;
}

export function createSdkE2eRuntimeFactory(
  factoryOptions: SdkE2eRuntimeFactoryOptions = {},
): NonNullable<RunnerServiceOptions["runtimeFactory"]> {
  const sessions = new Map<string, {
    version: number;
    threadId: string;
    graph: ProductTaskGraph;
    runCount: number;
  }>();

  function getSessionState(sessionId: string) {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const threadId = `thread-${sessionId}`;
    const created = {
      version: 1,
      threadId,
      graph: createMemoryGraph(sessionId, threadId, {
        goal: "Ship the release",
        currentPlan: "Write the release notes",
        findings: "",
        decisions: "",
        openQuestions: "",
        nextAction: "Publish",
        linkedArtifacts: ["docs/release.md"],
      }),
      runCount: 0,
    };
    sessions.set(sessionId, created);
    return created;
  }

  return (
    _resolvedProfile: TuiProfile,
    _onRunLog: (entry: RunLogEntry) => void,
    _onProgress: (update: ProgressUpdateV1) => void,
    _onConsole: unknown,
    _onReasoning: (update: ReasoningUpdateV1) => void,
    onTaskUpdate: (update: DelegationTaskUpdate) => void,
  ): RunnerRuntime => ({
    async runTurn(input, options) {
      const session = getSessionState(input.sessionId);
      session.runCount += 1;
      onTaskUpdate({
        kind: "waiting",
        assistantText: "The SDK E2E task is waiting for input.",
        task: {
          taskId: `task-${session.runCount}`,
          parentSessionId: input.sessionId,
          updatedAt: new Date().toISOString(),
        },
      } as never);

      const complete = () => ({
        assistantText: "The SDK E2E turn completed.",
        output: {
          status: "COMPLETED" as const,
          sessionId: input.sessionId,
          runId: `run-${input.sessionId}-${session.runCount}`,
          errors: [],
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 1,
            durationMs: 1,
          },
        },
      });

      if (input.message === "cancel me") {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(complete());
          }, 200);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            factoryOptions.onAbort?.(input.sessionId);
            const error = new Error("Run cancelled.") as Error & { code?: string };
            error.code = "RUN_CANCELLED";
            reject(error);
          }, { once: true });
        });
      }

      return complete();
    },

    async describeSession(sessionId) {
      const session = getSessionState(sessionId);
      return {
        sessionId,
        version: session.version,
        threadId: session.threadId,
      };
    },

    async getSessionState(sessionId) {
      const session = getSessionState(sessionId);
      return {
        session: {
          sessionId,
          version: session.version,
          threadId: session.threadId,
        },
        version: session.version,
        graph: session.graph,
      };
    },

    async getTaskGraph(input) {
      const session = getSessionState(input.sessionId);
      return {
        sessionId: input.sessionId,
        version: session.version,
        graph: session.graph,
      };
    },

    async updateTaskGraph(input) {
      const session = getSessionState(input.sessionId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== session.version) {
        const error = new Error(
          `Version conflict for session ${input.sessionId}; expected=${input.expectedVersion} actual=${session.version}`,
        ) as Error & { code?: string; details?: Record<string, unknown> };
        error.code = "SESSION_VERSION_CONFLICT";
        error.details = {
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          actualVersion: session.version,
        };
        throw error;
      }
      session.version += 1;
      session.graph = input.graph;
      return {
        sessionId: input.sessionId,
        version: session.version,
        graph: session.graph,
      };
    },

    async close() {},
  });
}

export function packPackage(packageDir: string, packDir: string): string {
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const before = new Set(readdirSync(packDir));
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const tarball = readdirSync(packDir)
    .find((entry) => entry.endsWith(".tgz") && before.has(entry) === false);
  assert.ok(tarball, `Missing tarball for ${packageDir}.`);
  return path.join(packDir, tarball);
}

export function writePnpmWorkspaceOverrides(
  fixtureDir: string,
  overrides: Record<string, string>,
  options: {
    allowBuilds?: Record<string, boolean> | undefined;
  } = {},
): void {
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({
      packages: ["."],
      overrides,
      ...(options.allowBuilds !== undefined
        ? { allowBuilds: options.allowBuilds }
        : {}),
    }, null, 2)}\n`,
  );
}

export async function runChildProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv | undefined;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error([
        `Command failed: ${command} ${args.join(" ")}`,
        `exitCode=${code ?? "null"}`,
        `signal=${signal ?? "null"}`,
        stdout.length > 0 ? `stdout:\n${stdout}` : "",
        stderr.length > 0 ? `stderr:\n${stderr}` : "",
      ].filter((line) => line.length > 0).join("\n")));
    });
  });
}

function createMemoryGraph(sessionId: string, threadId: string, memory: KestrelMemorySnapshot): ProductTaskGraph {
  return {
    version: 1,
    rootTaskIds: [`task:thread:${threadId}`],
    tasks: {
      [`task:thread:${threadId}`]: {
        id: `task:thread:${threadId}`,
        title: "Session memory",
        order: 0,
        status: "active",
        source: "thread",
        proposedByAgent: false,
        linkedSessionId: sessionId,
        linkedThreadId: threadId,
        activeThreadLineageId: threadId,
        runtime: {},
        memory,
        updatedAt: new Date().toISOString(),
      },
    },
  };
}
