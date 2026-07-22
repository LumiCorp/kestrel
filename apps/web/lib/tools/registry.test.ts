import assert from "node:assert/strict";
import {
  getToolProviderDefinition,
  listToolProviders,
  listToolRuntimeNames,
} from "./registry";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "tool registry includes seeded built-in and external providers", () => {
  const providers = listToolProviders();
  assert.ok(providers.some((provider) => provider.key === "built_in.weather"));
  assert.ok(
    providers.some((provider) => provider.key === "ngrok")
  );
  assert.ok(providers.some((provider) => provider.key === "built_in.time"));
  assert.ok(
    providers.some((provider) => provider.key === "built_in.geocoding")
  );
  assert.ok(
    providers.some((provider) => provider.key === "built_in.exchange_rates")
  );
  assert.ok(
    providers.some((provider) => provider.key === "built_in.knowledge_search")
  );
  assert.ok(providers.some((provider) => provider.key === "github"));
  assert.ok(providers.some((provider) => provider.key === "google_workspace"));
  assert.ok(providers.some((provider) => provider.key === "tavily"));
  assert.ok(providers.some((provider) => provider.key === "linear"));
  assert.equal(getToolProviderDefinition("built_in.hacker_news"), undefined);
  assert.equal(getToolProviderDefinition("discord"), undefined);
  assert.equal(getToolProviderDefinition("source.github"), undefined);
  assert.equal(getToolProviderDefinition("source.youtube"), undefined);
});

contractTest("web.hermetic", "GitHub exposes governed repository capabilities", () => {
  const github = getToolProviderDefinition("github");

  assert.ok(github);
  assert.deepEqual(
    github?.capabilities.map((capability) => [
      capability.key,
      capability.defaultPolicy.approvalMode,
    ]),
    [
      ["repository.read", "auto"],
      ["repository.push_agent_branch", "auto"],
      ["pull_request.write", "ask"],
      ["issue.write", "ask"],
      ["merge.write", "ask"],
      ["release.write", "ask"],
      ["workflow.dispatch", "ask"],
    ]
  );
});

contractTest("web.hermetic", "weather provider defaults weather capability to auto approval", () => {
  const provider = getToolProviderDefinition("built_in.weather");
  assert.ok(provider);
  assert.equal(provider?.capabilities[0]?.key, "getWeather");
  assert.deepEqual(
    provider?.capabilities.map((capability) => [
      capability.key,
      capability.runtimeName,
      capability.defaultPolicy.approvalMode,
    ]),
    [
      ["getWeather", "free.weather.current", "auto"],
      ["forecast", "free.weather.forecast", "auto"],
    ]
  );
});

contractTest("web.hermetic", "runtime names expose current chat tools", () => {
  const runtimeNames = listToolRuntimeNames();
  assert.ok(runtimeNames.includes("free.weather.current"));
  assert.ok(runtimeNames.includes("free.weather.forecast"));
  assert.ok(runtimeNames.includes("free.time.current"));
  assert.ok(runtimeNames.includes("free.geocode.lookup"));
  assert.ok(runtimeNames.includes("free.exchange.rate"));
  assert.ok(runtimeNames.includes("searchKnowledgeDocuments"));
  assert.ok(runtimeNames.includes("createDocument"));
});

contractTest("web.hermetic", "every provider declares a coherent App connection contract", () => {
  for (const provider of listToolProviders()) {
    assert.equal(
      provider.app.connectionModel === "none",
      provider.app.connectionRequirement === "none",
      `${provider.key} must align connection ownership and requirement`,
    );
    assert.ok(
      provider.app.authMethods.length > 0,
      `${provider.key} must declare at least one auth method`,
    );
    if (provider.app.connectionRequirement === "none") {
      assert.deepEqual(provider.app.authMethods, ["none"]);
    } else {
      assert.equal(provider.app.authMethods.includes("none"), false);
    }
  }
});
