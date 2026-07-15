import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import { createRunnerServiceServer } from "../../cli/runner/RunnerService.js";
import type { RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import type { ProgressUpdateV1 } from "../../src/index.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const actorMetadata = {
  actor: {
    actorId: "parity-user",
    actorType: "end_user" as const,
    displayName: "Parity User",
    tenantId: "internal",
  },
  tenantId: "internal",
};

test("runner service parity smoke matrix covers start, resume, and cancel telemetry paths", async (t) => {
  let progressListener: ((update: ProgressUpdateV1) => void) | undefined;

  const server = await createHttpServerOrSkip(t, {
    authToken: "secret-token",
    runtimeFactory: (_profile, _onRunLog, onProgress): RunnerRuntime => {
      progressListener = onProgress;
      return {
        runTurn: async (input, options) => {
          if (input.sessionId === "session-parity-cancel") {
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener(
                "abort",
                () => resolve(),
                { once: true },
              );
            });
            throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
          }

          const resumed = input.resumeBlockedRun === true;
          const runId = resumed ? "run-parity-resume" : "run-parity-start";

          progressListener?.({
            version: "v1",
            runId,
            sessionId: input.sessionId,
            ts: new Date().toISOString(),
            seq: 1,
            kind: "stage",
            phase: "engine",
            code: resumed ? "RUN_RESUMED" : "RUN_STARTED",
            message: resumed ? "Run resumed." : "Run started.",
            persist: true,
          });

          if (resumed) {
            return {
              assistantText: "The parity workflow completed.",
              output: {
                status: "COMPLETED",
                sessionId: input.sessionId,
                runId,
                errors: [],
                quality: {
                  citationCoverage: 1,
                  unresolvedClaims: 0,
                  reworkRate: 0,
                  thrashIndex: 0,
                },
                telemetry: {
                  stepsExecuted: 3,
                  toolCalls: 1,
                  modelCalls: 2,
                  durationMs: 23,
                },
              },
            };
          }

          return {
            assistantText: "Should I continue the parity workflow?",
            output: {
              status: "WAITING",
              sessionId: input.sessionId,
              runId,
              errors: [],
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                interaction: {
                  version: "v1",
                  requestId: "request-parity-resume",
                  kind: "user_input",
                  eventType: "user.reply",
                  prompt: "Should I continue the parity workflow?",
                },
                metadata: {
                  prompt: "Should I continue the parity workflow?",
                  requestId: "request-parity-resume",
                  reason: "awaiting_input",
                },
              },
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 2,
                toolCalls: 1,
                modelCalls: 1,
                durationMs: 11,
              },
            },
          };
        },
        close: async () => {},
      };
    },
  });

  if (server === undefined) {
    return;
  }

  try {
    const startResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-parity-start",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-parity-main",
            message: "Start workflow.",
            eventType: "user.message",
          },
        },
      }),
    });

    assert.equal(startResponse.status, 200);
    const startEvents = parseSseEvents(await startResponse.text());
    assert.ok(startEvents.some((entry) => entry.event === "run.started"));
    assert.ok(startEvents.some((entry) => entry.event === "run.progress"));

    const startTerminal = findEvent(startEvents, "run.completed");
    const startOutput = readRunOutput(startTerminal.data);
    assert.equal(startOutput.status, "WAITING");
    assert.equal(startOutput.telemetry.stepsExecuted, 2);
    assert.equal(startOutput.telemetry.toolCalls, 1);
    assert.equal(startOutput.telemetry.modelCalls, 1);
    assert.equal(startOutput.telemetry.durationMs, 11);

    const resumeResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-parity-resume",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-parity-main",
            message: "Approved.",
            eventType: "user.reply",
            resumeBlockedRun: true,
            resumeRequestId: "request-parity-resume",
          },
        },
      }),
    });

    assert.equal(resumeResponse.status, 200);
    const resumeEvents = parseSseEvents(await resumeResponse.text());
    assert.ok(resumeEvents.some((entry) => entry.event === "run.started"));
    assert.ok(resumeEvents.some((entry) => entry.event === "run.progress"));

    const resumeTerminal = findEvent(resumeEvents, "run.completed");
    const resumeOutput = readRunOutput(resumeTerminal.data);
    assert.equal(resumeOutput.status, "COMPLETED");
    assert.equal(resumeOutput.telemetry.stepsExecuted, 3);
    assert.equal(resumeOutput.telemetry.toolCalls, 1);
    assert.equal(resumeOutput.telemetry.modelCalls, 2);
    assert.equal(resumeOutput.telemetry.durationMs, 23);

    const cancelStreamResponse = await fetch(`${server.url}/commands/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-parity-cancel-start",
        type: "run.start",
        metadata: {
          ...actorMetadata,
          profile,
        },
        payload: {
          profile,
          turn: {
            sessionId: "session-parity-cancel",
            message: "Long running work.",
            eventType: "user.message",
          },
        },
      }),
    });

    assert.equal(cancelStreamResponse.status, 200);

    const cancelResponse = await fetch(`${server.url}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        id: "cmd-parity-cancel",
        type: "run.cancel",
        metadata: actorMetadata,
        payload: {
          sessionId: "session-parity-cancel",
        },
      }),
    });

    assert.equal(cancelResponse.status, 200);
    const cancelEvents = parseSseEvents(await cancelStreamResponse.text());
    assert.ok(cancelEvents.some((entry) => entry.event === "run.cancelled"));
    assert.ok(cancelEvents.every((entry) => entry.event !== "run.failed"));
  } finally {
    await server.close();
  }
});

