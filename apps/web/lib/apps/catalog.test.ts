import assert from "node:assert/strict";
import { KESTREL_APP_IDS } from "@kestrel-agents/protocol";
import { getCoreAppDefinition, listCoreAppDefinitions } from "./catalog";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Apps catalog exposes only implemented providers", () => {
  const keys = listCoreAppDefinitions().map((app) => app.key);
  assert.ok(keys.includes("google_workspace"));
  assert.ok(keys.includes("tavily"));
  assert.ok(keys.includes("linear"));
  assert.ok(keys.includes("atlassian"));
  assert.ok(keys.includes("notion"));
  assert.ok(keys.includes("slack"));
  assert.ok(keys.includes("vercel"));
  assert.ok(keys.includes("microsoft_365"));
  assert.ok(keys.includes("github"));
  assert.ok(keys.includes("built_in.weather"));
  assert.ok(keys.includes("built_in.time"));
  assert.ok(keys.includes("built_in.geocoding"));
  assert.ok(keys.includes("built_in.exchange_rates"));
  assert.ok(!keys.includes("built_in.hacker_news"));
  assert.ok(!keys.includes("discord"));
  assert.ok(!keys.includes("source.github"));
  assert.ok(!keys.includes("source.youtube"));
  assert.ok(!keys.includes("exa"));
  assert.ok(!keys.includes("microsoft"));
});

contractTest("web.hermetic", "Vercel is an operational App with governed delivery reads", () => {
  const vercel = getCoreAppDefinition(KESTREL_APP_IDS.VERCEL);
  assert.ok(vercel);
  assert.equal(vercel.delivery, "api_key");
  assert.equal(vercel.connectionModel, "environment");
  assert.deepEqual(
    vercel.capabilities.map((capability) => capability.key),
    ["projects.read", "deployments.read", "operations.read"]
  );
});

contractTest("web.hermetic", "Email exposes its organization configuration surface", () => {
  const email = getCoreAppDefinition("email");
  assert.ok(email);
  assert.equal(email.connectionModel, "organization");
  assert.equal(email.configurationPath, "/settings/organization/email");
  assert.equal(email.metadata.configurationPath, "/settings/organization/email");
});

contractTest("web.hermetic", "Atlassian is a standard App with Jira and Confluence packs", () => {
  const atlassian = getCoreAppDefinition(KESTREL_APP_IDS.ATLASSIAN);
  assert.ok(atlassian);
  assert.equal(atlassian.connectionModel, "environment");
  assert.equal(atlassian.connectionRequirement, "required");
  assert.equal(atlassian.installMode, "explicit");
  assert.deepEqual(
    atlassian.metadata.capabilityPacks,
    [
      {
        key: "jira",
        name: "Jira",
        description: "Find, create, and update work items and projects.",
      },
      {
        key: "confluence",
        name: "Confluence",
        description: "Find, create, and update shared knowledge.",
      },
    ],
  );
});

contractTest("web.hermetic", "Slack is one App with selectable search and message permissions", () => {
  const slack = getCoreAppDefinition(KESTREL_APP_IDS.SLACK);
  assert.ok(slack);
  assert.equal(slack.connectionModel, "environment");
  assert.equal(slack.connectionRequirement, "required");
  assert.deepEqual(slack.authMethods, ["oauth_environment"]);
  assert.equal(slack.installMode, "explicit");
  assert.deepEqual(
    (slack.metadata.connectionCapabilityPacks as Array<{ key: string }>).map(
      (pack) => pack.key
    ),
    ["search", "messages"]
  );
});

contractTest("web.hermetic", "Notion is one connectable App with workspace capability packs", () => {
  const notion = getCoreAppDefinition(KESTREL_APP_IDS.NOTION);
  assert.ok(notion);
  assert.equal(notion.connectionModel, "environment");
  assert.equal(notion.connectionRequirement, "required");
  assert.deepEqual(notion.authMethods, ["oauth_environment"]);
  assert.equal(notion.installMode, "explicit");
  assert.deepEqual(
    (notion.metadata.capabilityPacks as Array<{ key: string }>).map(
      (pack) => pack.key
    ),
    ["search", "pages", "databases"]
  );
});

contractTest("web.hermetic", "Kestrel One uses canonical shared App identities", () => {
  const oneAppKeys = new Set(listCoreAppDefinitions().map((app) => app.key));
  assert.ok(oneAppKeys.has(KESTREL_APP_IDS.WEATHER));
  assert.ok(oneAppKeys.has(KESTREL_APP_IDS.GITHUB));
  assert.ok(oneAppKeys.has(KESTREL_APP_IDS.GOOGLE_WORKSPACE));
  assert.ok(oneAppKeys.has(KESTREL_APP_IDS.MICROSOFT_365));
});

contractTest("web.hermetic", "workflow Apps are installable Apps with explicit dependency contracts", () => {
  const workflows = [
    KESTREL_APP_IDS.SOFTWARE_DELIVERY,
    KESTREL_APP_IDS.MEETING_FOLLOW_THROUGH,
    KESTREL_APP_IDS.INCIDENT_RESPONSE,
    KESTREL_APP_IDS.CUSTOMER_ESCALATION,
  ].map((appKey) => getCoreAppDefinition(appKey));
  assert.ok(workflows.every(Boolean));
  for (const workflow of workflows) {
    assert.equal(workflow?.category, "workflow");
    assert.equal(workflow?.connectionModel, "none");
    assert.equal(workflow?.connectionRequirement, "none");
    assert.equal(workflow?.installMode, "explicit");
    assert.ok(Array.isArray(workflow?.metadata.dependencies));
    assert.ok((workflow?.metadata.dependencies as unknown[]).length > 0);
    assert.equal(workflow?.capabilities.length, 1);
    assert.equal(workflow?.capabilities[0]?.runtimeName, null);
  }
});

contractTest("web.hermetic", "Microsoft 365 is one App with three capability packs", () => {
  const microsoft = getCoreAppDefinition(KESTREL_APP_IDS.MICROSOFT_365);
  assert.ok(microsoft);
  assert.deepEqual(
    [...new Set(microsoft.capabilities.map((capability) => capability.groupKey))],
    ["outlook", "teams", "sharepoint"]
  );
  assert.equal(microsoft.connectionModel, "personal");
  assert.equal(microsoft.installMode, "explicit");
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
