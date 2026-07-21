import assert from "node:assert/strict";

import { compileOpenRouterResponseSchema } from "../../models/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "OpenRouter schema compiler normalizes object required fields", () => {
  const compiled = compileOpenRouterResponseSchema({
    schemaName: "kestrel_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["version"],
    },
  });

  assert.equal(compiled.responseFormat.type, "json_schema");
  assert.equal(compiled.responseFormat.json_schema.name, "kestrel_test");
  const schema = compiled.responseFormat.json_schema.schema;
  const required = (schema.required ?? []) as string[];
  assert.deepEqual(required.sort(), ["rationale", "version"]);
  assert.equal(compiled.diagnostics.requiredPropertyExpansions, 1);
  assert.equal(compiled.diagnostics.nullablePropertyWraps, 1);
});

contractTest("runtime.hermetic", "OpenRouter schema compiler rejects unsupported keywords deterministically", () => {
  assert.throws(
    () =>
      compileOpenRouterResponseSchema({
        schemaName: "kestrel_test",
        schema: {
          type: "object",
          properties: {
            item: { $ref: "#/$defs/item" },
          },
          required: ["item"],
        },
      }),
    (error: unknown) => {
      const cast = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "MODEL_PROVIDER_SCHEMA");
      assert.equal(cast.details?.category, "provider_schema");
      assert.equal(cast.details?.keyword, "$ref");
      return true;
    },
  );
});

contractTest("runtime.hermetic", "OpenRouter schema compiler converts open objects to object-or-json-string fallback", () => {
  const compiled = compileOpenRouterResponseSchema({
    schemaName: "kestrel_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        details: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["details"],
    },
  });

  const root = compiled.responseFormat.json_schema.schema;
  const details = ((root.properties ?? {}) as Record<string, unknown>).details as
    | Record<string, unknown>
    | undefined;
  const branches = Array.isArray(details?.anyOf) ? details.anyOf : [];
  assert.equal(branches.length, 2);
  const objectBranch = branches.find(
    (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === "object",
  ) as Record<string, unknown> | undefined;
  assert.equal(objectBranch?.additionalProperties, false);
  assert.equal(compiled.diagnostics.openObjectStringFallbacks, 1);
});

contractTest("runtime.hermetic", "OpenRouter schema compiler strips unsupported string formats", () => {
  const compiled = compileOpenRouterResponseSchema({
    schemaName: "kestrel_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        filepath: {
          type: "string",
          format: "path",
        },
      },
      required: ["filepath"],
    },
  });

  const root = compiled.responseFormat.json_schema.schema;
  const filepath = ((root.properties ?? {}) as Record<string, unknown>).filepath as
    | Record<string, unknown>
    | undefined;
  assert.equal(filepath?.type, "string");
  assert.equal("format" in (filepath ?? {}), false);
  assert.equal(compiled.diagnostics.unsupportedStringFormatRemovals, 1);
});

contractTest("runtime.hermetic", "OpenRouter schema compiler preserves supported string formats", () => {
  const compiled = compileOpenRouterResponseSchema({
    schemaName: "kestrel_test",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        createdAt: {
          type: "string",
          format: "date-time",
        },
      },
      required: ["createdAt"],
    },
  });

  const root = compiled.responseFormat.json_schema.schema;
  const createdAt = ((root.properties ?? {}) as Record<string, unknown>).createdAt as
    | Record<string, unknown>
    | undefined;
  assert.equal(createdAt?.type, "string");
  assert.equal(createdAt?.format, "date-time");
  assert.equal(compiled.diagnostics.unsupportedStringFormatRemovals, 0);
});
