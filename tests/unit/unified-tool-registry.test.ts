import test from "node:test";
import assert from "node:assert/strict";
import { mkdir as fsMkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileStore } from "../../cli/config/ProfileStore.js";
import { DEFAULT_CODE_MODE_ENABLED_CONFIG } from "../../src/code/contracts.js";
import { composeKestrelOneProfile } from "../../src/profile/kestrelOnePolicy.js";
import type { McpStatusSnapshot, ToolRunContext } from "../../src/index.js";
import {
  RunCancelledError,
  RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import { validateWorkspaceSkillPackage } from "../../src/skills/index.js";
import { SensitiveValueRegistry } from "../../src/security/ExecutionBoundaryPolicy.js";
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
import {
  executeTestToolCall,
  prepareTestToolCall,
} from "../helpers/createTestToolGateway.js";

async function callTool(
  registry: UnifiedToolRegistry,
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: Parameters<typeof executeTestToolCall>[0]["options"],
) {
  return executeTestToolCall({
    gateway: registry,
    toolName,
    toolInput,
    options,
  });
}

function unsignedExecutionTicket(expiresAt: number, nonce: string) {
  return [
    "header",
    Buffer.from(JSON.stringify({ expiresAt, nonce }), "utf8").toString(
      "base64url",
    ),
    "signature",
  ].join(".");
}

async function validateToolInput(
  registry: UnifiedToolRegistry,
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: Parameters<typeof prepareTestToolCall>[0]["options"],
) {
  return (
    await prepareTestToolCall({
      gateway: registry,
      toolName,
      toolInput,
      options,
    })
  ).effectiveInput;
}

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

  pinTool(namespacedToolName: string) {
    let references = 1;
    return {
      call: <T>(input: unknown) => this.callTool<T>(namespacedToolName, input),
      retain: () => {
        assert.ok(references > 0);
        references += 1;
      },
      release: async () => {
        if (references > 0) references -= 1;
      },
    };
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

  async search(input: Parameters<TavilyInternetProvider["search"]>[0]): Promise<
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
    input: Parameters<TavilyInternetProvider["searchAdvanced"]>[0],
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

  async news(input: Parameters<TavilyInternetProvider["news"]>[0]): Promise<
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
    input: Parameters<TavilyInternetProvider["images"]>[0],
  ): Promise<InternetProviderCallResult<{ query: string; results: [] }>> {
    return {
      status: "ok",
      provider: "tavily",
      attempts: 1,
      data: { query: input.query, results: [] },
    };
  }

  async extract(
    input: Parameters<TavilyInternetProvider["extract"]>[0],
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

  async crawl(input: Parameters<TavilyInternetProvider["crawl"]>[0]): Promise<
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
    input: Parameters<TavilyInternetProvider["map"]>[0],
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
    input: Parameters<TavilyInternetProvider["research"]>[0],
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
    input: Parameters<TavilyInternetProvider["researchStatus"]>[0],
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
  },
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
    "expected invalid tool input to throw or return a FAILED tool result",
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

test("UnifiedToolRegistry includes allowlisted MCP tools in model specs and capability manifest", async () => {
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
          properties: {
            q: { type: "string" },
          },
          required: ["q"],
          additionalProperties: false,
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

  const result = await callTool(registry, "mcp.remote.lookup", {
    q: "hello",
  });
  assert.equal((result.auditRecord.output as { ok?: boolean }).ok, true);
  assert.equal(mcp.calls.length, 1);
});

test("UnifiedToolRegistry blocks non-allowlisted MCP tools", async () => {
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
    () => callTool(registry, "mcp.remote.lookup", {}),
    /not available/,
  );
});

test("UnifiedToolRegistry hides MCP tools without explicit presentation metadata", async () => {
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
    [],
  );
  await assert.rejects(
    () => callTool(registry, "mcp.remote.lookup", {}),
    /not available/,
  );
});

test("UnifiedToolRegistry exposes Playwright MCP tools only through explicit metadata", async () => {
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
    ["mcp.playwright.browser_snapshot"],
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
    ],
  );
  assert.deepEqual(
    registry.resolveAvailableAllowlist([
      "mcp.playwright.browser_snapshot",
      "mcp.playwright.browser_magic_unlisted",
    ]),
    ["mcp.playwright.browser_snapshot"],
  );
});

test("UnifiedToolRegistry exposes tool-runtime lifecycle hooks", async () => {
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

test("UnifiedToolRegistry does not advertise internet domain filters to the model", async () => {
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

test("UnifiedToolRegistry turns Project App ask policy into a runtime approval gate", () => {
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
      .map((capability) => [capability.name, capability]),
  );
  assert.deepEqual(
    manifest.get("internet.search")?.approvalCapabilities,
    undefined,
  );
  assert.deepEqual(manifest.get("internet.crawl")?.approvalCapabilities, [
    "external.confirm",
  ]);
});

test("UnifiedToolRegistry lets explicit Automatic App policy override a tool default", () => {
  const toolName = "kestrel_one.google_calendar_create_event";
  const registry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: {
      kestrelOne: {
        appApprovalModes: { [toolName]: "auto" },
      },
    },
  });
  const capability = registry
    .getCapabilityManifest()
    .find((candidate) => candidate.name === toolName);

  assert.deepEqual(capability?.approvalCapabilities, ["network.call"]);
  assert.equal(capability?.approvalDisposition?.mode, "auto");
  assert.equal(
    capability?.approvalDisposition?.reasonCode,
    "environment_policy",
  );
  assert.equal(capability?.approvalAuthority?.kind, "hosted_app_policy");
});

test("UnifiedToolRegistry applies a capability minimum after hosted App policy", () => {
  const toolName = "kestrel_one.email_send";
  const registry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: {
      kestrelOne: { appApprovalModes: { [toolName]: "auto" } },
    },
  });
  const capability = registry
    .getCapabilityManifest()
    .find((candidate) => candidate.name === toolName);
  assert.equal(capability?.minimumApprovalMode, "ask");
  assert.equal(capability?.approvalDisposition?.mode, "ask");
  assert.equal(capability?.approvalDisposition?.reasonCode, "tool_minimum");
  assert.equal(capability?.approvalAuthority?.kind, "hosted_app_policy");
});

