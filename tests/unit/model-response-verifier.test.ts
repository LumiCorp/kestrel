import assert from "node:assert/strict";
import test from "node:test";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import {
  createModelRequestV2,
  MODEL_RESPONSE_V2_VERSION,
} from "../../src/kestrel/contracts/model-registration.js";
import { verifyModelResponseV2 } from "../../src/io/ModelResponseVerifier.js";

function request({
  choice = "required",
  parallelism = "forbidden",
  streaming = false,
  includeSecondTool = false,
}: {
  choice?: "auto" | "required" | "named";
  parallelism?: "forbidden" | "allowed" | "required";
  streaming?: boolean;
  includeSecondTool?: boolean;
} = {}) {
  return createModelRequestV2({
    version: "model_request_v2",
    input: "look this up",
    tools: [
      {
        name: "lookup",
        description: "Look up a value.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      ...(includeSecondTool
        ? [
            {
              name: "summarize",
              description: "Summarize a value.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ]
        : []),
    ],
    requirements: {
      runtimeRole: "test",
      output: { kind: "text", assurance: "none" },
      tools: {
        choice,
        strictArguments: true,
        parallelism,
        ...(choice === "named" ? { toolName: "lookup" } : {}),
      },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: {
        required: streaming,
        terminalBehavior: streaming ? "required" : "not_required",
      },
      inputModalities: ["text"],
      endpoint: "any",
    },
  });
}

function response(input: Record<string, unknown>) {
  return {
    version: MODEL_RESPONSE_V2_VERSION,
    toolIntents: [{ id: "call-1", name: "lookup", input }],
    provider: { name: "openai" as const, model: "test", endpoint: "responses" as const },
    terminal: { state: "completed" as const, visibleOutputStarted: false },
    validation: { state: "not_requested" as const },
  };
}

test("response verifier accepts a known tool call and attaches its proof", () => {
  const verified = verifyModelResponseV2(request(), response({ query: "Kestrel" }));
  assert.equal(verified.validation.state, "passed");
  assert.match(verified.validation.toolSurfaceHash!, /^sha256:/u);
});

test("gateway rejects invalid tool arguments without retrying a V2 proof failure", async () => {
  let attempts = 0;
  const gateway = new RetryingModelGateway(async () => {
    attempts += 1;
    return response({}) as never;
  }, { retryCount: 2 });

  await assert.rejects(
    () => gateway.call(request()),
    (error: unknown) => (error as { code?: unknown }).code === "MODEL_TOOL_ARGUMENTS_INVALID",
  );
  assert.equal(attempts, 1);
});

test("response verifier requires two calls when the V2 contract requires parallelism", () => {
  assert.throws(
    () =>
      verifyModelResponseV2(
        request({ choice: "auto", parallelism: "required" }),
        { ...response({ query: "Kestrel" }), toolIntents: [] },
      ),
    (error: unknown) =>
      (error as { code?: unknown }).code === "MODEL_TOOL_PARALLELISM_REQUIRED",
  );
});

test("response verifier requires terminal evidence for required streams", () => {
  assert.throws(
    () => verifyModelResponseV2(request({ streaming: true }), response({ query: "Kestrel" })),
    (error: unknown) =>
      (error as { code?: unknown }).code === "MODEL_STREAM_TERMINAL_EVIDENCE_MISSING",
  );
});

test("response verifier rejects continuation from another provider", () => {
  assert.throws(
    () =>
      verifyModelResponseV2(request(), {
        ...response({ query: "Kestrel" }),
        reasoning: {
          visible: [],
          continuation: [
            { provider: "anthropic", kind: "signature", value: "opaque" },
          ],
        },
      }),
    (error: unknown) =>
      (error as { code?: unknown }).code === "MODEL_CONTINUATION_PROVIDER_MISMATCH",
  );
});

test("response verifier rejects extra tool calls for named tool choice", () => {
  assert.throws(
    () =>
      verifyModelResponseV2(request({ choice: "named", includeSecondTool: true }), {
        ...response({ query: "Kestrel" }),
        toolIntents: [
          { id: "call-1", name: "lookup", input: { query: "Kestrel" } },
          { id: "call-2", name: "summarize", input: { text: "Kestrel" } },
        ],
      }),
    (error: unknown) =>
      (error as { code?: unknown }).code === "MODEL_NAMED_TOOL_CALL_UNEXPECTED",
  );
});

test("response verifier retains safe provider correlation for malformed envelopes", () => {
  assert.throws(
    () =>
      verifyModelResponseV2(request(), {
        ...response({ query: "Kestrel" }),
        toolIntents: [{ id: "call-1", name: "lookup", input: null }],
        provider: {
          name: "openai",
          model: "test",
          endpoint: "responses",
          requestId: "req-preserve-me",
        },
        terminal: {
          state: "completed",
          visibleOutputStarted: false,
          providerTerminalEvent: "response.completed",
        },
      }),
    (error: unknown) => {
      const failure = error as { code?: unknown; details?: Record<string, unknown> };
      return (
        failure.code === "MODEL_MALFORMED_RESPONSE" &&
        failure.details?.requestId === "req-preserve-me" &&
        failure.details?.providerTerminalEvent === "response.completed"
      );
    },
  );
});
