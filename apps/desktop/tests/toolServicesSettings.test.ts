import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopMcpServerConfig } from "../../../src/desktopShell/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { buildExaMcpMutationInput } from "../renderer/src/ToolServicesSettings.js";

const rendererDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src",
);

contractTest("desktop.hermetic", "Desktop Tools and services uses a cardless guided connector surface", async () => {
  const [settingsSource, toolServicesSource] = await Promise.all([
    readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8"),
    readFile(path.join(rendererDirectory, "ToolServicesSettings.tsx"), "utf8"),
  ]);

  assert.match(settingsSource, /category === "tools_services"[\s\S]*<ToolServicesSettings/u);
  assert.doesNotMatch(toolServicesSource, /capability-card/u);
  assert.match(toolServicesSource, /name="Tavily"/u);
  assert.match(toolServicesSource, /name="Exa"/u);
  assert.match(toolServicesSource, /<SetupStep number=\{1\}/u);
  assert.match(toolServicesSource, /<SetupStep number=\{2\}/u);
  assert.match(toolServicesSource, /<SetupStep number=\{3\}/u);
});

contractTest("desktop.hermetic", "the prebuilt Exa connector uses the official credential-free hosted MCP endpoint", () => {
  const input = buildExaMcpMutationInput();

  assert.equal(input.id, "prebuilt.exa");
  assert.equal(input.transport, "http");
  assert.equal(input.url, "https://mcp.exa.ai/mcp");
  assert.equal(input.enabled, true);
  assert.equal(input.credentials, undefined);
});

contractTest("desktop.hermetic", "reconnecting Exa preserves its explicit tool policies", () => {
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