test("UnifiedToolRegistry preserves hosted App policy provenance", () => {
  const toolName = "internet.crawl";
  const registry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: {
      kestrelOne: {
        appApprovalModes: { [toolName]: "ask" },
        appApprovalPolicies: {
          [toolName]: {
            environment: "auto",
            project: "auto",
            subject: "ask",
            minimum: "auto",
          },
        },
      },
    },
  });
  const capability = registry
    .getCapabilityManifest()
    .find((candidate) => candidate.name === toolName);
  assert.equal(capability?.approvalDisposition?.mode, "ask");
  assert.equal(
    capability?.approvalDisposition?.reasonCode,
    "subject_restriction",
  );
  assert.equal(capability?.approvalAuthority?.kind, "hosted_app_policy");
});

test("UnifiedToolRegistry applies exact remembered thread evidence to eligible Ask First", () => {
  const toolName = "internet.search";
  const runContext = createToolRunContext({
    runId: "run-remembered-1",
    sessionId: "session-remembered-1",
    payload: {
      hostedApprovalAuthority: {
        organizationId: "org-1",
        environmentId: "environment-1",
        projectId: "project-1",
        threadId: "thread-1",
      },
      actor: {
        actorType: "end_user",
        actorId: "user-1",
        tenantId: "org-1",
      },
    },
  });
  const policy = {
    appApprovalModes: { [toolName]: "ask" as const },
    appApprovalPolicies: {
      [toolName]: {
        environment: "ask" as const,
        minimum: "auto" as const,
      },
    },
  };
  const baselineRegistry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: { kestrelOne: policy },
  });
  const baseline = baselineRegistry
    .getCapabilityManifest({ runContext })
    .find((candidate) => candidate.name === toolName);
  assert.notEqual(baseline?.descriptorRef, undefined);
  assert.notEqual(baseline?.approvalAuthority, undefined);
  const toolIdentity = {
    version: "stable_tool_approval_identity_v1" as const,
    toolId: toolName,
    descriptorContractRevision: baseline!.descriptorRef!.contractRevision,
    approvalAuthorityRevision: baseline!.approvalAuthority!.revision,
  };
  const evidence = {
    version: "remembered_tool_approval_evidence_v1" as const,
    organizationId: "org-1",
    environmentId: "environment-1",
    projectId: "project-1",
    threadId: "thread-1",
    actorUserId: "user-1",
    toolIdentity,
    sourceInteractionId: "interaction-1",
  };
  const rememberedRegistry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: {
      kestrelOne: {
        ...policy,
        rememberedToolApprovalEvidence: [evidence],
      },
    },
  });
  const remembered = rememberedRegistry
    .getCapabilityManifest({ runContext })
    .find((candidate) => candidate.name === toolName);
  assert.equal(remembered?.approvalDisposition?.mode, "auto");
  assert.equal(
    remembered?.approvalDisposition?.reasonCode,
    "remembered_thread",
  );
  assert.deepEqual(remembered?.approvalCapabilities, undefined);

  for (const mismatchedEvidence of [
    { ...evidence, threadId: "thread-2" },
    { ...evidence, actorUserId: "user-2" },
    { ...evidence, projectId: "project-2" },
    { ...evidence, environmentId: "environment-2" },
    {
      ...evidence,
      toolIdentity: { ...toolIdentity, toolId: "internet.crawl" },
    },
    {
      ...evidence,
      toolIdentity: {
        ...toolIdentity,
        descriptorContractRevision: `sha256:${"b".repeat(64)}`,
      },
    },
    {
      ...evidence,
      toolIdentity: {
        ...toolIdentity,
        approvalAuthorityRevision: "changed-authority",
      },
    },
  ]) {
    const mismatchRegistry = new UnifiedToolRegistry({
      allowlist: [toolName],
      context: {
        kestrelOne: {
          ...policy,
          rememberedToolApprovalEvidence: [mismatchedEvidence],
        },
      },
    });
    const mismatch = mismatchRegistry
      .getCapabilityManifest({ runContext })
      .find((candidate) => candidate.name === toolName);
    assert.equal(mismatch?.approvalDisposition?.mode, "ask");
    assert.equal(
      mismatch?.approvalDisposition?.reasonCode,
      "environment_policy",
    );
  }
});

test("UnifiedToolRegistry keeps stable approval identity across runs and preserves stricter policy", () => {
  const toolName = "internet.search";
  const makeRunContext = (runId: string) =>
    createToolRunContext({
      runId,
      sessionId: `session-${runId}`,
      payload: {
        hostedApprovalAuthority: {
          organizationId: "org-1",
          environmentId: "environment-1",
          projectId: "project-1",
          threadId: "thread-1",
        },
        actor: {
          actorType: "end_user",
          actorId: "user-1",
          tenantId: "org-1",
        },
      },
    });
  const policy = {
    appApprovalModes: { [toolName]: "ask" as const },
    appApprovalPolicies: {
      [toolName]: {
        environment: "auto" as const,
        subject: "ask" as const,
        minimum: "auto" as const,
      },
    },
  };
  const baselineRegistry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: { kestrelOne: policy },
  });
  const first = baselineRegistry
    .getCapabilityManifest({ runContext: makeRunContext("run-1") })
    .find((candidate) => candidate.name === toolName)!;
  const second = baselineRegistry
    .getCapabilityManifest({ runContext: makeRunContext("run-2") })
    .find((candidate) => candidate.name === toolName)!;
  assert.equal(
    first.approvalAuthority?.revision,
    second.approvalAuthority?.revision,
  );
  const evidence = {
    version: "remembered_tool_approval_evidence_v1" as const,
    organizationId: "org-1",
    environmentId: "environment-1",
    projectId: "project-1",
    threadId: "thread-1",
    actorUserId: "user-1",
    toolIdentity: {
      version: "stable_tool_approval_identity_v1" as const,
      toolId: toolName,
      descriptorContractRevision: first.descriptorRef!.contractRevision,
      approvalAuthorityRevision: first.approvalAuthority!.revision,
    },
    sourceInteractionId: "interaction-1",
  };
  const rememberedRegistry = new UnifiedToolRegistry({
    allowlist: [toolName],
    context: {
      kestrelOne: {
        ...policy,
        rememberedToolApprovalEvidence: [evidence],
      },
    },
  });
  const capability = rememberedRegistry
    .getCapabilityManifest({ runContext: makeRunContext("run-3") })
    .find((candidate) => candidate.name === toolName);
  assert.equal(capability?.approvalDisposition?.mode, "ask");
  assert.equal(
    capability?.approvalDisposition?.reasonCode,
    "subject_restriction",
  );
});

