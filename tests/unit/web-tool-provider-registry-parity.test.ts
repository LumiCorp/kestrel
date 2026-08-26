import assert from "node:assert/strict";
import test from "node:test";

import { WEB_ARTIFACT_TOOL_DESCRIPTORS } from "../../apps/web/lib/ai/tools/artifact-tool-contracts.js";
import {
  listToolRuntimeNames,
  resolveToolProviderDescriptorRefs,
} from "../../apps/web/lib/tools/registry.js";
import { createToolDescriptorV1, type ToolDescriptorAuthoringV1 } from "../../src/kestrel/contracts/tool-contract.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

test("Web-native artifact authoring compiles into complete canonical descriptors", () => {
  const descriptors = WEB_ARTIFACT_TOOL_DESCRIPTORS.map((authoring) =>
    createToolDescriptorV1(
      authoring as unknown as ToolDescriptorAuthoringV1,
    ),
  );

  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.toolId),
    ["createDocument", "updateDocument", "requestSuggestions"],
  );
  for (const descriptor of descriptors) {
    assert.match(descriptor.contractRevision, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(descriptor.execution.handlerId);
    assert.ok(descriptor.execution.resultNormalizerId);
  }
});

test("every Web App runtime mapping resolves to one exact canonical descriptor ref", () => {
  const resolved = resolveToolProviderDescriptorRefs({
    getDescriptorRef(runtimeName) {
      return defaultToolCatalog.getDescriptorRef(runtimeName);
    },
  });

  assert.equal(resolved.length, listToolRuntimeNames().length);
  for (const mapping of resolved) {
    assert.equal(mapping.runtimeName, mapping.descriptorRef.toolId);
    assert.match(mapping.descriptorRef.contractRevision, /^sha256:[0-9a-f]{64}$/u);
  }
});
