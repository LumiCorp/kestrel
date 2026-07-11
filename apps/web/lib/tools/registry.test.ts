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
  assert.ok(
    providers.some((provider) => provider.key === "built_in.knowledge_search")
  );
  assert.ok(providers.some((provider) => provider.key === "github"));
  assert.ok(providers.some((provider) => provider.key === "discord"));
  assert.ok(providers.some((provider) => provider.key === "source.github"));
  assert.ok(providers.some((provider) => provider.key === "source.youtube"));
});

test("github and discord providers stay connection-only until runtime tools exist", () => {
  const github = getToolProviderDefinition("github");
  const discord = getToolProviderDefinition("discord");
  const githubSources = getToolProviderDefinition("source.github");
  const youtubeSources = getToolProviderDefinition("source.youtube");

  assert.ok(github);
  assert.ok(discord);
  assert.ok(githubSources);
  assert.ok(youtubeSources);
  assert.equal(github?.capabilities.length, 0);
  assert.equal(discord?.capabilities.length, 0);
  assert.equal(githubSources?.capabilities.length, 0);
  assert.equal(youtubeSources?.capabilities.length, 0);
});

test("weather provider defaults weather capability to auto approval", () => {
  const provider = getToolProviderDefinition("built_in.weather");
  assert.ok(provider);
  assert.equal(provider?.capabilities[0]?.key, "getWeather");
  assert.equal(provider?.capabilities[0]?.defaultPolicy.approvalMode, "auto");
});

test("runtime names expose current chat tools", () => {
  const runtimeNames = listToolRuntimeNames();
  assert.ok(runtimeNames.includes("getWeather"));
  assert.ok(runtimeNames.includes("searchKnowledgeDocuments"));
  assert.ok(runtimeNames.includes("createDocument"));
});
