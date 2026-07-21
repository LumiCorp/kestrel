import assert from "node:assert/strict";
import { RUNNER_SHARED_TOOL_NAMES } from "@kestrel-agents/protocol";

import { listToolProviders } from "./registry";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const SHARED_RUNTIME_PROVIDER_KEYS = new Set([
  "built_in.weather",
  "built_in.time",
  "built_in.geocoding",
  "built_in.exchange_rates",
  "built_in.hacker_news",
  "tavily",
]);

contractTest("web.hermetic", "Kestrel One App capabilities reference canonical shared runtime tools", () => {
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
