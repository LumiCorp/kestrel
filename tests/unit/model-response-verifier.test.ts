import assert from "node:assert/strict";
import test from "node:test";

import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import {
  createModelRequestV2,
  MODEL_RESPONSE_V2_VERSION,
} from "../../src/kestrel/contracts/model-registration.js";
import { verifyModelResponseV2 } from "../../src/io/ModelResponseVerifier.js";

function request() {
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
    ],
    requirements: {
      runtimeRole: "test",
      output: { kind: "text", assurance: "none" },
      tools: {
        choice: "required",
        strictArguments: true,
        parallelism: "forbidden",
      },
      reasoning: { mode: "off", continuationKinds: [] },
      streaming: { required: false, terminalBehavior: "not_required" },
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