async function createHttpServerOrSkip(
  context: TestContext | undefined,
  options: Parameters<typeof createRunnerServiceServer>[0],
) {
  try {
    return await createRunnerServiceServer(options);
  } catch (error) {
    if (isListenPermissionError(error)) {
      context?.skip("sandbox denied localhost listener setup for runner-service parity smoke test");
      return undefined;
    }
    throw error;
  }
}

function isListenPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "EPERM" &&
    /listen/i.test(error.message)
  );
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const chunks = body.split("\n\n");
  const events: Array<{ event: string; data: unknown }> = [];

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }

    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice("data:".length).trim();
      }
    }

    events.push({
      event,
      data: data ? JSON.parse(data) : null,
    });
  }

  return events;
}

function findEvent(
  events: Array<{ event: string; data: unknown }>,
  eventName: string,
): { event: string; data: unknown } {
  const found = events.find((entry) => entry.event === eventName);
  assert.ok(found, `Expected "${eventName}" in SSE stream.`);
  return found;
}

function readRunOutput(data: unknown): {
  status: string;
  telemetry: {
    stepsExecuted: number;
    toolCalls: number;
    modelCalls: number;
    durationMs: number;
  };
} {
  const payload = data as {
    payload?: {
      result?: {
        output?: {
          status?: string;
          telemetry?: {
            stepsExecuted?: number;
            toolCalls?: number;
            modelCalls?: number;
            durationMs?: number;
          };
        };
      };
    };
  };
  const output = payload.payload?.result?.output;

  assert.ok(output, "Expected run.completed payload.result.output.");
  assert.equal(typeof output.status, "string");
  assert.equal(typeof output.telemetry?.stepsExecuted, "number");
  assert.equal(typeof output.telemetry?.toolCalls, "number");
  assert.equal(typeof output.telemetry?.modelCalls, "number");
  assert.equal(typeof output.telemetry?.durationMs, "number");

  return {
    status: output.status ?? "UNKNOWN",
    telemetry: {
      stepsExecuted: output.telemetry?.stepsExecuted ?? 0,
      toolCalls: output.telemetry?.toolCalls ?? 0,
      modelCalls: output.telemetry?.modelCalls ?? 0,
      durationMs: output.telemetry?.durationMs ?? 0,
    },
  };
}
