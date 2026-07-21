import assert from "node:assert/strict";
import { mkdir as fsMkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpStatusSnapshot, ToolRunContext } from "../../src/index.js";
import { RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type {
  InternetExtractOutput,
  InternetFetchResult,
  InternetProviderCallResult,
  InternetSearchResultItem,
  TavilyInternetProvider,
} from "../../tools/internet/contracts.js";
import {
  type McpToolProvider,
  UnifiedToolRegistry,
} from "../../tools/runtime/UnifiedToolRegistry.js";
import { isAgentToolResult } from "../../tools/toolResult.js";
import { contractTest } from "../helpers/contract-test.js";


class MockMcpProvider implements McpToolProvider {
  private readonly snapshot: McpStatusSnapshot;
  calls: Array<{ name: string; input: unknown }> = [];
  refreshCalls = 0;
  assertHealthyCalls = 0;

  constructor(snapshot: McpStatusSnapshot) {
    this.snapshot = snapshot;
  }

  async refresh(): Promise<McpStatusSnapshot> {
    this.refreshCalls += 1;
    return this.snapshot;
  }

  async assertHealthy(): Promise<void> {
    this.assertHealthyCalls += 1;
  }

  async callTool<T>(namespacedToolName: string, input: unknown): Promise<T> {
    this.calls.push({
      name: namespacedToolName,
      input,
    });
    return {
      ok: true,
      tool: namespacedToolName,
    } as T;
  }

  async close(): Promise<void> {}
}

class MockInternetProvider implements TavilyInternetProvider {
  searchCalls: unknown[] = [];
  searchAdvancedCalls: unknown[] = [];
  newsCalls: unknown[] = [];
  extractCalls: unknown[] = [];
  crawlCalls: unknown[] = [];
  mapCalls: unknown[] = [];

  async search(
    input: Parameters<TavilyInternetProvider["search"]>[0]
  ): Promise<
    InternetProviderCallResult<{
      query: string;
      results: InternetSearchResultItem[];
    }>
  > {
    this.searchCalls.push(input);
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { query: input.query, results: [] },
    };
  }

  async searchAdvanced(
    input: Parameters<TavilyInternetProvider["searchAdvanced"]>[0]
  ): Promise<
    InternetProviderCallResult<{
      query: string;
      results: InternetSearchResultItem[];
    }>
  > {
    this.searchAdvancedCalls.push(input);
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { query: input.query, results: [] },
    };
  }

  async news(
    input: Parameters<TavilyInternetProvider["news"]>[0]
  ): Promise<
    InternetProviderCallResult<{
      query: string;
      results: InternetSearchResultItem[];
    }>
  > {
    this.newsCalls.push(input);
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { query: input.query, results: [] },
    };
  }

  async images(
    input: Parameters<TavilyInternetProvider["images"]>[0]
  ): Promise<InternetProviderCallResult<{ query: string; results: [] }>> {
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { query: input.query, results: [] },
    };
  }

  async extract(
    input: Parameters<TavilyInternetProvider["extract"]>[0]
  ): Promise<InternetProviderCallResult<InternetExtractOutput>> {
    this.extractCalls.push(input);
    const url = input.urls[0] ?? "https://example.com";
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: {
        results: [
          {
            url,
            content: "ok",
            contentType: "text/plain",
            charCount: 2,
          },
        ],
        failedResults: [],
      },
    };
  }

  async crawl(
    input: Parameters<TavilyInternetProvider["crawl"]>[0]
  ): Promise<
    InternetProviderCallResult<{
      baseUrl: string;
      results: InternetFetchResult[];
    }>
  > {
    this.crawlCalls.push(input);
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { baseUrl: input.url, results: [] },
    };
  }

  async map(
    input: Parameters<TavilyInternetProvider["map"]>[0]
  ): Promise<
    InternetProviderCallResult<{ baseUrl: string; results: string[] }>
  > {
    this.mapCalls.push(input);
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { baseUrl: input.url, results: [] },
    };
  }

  async research(
    input: Parameters<TavilyInternetProvider["research"]>[0]
  ): Promise<
    InternetProviderCallResult<{
      requestId: string;
      status: string;
      input?: string;
    }>
  > {
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { requestId: "req", status: "completed", input: input.input },
    };
  }

  async researchStatus(
    input: Parameters<TavilyInternetProvider["researchStatus"]>[0]
  ): Promise<
    InternetProviderCallResult<{ requestId: string; status: string }>
  > {
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { requestId: input.requestId, status: "completed" },
    };
  }

  async usage(): Promise<InternetProviderCallResult<Record<string, never>>> {
    return { status: "ok", provider: "tavily", attempts: 1, data: {} };
  }
}

function createToolRunContext(input: {
  runId: string;
  sessionId: string;
  payload?: Record<string, unknown> | undefined;
  sessionState?: Record<string, unknown> | undefined;
}): ToolRunContext {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    payload: input.payload ?? {},
    sessionState: input.sessionState ?? {},
  };
}

