import assert from "node:assert/strict";
import test from "node:test";
import {
  getToolProviderDefinition,
  listToolProviders,
  listToolRuntimeNames,
} from "./registry";

test("tool registry includes seeded built-in and external providers", () => {
  const providers = listToolProviders();
  assert.ok(providers.some((provider) => provider.key === "built_in.weather"));
  assert.ok(providers.some((provider) => provider.key === "built_in.time"));
  assert.ok(
    providers.some((provider) => provider.key === "built_in.geocoding")
  );
  assert.ok(
    providers.some((provider) => provider.key === "built_in.exchange_rates")
  );
  assert.ok(
    providers.some((provider) => provider.key === "built_in.hacker_news")
  );
  assert.ok(
    providers.some((provider) => provider.key === "built_in.knowledge_search")
  );
  assert.ok(providers.some((provider) => provider.key === "github"));
  assert.ok(providers.some((provider) => provider.key === "discord"));
  assert.ok(providers.some((provider) => provider.key === "source.github"));
  assert.ok(providers.some((provider) => provider.key === "source.youtube"));
});

test("GitHub exposes governed capabilities while source adapters stay connection-only", () => {
  const github = getToolProviderDefinition("github");
  const discord = getToolProviderDefinition("discord");
  const githubSources = getToolProviderDefinition("source.github");
  const youtubeSources = getToolProviderDefinition("source.youtube");

  assert.ok(github);
  assert.ok(discord);
  assert.ok(githubSources);
  assert.ok(youtubeSources);
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
  assert.equal(discord?.capabilities.length, 0);
  assert.equal(githubSources?.capabilities.length, 0);
  assert.equal(youtubeSources?.capabilities.length, 0);
});

test("weather provider defaults weather capability to auto approval", () => {
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

test("runtime names expose current chat tools", () => {
  const runtimeNames = listToolRuntimeNames();
  assert.ok(runtimeNames.includes("free.weather.current"));
  assert.ok(runtimeNames.includes("free.weather.forecast"));
  assert.ok(runtimeNames.includes("free.time.current"));
  assert.ok(runtimeNames.includes("free.geocode.lookup"));
  assert.ok(runtimeNames.includes("free.exchange.rate"));
  assert.ok(runtimeNames.includes("free.hn.top"));
  assert.ok(runtimeNames.includes("searchKnowledgeDocuments"));
  assert.ok(runtimeNames.includes("createDocument"));
});

test("every provider declares a coherent App connection contract", () => {
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
