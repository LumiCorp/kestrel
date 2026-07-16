import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunnerEvent, RunnerStream } from "../../packages/sdk/src/contracts.js";
import { KestrelClient } from "../../packages/sdk/src/runner.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";

export type DurableTerminalStatus = "completed" | "failed" | "waiting" | "contract_failure";

export interface DurableTerminalObservation {
  eventType: "job.completed" | "job.failed" | "run.completed" | "run.failed";
  status: DurableTerminalStatus;
  outputStatus: string;
  sessionId: string;
  threadId?: string | undefined;
  runId: string;
  eventId: string;
  observedAt: string;
  emittedAt: string;
  reasonCode?: string | undefined;
  reconnectCount: number;
}

export interface PromptSmokeOutcome {
  runtimeStatus: "passed" | "failed";
  artifactStatus: "passed" | "failed" | "not_checked";
  status: "passed" | "failed";
}

export function derivePromptSmokeOutcome(input: {
  terminalStatus?: DurableTerminalStatus | undefined;
  assertionsConfigured: boolean;
  assertionsPassed?: boolean | undefined;
}): PromptSmokeOutcome {
  const runtimeStatus = input.terminalStatus === "completed" ? "passed" : "failed";
  const artifactStatus = input.terminalStatus === undefined || input.assertionsConfigured === false
    ? "not_checked"
    : input.assertionsPassed === true
      ? "passed"
      : "failed";
  return {
    runtimeStatus,
    artifactStatus,
    status: runtimeStatus === "passed" && artifactStatus !== "failed" ? "passed" : "failed",
  };
}

interface DurableEventClient {
  subscribe(
    filter: {
      sessionId: string;
      eventTypes: Array<"job.completed" | "job.failed" | "run.completed" | "run.failed">;
    },
    context: { actor: { actorId: string; actorType: "operator" } },
    options: { signal: AbortSignal },
  ): RunnerStream<RunnerEvent, void>;
  close(): Promise<void>;
}

export function classifyDurableTerminalEvent(
  event: RunnerEvent,
  reconnectCount = 0,
  observedAt = new Date().toISOString(),
): DurableTerminalObservation | undefined {
  if (
    event.type !== "job.completed" &&
    event.type !== "job.failed" &&
    event.type !== "run.completed" &&
    event.type !== "run.failed"
  ) {
    return undefined;
  }
  const output = event.type === "job.completed" || event.type === "job.failed"
    ? event.payload.output
    : event.payload.result.output;
  const failed = event.type === "job.failed" || event.type === "run.failed";
  const status: DurableTerminalStatus = failed
    ? "failed"
    : output.status === "COMPLETED"
      ? "completed"
      : output.status === "WAITING"
        ? "waiting"
        : "contract_failure";
  const reasonCode = failed
    ? event.payload.error.code
    : event.type === "job.completed"
      ? event.payload.output.error?.code
      : undefined;
  const threadId = event.threadId ?? readOptionalString(output.threadId);
  return {
    eventType: event.type,
    status,
    outputStatus: output.status,
    sessionId: output.sessionId,
    ...(threadId !== undefined ? { threadId } : {}),
    runId: output.runId,
    eventId: event.id,
    observedAt,
    emittedAt: event.ts,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    reconnectCount,
  };
}

export async function observeDurableSessionTerminal(input: {
  sessionId: string;
  timeoutMs: number;
  openClient: () => Promise<DurableEventClient>;
  now?: (() => number) | undefined;
  delay?: ((milliseconds: number) => Promise<void>) | undefined;
}): Promise<DurableTerminalObservation> {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? wait;
  const deadline = now() + input.timeoutMs;
  let reconnectCount = 0;
  let lastError: unknown;

  while (now() < deadline) {
    let client: DurableEventClient | undefined;
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - now());
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      client = await input.openClient();
      const stream = client.subscribe(
        {
          sessionId: input.sessionId,
          eventTypes: ["job.completed", "job.failed", "run.completed", "run.failed"],
        },
        {
          actor: {
            actorId: "cli-prompt-smoke-observer",
            actorType: "operator",
          },
        },
        { signal: controller.signal },
      );
      for await (const event of stream) {
        const terminal = classifyDurableTerminalEvent(event, reconnectCount);
        if (terminal !== undefined) {
          await stream.cancel();
          return terminal;
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client?.close().catch(() => undefined);
    }

    if (now() >= deadline) {
      break;
    }
    reconnectCount += 1;
    await delay(Math.min(250, Math.max(1, deadline - now())));
  }

  const suffix = lastError instanceof Error ? ` Last transport error: ${lastError.message}` : "";
  throw new Error(
    `Timed out after ${input.timeoutMs}ms waiting for a canonical terminal event for session '${input.sessionId}'.${suffix}`,
  );
}

export async function observeLocalPromptTerminal(input: {
  kestrelHome: string;
  sessionName: string;
  timeoutMs: number;
}): Promise<DurableTerminalObservation> {
  const paths = resolveLocalCorePaths(input.kestrelHome);
  const sessionId = await waitForSessionId({
    sessionsPath: path.join(paths.stateRootPath, "sessions.json"),
    sessionName: input.sessionName,
    timeoutMs: Math.min(input.timeoutMs, 120_000),
  });
  return observeDurableSessionTerminal({
    sessionId,
    timeoutMs: input.timeoutMs,
    openClient: async () => {
      const authToken = (await readFile(paths.apiTokenPath, "utf8")).trim();
      if (authToken.length === 0) {
        throw new Error("Local Core API token is empty.");
      }
      const client = new KestrelClient({
        target: {
          kind: "local",
          socketPath: paths.apiSocketPath,
          authToken,
        },
      });
      await client.getHealth();
      return client;
    },
  });
}

async function waitForSessionId(input: {
  sessionsPath: string;
  sessionName: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(input.sessionsPath, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: Array<{ name?: unknown; sessionId?: unknown }> };
      const session = parsed.sessions?.find((candidate) => candidate.name === input.sessionName);
      if (typeof session?.sessionId === "string" && session.sessionId.trim().length > 0) {
        return session.sessionId;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const suffix = lastError instanceof Error ? ` Last read error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for TUI session '${input.sessionName}'.${suffix}`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