async function assertToolInputInvalid(
  action: () => Promise<unknown>,
  expected: {
    field: string;
    expected?: string;
    invalidValues: unknown[];
  }
): Promise<void> {
  let failure:
    | RuntimeFailure
    | { code?: unknown; details?: unknown }
    | undefined;
  try {
    const result = await action();
    if (isAgentToolResult(result) && result.status === "FAILED") {
      failure = result.auditRecord.error as {
        code?: unknown;
        details?: unknown;
      };
    }
  } catch (error) {
    assert.equal(error instanceof RuntimeFailure, true);
    failure = error as RuntimeFailure;
  }
  assert.notEqual(
    failure,
    undefined,
    "expected invalid tool input to throw or return a FAILED tool result"
  );
  const details = failure?.details as Record<string, unknown> | undefined;
  assert.equal(failure?.code, "TOOL_INPUT_INVALID");
  assert.equal(details?.classification, "schema");
  assert.equal(details?.recoverable, true);
  assert.equal(details?.field, expected.field);
  if (expected.expected !== undefined) {
    assert.equal(details?.expected, expected.expected);
  }
  assert.deepEqual(details?.invalidValues, expected.invalidValues);
}

contractTest("runtime.hermetic", "UnifiedToolRegistry includes allowlisted MCP tools in model specs and capability manifest", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [
      {
        serverId: "remote",
        transport: "http",
        healthy: true,
        connected: true,
        enabled: true,
        toolCount: 1,
        checkedAt: new Date().toISOString(),
      },
    ],
    tools: [
      {
        serverId: "remote",
        toolName: "lookup",
        namespacedToolName: "mcp.remote.lookup",
        description: "Lookup via MCP",
        inputSchema: {
          type: "object",
        },
        presentation: {
          displayName: "Remote lookup",
          aliases: ["lookup", "mcp.remote.lookup"],
          keywords: ["lookup", "remote", "search"],
          provider: "remote",
          toolFamily: "mcp_lookup",
          capabilityClasses: ["remote_lookup"],
        },
      },
    ],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: ["FinalizeAnswer", "mcp.remote.lookup"],
    context: {
      onFinalize: (payload) => payload,
    },
    mcpManager: mcp,
  });

  await registry.refresh();

  const tools = registry.getModelTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "mcp.remote.lookup");

  const manifest = registry.getCapabilityManifest();
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0]?.name, "mcp.remote.lookup");
  assert.equal(manifest[0]?.freshnessClass, "volatile");
  assert.equal(manifest[0]?.displayName, "Remote lookup");
  assert.deepEqual(manifest[0]?.aliases?.includes("mcp.remote.lookup"), true);
  assert.equal(manifest[0]?.provider, "remote");

  const status = registry.getMcpStatus();
  assert.equal(status.tools[0]?.allowlisted, true);

  const result = await registry.call("mcp.remote.lookup", {
    q: "hello",
  });
  assert.equal((result.auditRecord.output as { ok?: boolean }).ok, true);
  assert.equal(mcp.calls.length, 1);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry blocks non-allowlisted MCP tools", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "remote",
        toolName: "lookup",
        namespacedToolName: "mcp.remote.lookup",
        description: "Lookup via MCP",
        inputSchema: {},
        presentation: {
          displayName: "Remote lookup",
          aliases: ["lookup", "mcp.remote.lookup"],
          keywords: ["lookup", "remote"],
          provider: "remote",
          toolFamily: "mcp_lookup",
          capabilityClasses: ["remote_lookup"],
        },
      },
    ],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: [],
    mcpManager: mcp,
  });
  await registry.refresh();

  await assert.rejects(
    () => registry.call("mcp.remote.lookup", {}),
    /not allowlisted/
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry hides MCP tools without explicit presentation metadata", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "remote",
        toolName: "lookup",
        namespacedToolName: "mcp.remote.lookup",
        description: "Lookup via MCP",
        inputSchema: {},
      },
    ],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: ["mcp.remote.lookup"],
    mcpManager: mcp,
  });
  await registry.refresh();

  assert.deepEqual(registry.getModelTools(), []);
  assert.deepEqual(registry.getCapabilityManifest(), []);
  assert.deepEqual(
    registry.resolveAvailableAllowlist(["mcp.remote.lookup"]),
    []
  );
  await assert.rejects(
    () => registry.call("mcp.remote.lookup", {}),
    /not available/
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry exposes Playwright MCP tools only through explicit metadata", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "playwright",
        toolName: "browser_snapshot",
        namespacedToolName: "mcp.playwright.browser_snapshot",
        description: "Capture browser DOM snapshot",
        inputSchema: {},
        presentation: {
          displayName: "Browser snapshot",
          aliases: ["browser_snapshot", "mcp.playwright.browser_snapshot"],
          keywords: ["browser", "dom", "snapshot"],
          provider: "playwright",
          toolFamily: "browser_automation",
          capabilityClasses: ["browser.automation"],
        },
      },
      {
        serverId: "playwright",
        toolName: "browser_magic_unlisted",
        namespacedToolName: "mcp.playwright.browser_magic_unlisted",
        description: "Unlisted browser tool",
        inputSchema: {},
      },
    ],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: [
      "mcp.playwright.browser_snapshot",
      "mcp.playwright.browser_magic_unlisted",
    ],
    mcpManager: mcp,
  });
  await registry.refresh();

  assert.deepEqual(
    registry.getModelTools().map((tool) => tool.name),
    ["mcp.playwright.browser_snapshot"]
  );
  assert.deepEqual(
    registry.getCapabilityManifest().map((tool) => ({
      name: tool.name,
      capabilityClasses: tool.capabilityClasses,
      provider: tool.provider,
      toolFamily: tool.toolFamily,
    })),
    [
      {
        name: "mcp.playwright.browser_snapshot",
        capabilityClasses: ["browser.automation"],
        provider: "playwright",
        toolFamily: "browser_automation",
      },
    ]
  );
  assert.deepEqual(
    registry.resolveAvailableAllowlist([
      "mcp.playwright.browser_snapshot",
      "mcp.playwright.browser_magic_unlisted",
    ]),
    ["mcp.playwright.browser_snapshot"]
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry exposes tool-runtime lifecycle hooks", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: [],
    mcpManager: mcp,
  });

  await registry.preRun({
    runId: "run-1",
    event: {
      id: "evt-1",
      type: "user.message",
      sessionId: "session-1",
      payload: {},
    },
    session: {
      sessionId: "session-1",
      version: 0,
      state: {},
      currentStepAgent: "react.deliberate",
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(mcp.refreshCalls, 1);
  assert.equal(mcp.assertHealthyCalls, 0);

  const runtimeStatus = await registry.getRuntimeStatus();
  assert.equal(runtimeStatus.providers.mcp !== undefined, true);

  await registry.refreshRuntime();
  assert.equal(mcp.refreshCalls, 2);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry does not advertise internet domain filters to the model", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.news", "internet.search"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  for (const toolName of ["internet.news", "internet.search"]) {
    const tool = registry
      .getModelTools()
      .find((candidate) => candidate.name === toolName);
    assert.notEqual(tool, undefined);
    const properties =
      (tool?.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {};
    assert.equal(Object.hasOwn(properties, "domainAllow"), false);
    assert.equal(Object.hasOwn(properties, "domainDeny"), false);
    if (toolName === "internet.news") {
      assert.equal(Object.hasOwn(properties, "region"), false);
    }
  }
});

contractTest("runtime.hermetic", "UnifiedToolRegistry turns Project App ask policy into a runtime approval gate", () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search", "internet.crawl"],
    context: {
      kestrelOne: {
        appApprovalModes: {
          "internet.search": "auto",
          "internet.crawl": "ask",
        },
      },
    },
  });
  const manifest = new Map(
    registry
      .getCapabilityManifest()
      .map((capability) => [capability.name, capability])
  );
  assert.deepEqual(
    manifest.get("internet.search")?.approvalCapabilities,
    undefined
  );
  assert.deepEqual(manifest.get("internet.crawl")?.approvalCapabilities, [
    "external.confirm",
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry routes a direct Environment App through scoped execution authorization", async () => {
  let requestUrl = "";
  let authorization = "";
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.usage"],
    context: {
      kestrelOne: {
        appUrl: "https://kestrel.example",
        appApprovalModes: { "internet.usage": "auto" },
      },
      fetchImpl: (async (url, init) => {
        requestUrl = String(url);
        authorization = String(
          (init?.headers as Record<string, string> | undefined)?.Authorization
        );
        return new Response(JSON.stringify({ key: { usage: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refreshForRuntimeTurn({
    runId: "run-environment-app",
    sessionId: "session-environment-app",
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  await registry.call(
    "internet.usage",
    {},
    {
      runContext: createToolRunContext({
        runId: "run-environment-app",
        sessionId: "session-environment-app",
      }),
    }
  );

  assert.equal(
    requestUrl,
    "https://kestrel.example/api/runtime/apps/tavily/usage/auto/usage"
  );
  assert.equal(authorization, "Bearer signed-run-ticket");
  registry.clearRuntimeTurnAuthorization("run-environment-app");
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips unadvertised internet.news domain filters before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.news"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.news", {
    query:
      "Georgia Florida wildfires current updates homes evacuations damage May 2026",
    domainDeny: ["opinion", "video"],
  });
  assert.deepEqual(internetProvider.newsCalls, [
    {
      query:
        "Georgia Florida wildfires current updates homes evacuations damage May 2026",
      limit: 8,
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips unadvertised internet.search domain filters before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.search", {
    query: "Ada Lovelace",
    domainAllow: ["wikipedia.org"],
    domainDeny: ["news"],
  });
  assert.deepEqual(internetProvider.searchCalls, [
    {
      query: "Ada Lovelace",
      limit: 8,
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects invalid internet.search_advanced domains before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.search_advanced", {
        query: "Georgia Florida wildfires current updates",
        domainDeny: ["opinion", "video"],
      }),
    {
      field: "domainDeny",
      expected: "hostnames only, without schemes, paths, or content categories",
      invalidValues: ["opinion", "video"],
    }
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects invalid internet.search_advanced country before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.search_advanced", {
        query:
          "Procter & Gamble latest earnings performance news 2026 investor relations",
        country: "United States",
      }),
    {
      field: "country",
      expected: "one of Tavily's supported lowercase country names",
      invalidValues: ["United States"],
    }
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips internet.search_advanced country outside general topic", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.search_advanced", {
    query:
      "Procter & Gamble latest earnings performance news 2026 investor relations",
    topic: "news",
    country: "india",
  });
  assert.deepEqual(internetProvider.searchAdvancedCalls, [
    {
      query:
        "Procter & Gamble latest earnings performance news 2026 investor relations",
      limit: 8,
      topic: "news",
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips internet.search_advanced freshness and days when explicit dates are present", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    freshness: "year",
    days: 7,
    startDate: "2026-01-01",
    endDate: "2026-05-15",
  });
  assert.deepEqual(internetProvider.searchAdvancedCalls, [
    {
      query: "TCS latest revenue and headcount",
      limit: 8,
      startDate: "2026-01-01",
      endDate: "2026-05-15",
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects invalid internet.search_advanced explicit dates before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.search_advanced", {
        query: "TCS latest revenue and headcount",
        startDate: "2026-02-31",
      }),
    {
      field: "startDate",
      expected: "a YYYY-MM-DD date",
      invalidValues: ["2026-02-31"],
    }
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects internet.search_advanced explicit date ranges with the same start and end day before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.search_advanced", {
        query: "current U.S. business and technology news",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      }),
    {
      field: "startDate",
      expected: "endDate must be a different YYYY-MM-DD date than startDate",
      invalidValues: ["2026-06-01", "2026-06-01"],
    }
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects internet.search_advanced exactMatch queries without a quoted phrase before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.search_advanced", {
        query: "current U.S. business and technology news",
        exactMatch: true,
      }),
    {
      field: "query",
      expected:
        "a query containing at least one double-quoted phrase when exactMatch is true",
      invalidValues: ["current U.S. business and technology news"],
    }
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips Tavily-conditional internet.search_advanced fields without prerequisites", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    topic: "general",
    searchDepth: "basic",
    chunksPerSource: 3,
    days: 7,
  });
  assert.deepEqual(internetProvider.searchAdvancedCalls, [
    {
      query: "TCS latest revenue and headcount",
      limit: 8,
      topic: "general",
      searchDepth: "basic",
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips extract and crawl chunksPerSource without Tavily prerequisites", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.extract", "internet.crawl"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.extract", {
    url: "https://example.com/page",
    chunksPerSource: 5,
  });
  await registry.call("internet.crawl", {
    url: "https://example.com",
    chunksPerSource: 5,
  });
  assert.deepEqual(internetProvider.extractCalls, [
    {
      urls: ["https://example.com/page"],
      maxChars: 12_000,
    },
  ]);
  assert.deepEqual(internetProvider.crawlCalls, [
    {
      url: "https://example.com",
      maxChars: 12_000,
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry passes valid internet.search_advanced domains to provider", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search_advanced"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.search_advanced", {
    query: "Ada Lovelace",
    country: "united states",
    domainAllow: ["wikipedia.org"],
    domainDeny: ["example.com"],
  });
  assert.deepEqual(internetProvider.searchAdvancedCalls, [
    {
      query: "Ada Lovelace",
      limit: 8,
      country: "united states",
      domainAllow: ["wikipedia.org"],
      domainDeny: ["example.com"],
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects invalid built-in internet URLs before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.extract"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.extract", {
        url: "/relative/path",
      }),
    {
      field: "url",
      invalidValues: ["/relative/path"],
    }
  );
  await assertToolInputInvalid(
    () =>
      registry.call("internet.extract", {
        url: "ftp://example.com/article",
      }),
    {
      field: "url",
      invalidValues: ["ftp://example.com/article"],
    }
  );
  assert.equal(internetProvider.extractCalls.length, 0);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects local built-in internet URLs before provider calls", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.extract", "internet.crawl", "internet.map"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.call("internet.extract", {
        url: "http://127.0.0.1:8000/index.html",
      }),
    {
      field: "url",
      expected: "public absolute http or https URLs",
      invalidValues: ["http://127.0.0.1:8000/index.html"],
    }
  );
  await assertToolInputInvalid(
    () =>
      registry.call("internet.crawl", {
        url: "http://localhost:3000",
      }),
    {
      field: "url",
      expected: "a public absolute http or https URL",
      invalidValues: ["http://localhost:3000"],
    }
  );
  await assertToolInputInvalid(
    () =>
      registry.call("internet.map", {
        url: "http://192.168.1.10",
      }),
    {
      field: "url",
      expected: "a public absolute http or https URL",
      invalidValues: ["http://192.168.1.10"],
    }
  );
  assert.equal(internetProvider.extractCalls.length, 0);
  assert.equal(internetProvider.crawlCalls.length, 0);
  assert.equal(internetProvider.mapCalls.length, 0);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry reports built-in schema bound failures as recoverable tool input errors", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.extract"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await assertToolInputInvalid(
    () =>
      registry.validateInput("internet.extract", {
        url: "https://example.com/article",
        maxChars: 100,
      }),
    {
      field: "maxChars",
      expected: "value >= 500",
      invalidValues: [100],
    }
  );
  assert.equal(internetProvider.extractCalls.length, 0);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry accepts valid built-in internet URLs", async () => {
  const internetProvider = new MockInternetProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.extract"],
    context: { internetProvider },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  await registry.call("internet.extract", {
    url: "https://example.com/article",
  });
  await registry.call("internet.extract", {
    url: "http://example.com/article",
  });

  assert.deepEqual(internetProvider.extractCalls, [
    {
      urls: ["https://example.com/article"],
      maxChars: 12_000,
    },
    {
      urls: ["http://example.com/article"],
      maxChars: 12_000,
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry applies only advertised schemas to MCP tools", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "remote",
        toolName: "news",
        namespacedToolName: "mcp.remote.news",
        description: "Remote news lookup",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            domainDeny: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        presentation: {
          displayName: "Remote news",
          aliases: ["remote news"],
          keywords: ["news"],
          provider: "remote",
          toolFamily: "mcp_news",
          capabilityClasses: ["news.search"],
        },
      },
    ],
  });
  const registry = new UnifiedToolRegistry({
    allowlist: ["mcp.remote.news"],
    mcpManager: mcp,
  });
  await registry.refresh();

  await registry.call("mcp.remote.news", {
    domainDeny: ["opinion", "video"],
  });

  assert.deepEqual(mcp.calls, [
    {
      name: "mcp.remote.news",
      input: {
        domainDeny: ["opinion", "video"],
      },
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry preserves MCP schema failure codes for dynamic tools", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "remote",
        toolName: "counter",
        namespacedToolName: "mcp.remote.counter",
        description: "Remote counter",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["count"],
          properties: {
            count: {
              type: "number",
              minimum: 5,
            },
          },
        },
        presentation: {
          displayName: "Remote counter",
          aliases: ["remote counter"],
          keywords: ["counter"],
          provider: "remote",
          toolFamily: "mcp_counter",
          capabilityClasses: ["counter"],
        },
      },
    ],
  });
  const registry = new UnifiedToolRegistry({
    allowlist: ["mcp.remote.counter"],
    mcpManager: mcp,
  });
  await registry.refresh();

  await assert.rejects(
    () =>
      registry.validateInput("mcp.remote.counter", {
        count: 1,
      }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_SCHEMA_FAILED");
      assert.notEqual(failure.code, "TOOL_INPUT_INVALID");
      return true;
    }
  );
  assert.equal(mcp.calls.length, 0);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry preRun does not fail on unhealthy optional MCP servers", async () => {
  const mcp = new MockMcpProvider({
    healthy: false,
    checkedAt: new Date().toISOString(),
    servers: [
      {
        serverId: "docker-gw",
        transport: "stdio",
        healthy: false,
        connected: false,
        enabled: true,
        toolCount: 0,
        checkedAt: new Date().toISOString(),
        error: "spawn docker ENOENT",
      },
    ],
    tools: [],
  });

  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.search"],
    mcpManager: mcp,
  });

  await registry.preRun({
    runId: "run-unhealthy-mcp",
    event: {
      id: "evt-unhealthy-mcp",
      type: "user.message",
      sessionId: "session-unhealthy-mcp",
      payload: {},
    },
    session: {
      sessionId: "session-unhealthy-mcp",
      version: 0,
      state: {},
      currentStepAgent: "react.deliberate",
      updatedAt: new Date().toISOString(),
    },
  });

  const runtimeStatus = await registry.getRuntimeStatus();
  assert.equal(runtimeStatus.providers.mcp !== undefined, true);
  const mcpStatus = runtimeStatus.providers.mcp as McpStatusSnapshot;
  assert.equal(mcpStatus.healthy, false);
  assert.equal(mcp.assertHealthyCalls, 0);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry hides code.execute when profile code-mode is disabled", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["code.execute"],
    context: {
      codeMode: {
        enabled: false,
        languages: ["javascript", "python", "bash"],
        sandbox: {
          executor: "docker",
          timeoutMs: 20_000,
          memoryMb: 256,
          cpuShares: 256,
          networkDefault: "off",
          allowDependencyInstall: false,
          maxOutputBytes: 32_000,
          maxArtifacts: 20,
          maxArtifactBytes: 64_000,
        },
        retention: {
          persistSummary: true,
          persistArtifacts: true,
        },
        approvalMode: "auto",
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  assert.deepEqual(registry.getModelTools(), []);
  assert.deepEqual(registry.getCapabilityManifest(), []);
  await assert.rejects(
    () => registry.call("code.execute", {}),
    /disabled for this profile/
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry gates dev.shell tools by devShell profile config", async () => {
  const disabledRegistry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: false,
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await disabledRegistry.refresh();
  assert.deepEqual(disabledRegistry.getModelTools(), []);
  assert.deepEqual(disabledRegistry.getCapabilityManifest(), []);
  await assert.rejects(
    () =>
      disabledRegistry.call("dev.shell.run", {
        command: "echo ok",
        workspaceRoot: ".",
      }),
    /disabled for this profile/
  );

  const enabledRegistry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await enabledRegistry.refresh();
  assert.deepEqual(
    enabledRegistry.getModelTools().map((tool) => tool.name),
    ["dev.shell.run"]
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry enables managed dev-shell mode from trusted agent session binding", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-1",
        sessionId: "session-1",
        payload: {
          workspace: {
            managedWorktree: true,
            workspaceRoot: "/spoofed",
          },
        },
      }),
    }
  );

  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-2",
        sessionId: "session-1",
        payload: {
          workspace: {
            managedWorktree: true,
            workspaceRoot: "/trusted-worktree",
            leaseId: "lease-1",
          },
        },
        sessionState: {
          agent: {
            exec: {
              managedWorktreeBinding: {
                status: "bound",
                sessionId: "session-1",
                runId: "run-2",
                worktreeRoot: "/trusted-worktree",
                leaseId: "lease-1",
              },
            },
          },
        },
      }),
    }
  );

  assert.deepEqual(execInputs[0]?.sourceWriteGuard, { enabled: true });
  assert.deepEqual(execInputs[1]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
    approvalGrants: [],
  });
  assert.equal(execInputs[0]?.sourceWriteAuthority, undefined);
  assert.equal(execInputs[1]?.sourceWriteAuthority, "source_write");
});

