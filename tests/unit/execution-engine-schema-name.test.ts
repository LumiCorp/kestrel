import test from "node:test";
import assert from "node:assert/strict";

import { readModelRequestSchemaName } from "../../src/engine/ExecutionEngine.js";

test("readModelRequestSchemaName returns the OpenRouter schema name when present", () => {
  assert.equal(
    readModelRequestSchemaName({
      input: "hello",
      providerOptions: {
        openrouter: {
          responseSchemaName: "route_schema",
        },
      },
    }),
    "route_schema",
  );
});

test("readModelRequestSchemaName returns the OpenAI schema name when present", () => {
  assert.equal(
    readModelRequestSchemaName({
      input: "hello",
      providerOptions: {
        openai: {
          responseSchemaName: "chat_schema",
        },
      },
    }),
    "chat_schema",
  );
});
