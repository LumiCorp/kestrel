import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopMcpServerConfig } from "../../../src/desktopShell/contracts.js";
import { buildExaMcpMutationInput } from "../renderer/src/ToolServicesSettings.js";

const rendererDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src",
);

test("Desktop Tools and services uses a cardless guided connector surface", async () => {
  const [appsSource, settingsSource, toolServicesSource] = await Promise.all([
    readFile(path.join(rendererDirectory, "McpWorkspace.tsx"), "utf8"),
    readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8"),
    readFile(path.join(rendererDirectory, "ToolServicesSettings.tsx"), "utf8"),
  ]);

  assert.match(appsSource, /<ToolServicesSettings/u);
  assert.doesNotMatch(settingsSource, /<ToolServicesSettings/u);
  assert.doesNotMatch(toolServicesSource, /capability-card/u);
  assert.match(toolServicesSource, /name="Tavily"/u);
  assert.match(toolServicesSource, /name="Exa"/u);
  assert.match(toolServicesSource, /<SetupStep number=\{1\}/u);
  assert.match(toolServicesSource, /<SetupStep number=\{2\}/u);
  assert.match(toolServicesSource, /<SetupStep number=\{3\}/u);
});

test("Desktop Apps routes Tavily through its standard App detail", async () => {
  const appsSource = await readFile(path.join(rendererDirectory, "McpWorkspace.tsx"), "utf8");

  assert.match(appsSource, /selectedStandardApp\?\.id === "tavily"/u);
  assert.match(appsSource, /<section[\s\S]*aria-label="App details"/u);
});

test("guided recovery requests select and focus the requested connector", async () => {
  const toolServicesSource = await readFile(path.join(rendererDirectory, "ToolServicesSettings.tsx"), "utf8");

  assert.match(toolServicesSource, /navigationRequest\.requestId !== handledNavigationRequestRef\.current/u);
  assert.match(toolServicesSource, /selectedConnectorRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
});

test("the prebuilt Exa connector uses the official credential-free hosted MCP endpoint", () => {
  const input = buildExaMcpMutationInput();

  assert.equal(input.id, "prebuilt.exa");
  assert.equal(input.transport, "http");
  assert.equal(input.url, "https://mcp.exa.ai/mcp");
  assert.equal(input.enabled, true);
  assert.equal(input.credentials, undefined);
});

test("reconnecting Exa preserves its explicit tool policies", () => {
  const server: DesktopMcpServerConfig = {
    id: "prebuilt.exa",
    name: "Exa",
    transport: "http",
    url: "https://mcp.exa.ai/mcp",
    enabled: false,
    source: "Kestrel Desktop",
    sourceKind: "desktop-managed",
    tools: [{
      name: "web_search_exa",
      approvalMode: "auto",
      allowedInteractionModes: ["plan", "build"],
    }],
  };

  assert.deepEqual(buildExaMcpMutationInput(server).toolPolicies, {
    web_search_exa: {
      approvalMode: "auto",
      allowedInteractionModes: ["plan", "build"],
    },
  });
});