contractTest("runtime.hermetic", "UnifiedToolRegistry scopes pnpm build approval preflight to Build-mode dev-shell calls", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  await registry.call(
    "dev.shell.run",
    { command: "pnpm lint", workspaceRoot: "/workspace" },
    {
      runContext: createToolRunContext({
        runId: "run-build",
        sessionId: "session-1",
        payload: {
          interactionMode: "build",
          workspace: {
            workspaceRoot: "/workspace",
            managedWorktreeRequired: false,
          },
        },
      }),
    }
  );

  await registry.call(
    "dev.shell.run",
    { command: "pnpm lint", workspaceRoot: "/workspace" },
    {
      runContext: createToolRunContext({
        runId: "run-plan",
        sessionId: "session-1",
        payload: {
          interactionMode: "plan",
          workspace: {
            workspaceRoot: "/workspace",
          },
        },
      }),
    }
  );

  assert.deepEqual(execInputs[0]?.packageManagerPreflight, {
    pnpmApproveBuilds: "approve_all",
  });
  assert.equal(execInputs[1]?.packageManagerPreflight, undefined);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry rejects managed dev-shell mode when trusted binding does not match the session or workspace", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  const state = {
    agent: {
      exec: {
        managedWorktreeBinding: {
          status: "bound",
          sessionId: "session-1",
          worktreeRoot: "/trusted-worktree",
        },
      },
    },
  };

  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-workspace-mismatch",
        sessionId: "session-1",
        payload: {
          workspace: {
            managedWorktree: true,
            workspaceRoot: "/other-worktree",
          },
        },
        sessionState: state,
      }),
    }
  );

  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-session-mismatch",
        sessionId: "session-2",
        payload: {
          workspace: {
            managedWorktree: true,
            workspaceRoot: "/trusted-worktree",
          },
        },
        sessionState: state,
      }),
    }
  );

  assert.deepEqual(execInputs[0]?.sourceWriteGuard, { enabled: true });
  assert.deepEqual(execInputs[1]?.sourceWriteGuard, { enabled: true });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry does not grant direct source writes for explicit managed worktree contracts before binding", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-workspace-authority",
        sessionId: "session-1",
        payload: {
          workspace: {
            workspaceRoot: "/workspace",
            managedWorktreeRequired: true,
            workspaceAuthority: {
              mode: "draft_workspace",
              label: "Draft workspace",
              source: "runtime_mode",
            },
          },
        },
      }),
    }
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, undefined);
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
  });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry carries source-write authority and write roots for default source workspaces", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-source-workspace-authority",
        sessionId: "session-1",
        payload: {
          workspace: {
            workspaceRoot: "/workspace",
            managedWorktreeRequired: false,
            workspaceAuthority: {
              mode: "draft_workspace",
              label: "Source workspace",
              source: "runtime_mode",
            },
          },
        },
      }),
    }
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    allowedWriteRoots: ["/workspace"],
    approvalGrants: [],
  });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry ignores descriptive workspace authority without an explicit source-workspace contract", async () => {
  const execInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["dev.shell.run"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          execInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
      } as never,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();
  await registry.call(
    "dev.shell.run",
    { command: "echo ok", workspaceRoot: "." },
    {
      runContext: createToolRunContext({
        runId: "run-descriptive-authority",
        sessionId: "session-1",
        payload: {
          workspace: {
            workspaceRoot: "/workspace",
            workspaceAuthority: {
              mode: "draft_workspace",
              label: "Draft workspace",
              source: "runtime_mode",
            },
          },
        },
      }),
    }
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, undefined);
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, { enabled: true });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry exposes allowlisted filesystem tools and can call them with default policy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-unified-fs-"));
  const filePath = path.join(tempDir, "note.txt");
  await writeFile(filePath, "registry file", "utf8");

  const registry = new UnifiedToolRegistry({
    allowlist: ["fs.read_text", "fs.write_text"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  const tools = registry.getModelTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["fs.read_text", "fs.write_text"]
  );

  const manifest = registry.getCapabilityManifest();
  assert.deepEqual(
    manifest.map((item) => ({
      name: item.name,
      executionClass: item.executionClass,
    })),
    [
      { name: "fs.read_text", executionClass: "read_only" },
      { name: "fs.write_text", executionClass: "sandboxed_only" },
    ]
  );

  const result = await registry.call("fs.read_text", {
    path: filePath,
  });
  assert.equal(
    (result.auditRecord.output as { content?: string }).content,
    "registry file"
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry exposes allowlisted repo.trace as read-only workspace inspection", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-unified-repo-trace-")
  );
  await fsMkdir(path.join(tempDir, "src"), { recursive: true });
  await writeFile(
    path.join(tempDir, "src", "main.ts"),
    "export const value = 'TRACE_TOKEN';\n",
    "utf8"
  );

  const registry = new UnifiedToolRegistry({
    allowlist: ["repo.trace"],
    context: {
      fileSystem: {
        workspaceRoot: tempDir,
        tempRoots: [os.tmpdir()],
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  const tools = registry.getModelTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["repo.trace"]
  );

  const manifest = registry.getCapabilityManifest();
  assert.deepEqual(
    manifest.map((item) => ({
      name: item.name,
      executionClass: item.executionClass,
      capabilityClasses: item.capabilityClasses,
    })),
    [
      {
        name: "repo.trace",
        executionClass: "read_only",
        capabilityClasses: ["fs.read", "repo.trace"],
      },
    ]
  );

  const result = await registry.call("repo.trace", {
    seeds: ["TRACE_TOKEN"],
  });
  const output = result.auditRecord.output as {
    resultCount?: number;
    groups?: Array<{ path: string }>;
  };
  assert.equal(output.resultCount, 1);
  assert.deepEqual(
    output.groups?.map((group) => group.path),
    ["src/main.ts"]
  );
  assert.match(result.modelContext.text, /Tool result: repo\.trace/u);
  assert.match(result.modelContext.text, /resultCount: 1/u);
  assert.match(result.modelContext.text, /src\/main\.ts/u);
  assert.match(result.modelContext.text, /TRACE_TOKEN/u);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry strips unsupported fields for strict schemas before validation", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["free.time.current"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  const normalized = await registry.validateInput("free.time.current", {
    timezone: "Etc/UTC",
    unexpected: true,
  });

  assert.deepEqual(normalized, {
    timezone: "Etc/UTC",
  });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry validates internet.research after canonicalizing topic aliases", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.research"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  const normalized = await registry.validateInput("internet.research", {
    query: "Cults of Cincinnati, OH",
    maxSources: "6",
    includeNews: "false",
    includeImages: "true",
    region: "global",
  });

  assert.deepEqual(normalized, {
    input: "Cults of Cincinnati, OH",
    query: "Cults of Cincinnati, OH",
  });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry validates evidence.extract after canonicalizing content aliases", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["evidence.extract"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  const normalized = await registry.validateInput("evidence.extract", {
    content: "Deterministic validation reduced approval rework by 18 percent.",
    source: "benchmark-1",
    limit: "2",
    unexpected: true,
  });

  assert.deepEqual(normalized, {
    text: "Deterministic validation reduced approval rework by 18 percent.",
    sourceId: "benchmark-1",
    maxItems: 2,
  });
});

