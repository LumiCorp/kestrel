import assert from "node:assert/strict";

import {
  appendDesktopModelConfigurationRevision,
  assertDesktopModelConfigurationHistoryPreserved,
  createDesktopModelConfiguration,
  DESKTOP_DEFAULT_ENABLED_APP_IDS,
  DESKTOP_WEATHER_APP_ID,
  listDesktopAppDefinitions,
  getDesktopAppDefinition,
  getDesktopStandardAppConnection,
  formatDesktopWorkflowInstructions,
  parseDesktopExecutionSelection,
  parseDesktopModelConfigurations,
  resolveDesktopModelConfiguration,
  resolveDesktopWorkflowSelections,
} from "../../../src/desktopShell/configuration.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest(
  "desktop.hermetic",
  "desktop model configurations retain immutable revisions",
  () => {
    const initial = createDesktopModelConfiguration(
      {
        version: 1,
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        modelByStage: {},
        modelCapabilities: { visionInputEnabled: false },
      },
      {
        id: "primary",
        name: "Primary",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    );
    const next = appendDesktopModelConfigurationRevision(
      initial,
      {
        ...initial.revisions[0]!.policy,
        provider: "openai",
        model: "gpt-5.4",
      },
      "2026-07-20T01:00:00.000Z",
    );

    assert.equal(initial.currentRevision, 1);
    assert.equal(next.currentRevision, 2);
    assert.equal(next.revisions[0]!.policy.provider, "openrouter");
    assert.equal(next.revisions[1]!.policy.provider, "openai");
    assert.equal(
      resolveDesktopModelConfiguration([next], { id: "primary", revision: 1 })
        ?.revision.policy.provider,
      "openrouter",
    );
    assert.deepEqual(parseDesktopModelConfigurations([next]), [next]);
  },
);

contractTest(
  "desktop.hermetic",
  "Desktop presents shipped services through canonical Apps",
  () => {
    const apps = new Map(
      listDesktopAppDefinitions().map((app) => [app.id, app]),
    );
    assert.deepEqual(
      [...DESKTOP_DEFAULT_ENABLED_APP_IDS],
      [
        "built_in.weather",
        "built_in.time",
        "built_in.geocoding",
        "built_in.exchange_rates",
      ],
    );
    assert.deepEqual(apps.get("built_in.time")?.toolNames, [
      "free.time.current",
    ]);
    assert.deepEqual(apps.get("built_in.geocoding")?.toolNames, [
      "free.geocode.lookup",
    ]);
    assert.deepEqual(apps.get("built_in.exchange_rates")?.toolNames, [
      "free.exchange.rate",
    ]);
    assert.ok(apps.get("tavily")?.toolNames.includes("internet.search"));
    assert.ok(apps.get("tavily")?.toolNames.includes("internet.research"));
    assert.deepEqual(apps.get("workflow.software_delivery")?.toolNames, []);
    assert.equal(
      getDesktopStandardAppConnection("linear")?.url,
      "https://mcp.linear.app/mcp",
    );
    assert.deepEqual(getDesktopStandardAppConnection("github"), {
      appId: "github",
      kind: "token",
      url: "https://api.githubcopilot.com/mcp/",
      credentialLabel: "GitHub personal access token",
      credentialPlaceholder: "Paste a fine-grained GitHub token",
    });
    assert.equal(
      getDesktopStandardAppConnection("atlassian")?.credentialLabel,
      "Atlassian service account API key",
    );
    assert.deepEqual(getDesktopStandardAppConnection("notion"), {
      appId: "notion",
      kind: "authorization",
      url: "https://mcp.notion.com/mcp",
      credentialPrefix: "mcp.standard.notion",
    });
    assert.deepEqual(getDesktopStandardAppConnection("slack"), {
      appId: "slack",
      kind: "authorization",
      url: "https://mcp.slack.com/mcp",
      credentialPrefix: "mcp.standard.slack",
      clientIdEnvironmentVariable: "KESTREL_SLACK_MCP_CLIENT_ID",
      capabilityPackScopes: {
        search: [
          "search:read.public",
          "search:read.private",
          "search:read.mpim",
          "search:read.im",
          "search:read.files",
          "search:read.users",
          "files:read",
          "channels:history",
          "groups:history",
          "mpim:history",
          "im:history",
          "channels:read",
          "groups:read",
          "mpim:read",
        ],
        messages: ["chat:write"],
      },
    });
    const vercel = getDesktopStandardAppConnection("vercel");
    assert.equal(vercel?.kind, "authorization");
    assert.equal(vercel?.url, "https://mcp.vercel.com");
    if (vercel?.kind !== "authorization") return;
    assert.deepEqual(Object.keys(vercel.capabilityPackScopes ?? {}), [
      "projects",
      "deployments",
      "operations",
    ]);
    assert.deepEqual(vercel.capabilityPackTools?.projects, [
      "search_documentation",
      "list_teams",
      "list_projects",
      "get_project",
    ]);
  },
);

