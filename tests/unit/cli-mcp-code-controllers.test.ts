import test from "node:test";
import assert from "node:assert/strict";

import { CodeModeController } from "../../cli/app/CodeModeController.js";
import { McpController, parseMcpRemoteFlags, summarizeMcpDetails } from "../../cli/app/McpController.js";
import type { TuiAppContext } from "../../cli/app/TuiAppContext.js";
import type { AppView, TuiProfile, TuiSessionMeta } from "../../cli/contracts.js";
import { buildInitialUiRuntimeState, UiStore } from "../../cli/ink/store/UiStore.js";
import { createUiDerivedSelectors } from "../../cli/ink/store/selectors.js";
import type { McpStatusSnapshot } from "../../src/index.js";

function createControllerHarness(): {
  context: TuiAppContext;
  uiStore: UiStore;
  historyLines: string[];
  persistedProfiles: TuiProfile[];
} {
  const activeProfile: TuiProfile = {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "ref",
  };
  const activeSession: TuiSessionMeta = {
    name: "default",
    sessionId: "session-1",
    profileId: activeProfile.id,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    started: true,
  };
  const uiStore = new UiStore(
    buildInitialUiRuntimeState({
      profile: activeProfile,
      activeSession,
      sessions: [activeSession],
      transcript: [],
    }),
  );
  const historyLines: string[] = [];
  const persistedProfiles: TuiProfile[] = [];
  const context = {
    options: { cwd: process.cwd() },
    profileStore: undefined,
    sessionStore: undefined,
    workspaceStore: undefined,
    historyStore: undefined,
    diagnosticsStore: undefined,
    uiStateStore: undefined,
    client: undefined,
    uiStore,
    selectors: createUiDerivedSelectors(),
    getRuntimeSettings: () => ({ version: 1, defaults: {} }),
    getSessionsFile: () => ({ version: 1, active: "default", sessions: [activeSession] }),
    setSessionsFile: () => undefined,
    getActiveWorkspace: () => undefined,
    setActiveWorkspace: () => undefined,
    getLaunchWorkspace: () => undefined,
    setLaunchWorkspace: () => undefined,
    appendHistoryLine: async (_role: "system" | "assistant" | "user", text: string) => {
      historyLines.push(text);
    },
    persistSessionAndUi: async () => undefined,
    persistUiState: async () => undefined,
    persistActiveProfile: async (profile: TuiProfile) => {
      persistedProfiles.push(profile);
      uiStore.patch({ activeProfile: profile });
    },
    setActiveSessionState: async () => undefined,
    navigateToView: (view: AppView) => {
      uiStore.patch({ activeView: view });
    },
    withMcpSummary: (statusLine: string) => statusLine,
    recordPersistenceFailure: () => undefined,
  } as unknown as TuiAppContext;

  return {
    context,
    uiStore,
    historyLines,
    persistedProfiles,
  };
}

const emptyMcpStatus: McpStatusSnapshot = {
  healthy: true,
  checkedAt: "2026-05-14T00:00:00.000Z",
  servers: [],
  tools: [],
};

test("CodeModeController enables and disables code.execute through profile persistence", async () => {
  const harness = createControllerHarness();
  const controller = new CodeModeController(harness.context);

  await controller.handleCodeCommand(["enable"]);
  assert.equal(harness.uiStore.getState().activeProfile.codeMode?.enabled, true);
  assert.equal(harness.uiStore.getState().activeProfile.toolAllowlist?.includes("code.execute"), true);
  assert.match(harness.historyLines.join("\n"), /code-mode enabled\./u);

  await controller.handleCodeCommand(["disable"]);
  assert.equal(harness.uiStore.getState().activeProfile.codeMode?.enabled, false);
  assert.equal(harness.uiStore.getState().activeProfile.toolAllowlist?.includes("code.execute"), false);
  assert.equal(harness.persistedProfiles.length, 2);
});

test("McpController adds remote servers with parsed auth and header env flags", async () => {
  const harness = createControllerHarness();
  const fetchCalls: boolean[] = [];
  const controller = new McpController({
    ...harness.context,
    fetchMcpStatus: async (refresh) => {
      fetchCalls.push(refresh);
      return emptyMcpStatus;
    },
  });

  await controller.handleMcpCommand([
    "add",
    "http",
    "docs",
    "https://mcp.example.test",
    "--auth-env",
    "DOCS_TOKEN",
    "--header-env",
    "X-Team=TEAM_TOKEN",
  ]);

  const profile = harness.uiStore.getState().activeProfile;
  assert.deepEqual(profile.mcpServers?.[0], {
    id: "docs",
    transport: "http",
    url: "https://mcp.example.test",
    authTokenEnv: "DOCS_TOKEN",
    headerEnvs: {
      "X-Team": "TEAM_TOKEN",
    },
  });
  assert.deepEqual(fetchCalls, [true]);
  assert.match(harness.historyLines.join("\n"), /Added MCP server 'docs' \(http\)\. no enabled servers/u);
});

test("MCP formatting helpers preserve status and flag copy", () => {
  assert.equal(
    summarizeMcpDetails({
      healthy: false,
      checkedAt: "2026-05-14T00:00:00.000Z",
      servers: [
        {
          serverId: "docs",
          transport: "http",
          healthy: false,
          connected: false,
          enabled: true,
          toolCount: 0,
          checkedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      tools: [],
    }),
    "0/1 healthy, tools=0, unhealthy=docs",
  );
  assert.deepEqual(parseMcpRemoteFlags(["--header-env", "BadValue"]), {
    ok: false,
    error: "Flag --header-env must be formatted as Name=ENV.",
  });
});