contractTest("runtime.hermetic", "UnifiedToolRegistry scopes allowlists per run context", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["fs.read_text", "mcp.remote.lookup"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [
        {
          serverId: "remote",
          toolName: "lookup",
          namespacedToolName: "mcp.remote.lookup",
          description: "Lookup via MCP",
          inputSchema: { type: "object" },
          presentation: {
            displayName: "Remote lookup",
            aliases: ["lookup", "mcp.remote.lookup"],
            keywords: ["lookup", "remote"],
            provider: "remote",
            toolFamily: "mcp_lookup",
            capabilityClasses: ["remote_lookup"],
          },
        },
      ],
    }),
  });
  await registry.refresh();

  const runWithAllowlist = async (toolAllowlist: string[]) =>
    registry
      .getModelTools({
        runContext: createToolRunContext({
          runId: `run-${toolAllowlist.join("-")}`,
          sessionId: `session-${toolAllowlist.join("-")}`,
          payload: {
            orchestration: {
              runtimeAssembly: {
                toolAllowlist,
              },
            },
          },
        }),
      })
      .map((tool) => tool.name);

  const [filesystemOnly, mcpOnly] = await Promise.all([
    runWithAllowlist(["fs.read_text"]),
    runWithAllowlist(["mcp.remote.lookup"]),
  ]);

  assert.deepEqual(filesystemOnly, ["fs.read_text"]);
  assert.deepEqual(mcpOnly, ["mcp.remote.lookup"]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry preserves runtime built-ins when pruning unavailable tools", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: [
      "internet.search",
      "FinalizeAnswer",
      "effect_result_lookup",
      "delegate.spawn_child",
    ],
    context: {
      onFinalize: (payload) => payload,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  const resolved = registry.resolveAvailableAllowlist([
    "internet.search",
    "FinalizeAnswer",
    "effect_result_lookup",
    "delegate.spawn_child",
    "mcp.remote.lookup",
  ]);

  assert.deepEqual(resolved, [
    "internet.search",
    "FinalizeAnswer",
    "effect_result_lookup",
    "delegate.spawn_child",
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry exposes agent.spawn as the model-facing runtime spawn tool", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn", "delegate.spawn_child", "FinalizeAnswer"],
    context: {
      onFinalize: (payload) => payload,
      delegationService: {
        async spawnTask() {
          throw new Error(
            "spawnTask should not be called by model tool listing"
          );
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  assert.deepEqual(
    registry.getModelTools().map((tool) => tool.name),
    ["agent.spawn"]
  );
});

contractTest("runtime.hermetic", "UnifiedToolRegistry blocks internal delegate runtime tools even when allowlisted", async () => {
  const now = new Date().toISOString();
  const registry = new UnifiedToolRegistry({
    allowlist: [
      "agent.spawn",
      "delegate.spawn_child",
      "delegate.list_children",
      "delegate.get_child_result",
    ],
    context: {
      delegationService: {
        async spawnTask(input) {
          return {
            taskId: "task-child",
            parentSessionId: input.parentSessionId,
            title: input.title,
            status: "PENDING",
            childSessionId: "child-session",
            childSessionName: "Child Session",
            profileId: "default",
            provider: "openrouter",
            model: "model",
            createdAt: now,
            updatedAt: now,
          };
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: now,
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  assert.deepEqual(
    registry.getModelTools().map((tool) => tool.name),
    ["agent.spawn"]
  );
  await assert.rejects(
    () =>
      registry.call("delegate.spawn_child", {
        title: "Legacy child",
        prompt: "Do the legacy thing",
        parentSessionId: "session-parent",
      }),
    /internal-only runtime tool/
  );
  await assert.rejects(
    () =>
      registry.validateInput("delegate.list_children", {
        parentSessionId: "session-parent",
      }),
    /internal-only runtime tool/
  );

  const result = await registry.call(
    "agent.spawn",
    {
      task: "Spawn through the supported boundary",
    },
    {
      runContext: createToolRunContext({
        runId: "run-parent",
        sessionId: "session-parent",
        payload: {
          orchestration: {
            threadId: "thread-parent",
            activeTaskId: "task-parent",
            runtimeAssembly: {
              toolAllowlist: ["agent.spawn"],
            },
          },
        },
      }),
    }
  );
  assert.equal(
    (result.auditRecord.output as { taskId?: string }).taskId,
    "task-child"
  );
});

contractTest("runtime.hermetic", "agent.spawn accepts only a task string", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn"],
    context: {
      delegationService: {
        async spawnTask() {
          throw new Error("spawnTask should not be called by validation");
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  assert.deepEqual(
    await registry.validateInput("agent.spawn", {
      task: "Investigate failing tests",
    }),
    {
      task: "Investigate failing tests",
    }
  );
  await assert.rejects(
    () =>
      registry.validateInput("agent.spawn", {
        task: "Investigate failing tests",
        parentSessionId: "session-1",
      }),
    /parentSessionId/
  );
});

contractTest("runtime.hermetic", "agent.spawn delegates using the active runtime context", async () => {
  const requests: unknown[] = [];
  const now = new Date().toISOString();
  const registry = new UnifiedToolRegistry({
    allowlist: ["agent.spawn"],
    context: {
      delegationService: {
        async spawnTask(input) {
          requests.push(input);
          return {
            taskId: "task-child",
            parentSessionId: input.parentSessionId,
            ...(input.parentRunId !== undefined
              ? { parentRunId: input.parentRunId }
              : {}),
            title: input.title,
            status: "PENDING",
            childSessionId: "child-session",
            childSessionName: "Child Session",
            profileId: "default",
            provider: "openrouter",
            model: "model",
            createdAt: now,
            updatedAt: now,
          };
        },
        async listTasks() {
          return [];
        },
        async getTaskResult() {
          return null;
        },
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();
  const result = await registry.call(
    "agent.spawn",
    {
      task: "Investigate failing tests\nUse the unit output as the starting point.",
    },
    {
      runContext: createToolRunContext({
        runId: "run-parent",
        sessionId: "session-parent",
        payload: {
          orchestration: {
            threadId: "thread-parent",
            activeTaskId: "task-parent",
            delegationId: "delegation-parent",
            delegationDepth: 2,
            runtimeAssembly: {
              toolAllowlist: ["agent.spawn"],
            },
          },
        },
      }),
    }
  );

  assert.equal(
    (result.auditRecord.output as { taskId?: string }).taskId,
    "task-child"
  );
  assert.deepEqual(requests, [
    {
      parentSessionId: "thread-parent",
      parentRunId: "run-parent",
      title: "Investigate failing tests",
      prompt:
        "Investigate failing tests\nUse the unit output as the starting point.",
      launchedBy: "agent",
      taskId: "task-parent",
      parentTaskId: "task-parent",
      delegationDepth: 2,
      rootDelegationId: "delegation-parent",
    },
  ]);
});

contractTest("runtime.hermetic", "UnifiedToolRegistry scopes filesystem root per workspace payload", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-unified-workspace-fs-")
  );
  const workspaceA = path.join(baseDir, "workspace-a");
  const workspaceB = path.join(baseDir, "workspace-b");
  const tempRoot = path.join(baseDir, "temp-root");
  await fsMkdir(workspaceA, { recursive: true });
  await fsMkdir(workspaceB, { recursive: true });
  await fsMkdir(tempRoot, { recursive: true });
  await writeFile(path.join(baseDir, "outside.txt"), "outside", "utf8");
  await writeFile(path.join(workspaceA, "note.txt"), "workspace-a", "utf8");
  await writeFile(path.join(workspaceB, "note.txt"), "workspace-b", "utf8");

  const registry = new UnifiedToolRegistry({
    allowlist: ["fs.read_text"],
    context: {
      fileSystem: {
        workspaceRoot: workspaceA,
        tempRoots: [tempRoot],
      },
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  const readWithinWorkspace = async (workspaceRoot: string) =>
    registry.call(
      "fs.read_text",
      { path: "note.txt" },
      {
        runContext: createToolRunContext({
          runId: `run-${path.basename(workspaceRoot)}`,
          sessionId: `session-${path.basename(workspaceRoot)}`,
          payload: {
            workspace: {
              workspaceId: path.basename(workspaceRoot),
              workspaceRoot,
              appRoot: ".",
              commands: {},
            },
          },
        }),
      }
    );

  const [left, right] = await Promise.all([
    readWithinWorkspace(workspaceA),
    readWithinWorkspace(workspaceB),
  ]);

  assert.equal(
    (left.auditRecord.output as { content?: string }).content,
    "workspace-a"
  );
  assert.equal(
    (right.auditRecord.output as { content?: string }).content,
    "workspace-b"
  );
  await assert.rejects(async () => {
    await registry.call(
      "fs.read_text",
      { path: path.join(baseDir, "outside.txt") },
      {
        runContext: createToolRunContext({
          runId: "run-outside",
          sessionId: "session-outside",
          payload: {
            workspace: {
              workspaceId: "workspace-a",
              workspaceRoot: workspaceA,
              appRoot: ".",
              commands: {},
            },
          },
        }),
      }
    );
  }, /outside allowed roots/i);
});
