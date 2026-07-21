import assert from "node:assert/strict";
import { inspect } from "node:util";

import {
  createToolProviderConfigurationResolver,
  createToolProviderRuntimeConfiguration,
} from "../../tools/providers/runtimeConfiguration.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "provider runtime configuration keeps credentials out of serialized metadata", () => {
  const configuration = createToolProviderRuntimeConfiguration({
    providerKey: "tavily",
    credential: "  tavily-secret  ",
    baseUrl: "  https://api.tavily.test  ",
    settings: {
      projectId: "  project-1  ",
      empty: "   ",
    },
  });

  assert.equal(configuration.providerKey, "tavily");
  assert.equal(configuration.baseUrl, "https://api.tavily.test");
  assert.equal(configuration.hasCredential, true);
  assert.equal(configuration.readCredential(), "tavily-secret");
  assert.deepEqual(configuration.settings, { projectId: "project-1" });
  assert.equal(JSON.stringify(configuration).includes("tavily-secret"), false);
  assert.equal(inspect(configuration).includes("tavily-secret"), false);
});

contractTest("runtime.hermetic", "provider configuration resolver rejects duplicate provider authority", () => {
  const first = createToolProviderRuntimeConfiguration({ providerKey: "exa" });
  const second = createToolProviderRuntimeConfiguration({ providerKey: "exa" });

  assert.throws(
    () => createToolProviderConfigurationResolver([first, second]),
    /Duplicate tool provider configuration 'exa'/u,
  );
});

contractTest("runtime.hermetic", "provider configuration resolver returns only exact provider matches", () => {
  const tavily = createToolProviderRuntimeConfiguration({
    providerKey: "tavily",
    credential: "secret",
  });
  const resolver = createToolProviderConfigurationResolver([tavily]);

  assert.equal(resolver.resolve("tavily"), tavily);
  assert.equal(resolver.resolve("exa"), undefined);
  assert.deepEqual(resolver.list(), [
    {
      providerKey: "tavily",
      configured: true,
      baseUrlConfigured: false,
      settings: [],
    },
  ]);
  assert.equal(JSON.stringify(resolver.list()).includes("secret"), false);
});