test("UnifiedToolRegistry inspection validates without reserving a prepared execution", async () => {
  const toolName = "internet.search";
  const registry = new UnifiedToolRegistry({ allowlist: [toolName] });
  const runContext = createToolRunContext({
    runId: "run-inspection",
    sessionId: "session-inspection",
  });
  const snapshot = await registry.createToolSurfaceSnapshot({
    runContext,
    toolNames: [toolName],
  });
  const activation = snapshot.tools.find(
    (candidate) => candidate.descriptor.toolId === toolName,
  );
  assert.notEqual(activation, undefined);
  const inspect = () =>
    registry.inspectToolCall!(
      {
        activation: activation!,
        origin: {
          kind: "trusted_runtime",
          producerId: "test",
          adapterId: "test",
        },
        rawInput: { query: "Kestrel" },
      },
      { runContext },
    );
  assert.deepEqual(await inspect(), await inspect());
  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
});

test("UnifiedToolRegistry routes a direct Environment App through scoped execution authorization", async () => {
  let requestUrl = "";
  let authorization = "";
  const sensitiveValueRegistry = new SensitiveValueRegistry();
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
          (init?.headers as Record<string, string> | undefined)?.Authorization,
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
    sensitiveValueRegistry,
  });
  await registry.refreshForRuntimeTurn({
    runId: "run-environment-app",
    sessionId: "session-environment-app",
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  await callTool(
    registry,
    "internet.usage",
    {},
    {
      runContext: createToolRunContext({
        runId: "run-environment-app",
        sessionId: "session-environment-app",
      }),
    },
  );

  assert.equal(
    requestUrl,
    "https://kestrel.example/api/runtime/apps/tavily/usage/auto/usage",
  );
  assert.equal(authorization, "Bearer signed-run-ticket");
  assert.deepEqual(
    sensitiveValueRegistry
      .registeredValueDigests()
      .map((entry) => entry.referenceId),
    ["execution-ticket:run-environment-app"],
  );
  registry.clearRuntimeTurnAuthorization("run-environment-app");
  assert.deepEqual(sensitiveValueRegistry.registeredValueDigests(), []);
});

test("UnifiedToolRegistry renews and retries exactly once after a pre-dispatch expiry", async () => {
  const now = Date.now();
  const initialTicket = unsignedExecutionTicket(
    Math.floor(now / 1000) + 300,
    "initial",
  );
  const renewedTicket = unsignedExecutionTicket(
    Math.floor(now / 1000) + 600,
    "renewed",
  );
  let renewalRequests = 0;
  let capabilityRequests = 0;
  let providerDispatches = 0;
  const sensitiveValueRegistry = new SensitiveValueRegistry();
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url) === "https://kestrel.example/renew") {
      renewalRequests += 1;
      return Response.json({
        version: "execution-authorization-renewal-v1",
        executionTicket: renewedTicket,
        expiresAt: new Date(now + 600_000).toISOString(),
        renewAfter: new Date(now + 540_000).toISOString(),
      });
    }
    capabilityRequests += 1;
    const authorization = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    );
    if (authorization === `Bearer ${initialTicket}`) {
      return Response.json(
        { error: { code: "EXECUTION_AUTH_EXPIRED" } },
        { status: 401 },
      );
    }
    assert.equal(authorization, `Bearer ${renewedTicket}`);
    providerDispatches += 1;
    return Response.json({ key: { usage: 1 } });
  }) as unknown as typeof fetch;
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.usage"],
    fetchImpl,
    context: {
      kestrelOne: {
        appUrl: "https://kestrel.example",
        appApprovalModes: { "internet.usage": "auto" },
      },
      fetchImpl,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
    sensitiveValueRegistry,
  });
  await registry.refreshForRuntimeTurn({
    runId: "run-expiry-retry",
    sessionId: "session-expiry-retry",
    mcpAuthorization: {
      executionTicket: initialTicket,
      renewal: {
        version: "execution-authorization-renewal-v1",
        endpoint: "https://kestrel.example/renew",
        token: "opaque-renewal-token",
      },
    },
  });

  const result = await callTool(
    registry,
    "internet.usage",
    {},
    {
      runContext: createToolRunContext({
        runId: "run-expiry-retry",
        sessionId: "session-expiry-retry",
      }),
    },
  );

  assert.equal(result.outcome.kind, "success", JSON.stringify(result));
  assert.equal(renewalRequests, 1);
  assert.equal(capabilityRequests, 2);
  assert.equal(providerDispatches, 1);
  assert.deepEqual(
    sensitiveValueRegistry
      .registeredValueDigests()
      .map((entry) => entry.referenceId)
      .sort(),
    [
      "execution-renewal-token:run-expiry-retry",
      "execution-ticket:run-expiry-retry",
    ],
  );
  registry.clearRuntimeTurnAuthorization("run-expiry-retry");
  assert.deepEqual(sensitiveValueRegistry.registeredValueDigests(), []);
});

