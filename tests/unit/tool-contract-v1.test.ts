import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_DESCRIPTOR_VERSION,
  TOOL_SCHEMA_LIMITS_V1,
  canonicalJson,
  compileToolJsonSchemaV1,
  createToolActivationRefV1,
  createToolDescriptorV1,
  createToolSurfaceSnapshotV1,
  fingerprintToolScopeV1,
  parseToolDescriptorV1,
  parseToolSurfaceSnapshotV1,
  toToolDescriptorRefV1,
  type ToolDescriptorAuthoringV1,
  type ToolDescriptorV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  compileToolRegistryV1,
  type ToolRegistrySourceAdapterV1,
} from "../../src/kestrel/contracts/tool-registry.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

function validAuthoring(
  overrides: Partial<ToolDescriptorAuthoringV1> = {},
): ToolDescriptorAuthoringV1 {
  return {
    version: TOOL_DESCRIPTOR_VERSION,
    toolId: "test.lookup",
    source: {
      kind: "embedded",
      sourceId: "tests",
      protocolKind: "handler",
      protocolTarget: "lookup",
    },
    description: "Look up an exact test value.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
      additionalProperties: false,
    },
    runtimeOutput: {
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    capability: {
      freshnessClass: "static",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      allowedInteractionModes: ["chat", "plan", "build"],
      capabilityClasses: ["test.lookup"],
    },
    presentation: {
      displayName: "Test lookup",
      aliases: ["lookup"],
      keywords: ["test"],
      provider: "tests",
      toolFamily: "test",
    },
    execution: {
      handlerId: "tests:lookup:v1",
      resultNormalizerId: "tests:json:v1",
    },
    ...overrides,
  };
}

test("tool descriptor canonical hashes are stable across object-key order", () => {
  const first = createToolDescriptorV1(validAuthoring());
  const reordered = createToolDescriptorV1({
    ...validAuthoring(),
    inputSchema: {
      additionalProperties: false,
      required: ["id"],
      properties: { id: { format: "uuid", type: "string" } },
      type: "object",
    },
  });

  assert.equal(first.contractRevision, reordered.contractRevision);
  assert.equal(first.inputSchemaHash, reordered.inputSchemaHash);
  assert.match(first.contractRevision, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: false } }),
    '{"a":{"b":false,"y":true},"z":1}',
  );
  assert.equal(
    fingerprintToolScopeV1({ tenant: "t", environment: "e" }),
    fingerprintToolScopeV1({ environment: "e", tenant: "t" }),
  );
});

test("every decision-relevant descriptor field moves the contract revision", () => {
  const base = createToolDescriptorV1(validAuthoring());
  const variants = [
    validAuthoring({ description: "Changed description." }),
    validAuthoring({
      execution: {
        handlerId: "tests:lookup:v2",
        resultNormalizerId: "tests:json:v1",
      },
    }),
    validAuthoring({
      execution: {
        handlerId: "tests:lookup:v1",
        resultNormalizerId: "tests:json:v2",
      },
    }),
    validAuthoring({
      capability: {
        ...validAuthoring().capability,
        costClass: "metered",
      },
    }),
  ];

  for (const variant of variants) {
    assert.notEqual(
      createToolDescriptorV1(variant).contractRevision,
      base.contractRevision,
    );
  }
});

test("descriptor parsing rejects unknown fields, secrets, and stale hashes", () => {
  const descriptor = createToolDescriptorV1(validAuthoring());
  assert.equal(parseToolDescriptorV1(descriptor).contractRevision, descriptor.contractRevision);
  assert.throws(
    () => parseToolDescriptorV1({ ...descriptor, credential: "secret" }),
    /unknown field 'credential'/u,
  );
  assert.throws(
    () =>
      parseToolDescriptorV1({
        ...descriptor,
        source: { ...descriptor.source, accessToken: "secret" },
      }),
    /unknown field 'accessToken'/u,
  );
  assert.throws(
    () =>
      parseToolDescriptorV1({
        ...descriptor,
        description: "tampered",
      }),
    /contractRevision does not match canonical content/u,
  );
});

test("activation and ordered tool-surface snapshots are canonical and fail closed", () => {
  const descriptor = createToolDescriptorV1(validAuthoring());
  const scopeFingerprint = fingerprintToolScopeV1({
    tenant: "tenant-a",
    environment: "env-a",
    gateway: "gateway-a",
    authorizationScope: ["read"],
  });
  const activation = createToolActivationRefV1({
    descriptor: toToolDescriptorRefV1(descriptor),
    registryGeneration: "generation-1",
    scopeFingerprint,
  });
  const snapshot = createToolSurfaceSnapshotV1({
    registryGeneration: "generation-1",
    scopeFingerprint,
    tools: [activation],
  });

  assert.equal(parseToolSurfaceSnapshotV1(snapshot).snapshotId, snapshot.snapshotId);
  assert.throws(
    () =>
      parseToolSurfaceSnapshotV1({
        ...snapshot,
        registryGeneration: "generation-2",
      }),
    /different registry generation/u,
  );
  assert.throws(
    () =>
      createToolSurfaceSnapshotV1({
        registryGeneration: "generation-1",
        scopeFingerprint,
        tools: [activation, activation],
      }),
    /duplicate tool/u,
  );
  assert.throws(
    () => parseToolSurfaceSnapshotV1({ ...snapshot, snapshotId: descriptor.contractRevision }),
    /snapshotId does not match canonical content/u,
  );
});

