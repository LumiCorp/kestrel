import test from "node:test";
import assert from "node:assert/strict";
import { RUNNER_SHARED_TOOL_NAMES } from "@kestrel-agents/protocol";

import {
  listToolProviders,
  listToolRuntimeNames,
  resolveToolProviderDescriptorRefs,
} from "./registry";


const SHARED_RUNTIME_PROVIDER_KEYS = new Set([
  "built_in.weather",
  "built_in.time",
  "built_in.geocoding",
  "built_in.exchange_rates",
  "tavily",
]);

test("Kestrel One App capabilities reference canonical shared runtime tools", () => {
  const sharedToolNames = new Set<string>(RUNNER_SHARED_TOOL_NAMES);
  const capabilities = listToolProviders()
    .filter((provider) => SHARED_RUNTIME_PROVIDER_KEYS.has(provider.key))
    .flatMap((provider) =>
      provider.capabilities.map((capability) => ({
        providerKey: provider.key,
        capabilityKey: capability.key,
        runtimeName: capability.runtimeName,
      }))
    );

  for (const capability of capabilities) {
    assert.ok(
      capability.runtimeName && sharedToolNames.has(capability.runtimeName),
      `${capability.providerKey}.${capability.capabilityKey} must reference a shared tool definition`
    );
  }
});

test("every App runtime mapping resolves to one exact canonical descriptor", () => {
  const resolved = resolveToolProviderDescriptorRefs({
    getDescriptorRef(runtimeName) {
      return {
        toolId: runtimeName,
        contractRevision: `sha256:${"0".repeat(64)}`,
      };
    },
  });
  const runtimeNames = listToolRuntimeNames();

  assert.equal(resolved.length, runtimeNames.length);
  for (const mapping of resolved) {
    assert.equal(mapping.descriptorRef.toolId, mapping.runtimeName);
    assert.match(mapping.descriptorRef.contractRevision, /^sha256:[0-9a-f]{64}$/u);
  }
});

test("App runtime descriptor resolution fails closed on missing and divergent mappings", () => {
  assert.throws(
    () => resolveToolProviderDescriptorRefs({ getDescriptorRef: () => undefined }),
    /references missing runtime descriptor/u,
  );
  assert.throws(
    () =>
      resolveToolProviderDescriptorRefs({
        getDescriptorRef(runtimeName) {
          return {
            toolId: `${runtimeName}.divergent`,
            contractRevision: `sha256:${"0".repeat(64)}`,
          };
        },
      }),
    /diverges from descriptor/u,
  );
});
