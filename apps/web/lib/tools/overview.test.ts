import assert from "node:assert/strict";
import { buildToolsOverview } from "./overview";
import type { ResolvedToolProvider } from "./types";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


function makeProvider(
  overrides: Partial<ResolvedToolProvider>
): ResolvedToolProvider {
  return {
    key: "provider.test",
    displayName: "Test Provider",
    description: "Test provider",
    type: "built_in",
    authType: "system",
    enabled: true,
    settings: {},
    connection: {
      authSource: "system",
      status: "connected",
      isReady: true,
      label: "System",
      lastError: null,
      metadata: {},
    },
    capabilities: [],
    counts: {
      total: 0,
      enabled: 0,
      available: 0,
    },
    ...overrides,
  };
}

contractTest("web.hermetic", "tool overview builds provider and capability scan summaries", () => {
  const overview = buildToolsOverview([
    makeProvider({
      key: "built_in.weather",
      displayName: "Weather",
      capabilities: [
        {
          key: "getWeather",
          runtimeName: "getWeather",
          displayName: "Get Weather",
          description: "Weather tool",
          accessMode: "read",
          defaultPolicy: {
            enabled: true,
            approvalMode: "auto",
            surfaceAccess: { chat: true, admin: false },
            rateLimitMode: "default",
            loggingMode: "full",
            settings: {},
          },
          policy: {
            enabled: true,
            approvalMode: "auto",
            surfaceAccess: { chat: true, admin: false },
            rateLimitMode: "default",
            loggingMode: "full",
            settings: {},
          },
          isAvailable: true,
        },
      ],
      counts: {
        total: 1,
        enabled: 1,
        available: 1,
      },
    }),
    makeProvider({
      key: "built_in.knowledge_search",
      displayName: "Knowledge Search",
      connection: {
        authSource: "system",
        status: "degraded",
        isReady: false,
        label: "Upload documents",
        lastError: null,
        metadata: {},
      },
      capabilities: [
        {
          key: "searchKnowledgeDocuments",
          runtimeName: "searchKnowledgeDocuments",
          displayName: "Search Knowledge Documents",
          description: "Knowledge tool",
          accessMode: "read",
          defaultPolicy: {
            enabled: true,
            approvalMode: "auto",
            surfaceAccess: { chat: true, admin: false },
            rateLimitMode: "default",
            loggingMode: "metadata_only",
            settings: {},
          },
          policy: {
            enabled: true,
            approvalMode: "auto",
            surfaceAccess: { chat: true, admin: false },
            rateLimitMode: "default",
            loggingMode: "metadata_only",
            settings: {},
          },
          isAvailable: false,
        },
      ],
      counts: {
        total: 1,
        enabled: 1,
        available: 0,
      },
    }),
  ]);

  assert.equal(overview.summary.providers.total, 2);
  assert.equal(overview.summary.providers.available, 1);
  assert.equal(overview.summary.providers.setupRequired, 1);
  assert.equal(overview.summary.capabilities.total, 2);
  assert.equal(overview.summary.capabilities.available, 1);
  assert.equal(overview.summary.capabilities.setupRequired, 1);
  assert.equal(overview.providerRows[1]?.status, "setup_required");
  assert.equal(overview.capabilityRows[1]?.status, "setup_required");
});

contractTest("web.hermetic", "capability-free custom providers can still show as available", () => {
  const overview = buildToolsOverview([
    makeProvider({
      key: "custom.status",
      displayName: "Status App",
      type: "custom_imported",
      capabilities: [],
      counts: {
        total: 0,
        enabled: 0,
        available: 0,
      },
      connection: {
        authSource: "env",
        status: "env_backed",
        isReady: true,
        label: "Env-backed",
        lastError: null,
        metadata: {},
      },
    }),
  ]);

  assert.equal(overview.summary.providers.available, 1);
  assert.equal(overview.providerRows[0]?.status, "available");
});