contractTest(
  "desktop.hermetic",
  "Desktop Workflow Apps require selected executable dependency Apps",
  () => {
    const connections = [
      {
        id: "github",
        appId: "github",
        name: "GitHub",
        enabled: true,
        capabilityPacks: ["repositories"],
        tools: [{ name: "pull_request_read" }],
      },
      {
        id: "linear",
        appId: "linear",
        name: "Linear",
        enabled: true,
        capabilityPacks: ["issues"],
        tools: [{ name: "create_issue" }],
      },
      {
        id: "vercel",
        appId: "vercel",
        name: "Vercel",
        enabled: true,
        capabilityPacks: ["deployments"],
        tools: [{ name: "list_deployments" }],
      },
    ];
    const selection = {
      modelConfiguration: { id: "primary", revision: 1 },
      apps: [
        { id: "workflow.software_delivery", contractVersion: 1 },
        { id: "github", contractVersion: 1 },
        { id: "linear", contractVersion: 1 },
        { id: "vercel", contractVersion: 1 },
      ],
    };
    const [workflow] = resolveDesktopWorkflowSelections(selection, connections);

    assert.equal(workflow?.ready, true);
    assert.deepEqual(
      workflow?.dependencies.map((dependency) => dependency.role),
      ["Source control", "Work tracking", "Deployment"],
    );
    assert.match(
      formatDesktopWorkflowInstructions([workflow!]) ?? "",
      /do not grant additional access/iu,
    );

    const [missingDeployment] = resolveDesktopWorkflowSelections(
      {
        ...selection,
        apps: selection.apps.filter((app) => app.id !== "vercel"),
      },
      connections,
    );
    assert.equal(missingDeployment?.ready, false);
    assert.deepEqual(
      missingDeployment?.dependencies
        .filter((dependency) => dependency.missing)
        .map((dependency) => dependency.role),
      ["Deployment"],
    );

    const [disconnectedWorkTracker] = resolveDesktopWorkflowSelections(
      selection,
      connections.filter((connection) => connection.appId !== "linear"),
    );
    assert.equal(disconnectedWorkTracker?.ready, false);
    assert.deepEqual(
      disconnectedWorkTracker?.dependencies
        .filter((dependency) => dependency.missing)
        .map((dependency) => dependency.role),
      ["Work tracking"],
    );

    const [wrongDeploymentPack] = resolveDesktopWorkflowSelections(
      selection,
      connections.map((connection) =>
        connection.appId === "vercel"
          ? { ...connection, capabilityPacks: ["projects"] }
          : connection,
      ),
    );
    assert.equal(wrongDeploymentPack?.ready, false);
    assert.deepEqual(
      wrongDeploymentPack?.dependencies
        .filter((dependency) => dependency.missing)
        .map((dependency) => dependency.role),
      ["Deployment"],
    );
  },
);

contractTest(
  "desktop.hermetic",
  "connected standard services retain canonical App identity",
  () => {
    const apps = listDesktopAppDefinitions([
      {
        id: "standard.linear",
        appId: "linear",
        name: "Internal connection label",
        enabled: true,
        tools: [{ name: "create_issue", description: "Create an issue." }],
      },
    ]);
    const linear = apps.find((app) => app.id === "linear");
    assert.deepEqual(linear, {
      id: "linear",
      contractVersion: 1,
      label: "Linear",
      description: "Plan, track, and update product and engineering work.",
      toolNames: ["mcp.standard.linear.create_issue"],
    });
    assert.equal(
      apps.some((app) => app.id === "custom.standard.linear"),
      false,
    );
  },
);

contractTest(
  "desktop.hermetic",
  "desktop execution selections reject duplicate apps and preserve explicit contracts",
  () => {
    assert.throws(
      () =>
        parseDesktopExecutionSelection({
          modelConfiguration: { id: "primary", revision: 1 },
          apps: [
            { id: "weather", contractVersion: 1 },
            { id: DESKTOP_WEATHER_APP_ID, contractVersion: 1 },
          ],
        }),
      /duplicated/u,
    );

    assert.deepEqual(
      parseDesktopExecutionSelection({
        modelConfiguration: { id: "primary", revision: 2 },
        apps: [{ id: "weather", contractVersion: 1 }],
      }),
      {
        modelConfiguration: { id: "primary", revision: 2 },
        apps: [{ id: DESKTOP_WEATHER_APP_ID, contractVersion: 1 }],
      },
    );
    assert.deepEqual(
      getDesktopAppDefinition(DESKTOP_WEATHER_APP_ID, 1)?.toolNames,
      ["free.weather.current", "free.weather.forecast"],
    );
    assert.equal(getDesktopAppDefinition(DESKTOP_WEATHER_APP_ID, 2), undefined);
  },
);

contractTest(
  "desktop.hermetic",
  "desktop model configuration updates preserve pinned revision history",
  () => {
    const initial = createDesktopModelConfiguration(
      {
        version: 1,
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        modelByStage: {},
        modelCapabilities: { visionInputEnabled: false },
      },
      { id: "primary", name: "Primary" },
    );
    const appended = appendDesktopModelConfigurationRevision(initial, {
      ...initial.revisions[0]!.policy,
      model: "openai/gpt-5.4",
    });

    assert.doesNotThrow(() =>
      assertDesktopModelConfigurationHistoryPreserved(
        [initial],
        [{ ...appended, name: "Primary model" }],
      ),
    );
    assert.throws(
      () =>
        assertDesktopModelConfigurationHistoryPreserved(
          [initial],
          [
            {
              ...initial,
              revisions: [
                {
                  ...initial.revisions[0]!,
                  policy: {
                    ...initial.revisions[0]!.policy,
                    model: "rewritten-model",
                  },
                },
              ],
            },
          ],
        ),
      /revision 1 is immutable/u,
    );
    assert.throws(
      () => assertDesktopModelConfigurationHistoryPreserved([initial], []),
      /cannot be removed/u,
    );
  },
);
