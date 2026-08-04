import assert from "node:assert/strict";
import test from "node:test";

import {
  listToolRuntimeNames,
  resolveToolProviderDescriptorRefs,
} from "../../apps/web/lib/tools/registry.js";
import {
  TOOL_DESCRIPTOR_VERSION,
  createToolDescriptorV1,
  toToolDescriptorRefV1,
  type ToolDescriptorAuthoringV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  TOOL_REGISTRY_SOURCE_FAMILIES_V1,
  compileToolRegistryV1,
  type ToolRegistrySourceAdapterV1,
  type ToolRegistrySourceFamilyV1,
} from "../../src/kestrel/contracts/tool-registry.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

type ConformanceFixture = () => Promise<void> | void;

const SOURCE_CONFORMANCE = {
  builtin() {
    const descriptor = defaultToolCatalog.listDescriptors()[0];
    assert.ok(descriptor);
    assert.equal(descriptor.source.kind, "builtin");
    assert.equal(
      defaultToolCatalog.getDescriptorRef(descriptor.toolId)?.contractRevision,
      descriptor.contractRevision,
    );
  },
  embedded() {
    assertAdapterConforms(createAdapter("embedded"));
  },
  "mcp.local"() {
    assertAdapterConforms(createAdapter("mcp.local"));
  },
  "mcp.hosted"() {
    const local = createAdapter("mcp.local").compileDescriptors()[0]!;
    const hosted = createAdapter("mcp.hosted").compileDescriptors()[0]!;
    assertAdapterConforms(createAdapter("mcp.hosted"));
    assert.notEqual(hosted.source.sourceId, local.source.sourceId);
    assert.notEqual(hosted.contractRevision, local.contractRevision);
  },
  "app.provider-overlay"() {
    const resolved = resolveToolProviderDescriptorRefs({
      getDescriptorRef(runtimeName) {
        return {
          toolId: runtimeName,
          contractRevision: `sha256:${"0".repeat(64)}`,
        };
      },
    });
    assert.equal(resolved.length, listToolRuntimeNames().length);
    assert.ok(resolved.length > 0);
    for (const mapping of resolved) {
      assert.equal(mapping.runtimeName, mapping.descriptorRef.toolId);
    }
  },
} satisfies Record<ToolRegistrySourceFamilyV1, ConformanceFixture>;

test("every supported tool source family traverses the conformance harness", async () => {
  assert.deepEqual(
    Object.keys(SOURCE_CONFORMANCE).sort(),
    [...TOOL_REGISTRY_SOURCE_FAMILIES_V1].sort(),
  );
  for (const sourceFamily of TOOL_REGISTRY_SOURCE_FAMILIES_V1) {
    await SOURCE_CONFORMANCE[sourceFamily]();
  }
});

function assertAdapterConforms(adapter: ToolRegistrySourceAdapterV1): void {
  const compiled = compileToolRegistryV1([adapter]);
  assert.equal(compiled.descriptors.length, 1);
  const descriptor = compiled.descriptors[0]!;
  assert.equal(Object.isFrozen(descriptor), true);
  assert.match(descriptor.contractRevision, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    compiled.getDescriptor(descriptor.toolId),
    descriptor,
  );
}

function createAdapter(
  sourceFamily: "embedded" | "mcp.local" | "mcp.hosted",
): ToolRegistrySourceAdapterV1 {
  const sourceKind = sourceFamily === "embedded" ? "embedded" : "mcp";
  const sourceId = `conformance.${sourceFamily}`;
  const toolId = `conformance.${sourceFamily}.lookup`;
  const descriptor = createToolDescriptorV1({
    version: TOOL_DESCRIPTOR_VERSION,
    toolId,
    source: {
      kind: sourceKind,
      sourceId,
      protocolKind: sourceKind === "mcp" ? "tool" : "handler",
      protocolTarget: "lookup",
    },
    description: `Conformance fixture for ${sourceFamily}.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
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
      freshnessClass: "live",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["conformance.lookup"],
    },
    presentation: {
      displayName: "Conformance lookup",
      aliases: [toolId],
      keywords: ["conformance"],
      provider: sourceId,
      toolFamily: "conformance",
    },
    execution: {
      handlerId: `${sourceId}:lookup:v1`,
      resultNormalizerId: `${sourceId}:result:v1`,
    },
  } satisfies ToolDescriptorAuthoringV1);
  const descriptorRef = toToolDescriptorRefV1(descriptor);
  return {
    adapterId: `${sourceId}:v1`,
    sourceKind,
    sourceId,
    compileDescriptors: () => [descriptor],
    hasHandler: (handlerId) => handlerId === descriptor.execution.handlerId,
    hasResultNormalizer: (normalizerId) =>
      normalizerId === descriptor.execution.resultNormalizerId &&
      descriptorRef.outputContractHash === descriptor.outputContractHash,
  };
}