test("strict schema profile rejects refs, unknown formats, and implicit open objects", () => {
  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({ inputSchema: { $ref: "https://invalid/schema" } }),
      ),
    /unknown field '\$ref'/u,
  );
  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", format: "uri" } },
            additionalProperties: false,
          },
        }),
      ),
    /format is unsupported/u,
  );
  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({
          inputSchema: { type: "object", properties: {} },
        }),
      ),
    /must declare additionalProperties explicitly/u,
  );
});

test("strict validators neither coerce, strip, nor inject defaults", () => {
  const validator = compileToolJsonSchemaV1(
    {
      type: "object",
      properties: {
        count: { type: "number" },
        label: { type: "string", default: "defaulted" },
      },
      additionalProperties: false,
    },
    { surface: "input" },
  );
  const value: Record<string, unknown> = { count: "1", extra: true };
  assert.equal(validator(value), false);
  assert.deepEqual(value, { count: "1", extra: true });

  const noDefault: Record<string, unknown> = { count: 1 };
  assert.equal(validator(noDefault), true);
  assert.deepEqual(noDefault, { count: 1 });
});

test("schema resource limits reject oversized, deep, broad, and huge-enum schemas", () => {
  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({
          inputSchema: {
            type: "object",
            description: "x".repeat(TOOL_SCHEMA_LIMITS_V1.maxBytes),
            additionalProperties: false,
          },
        }),
      ),
    /exceeds 262144 bytes/u,
  );

  let deep: Record<string, unknown> = { type: "string" };
  for (let index = 0; index <= TOOL_SCHEMA_LIMITS_V1.maxDepth; index += 1) {
    deep = {
      type: "object",
      properties: { value: deep },
      additionalProperties: false,
    };
  }
  assert.throws(
    () => createToolDescriptorV1(validAuthoring({ inputSchema: deep })),
    /exceeds depth 32/u,
  );

  const properties = Object.fromEntries(
    Array.from(
      { length: TOOL_SCHEMA_LIMITS_V1.maxNodes + 1 },
      (_, index) => [`p${index}`, { type: "boolean" }],
    ),
  );
  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({
          inputSchema: {
            type: "object",
            properties,
            additionalProperties: false,
          },
        }),
      ),
    /exceeds 4096 schema nodes/u,
  );

  assert.throws(
    () =>
      createToolDescriptorV1(
        validAuthoring({
          inputSchema: {
            type: "object",
            properties: {
              value: {
                type: "number",
                enum: Array.from(
                  { length: TOOL_SCHEMA_LIMITS_V1.maxEnumValues + 1 },
                  (_, index) => index,
                ),
              },
            },
            additionalProperties: false,
          },
        }),
      ),
    /enum exceeds 1024 values/u,
  );
});

function sourceAdapter(
  descriptor: ToolDescriptorV1,
  options: { handler?: boolean; normalizer?: boolean } = {},
): ToolRegistrySourceAdapterV1 {
  return {
    adapterId: `${descriptor.source.sourceId}:${descriptor.contractRevision}`,
    sourceKind: descriptor.source.kind,
    sourceId: descriptor.source.sourceId,
    compileDescriptors: () => [descriptor],
    hasHandler: () => options.handler ?? true,
    hasResultNormalizer: () => options.normalizer ?? true,
  };
}

test("registry compilation fails closed on missing bindings and cross-source collisions", () => {
  const descriptor = createToolDescriptorV1(validAuthoring());
  assert.throws(
    () => compileToolRegistryV1([sourceAdapter(descriptor, { handler: false })]),
    /missing handler/u,
  );
  assert.throws(
    () =>
      compileToolRegistryV1([
        sourceAdapter(descriptor, { normalizer: false }),
      ]),
    /missing result normalizer/u,
  );
  const other = createToolDescriptorV1(
    validAuthoring({
      source: { ...validAuthoring().source, sourceId: "other" },
    }),
  );
  assert.throws(
    () => compileToolRegistryV1([sourceAdapter(descriptor), sourceAdapter(other)]),
    /cross-source collision/u,
  );
});

test("all shipped shared built-ins compile as complete immutable descriptors", () => {
  const definitions = defaultToolCatalog.list();
  const descriptors = defaultToolCatalog.listDescriptors();
  assert.equal(descriptors.length, definitions.length);
  assert.equal(new Set(descriptors.map((item) => item.toolId)).size, descriptors.length);
  for (const descriptor of descriptors) {
    assert.equal(Object.isFrozen(descriptor), true);
    assert.ok(descriptor.execution.handlerId);
    assert.ok(descriptor.execution.resultNormalizerId);
    assert.match(descriptor.outputContractHash, /^sha256:[0-9a-f]{64}$/u);
    const wire = defaultToolCatalog.toModelTools([descriptor.toolId])[0];
    assert.equal(wire?.name, descriptor.toolId);
    assert.equal(wire?.description, descriptor.description);
    assert.deepEqual(wire?.inputSchema, descriptor.inputSchema);
  }
});
