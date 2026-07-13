import assert from "node:assert/strict";
import test from "node:test";

import type { TuiProfile } from "../../cli/contracts.js";
import { createInMemoryRunnerService } from "../../cli/runner/RunnerService.js";
import type { RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import type { ProgressUpdateV1 } from "../../src/index.js";

const profile: TuiProfile = {
  id: "reference-react",
  label: "Reference React",
  agent: "reference-react",
  sessionPrefix: "reference-react",
};

test("OpenAI compatibility lists supported models", async () => {
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    const body = JSON.parse(response.body) as {
      object: string;
      data: Array<{ id: string; object: string }>;
    };
    assert.equal(response.statusCode, 200);
    assert.equal(body.object, "list");
    assert.equal(body.data[0]?.id, "reference-react");
    assert.equal(body.data[0]?.object, "model");
  } finally {
    await service.close();
  }
});

test("OpenAI compatibility returns non-streaming chat completions with sticky session metadata", async () => {
  const seenSessionIds: string[] = [];
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: (): RunnerRuntime => ({
      runTurn: async (input) => {
        seenSessionIds.push(input.sessionId);
        return {
          assistantText: "Compatibility hello",
          output: {
            status: "COMPLETED",
            sessionId: input.sessionId,
            runId: "run-chat-1",
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
              durationMs: 2,
              inputTokens: 12,
              outputTokens: 8,
              totalTokens: 20,
            },
          },
          finalizedPayload: null,
        };
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        "x-kestrel-session-id": "session-sticky",
      },
      body: JSON.stringify({
        model: "reference-react",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant.",
          },
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
    });

    const body = JSON.parse(response.body) as {
      object: string;
      choices: Array<{
        message: {
          role: string;
          content: string;
        };
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
      metadata?: {
        kestrel?: {
          session_id?: string;
          run_id?: string;
          source?: unknown;
        };
      };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-kestrel-session-id"], "session-sticky");
    assert.equal(response.headers["x-kestrel-run-id"], "run-chat-1");
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0]?.message.role, "assistant");
    assert.equal(body.choices[0]?.message.content, "Compatibility hello");
    assert.deepEqual(body.usage, {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });
    assert.equal(body.metadata?.kestrel?.session_id, "session-sticky");
    assert.equal(body.metadata?.kestrel?.run_id, "run-chat-1");
    assert.equal(body.metadata?.kestrel?.source, null);
    assert.deepEqual(seenSessionIds, ["session-sticky"]);
  } finally {
    await service.close();
  }
});

test("OpenAI compatibility streams chat completion chunks and mirrors internal tool calls", async () => {
  let progressListener: ((update: ProgressUpdateV1) => void) | undefined;
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: (_profile, _onRunLog, onProgress): RunnerRuntime => {
      progressListener = onProgress;
      return {
        runTurn: async (input) => {
          progressListener?.({
            version: "v1",
            runId: "run-stream-1",
            sessionId: input.sessionId,
            ts: new Date().toISOString(),
            seq: 1,
            kind: "tool",
            phase: "agent",
            code: "TOOL_CALL_STARTED",
            message: "Calling tool 'internet.search'.",
            tool: {
              name: "internet.search",
              status: "STARTED",
            },
            persist: true,
            toolInput: {
              q: "kestrel compatibility",
            },
          } as ProgressUpdateV1 & { toolInput: Record<string, unknown> });
          return {
            assistantText: "Streamed answer",
            output: {
              status: "COMPLETED",
              sessionId: input.sessionId,
              runId: "run-stream-1",
              errors: [],
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 1,
                toolCalls: 1,
                modelCalls: 1,
                durationMs: 3,
              },
            },
            finalizedPayload: {
              message: "Streamed answer",
            },
          };
        },
        close: async () => {},
      };
    },
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "reference-react",
        stream: true,
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["Content-Type"] ?? response.headers["content-type"] ?? "", /text\/event-stream/i);
    assert.match(response.body, /"object":"chat\.completion\.chunk"/);
    assert.match(response.body, /"tool_calls"/);
    assert.match(response.body, /"internet\.search"/);
    assert.match(response.body, /"Streamed answer"/);
    assert.match(response.body, /\[DONE\]/);
  } finally {
    await service.close();
  }
});

test("OpenAI compatibility returns responses output and enforces structured output schemas", async () => {
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: (): RunnerRuntime => ({
      runTurn: async (input) => ({
        assistantText: "{\"status\":\"ok\"}",
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: "run-response-1",
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
        finalizedPayload: {
          message: "{\"status\":\"ok\"}",
        },
      }),
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "reference-react",
        input: "Return machine readable status",
        text: {
          format: {
            type: "json_schema",
            json_schema: {
              name: "compat_status",
              schema: {
                type: "object",
                properties: {
                  status: {
                    type: "string",
                  },
                },
                required: ["status"],
                additionalProperties: false,
              },
            },
          },
        },
      }),
    });

    const body = JSON.parse(response.body) as {
      object: string;
      output_text: string;
      metadata?: {
        kestrel?: {
          run_id?: string;
        };
      };
    };
    assert.equal(response.statusCode, 200);
    assert.equal(body.object, "response");
    assert.equal(body.output_text, "{\"status\":\"ok\"}");
    assert.equal(body.metadata?.kestrel?.run_id, "run-response-1");
  } finally {
    await service.close();
  }
});

test("OpenAI compatibility rejects unknown models deterministically", async () => {
  const service = createInMemoryRunnerService({
    authToken: "secret-token",
    runtimeFactory: () => ({
      runTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
  });

  try {
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "unknown-model",
        messages: [
          {
            role: "user",
            content: "hello",
          },
        ],
      }),
    });

    const body = JSON.parse(response.body) as {
      error: {
        code: string;
        message: string;
      };
    };
    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, "model_not_found");
    assert.match(body.error.message, /unsupported model/i);
  } finally {
    await service.close();
  }
});