// Regression guard: production has two real IDs here. Keeping them different
// is intentional; making them equal recreates the test gap that hid the bug.
test("UnifiedToolRegistry preserves execution authorization when the engine assigns a different run id", async () => {
  let authorization = "";
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.usage"],
    context: {
      kestrelOne: {
        appUrl: "https://kestrel.example",
        appApprovalModes: { "internet.usage": "auto" },
      },
      fetchImpl: (async (_url, init) => {
        authorization = String(
          (init?.headers as Record<string, string> | undefined)?.Authorization,
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
    runId: "environment-execution-id",
    sessionId: "session-environment-app",
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  await callTool(
    registry,
    "internet.usage",
    {},
    {
      runContext: createToolRunContext({
        runId: "engine-run-id",
        sessionId: "session-environment-app",
      }),
    },
  );

  assert.equal(authorization, "Bearer signed-run-ticket");
  registry.clearRuntimeTurnAuthorization(
    "environment-execution-id",
    "session-environment-app",
  );
});

// Regression guard: the session bridge is valid only for one active ticket.
// Never weaken this to pick the first or most recent authorization.
test("UnifiedToolRegistry fails closed when a session has overlapping execution authorizations", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["internet.usage"],
    context: {
      kestrelOne: {
        appUrl: "https://kestrel.example",
        appApprovalModes: { "internet.usage": "auto" },
      },
      internetEnv: Object.create(null) as NodeJS.ProcessEnv,
    },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refreshForRuntimeTurn({
    runId: "environment-execution-a",
    sessionId: "shared-session",
    mcpAuthorization: { executionTicket: "signed-ticket-a" },
  });
  await registry.refreshForRuntimeTurn({
    runId: "environment-execution-b",
    sessionId: "shared-session",
    mcpAuthorization: { executionTicket: "signed-ticket-b" },
  });

  await assert.rejects(
    callTool(
      registry,
      "internet.usage",
      {},
      {
        runContext: createToolRunContext({
          runId: "unmatched-engine-run",
          sessionId: "shared-session",
        }),
      },
    ),
    /Missing Tavily API key/u,
  );

  registry.clearRuntimeTurnAuthorization(
    "environment-execution-a",
    "shared-session",
  );
  registry.clearRuntimeTurnAuthorization(
    "environment-execution-b",
    "shared-session",
  );
});

test("UnifiedToolRegistry rejects unadvertised internet.news domain filters before provider calls", async () => {
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

  await assertToolInputInvalid(
    () =>
      callTool(registry, "internet.news", {
        query:
          "Georgia Florida wildfires current updates homes evacuations damage May 2026",
        domainDeny: ["opinion", "video"],
      }),
    {
      field: "domainDeny",
      expected: "no unknown fields",
      invalidValues: [["opinion", "video"]],
    },
  );
  assert.deepEqual(internetProvider.newsCalls, []);
});

test("UnifiedToolRegistry rejects the first unadvertised internet.search field before provider calls", async () => {
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

  await assertToolInputInvalid(
    () =>
      callTool(registry, "internet.search", {
        query: "Ada Lovelace",
        domainAllow: ["wikipedia.org"],
        domainDeny: ["news"],
      }),
    {
      field: "domainAllow",
      expected: "no unknown fields",
      invalidValues: [["wikipedia.org"]],
    },
  );
  assert.deepEqual(internetProvider.searchCalls, []);
});

test("UnifiedToolRegistry rejects invalid internet.search_advanced domains before provider calls", async () => {
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
      callTool(registry, "internet.search_advanced", {
        query: "Georgia Florida wildfires current updates",
        domainDeny: ["opinion", "video"],
      }),
    {
      field: "domainDeny",
      expected: "hostnames only, without schemes, paths, or content categories",
      invalidValues: ["opinion", "video"],
    },
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

test("UnifiedToolRegistry rejects invalid internet.search_advanced country before provider calls", async () => {
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
      callTool(registry, "internet.search_advanced", {
        query:
          "Procter & Gamble latest earnings performance news 2026 investor relations",
        country: "United States",
      }),
    {
      field: "country",
      invalidValues: ["United States"],
    },
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

test("UnifiedToolRegistry strips internet.search_advanced country outside general topic", async () => {
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

  await callTool(registry, "internet.search_advanced", {
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

test("UnifiedToolRegistry strips internet.search_advanced freshness and days when explicit dates are present", async () => {
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

  await callTool(registry, "internet.search_advanced", {
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

test("UnifiedToolRegistry rejects invalid internet.search_advanced explicit dates before provider calls", async () => {
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
      callTool(registry, "internet.search_advanced", {
        query: "TCS latest revenue and headcount",
        startDate: "2026-02-31",
      }),
    {
      field: "startDate",
      expected: "a YYYY-MM-DD date",
      invalidValues: ["2026-02-31"],
    },
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

test("UnifiedToolRegistry rejects internet.search_advanced explicit date ranges with the same start and end day before provider calls", async () => {
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
      callTool(registry, "internet.search_advanced", {
        query: "current U.S. business and technology news",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      }),
    {
      field: "startDate",
      expected: "endDate must be a different YYYY-MM-DD date than startDate",
      invalidValues: ["2026-06-01", "2026-06-01"],
    },
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

test("UnifiedToolRegistry rejects internet.search_advanced exactMatch queries without a quoted phrase before provider calls", async () => {
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
      callTool(registry, "internet.search_advanced", {
        query: "current U.S. business and technology news",
        exactMatch: true,
      }),
    {
      field: "query",
      expected:
        "a query containing at least one double-quoted phrase when exactMatch is true",
      invalidValues: ["current U.S. business and technology news"],
    },
  );
  assert.deepEqual(internetProvider.searchAdvancedCalls, []);
});

test("UnifiedToolRegistry strips Tavily-conditional internet.search_advanced fields without prerequisites", async () => {
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

  await callTool(registry, "internet.search_advanced", {
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

test("UnifiedToolRegistry strips extract and crawl chunksPerSource without Tavily prerequisites", async () => {
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

  await callTool(registry, "internet.extract", {
    url: "https://example.com/page",
    chunksPerSource: 5,
  });
  await callTool(registry, "internet.crawl", {
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

test("UnifiedToolRegistry passes valid internet.search_advanced domains to provider", async () => {
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

  await callTool(registry, "internet.search_advanced", {
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

test("UnifiedToolRegistry rejects invalid built-in internet URLs before provider calls", async () => {
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
      callTool(registry, "internet.extract", {
        url: "/relative/path",
      }),
    {
      field: "url",
      invalidValues: ["/relative/path"],
    },
  );
  await assertToolInputInvalid(
    () =>
      callTool(registry, "internet.extract", {
        url: "ftp://example.com/article",
      }),
    {
      field: "url",
      invalidValues: ["ftp://example.com/article"],
    },
  );
  assert.equal(internetProvider.extractCalls.length, 0);
});

test("UnifiedToolRegistry rejects local built-in internet URLs before provider calls", async () => {
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
      callTool(registry, "internet.extract", {
        url: "http://127.0.0.1:8000/index.html",
      }),
    {
      field: "url",
      expected: "public absolute http or https URLs",
      invalidValues: ["http://127.0.0.1:8000/index.html"],
    },
  );
  await assertToolInputInvalid(
    () =>
      callTool(registry, "internet.crawl", {
        url: "http://localhost:3000",
      }),
    {
      field: "url",
      expected: "a public absolute http or https URL",
      invalidValues: ["http://localhost:3000"],
    },
  );
  await assertToolInputInvalid(
    () =>
      callTool(registry, "internet.map", {
        url: "http://192.168.1.10",
      }),
    {
      field: "url",
      expected: "a public absolute http or https URL",
      invalidValues: ["http://192.168.1.10"],
    },
  );
  assert.equal(internetProvider.extractCalls.length, 0);
  assert.equal(internetProvider.crawlCalls.length, 0);
  assert.equal(internetProvider.mapCalls.length, 0);
});

test("UnifiedToolRegistry reports built-in schema bound failures as recoverable tool input errors", async () => {
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
      validateToolInput(registry, "internet.extract", {
        url: "https://example.com/article",
        maxChars: 100,
      }),
    {
      field: "maxChars",
      expected: "value >= 500",
      invalidValues: [100],
    },
  );
  assert.equal(internetProvider.extractCalls.length, 0);
});

test("UnifiedToolRegistry accepts valid built-in internet URLs", async () => {
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

  await callTool(registry, "internet.extract", {
    url: "https://example.com/article",
  });
  await callTool(registry, "internet.extract", {
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

test("UnifiedToolRegistry applies only advertised schemas to MCP tools", async () => {
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

  await callTool(registry, "mcp.remote.news", {
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

test("UnifiedToolRegistry preserves MCP schema failure codes for dynamic tools", async () => {
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
      validateToolInput(registry, "mcp.remote.counter", {
        count: 1,
      }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_SCHEMA_FAILED");
      assert.notEqual(failure.code, "TOOL_INPUT_INVALID");
      return true;
    },
  );
  assert.equal(mcp.calls.length, 0);
});

test("UnifiedToolRegistry reports the first nested unsupported MCP field", async () => {
  const mcp = new MockMcpProvider({
    healthy: true,
    checkedAt: new Date().toISOString(),
    servers: [],
    tools: [
      {
        serverId: "remote",
        toolName: "nested",
        namespacedToolName: "mcp.remote.nested",
        description: "Remote nested input",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["request"],
          properties: {
            request: {
              type: "object",
              additionalProperties: false,
              required: ["count"],
              properties: {
                count: { type: "number" },
              },
            },
          },
        },
        presentation: {
          displayName: "Remote nested input",
          aliases: ["remote nested"],
          keywords: ["nested"],
          provider: "remote",
          toolFamily: "mcp_nested",
          capabilityClasses: ["nested"],
        },
      },
    ],
  });
  const registry = new UnifiedToolRegistry({
    allowlist: ["mcp.remote.nested"],
    mcpManager: mcp,
  });
  await registry.refresh();

  await assert.rejects(
    () =>
      validateToolInput(registry, "mcp.remote.nested", {
        request: {
          count: 1,
          unexpected: true,
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      const failure = error as RuntimeFailure;
      assert.equal(failure.code, "TOOL_INPUT_SCHEMA_FAILED");
      assert.deepEqual(failure.details?.validationErrors, [
        {
          field: "request.unexpected",
          instancePath: "/request",
          schemaPath: "#/properties/request/additionalProperties",
          keyword: "additionalProperties",
          message: "must NOT have additional properties",
        },
      ]);
      return true;
    },
  );
  assert.equal(mcp.calls.length, 0);
});

test("UnifiedToolRegistry preRun does not fail on unhealthy optional MCP servers", async () => {
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

test("UnifiedToolRegistry hides code.execute when profile code-mode is disabled", async () => {
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
    () => callTool(registry, "code.execute", {}),
    /not available/,
  );
});

test("UnifiedToolRegistry carries cancellation into code.execute", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["code.execute"],
    context: {
      codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG,
      codeExecutionService: {
        async execute(_config, _request, options) {
          if (options?.signal?.aborted === true) {
            throw new Error("sandbox cancelled");
          }
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("sandbox cancelled")),
              { once: true },
            );
          });
          throw new Error("unreachable");
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
  const controller = new AbortController();
  const call = callTool(
    registry,
    "code.execute",
    {
      language: "javascript",
      code: "setInterval(() => {}, 1_000)",
    },
    { signal: controller.signal },
  );

  controller.abort();
  await assert.rejects(
    call,
    (error: unknown) => error instanceof RunCancelledError,
  );
});

test("UnifiedToolRegistry gates dev.shell tools by devShell profile config", async () => {
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
      callTool(disabledRegistry, "dev.shell.run", {
        command: "echo ok",
        workspaceRoot: ".",
      }),
    /not available/,
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
    ["dev.shell.run"],
  );
});

test("UnifiedToolRegistry enables managed dev-shell mode from trusted agent session binding", async () => {
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
  await callTool(
    registry,
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
    },
  );

  await callTool(
    registry,
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
    },
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

test("UnifiedToolRegistry rebinds a prepared built-in after trusted managed-worktree provisioning", async () => {
  const startInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["exec_command"],
    context: {
      devShell: { enabled: true },
      devShellService: {
        startProcess: async (input: unknown) => {
          startInputs.push(input as Record<string, unknown>);
          return {
            processId: "process-managed",
            status: "COMPLETED",
            text: "ok\n",
            truncated: false,
            cursor: 0,
            nextCursor: 3,
            exitCode: 0,
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
  const sourceContext = createToolRunContext({
    runId: "run-managed-rebind",
    sessionId: "session-managed-rebind",
    payload: {
      workspace: {
        workspaceRoot: "/workspace",
        sourceWorkspaceRoot: "/workspace",
        managedWorktreeRequired: true,
      },
    },
  });
  const prepared = await prepareTestToolCall({
    gateway: registry,
    toolName: "exec_command",
    toolInput: { command: "printf ok", cwd: "." },
    runId: sourceContext.runId,
    sessionId: sourceContext.sessionId,
    options: { runContext: sourceContext },
  });
  const managedContext = createToolRunContext({
    runId: sourceContext.runId,
    sessionId: sourceContext.sessionId,
    payload: {
      workspace: {
        workspaceRoot: "/workspace/.kestrel/worktrees/session",
        sourceWorkspaceRoot: "/workspace",
        managedWorktree: true,
        leaseId: "lease-managed-rebind",
      },
    },
    sessionState: {
      agent: {
        exec: {
          managedWorktreeBinding: {
            status: "bound",
            sessionId: sourceContext.sessionId,
            runId: sourceContext.runId,
            worktreeRoot: "/workspace/.kestrel/worktrees/session",
            leaseId: "lease-managed-rebind",
          },
        },
      },
    },
  });

  const result = await registry.executePreparedToolCall(prepared, {
    runContext: managedContext,
  });

  assert.equal(result.status, "OK");
  assert.equal(
    startInputs[0]?.workspaceRoot,
    "/workspace/.kestrel/worktrees/session",
  );
  assert.deepEqual(startInputs[0]?.sourceWriteGuard, {
    enabled: true,
    mutationPolicy: "direct",
    managedWorktree: true,
    approvalGrants: [],
  });
});

test("UnifiedToolRegistry passes Build-mode dev-shell commands without package-manager preflight", async () => {
  const runInputs: Array<Record<string, unknown>> = [];
  const startInputs: Array<Record<string, unknown>> = [];
  const registry = new UnifiedToolRegistry({
    allowlist: ["exec_command", "dev.shell.run", "dev.process.start"],
    context: {
      devShell: {
        enabled: true,
      },
      devShellService: {
        runCommand: async (input: unknown) => {
          runInputs.push(input as Record<string, unknown>);
          return {
            submittedAt: "2026-01-01T00:00:00.000Z",
            status: "COMPLETED",
            stdout: "",
            text: "",
            truncated: false,
          };
        },
        startProcess: async (input: unknown) => {
          startInputs.push(input as Record<string, unknown>);
          return {
            processId: "process-1",
            status: "RUNNING",
            text: "ready\n",
            truncated: false,
            cursor: 0,
            nextCursor: 6,
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
  const buildRunContext = {
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
  };
  await callTool(
    registry,
    "exec_command",
    { command: "pnpm dev", cwd: "." },
    buildRunContext,
  );
  await callTool(
    registry,
    "dev.shell.run",
    { command: "pnpm dev", workspaceRoot: "/workspace" },
    buildRunContext,
  );
  await callTool(
    registry,
    "dev.process.start",
    { command: "pnpm dev", workspaceRoot: "/workspace" },
    buildRunContext,
  );

  assert.deepEqual(
    startInputs.map((input) => input.command),
    ["pnpm dev", "pnpm dev"],
  );
  assert.deepEqual(
    runInputs.map((input) => input.command),
    ["pnpm dev"],
  );
  for (const input of [...startInputs, ...runInputs]) {
    assert.equal("packageManagerPreflight" in input, false);
  }
});

test("UnifiedToolRegistry rejects managed dev-shell mode when trusted binding does not match the session or workspace", async () => {
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

  await callTool(
    registry,
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
    },
  );

  await callTool(
    registry,
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
    },
  );

  assert.deepEqual(execInputs[0]?.sourceWriteGuard, { enabled: true });
  assert.deepEqual(execInputs[1]?.sourceWriteGuard, { enabled: true });
});

test("UnifiedToolRegistry does not grant direct source writes for explicit managed worktree contracts before binding", async () => {
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
  await callTool(
    registry,
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
    },
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, undefined);
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
  });
});

test("UnifiedToolRegistry carries source-write authority and write roots for default source workspaces", async () => {
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
  await callTool(
    registry,
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
    },
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    allowedWriteRoots: ["/workspace"],
    approvalGrants: [],
  });
});

test("UnifiedToolRegistry ignores descriptive workspace authority without an explicit source-workspace contract", async () => {
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
  await callTool(
    registry,
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
    },
  );

  assert.equal(execInputs[0]?.sourceWriteAuthority, undefined);
  assert.deepEqual(execInputs[0]?.sourceWriteGuard, { enabled: true });
});

test("UnifiedToolRegistry exposes allowlisted filesystem tools and can call them with default policy", async () => {
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
    ["fs.read_text", "fs.write_text"],
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
    ],
  );

  const result = await callTool(registry, "fs.read_text", {
    path: filePath,
  });
  assert.equal(
    (result.auditRecord.output as { content?: string }).content,
    "registry file",
  );
});

test("UnifiedToolRegistry exposes allowlisted repo.trace as read-only workspace inspection", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-unified-repo-trace-"),
  );
  await fsMkdir(path.join(tempDir, "src"), { recursive: true });
  await writeFile(
    path.join(tempDir, "src", "main.ts"),
    "export const value = 'TRACE_TOKEN';\n",
    "utf8",
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
    ["repo.trace"],
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
    ],
  );

  const result = await callTool(registry, "repo.trace", {
    seeds: ["TRACE_TOKEN"],
  });
  const output = result.auditRecord.output as {
    resultCount?: number;
    groups?: Array<{ path: string }>;
  };
  assert.equal(output.resultCount, 1);
  assert.deepEqual(
    output.groups?.map((group) => group.path),
    ["src/main.ts"],
  );
  assert.match(result.modelContext.text, /Tool result: repo\.trace/u);
  assert.match(result.modelContext.text, /resultCount: 1/u);
  assert.match(result.modelContext.text, /src\/main\.ts/u);
  assert.match(result.modelContext.text, /TRACE_TOKEN/u);
});

test("UnifiedToolRegistry rejects unsupported fields before normalization", async () => {
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

  await assertToolInputInvalid(
    () =>
      validateToolInput(registry, "free.time.current", {
        timezone: "Etc/UTC",
        unexpected: true,
      }),
    {
      field: "unexpected",
      expected: "no unknown fields",
      invalidValues: [true],
    },
  );
});

test("UnifiedToolRegistry validates internet.research after canonicalizing advertised query input", async () => {
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

  const normalized = await validateToolInput(registry, "internet.research", {
    query: "Cults of Cincinnati, OH",
  });

  assert.deepEqual(normalized, {
    input: "Cults of Cincinnati, OH",
    query: "Cults of Cincinnati, OH",
  });
});

test("UnifiedToolRegistry rejects legacy aliases and accepts canonical model input", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["evidence.extract", "fs.read_text", "fs.copy"],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });

  await registry.refresh();

  for (const [name, input] of [
    ["evidence.extract", { content: "legacy", source: "report", limit: 2 }],
    ["fs.read_text", { filePath: "README.md" }],
    ["fs.read_text", { targetPath: "README.md" }],
    ["fs.copy", { from: "a.txt", to: "b.txt" }],
  ] as const) {
    await assert.rejects(
      () => validateToolInput(registry, name, input),
      (error: unknown) => {
        assert.equal(error instanceof RuntimeFailure, true);
        const failure = error as RuntimeFailure;
        assert.equal(failure.code, "TOOL_INPUT_INVALID");
        assert.equal(
          (
            failure.details?.validationErrors as
              | Array<{ keyword?: string }>
              | undefined
          )?.some((item) => item.keyword === "additionalProperties"),
          true,
        );
        return true;
      },
    );
  }

  await assert.rejects(
    () =>
      validateToolInput(registry, "fs.read_text", {
        path: "README.md",
        maxBytes: "2",
      }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      assert.equal((error as RuntimeFailure).code, "TOOL_INPUT_INVALID");
      return true;
    },
  );

  await assert.rejects(
    () => validateToolInput(registry, "fs.read_text", {
      path: "README.md",
      offsetBytes: 8192,
      expectedRevision: `sha256:${"a".repeat(64)}`,
    }),
    (error: unknown) => {
      assert.equal(error instanceof RuntimeFailure, true);
      assert.match((error as RuntimeFailure).message, /fs\.read_text_page/u);
      return true;
    },
  );

  const normalized = await validateToolInput(registry, "evidence.extract", {
    text: "Deterministic validation reduced approval rework by 18 percent.",
    sourceId: "benchmark-1",
    maxItems: 2,
  });

  assert.deepEqual(normalized, {
    text: "Deterministic validation reduced approval rework by 18 percent.",
    sourceId: "benchmark-1",
    maxItems: 2,
  });
});

test("UnifiedToolRegistry scopes allowlists per run context", async () => {
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
          inputSchema: { type: "object", additionalProperties: false },
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

test("UnifiedToolRegistry preserves runtime built-ins when pruning unavailable tools", async () => {
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

test("UnifiedToolRegistry exposes persistent dialog tools and hides legacy spawn tools", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: [
      "dialog.open",
      "dialog.send",
      "dialog.close",
      "agent.spawn",
      "delegate.spawn_child",
    ],
    context: {
      dialogService: {
        async open() {
          throw new Error("not called");
        },
        async send() {
          throw new Error("not called");
        },
        async close() {
          throw new Error("not called");
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
    ["dialog.open", "dialog.send", "dialog.close"],
  );
});

test("Kestrel-One profile exposes only model-visible collaborator dialogs", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-dialog-profile-registry-"),
  );
  const store = new ProfileStore(tempDir);
  const profile = store.findById(await store.load(), "kestrel");
  assert.ok(profile);
  const registry = new UnifiedToolRegistry({
    allowlist: profile.toolAllowlist ?? [],
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();

  assert.deepEqual(
    registry
      .getModelTools()
      .map((tool) => tool.name)
      .filter(
        (toolName) =>
          toolName.startsWith("dialog.") ||
          toolName.startsWith("delegate.") ||
          toolName === "agent.spawn",
      ),
    ["dialog.open", "dialog.send", "dialog.close"],
  );
});

test("every canonical Kestrel One environment exposes dialogs without legacy delegation tools", async () => {
  for (const environmentPresetId of [
    "cli_safe_local",
    "cli_dev_local",
    "desktop_safe_local",
    "desktop_dev_local",
    "workspace_hosted",
  ] as const) {
    const profile = composeKestrelOneProfile({
      environmentPresetId,
      overlay: {
        ...(environmentPresetId === "workspace_hosted"
          ? {
              modelProvider: "openrouter" as const,
              model: "openai/gpt-5.6-luna",
            }
          : {}),
        additionalToolNames: ["agent.spawn", "delegate.spawn_child"],
      },
    }).profile;
    const registry = new UnifiedToolRegistry({
      allowlist: profile.toolAllowlist ?? [],
      mcpManager: new MockMcpProvider({
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      }),
    });
    await registry.refresh();
    assert.deepEqual(
      registry
        .getModelTools()
        .map((tool) => tool.name)
        .filter(
          (name) =>
            name.startsWith("dialog.") ||
            name.startsWith("delegate.") ||
            name === "agent.spawn",
        ),
      ["dialog.open", "dialog.send", "dialog.close"],
    );
  }
});

test("UnifiedToolRegistry blocks all legacy spawn tools even when allowlisted", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: [
      "agent.spawn",
      "delegate.spawn_child",
      "delegate.list_children",
      "delegate.get_child_result",
      "delegate.future_internal_tool",
    ],
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
    [],
  );
  await assert.rejects(
    () => callTool(registry, "agent.spawn", { task: "legacy" }),
    /not available/,
  );
  await assert.rejects(
    () =>
      callTool(registry, "delegate.spawn_child", {
        title: "Legacy child",
        prompt: "Do the legacy thing",
        parentSessionId: "session-parent",
      }),
    /not available/,
  );
  await assert.rejects(
    () =>
      validateToolInput(registry, "delegate.list_children", {
        parentSessionId: "session-parent",
      }),
    /not available/,
  );
  await assert.rejects(
    () => validateToolInput(registry, "delegate.future_internal_tool", {}),
    /not available/,
  );
});

test("dialog.open validates its minimal name and message contract", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["dialog.open"],
    context: {
      dialogService: {
        async open() {
          throw new Error("not called");
        },
        async send() {
          throw new Error("not called");
        },
        async close() {
          throw new Error("not called");
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
    await validateToolInput(registry, "dialog.open", {
      name: "Peregrine",
      message: "Investigate failing tests",
    }),
    {
      name: "Peregrine",
      message: "Investigate failing tests",
    },
  );
  await assert.rejects(
    () =>
      validateToolInput(registry, "dialog.open", {
        name: "Peregrine",
        message: "Investigate failing tests",
        parentSessionId: "session-1",
      }),
    /parentSessionId/,
  );
});

test("dialog.open uses active thread identity and forbids nested dialogs", async () => {
  const requests: unknown[] = [];
  const now = new Date().toISOString();
  const registry = new UnifiedToolRegistry({
    allowlist: ["dialog.open"],
    context: {
      dialogService: {
        async open(input) {
          requests.push(input);
          return {
            dialogId: "dialog-child",
            name: input.name,
            parentSessionId: input.parentSessionId,
            status: "open",
            active: true,
            childSessionId: "child-session",
            createdAt: now,
            updatedAt: now,
          };
        },
        async send() {
          throw new Error("not called");
        },
        async close() {
          throw new Error("not called");
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
  const result = await callTool(
    registry,
    "dialog.open",
    {
      name: "Peregrine",
      message: "Investigate failing tests",
    },
    {
      runContext: createToolRunContext({
        runId: "run-parent",
        sessionId: "session-parent",
        payload: {
          orchestration: {
            threadId: "thread-parent",
            runtimeAssembly: {
              toolAllowlist: ["dialog.open"],
            },
          },
        },
      }),
    },
  );

  assert.equal(
    (result.auditRecord.output as { dialogId?: string }).dialogId,
    "dialog-child",
  );
  assert.deepEqual(requests, [
    {
      parentSessionId: "thread-parent",
      parentRunId: "run-parent",
      name: "Peregrine",
      message: "Investigate failing tests",
    },
  ]);
  const nested = await callTool(
    registry,
    "dialog.open",
    { name: "Osprey", message: "nested" },
    {
      runContext: createToolRunContext({
        runId: "run-child",
        sessionId: "session-child",
        payload: {
          orchestration: {
            threadId: "thread-child",
            delegationId: "dialog-parent",
            delegationDepth: 1,
            runtimeAssembly: { toolAllowlist: ["dialog.open"] },
          },
        },
      }),
    },
  );
  assert.equal(nested.status, "FAILED");
  assert.match(
    String(
      (nested.auditRecord.error as { message?: string } | undefined)?.message,
    ),
    /Only Kestrel can open collaborator dialogs/,
  );
});

test("UnifiedToolRegistry scopes filesystem root per workspace payload", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-unified-workspace-fs-"),
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
    callTool(
      registry,
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
      },
    );

  const [left, right] = await Promise.all([
    readWithinWorkspace(workspaceA),
    readWithinWorkspace(workspaceB),
  ]);

  assert.equal(
    (left.auditRecord.output as { content?: string }).content,
    "workspace-a",
  );
  assert.equal(
    (right.auditRecord.output as { content?: string }).content,
    "workspace-b",
  );
  const outside = await callTool(
    registry,
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
    },
  );
  assert.equal(outside.status, "FAILED");
  assert.match(
    String(
      (outside.auditRecord.error as { message?: string } | undefined)?.message,
    ),
    /outside allowed roots/i,
  );
});

test("UnifiedToolRegistry records exact provenance when an installed SKILL.md is fully loaded", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-unified-skill-read-"),
  );
  const commitSha = "a".repeat(40);
  const skillFile = `.kestrel/skills/review/revisions/${commitSha}/SKILL.md`;
  await fsMkdir(path.dirname(path.join(workspaceRoot, skillFile)), {
    recursive: true,
  });
  await writeFile(
    path.join(workspaceRoot, skillFile),
    `---\nname: review\ndescription: Review carefully.\n---\n\n# Review\n\n${"Use evidence.\n".repeat(700)}`,
    "utf8",
  );
  const contentDigest = (
    await validateWorkspaceSkillPackage(
      path.dirname(path.join(workspaceRoot, skillFile)),
    )
  ).contentDigest;
  const registry = new UnifiedToolRegistry({
    allowlist: ["fs.read_text", "fs.read_text_page", "fs.write_text"],
    context: { fileSystem: { workspaceRoot, tempRoots: [os.tmpdir()] } },
    mcpManager: new MockMcpProvider({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [],
    }),
  });
  await registry.refresh();
  const runContext = createToolRunContext({
    runId: "run-skill-read",
    sessionId: "session-skill-read",
    payload: {
      workspace: {
        workspaceId: "workspace-skill",
        workspaceRoot,
        appRoot: ".",
        commands: {},
      },
      workspaceSkills: [
        {
          installationId: "review",
          name: "review",
          description: "Review carefully.",
          commitSha,
          contentDigest,
          skillFile,
        },
      ],
    },
  });
  const firstPage = await callTool(
    registry,
    "fs.read_text",
    { path: skillFile },
    {
      runContext,
    },
  );
  assert.equal(
    (firstPage.auditRecord.output as { workspaceSkillProvenance?: unknown })
      .workspaceSkillProvenance,
    undefined,
  );
  const firstOutput = firstPage.auditRecord.output as {
    nextOffsetBytes: number;
    revision: string;
    nextPage: { input: Record<string, unknown> };
  };
  const result = await callTool(
    registry,
    "fs.read_text_page",
    firstOutput.nextPage.input,
    { runContext },
  );
  assert.deepEqual(
    (result.auditRecord.output as { range: unknown; complete: unknown }).range,
    {
      startByte: firstOutput.nextOffsetBytes,
      endByte: (result.auditRecord.output as { totalBytes: number }).totalBytes,
    },
  );
  assert.equal(
    (result.auditRecord.output as { complete: boolean }).complete,
    true,
  );
  assert.deepEqual(
    (result.auditRecord.output as { workspaceSkillProvenance?: unknown })
      .workspaceSkillProvenance,
    {
      installationId: "review",
      name: "review",
      commitSha,
      contentDigest,
      skillFile,
      loaded: true,
    },
  );
  const writeResult = await callTool(
    registry,
    "fs.write_text",
    { path: skillFile, content: "tampered" },
    { runContext },
  );
  assert.equal(writeResult.status, "FAILED");
  assert.match(
    String(
      (writeResult.auditRecord.error as { message?: string } | undefined)
        ?.message,
    ),
    /cannot modify Kestrel-owned workspace skill state/u,
  );
});
