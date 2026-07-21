import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDesktopCapabilityView,
  type DesktopCapabilityProbeResults,
} from "../../../src/desktopShell/capabilityRegistry.js";
import { LOCAL_CORE_CREDENTIAL_IDS } from "../../../src/localCore/credentialStore.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "../../../src/profile/runtimeProfile.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";

function credentials(configured: string[] = []) {
  return {
    backend: "macos_keychain" as const,
    available: true,
    credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
      id,
      configured: configured.includes(id),
    })),
  };
}

function probes(): DesktopCapabilityProbeResults {
  return {
    filesystemAccessible: false,
    shellAvailable: true,
    shellPath: "/bin/zsh",
    executablePath: "/usr/bin:/bin",
    languageRuntimes: [{ name: "node", available: true }],
    packageManagers: [{ name: "pnpm", available: true }],
    dockerInstalled: true,
    dockerDaemonReachable: false,
    dockerImages: [{ name: "node:20-alpine", available: false }],
    databaseReady: true,
    microphone: "not-determined" as const,
    mcpServers: [],
    localModelProviders: { ollama: false, lmstudio: false },
  };
}

test("Desktop capability registry exposes stable coverage and honest readiness", () => {
  const view = resolveDesktopCapabilityView({
    settings: createDefaultDesktopSettings(),
    credentials: credentials(),
    probes: probes(),
    now: new Date("2026-07-20T12:00:00.000Z"),
  });

  assert.equal(view.capabilities.length, 15);
  assert.equal(new Set(view.capabilities.map((capability) => capability.id)).size, 15);
  assert.equal(
    view.capabilities.find((capability) => capability.id === "model.openrouter")?.readiness,
    "setup_required",
  );
  assert.equal(
    view.capabilities.find((capability) => capability.id === "model.openai")?.readiness,
    "disabled",
  );
  assert.equal(
    view.capabilities.find((capability) => capability.id === "local.sandbox_code")?.readiness,
    "setup_required",
  );
  assert.equal(
    view.capabilities.find((capability) => capability.id === "tools.weather")?.readiness,
    "optional",
  );
  assert.equal(view.refreshedAt, "2026-07-20T12:00:00.000Z");
});

test("Desktop capability registry reports configured families without serializing secrets", () => {
  const secret = "credential-that-must-not-cross-the-boundary";
  const settings = {
    ...createDefaultDesktopSettings(),
    openrouterApiKey: secret,
    tavilyApiKey: secret,
  };
  const view = resolveDesktopCapabilityView({
    settings,
    credentials: credentials([
      "provider.openrouter.default",
      "tool.tavily.default",
      "tool.visual-crossing.default",
    ]),
    probes: probes(),
  });

  assert.equal(
    view.capabilities.find((capability) => capability.id === "model.openrouter")?.readiness,
    "ready",
  );
  assert.equal(
    view.capabilities.find((capability) => capability.id === "tools.internet.tavily")?.readiness,
    "ready",
  );
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(
    view.capabilities.flatMap((capability) => capability.settings).some(
      (field) => field.secret && field.value !== undefined,
    ),
    false,
  );
});

test("Desktop capability registry does not claim discovered MCP is active", () => {
  const nextProbes = probes();
  nextProbes.mcpServers = [{
    id: "example",
    name: "Example",
    transport: "stdio",
    command: "example-server",
    enabled: true,
    source: "discovered config",
    tools: [{ name: "example.tool" }],
  }];
  const view = resolveDesktopCapabilityView({
    settings: createDefaultDesktopSettings(),
    credentials: credentials(["provider.openrouter.default"]),
    probes: nextProbes,
  });
  const mcp = view.capabilities.find((capability) => capability.id === "connections.mcp");

  assert.equal(mcp?.readiness, "setup_required");
  assert.match(mcp?.detail ?? "", /available to import and verify/u);
});

test("Desktop capability registry reports only managed verified MCP as active", () => {
  const nextProbes = probes();
  nextProbes.mcpServers = [{
    id: "managed", name: "Managed", transport: "http", url: "https://mcp.example.test",
    enabled: true, source: "Kestrel Desktop", sourceKind: "desktop-managed",
    tools: [{ name: "lookup" }], toolCount: 1,
  }];
  const view = resolveDesktopCapabilityView({ settings: createDefaultDesktopSettings(), credentials: credentials(), probes: nextProbes });
  const mcp = view.capabilities.find((capability) => capability.id === "connections.mcp");
  assert.equal(mcp?.readiness, "ready");
  assert.deepEqual(mcp?.toolNames, ["lookup"]);
});

test("Desktop capability registry uses live local-model readiness and useful defaults", () => {
  const nextProbes = probes();
  nextProbes.localModelProviders.ollama = true;
  const view = resolveDesktopCapabilityView({
    settings: { ...createDefaultDesktopSettings(), selectedProvider: "ollama" },
    credentials: credentials(),
    probes: nextProbes,
  });
  const ollama = view.capabilities.find((capability) => capability.id === "model.ollama");

  assert.equal(ollama?.readiness, "ready");
  assert.match(ollama?.detail ?? "", /reachable.*available/u);
  assert.equal(
    ollama?.settings.find((field) => field.key === "model")?.value,
    DEFAULT_MODEL_BY_PROVIDER.ollama,
  );
});
