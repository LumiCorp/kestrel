import assert from "node:assert/strict";
import { getCoreAppDefinition, listCoreAppDefinitions } from "./catalog";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Apps catalog exposes only implemented providers", () => {
  const keys = listCoreAppDefinitions().map((app) => app.key);
  assert.ok(keys.includes("google_workspace"));
  assert.ok(keys.includes("tavily"));
  assert.ok(keys.includes("github"));
  assert.ok(keys.includes("discord"));
  assert.ok(keys.includes("built_in.weather"));
  assert.ok(keys.includes("built_in.time"));
  assert.ok(keys.includes("built_in.geocoding"));
  assert.ok(keys.includes("built_in.exchange_rates"));
  assert.ok(keys.includes("built_in.hacker_news"));
  assert.ok(!keys.includes("exa"));
  assert.ok(!keys.includes("microsoft"));
  assert.ok(!keys.includes("slack"));
  assert.ok(!keys.includes("notion"));
});

contractTest("web.hermetic", "Tavily recommended defaults require approval for expansive work", () => {
  const tavily = getCoreAppDefinition("tavily");
  assert.ok(tavily);
  const byKey = new Map(
    tavily.capabilities.map((capability) => [capability.key, capability])
  );
  assert.equal(byKey.get("search")?.defaultApprovalMode, "auto");
  assert.equal(byKey.get("extract")?.defaultApprovalMode, "auto");
  assert.equal(byKey.get("crawl")?.defaultApprovalMode, "ask");
  assert.equal(byKey.get("map")?.defaultApprovalMode, "ask");
  assert.equal(byKey.get("research")?.defaultApprovalMode, "ask");
  assert.equal(byKey.get("usage")?.defaultEnabled, false);
  assert.equal(byKey.get("usage")?.defaultApprovalMode, "deny");
});

contractTest("web.hermetic", "Google Workspace is personal while built-ins are inherited", () => {
  const google = getCoreAppDefinition("google_workspace");
  const weather = getCoreAppDefinition("built_in.weather");
  assert.equal(google?.connectionModel, "personal");
  assert.equal(google?.connectionRequirement, "required");
  assert.equal(google?.installMode, "explicit");
  assert.equal(weather?.connectionModel, "environment");
  assert.equal(weather?.connectionRequirement, "optional");
  assert.deepEqual(weather?.authMethods, ["api_key"]);
  assert.equal(weather?.installMode, "inherited");
  assert.deepEqual(
    weather?.capabilities.map((capability) => [
      capability.key,
      capability.runtimeName,
    ]),
    [
      ["getWeather", "free.weather.current"],
      ["forecast", "free.weather.forecast"],
    ]
  );
});
