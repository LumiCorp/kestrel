import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AllowlistedToolGateway,
  createEmbeddedToolModuleV1,
} from "../../src/io/ToolGateway.js";
import {
  createToolActivationRefV1,
  hashCanonical,
  toToolDescriptorRefV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import type {
  PreparedToolCallV1,
  ResolvedModelToolIntentV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import {
  parseAgentToolResultV2,
  parsePreparedToolCallV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import { createPreparedToolCallV1 } from "../../src/io/ToolInvocationSupport.js";
import type { McpStatusSnapshot } from "../../src/mcp/contracts.js";
import {
  RuntimeFailure,
  createRuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import {
  type McpToolProvider,
  UnifiedToolRegistry,
} from "../../tools/runtime/UnifiedToolRegistry.js";
import { executeTestToolCall } from "../helpers/createTestToolGateway.js";
import { prepareTestToolCall } from "../helpers/createTestToolGateway.js";

const TOOL_ID = "mcp.test.lookup";

class VersionedMcpProvider implements McpToolProvider {
  version = "v1";
  references = 0;
  failCalls = false;

  async refresh(): Promise<McpStatusSnapshot> {
    return {
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [{
        serverId: "test",
        toolName: "lookup",
        namespacedToolName: TOOL_ID,
        description: `Lookup ${this.version}`,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        presentation: {
          displayName: "Lookup",
          aliases: [TOOL_ID],
          keywords: ["lookup"],
          provider: "test",
          toolFamily: "test",
          capabilityClasses: ["test.lookup"],
          approvalMode: "auto",
        },
      }],
    };
  }

  async assertHealthy(): Promise<void> {}

  async callTool<T>(_name: string, _input: unknown): Promise<T> {
    if (this.failCalls) throw new Error("planned MCP failure");
    return { content: [{ type: "text", text: this.version }] } as T;
  }

  pinTool(name: string) {
    assert.equal(name, TOOL_ID);
    const pinnedVersion = this.version;
    let references = 1;
    this.references += 1;
    return {
      call: async <T>(_input: unknown) => {
        if (this.failCalls) throw new Error("planned pinned MCP failure");
        return {
          content: [{ type: "text", text: pinnedVersion }],
        } as T;
      },
      retain: () => {
        assert.ok(references > 0);
        references += 1;
        this.references += 1;
      },
      release: async () => {
        if (references === 0) return;
        references -= 1;
        this.references -= 1;
      },
    };
  }

  async close(): Promise<void> {}
}

test("explicit runtime-only tools receive activations without entering the model surface", async () => {
  const registry = new UnifiedToolRegistry({ allowlist: ["FinalizeAnswer"] });

  assert.equal(
    registry.getModelTools().some((tool) => tool.name === "FinalizeAnswer"),
    false,
  );

  const snapshot = await registry.createToolSurfaceSnapshot({
    toolNames: ["FinalizeAnswer"],
  });
  assert.deepEqual(
    snapshot.tools.map((activation) => activation.descriptor.toolId),
    ["FinalizeAnswer"],
  );

  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  await registry.close();
});

test("model snapshot, preparation, and execution retain one exact MCP activation", async () => {
  const provider = new VersionedMcpProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();
  const snapshot = await registry.createToolSurfaceSnapshot({
    toolNames: [TOOL_ID],
  });
  const intent = registry.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-1", name: TOOL_ID, input: { query: "old" } },
  });

  provider.version = "v2";
  await registry.refresh();
  const prepared = await prepareModelIntent(registry, intent);
  const result = await registry.executePreparedToolCall(prepared);

  assert.equal(result.status, "OK");
  assert.equal(
    ((result.auditRecord.output as { content: Array<{ text: string }> }).content[0]?.text),
    "v1",
  );
  assert.equal(result.activation.descriptor.contractRevision, intent.activation.descriptor.contractRevision);
  assert.equal(provider.references, 1);
  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  assert.equal(provider.references, 0);
});

test("explicit prepared-call release is idempotent and prevents later execution", async () => {
  const provider = new VersionedMcpProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();
  const snapshot = await registry.createToolSurfaceSnapshot({ toolNames: [TOOL_ID] });
  const intent = registry.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-release", name: TOOL_ID, input: { query: "old" } },
  });
  const prepared = await prepareModelIntent(registry, intent);
  assert.equal(provider.references, 2);

  await registry.releasePreparedToolCall(prepared);
  assert.equal(provider.references, 1);
  await registry.releasePreparedToolCall(prepared);
  assert.equal(provider.references, 1);
  await assert.rejects(
    () => registry.executePreparedToolCall(prepared),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );

  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  assert.equal(provider.references, 0);
  await registry.close();
});

test("explicit release prevents same-process static built-in rehydration", async () => {
  const registry = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await registry.refresh();
  const prepared = await prepareTestToolCall({
    gateway: registry,
    toolName: "free.time.current",
    toolInput: {},
  });

  await registry.releasePreparedToolCall(prepared);
  await registry.releasePreparedToolCall(prepared);
  await assert.rejects(
    () => registry.executePreparedToolCall(prepared),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
  await registry.close();
});

test("a static prepared call executes at most once per registry", async () => {
  const registry = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await registry.refresh();
  const prepared = await prepareTestToolCall({
    gateway: registry,
    toolName: "free.time.current",
    toolInput: {},
  });

  const result = await registry.executePreparedToolCall(prepared);
  assert.equal(result.status, "OK");
  await assert.rejects(
    () => registry.executePreparedToolCall(prepared),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
  await registry.close();
});

test("run release reclaims only that run's terminal prepared keys", async () => {
  const registry = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await registry.refresh();
  const sessionId = "terminal-key-session";
  const completed = await Promise.all(
    Array.from({ length: 24 }, (_, index) => prepareTestToolCall({
      gateway: registry,
      toolName: "free.time.current",
      toolInput: {},
      runId: "completed-run",
      sessionId,
      callId: `completed-call-${index}`,
    })),
  );
  for (const prepared of completed) {
    assert.equal((await registry.executePreparedToolCall(prepared)).status, "OK");
  }
  const otherTerminal = await prepareTestToolCall({
    gateway: registry,
    toolName: "free.time.current",
    toolInput: {},
    runId: "live-run",
    sessionId,
    callId: "other-terminal-call",
  });
  assert.equal(
    (await registry.executePreparedToolCall(otherTerminal)).status,
    "OK",
  );
  const livePending = await prepareTestToolCall({
    gateway: registry,
    toolName: "free.time.current",
    toolInput: {},
    runId: "live-run",
    sessionId,
    callId: "live-pending-call",
  });

  await registry.releaseToolRun("completed-run", sessionId);

  assert.equal(
    (await registry.executePreparedToolCall(completed[0]!)).status,
    "OK",
  );
  await assert.rejects(
    () => registry.executePreparedToolCall(otherTerminal),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
  assert.equal(
    (await registry.executePreparedToolCall(livePending)).status,
    "OK",
  );
  await registry.close();
});

test("failed prepared execution releases its retained source", async () => {
  const provider = new VersionedMcpProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();
  const snapshot = await registry.createToolSurfaceSnapshot({ toolNames: [TOOL_ID] });
  const intent = registry.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-failure", name: TOOL_ID, input: { query: "old" } },
  });
  const prepared = await prepareModelIntent(registry, intent);
  provider.failCalls = true;

  const result = await registry.executePreparedToolCall(prepared);
  assert.equal(result.status, "FAILED");
  assert.equal(provider.references, 1);

  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  assert.equal(provider.references, 0);
  await registry.close();
});

test("registry close releases snapshot and prepared-call ownership exactly once", async () => {
  const provider = new VersionedMcpProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();
  const snapshot = await registry.createToolSurfaceSnapshot({ toolNames: [TOOL_ID] });
  const intent = registry.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-close", name: TOOL_ID, input: { query: "old" } },
  });
  const prepared = await prepareModelIntent(registry, intent);
  assert.equal(provider.references, 2);

  await registry.close();
  assert.equal(provider.references, 0);
  await registry.close();
  assert.equal(provider.references, 0);
  await assert.rejects(
    () => registry.executePreparedToolCall(prepared),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
});

test("interruption resumes one persisted MCP action without generation substitution", async () => {
  const provider = new VersionedMcpProvider();
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();
  const snapshot = await registry.createToolSurfaceSnapshot({
    toolNames: [TOOL_ID],
  });
  const intent = registry.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-interrupted", name: TOOL_ID, input: { query: "old" } },
  });
  const prepared = await prepareModelIntent(registry, intent);
  const persisted = parsePreparedToolCallV1(
    JSON.parse(JSON.stringify(prepared)) as unknown,
  );

  provider.version = "v2";
  await registry.refresh();
  const result = await registry.executePreparedToolCall(persisted);
  assert.equal(result.status, "OK");
  assert.equal(
    ((result.auditRecord.output as { content: Array<{ text: string }> }).content[0]?.text),
    "v1",
  );
  assert.deepEqual(result.activation, persisted.activation);

  await assert.rejects(
    () => registry.executePreparedToolCall(persisted),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
  await registry.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  await registry.close();
});

test("terminal continuation cleanup releases snapshots retained by the waiting run", async () => {
  const registry = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  const snapshot = await registry.createToolSurfaceSnapshot({
    toolNames: ["free.time.current"],
    runContext: {
      runId: "waiting-run",
      sessionId: "shared-session",
      payload: {},
      sessionState: {},
    },
  });

  await registry.releaseToolRun("continuation-run", "shared-session");

  assert.throws(
    () => registry.resolveModelToolIntent({
      snapshot,
      toolCall: {
        id: "stale-call",
        name: "free.time.current",
        input: {},
      },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_SNAPSHOT_STALE",
  );
});

test("restart without the prepared dynamic handler fails closed", async () => {
  const provider = new VersionedMcpProvider();
  const original = new UnifiedToolRegistry({ allowlist: [TOOL_ID], mcpManager: provider });
  await original.refresh();
  const snapshot = await original.createToolSurfaceSnapshot({ toolNames: [TOOL_ID] });
  const intent = original.resolveModelToolIntent({
    snapshot,
    toolCall: { id: "call-restart", name: TOOL_ID, input: { query: "old" } },
  });
  const prepared = await prepareModelIntent(original, intent);

  const restarted = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: new VersionedMcpProvider(),
  });
  await restarted.refresh();
  await assert.rejects(
    () => restarted.executePreparedToolCall(prepared),
    (error) => error instanceof RuntimeFailure && error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
});

test("dynamic tools without exact generation pinning fail closed before exposure", async () => {
  const provider: McpToolProvider = {
    refresh: async () => ({
      healthy: true,
      checkedAt: new Date().toISOString(),
      servers: [],
      tools: [{
        serverId: "test",
        toolName: "lookup",
        namespacedToolName: TOOL_ID,
        description: "Unpinned lookup",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        presentation: {
          displayName: "Lookup",
          aliases: [TOOL_ID],
          keywords: ["lookup"],
          provider: "test",
          toolFamily: "test",
          capabilityClasses: ["test.lookup"],
          approvalMode: "auto",
        },
      }],
    }),
    assertHealthy: async () => {},
    callTool: async <T>() => ({}) as T,
    close: async () => {},
  };
  const registry = new UnifiedToolRegistry({
    allowlist: [TOOL_ID],
    mcpManager: provider,
  });
  await registry.refresh();

  await assert.rejects(
    () => registry.createToolSurfaceSnapshot({ toolNames: [TOOL_ID] }),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
});

test("restart rehydrates only an exact static built-in activation", async () => {
  const original = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await original.refresh();
  const prepared = await prepareTestToolCall({
    gateway: original,
    toolName: "free.time.current",
    toolInput: {},
  });
  const restarted = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await restarted.refresh();
  const result = await restarted.executePreparedToolCall(prepared);
  assert.equal(result.status, "OK");
  assert.equal(result.activation.descriptor.contractRevision, prepared.activation.descriptor.contractRevision);
});

test("approval resume rehydrates an exact static built-in before inspection and preparation", async (t) => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "kestrel-static-approval-resume-"),
  );
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "sentinel.txt"), "sentinel", "utf8");
  const runContext = {
    runId: "run-static-approval-resume",
    sessionId: "session-static-approval-resume",
    payload: {
      workspace: { workspaceRoot },
      clientCapabilities: {
        kestrelOne: {
          contextGrantId: "context-grant-static-approval-resume",
        },
      },
      mcpContext: {
        gatewayUrl: "https://gateway.example.test",
        grantId: "11111111-1111-4111-8111-111111111111",
        protocolVersion: "2025-11-25",
        organizationId: "organization-static-approval-resume",
        environmentId: "environment-static-approval-resume",
        projectId: "project-static-approval-resume",
        threadId: "thread-static-approval-resume",
      },
    },
    sessionState: {},
  };

  const original = new UnifiedToolRegistry({ allowlist: ["fs.list"] });
  await original.refresh();
  const snapshot = await original.createToolSurfaceSnapshot({
    runContext,
    toolNames: ["fs.list"],
  });
  const intent = structuredClone(
    original.resolveModelToolIntent({
      snapshot,
      toolCall: { id: "call-static-approval-resume", name: "fs.list", input: { path: "." } },
    }),
  );
  await original.releaseToolSurfaceSnapshot(snapshot.snapshotId);
  await original.close();

  const resumed = new UnifiedToolRegistry({ allowlist: ["fs.list"] });
  await resumed.refresh();
  const resumedRunContext = {
    ...runContext,
    runId: "run-static-approval-continuation",
    payload: {
      ...runContext.payload,
      resumeBlockedRun: true,
      metadata: {
        blockedRunId: runContext.runId,
        blockedToolScope: {
          runId: runContext.runId,
          mcpContext: runContext.payload.mcpContext,
        },
      },
      mcpContext: {
        ...runContext.payload.mcpContext,
        grantId: "22222222-2222-4222-8222-222222222222",
      },
    },
  };
  const origin = {
    kind: "model" as const,
    snapshotId: intent.snapshotId,
    modelToolCallId: intent.modelToolCallId,
  };
  assert.deepEqual(
    await resumed.inspectToolCall!(
      { activation: intent.activation, origin, rawInput: intent.rawInput },
      { runContext: resumedRunContext },
    ),
    { effectiveInput: { path: "." } },
  );
  const prepared = await resumed.prepareToolCall(
    {
      runId: resumedRunContext.runId,
      sessionId: runContext.sessionId,
      callId: intent.modelToolCallId,
      activation: intent.activation,
      origin,
      rawInput: intent.rawInput,
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({ source: "approved-resume" }),
      },
    },
    { runContext: resumedRunContext },
  );
  const result = await resumed.executePreparedToolCall(prepared, {
    runContext: resumedRunContext,
  });
  assert.equal(result.status, "OK");
  assert.match(JSON.stringify(result.auditRecord.output), /sentinel\.txt/u);
  for (const rejectedRunContext of [
    {
      ...resumedRunContext,
      payload: {
        ...resumedRunContext.payload,
        clientCapabilities: {
          kestrelOne: { contextGrantId: "context-grant-unrelated" },
        },
      },
    },
    {
      ...resumedRunContext,
      payload: {
        ...resumedRunContext.payload,
        metadata: { blockedRunId: "run-unrelated" },
      },
    },
    {
      ...resumedRunContext,
      payload: {
        ...resumedRunContext.payload,
        workspace: { workspaceRoot: path.join(workspaceRoot, "other") },
      },
    },
    {
      ...resumedRunContext,
      payload: {
        ...resumedRunContext.payload,
        orchestration: { blockedRunId: "run-conflicting" },
      },
    },
    {
      ...resumedRunContext,
      payload: {
        ...resumedRunContext.payload,
        metadata: {
          ...resumedRunContext.payload.metadata,
          blockedToolScope: {
            runId: runContext.runId,
            mcpContext: {
              ...runContext.payload.mcpContext,
              environmentId: "environment-unrelated",
            },
          },
        },
      },
    },
  ]) {
    await assert.rejects(
      () => resumed.inspectToolCall!(
        { activation: intent.activation, origin, rawInput: intent.rawInput },
        { runContext: rejectedRunContext },
      ),
      (error) =>
        error instanceof RuntimeFailure &&
        error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
    );
  }
  await resumed.close();
});

test("static restart rehydration rejects changed workspace authority", async () => {
  const original = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await original.refresh();
  const prepared = await prepareTestToolCall({
    gateway: original,
    toolName: "free.time.current",
    toolInput: {},
    options: {
      runContext: {
        runId: "run-scope",
        sessionId: "session-scope",
        payload: { workspace: { workspaceRoot: "/workspace/a" } },
        sessionState: {},
      },
    },
  });
  const restarted = new UnifiedToolRegistry({ allowlist: ["free.time.current"] });
  await restarted.refresh();

  await assert.rejects(
    () => restarted.executePreparedToolCall(prepared, {
      runContext: {
        runId: "run-scope",
        sessionId: "session-scope",
        payload: { workspace: { workspaceRoot: "/workspace/b" } },
        sessionState: {},
      },
    }),
    (error) =>
      error instanceof RuntimeFailure &&
      error.code === "TOOL_PINNED_HANDLER_UNAVAILABLE",
  );
});

test("handlers cannot replace the gateway-owned result envelope", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.envelope",
    description: "Envelope rejection test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("read_only"),
    presentation: presentation("Envelope"),
    handlerId: "test:envelope:handler:v1",
    resultNormalizerId: "test:envelope:normalizer:v1",
    handler: async () => buildAgentToolSuccessResult({
      toolName: "test.envelope",
      input: {},
      output: { forged: true },
    }),
  });
  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "test.envelope",
    toolInput: {},
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.outcome.kind, "failure");
  assert.equal(result.outcome.kind === "failure" && result.outcome.normalizedFailureCode, "TOOL_RESULT_ENVELOPE_FORBIDDEN");
});

test("ordinary tool errors preserve structured cleanup evidence in the normalized result", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.cleanup-evidence",
    description: "Cleanup evidence serialization test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("external_side_effect"),
    presentation: presentation("Cleanup evidence"),
    handlerId: "test:cleanup-evidence:handler:v1",
    resultNormalizerId: "test:cleanup-evidence:normalizer:v1",
    handler: async () => {
      const primary = new Error("promotion persistence failed");
      Object.assign(primary, {
        details: {
          cleanupFailures: [{ operation: "release_provisional_retention", message: "release failed" }],
        },
      });
      throw primary;
    },
  });

  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "test.cleanup-evidence",
    toolInput: {},
  });

  assert.equal(result.outcome.kind, "failure");
  assert.deepEqual(
    result.outcome.kind === "failure" ? result.outcome.error.details : undefined,
    {
      cleanupFailures: [{ operation: "release_provisional_retention", message: "release failed" }],
    },
  );
});

test("preparation rejects a forged descriptor reference under a valid revision", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.activation",
    description: "Exact activation test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("read_only"),
    presentation: presentation("Activation"),
    handlerId: "test:activation:handler:v1",
    resultNormalizerId: "test:activation:normalizer:v1",
    handler: async () => ({}),
  });
  const gateway = new AllowlistedToolGateway([module]);
  const snapshot = await gateway.createToolSurfaceSnapshot();
  const activation = snapshot.tools[0]!;

  await assert.rejects(
    () => gateway.prepareToolCall({
      runId: "run-forged",
      sessionId: "session-forged",
      callId: "call-forged",
      activation: {
        ...activation,
        descriptor: {
          ...activation.descriptor,
          sourceId: "forged-owner",
        },
      },
      origin: {
        kind: "trusted_runtime",
        producerId: "test:v1",
        adapterId: "test:v1",
      },
      rawInput: {},
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({ source: "test" }),
      },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_ACTIVATION_STALE",
  );
});

test("model input must pass the exposed schema before preparation", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.model-input",
    description: "Strict model input test",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    capability: capability("read_only"),
    presentation: presentation("Model input"),
    handlerId: "test:model-input:handler:v1",
    resultNormalizerId: "test:model-input:normalizer:v1",
    handler: async () => ({}),
  });
  const gateway = new AllowlistedToolGateway([module]);
  const snapshot = await gateway.createToolSurfaceSnapshot();
  const intent = gateway.resolveModelToolIntent({
    snapshot,
    toolCall: {
      id: "call-invalid-model-input",
      name: "test.model-input",
      input: { query: 42 },
    },
  });

  await assert.rejects(
    () => gateway.prepareToolCall({
      runId: "run-invalid-model-input",
      sessionId: "session-invalid-model-input",
      callId: intent.modelToolCallId,
      activation: intent.activation,
      origin: {
        kind: "model",
        snapshotId: intent.snapshotId,
        modelToolCallId: intent.modelToolCallId,
      },
      rawInput: intent.rawInput,
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({ source: "model-input-test" }),
      },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_INPUT_SCHEMA_FAILED",
  );
});

test("model input validation never strips unsupported fields", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.model-fields",
    description: "Unsupported model field test",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    capability: capability("read_only"),
    presentation: presentation("Model fields"),
    handlerId: "test:model-fields:handler:v1",
    resultNormalizerId: "test:model-fields:normalizer:v1",
    handler: async () => ({}),
  });
  const gateway = new AllowlistedToolGateway([module]);
  const snapshot = await gateway.createToolSurfaceSnapshot();
  const intent = gateway.resolveModelToolIntent({
    snapshot,
    toolCall: {
      id: "call-extra-model-field",
      name: "test.model-fields",
      input: { query: "exact", unsupported: true },
    },
  });

  await assert.rejects(
    () => gateway.prepareToolCall({
      runId: "run-extra-model-field",
      sessionId: "session-extra-model-field",
      callId: intent.modelToolCallId,
      activation: intent.activation,
      origin: {
        kind: "model",
        snapshotId: intent.snapshotId,
        modelToolCallId: intent.modelToolCallId,
      },
      rawInput: intent.rawInput,
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({ source: "model-field-test" }),
      },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_INPUT_SCHEMA_FAILED",
  );
  assert.deepEqual(intent.rawInput, { query: "exact", unsupported: true });
});

test("preparation rejects a stale runtime scope fingerprint", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.scope",
    description: "Scope binding test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("read_only"),
    presentation: presentation("Scope"),
    handlerId: "test:scope:handler:v1",
    resultNormalizerId: "test:scope:normalizer:v1",
    handler: async () => ({}),
  });
  const gateway = new AllowlistedToolGateway([module]);
  const originalContext = {
    runId: "run-scope-original",
    sessionId: "session-scope",
    payload: { workspace: { workspaceRoot: "/workspace/original" } },
    sessionState: {},
  };
  const snapshot = await gateway.createToolSurfaceSnapshot({
    runContext: originalContext,
  });

  await assert.rejects(
    () => gateway.prepareToolCall({
      runId: "run-scope-original",
      sessionId: "session-scope",
      callId: "call-stale-scope",
      activation: snapshot.tools[0]!,
      origin: {
        kind: "trusted_runtime",
        producerId: "test:v1",
        adapterId: "test:v1",
      },
      rawInput: {},
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({ source: "scope-test" }),
      },
    }, {
      runContext: {
        ...originalContext,
        payload: { workspace: { workspaceRoot: "/workspace/substituted" } },
      },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_ACTIVATION_STALE",
  );
});

test("approval authority includes the exact descriptor revision", () => {
  const first = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.approval-revision",
    description: "Approval revision one",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("external_side_effect"),
    presentation: presentation("Approval revision"),
    handlerId: "test:approval-revision:handler:v1",
    resultNormalizerId: "test:approval-revision:normalizer:v1",
    handler: async () => ({}),
  }).descriptor;
  const second = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.approval-revision",
    description: "Approval revision two",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("external_side_effect"),
    presentation: presentation("Approval revision"),
    handlerId: "test:approval-revision:handler:v1",
    resultNormalizerId: "test:approval-revision:normalizer:v1",
    handler: async () => ({}),
  }).descriptor;
  const buildPrepared = (descriptor: typeof first) => createPreparedToolCallV1({
    runId: "run-approval-revision",
    sessionId: "session-approval-revision",
    callId: "call-approval-revision",
    activation: createToolActivationRefV1({
      descriptor: toToolDescriptorRefV1(descriptor),
      registryGeneration: hashCanonical({ generation: "fixed" }),
      scopeFingerprint: hashCanonical({ scope: "fixed" }),
    }),
    origin: {
      kind: "trusted_runtime",
      producerId: "test:v1",
      adapterId: "test:v1",
    },
    effectiveInput: {},
    policy: {
      decision: "approval_required",
      policyRevision: hashCanonical({ policy: "fixed" }),
    },
    approval: {
      approvalId: "approval-revision",
      authorityRevision: hashCanonical({ upstream: "fixed" }),
    },
    preparedAt: "2026-08-03T00:00:00.000Z",
  });

  assert.notEqual(first.contractRevision, second.contractRevision);
  assert.notEqual(
    buildPrepared(first).approval?.authorityRevision,
    buildPrepared(second).approval?.authorityRevision,
  );
});

test("successful tool results require exact descriptor evidence", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.result-evidence",
    description: "Result evidence test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("read_only"),
    presentation: presentation("Result evidence"),
    handlerId: "test:result-evidence:handler:v1",
    resultNormalizerId: "test:result-evidence:normalizer:v1",
    handler: async () => ({ recorded: true }),
  });
  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "test.result-evidence",
    toolInput: {},
  });
  const parsed = parseAgentToolResultV2(result);
  assert.deepEqual(parsed.activation, parsed.outcome.activation);
  assert.match(parsed.activation.descriptor.contractRevision, /^sha256:[0-9a-f]{64}$/u);
});

test("allowlisted terminal cleanup releases session-owned snapshots", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.release",
    description: "Snapshot release test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("read_only"),
    presentation: presentation("Release"),
    handlerId: "test:release:handler:v1",
    resultNormalizerId: "test:release:normalizer:v1",
    handler: async () => ({}),
  });
  const gateway = new AllowlistedToolGateway([module]);
  const snapshot = await gateway.createToolSurfaceSnapshot({
    runContext: {
      runId: "waiting-run",
      sessionId: "allowlisted-session",
      payload: {},
      sessionState: {},
    },
  });

  gateway.releaseToolRun("continuation-run", "allowlisted-session");

  assert.throws(
    () => gateway.resolveModelToolIntent({
      snapshot,
      toolCall: { id: "stale", name: "test.release", input: {} },
    }),
    (error) =>
      error instanceof RuntimeFailure && error.code === "TOOL_SNAPSHOT_STALE",
  );
});

test("committed external effects never become retryable after output-contract failure", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.external",
    description: "External result contract test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    runtimeOutputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    capability: capability("external_side_effect"),
    presentation: presentation("External"),
    handlerId: "test:external:handler:v1",
    resultNormalizerId: "test:external:normalizer:v1",
    handler: async () => ({ wrong: true }),
  });
  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "test.external",
    toolInput: {},
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.outcome.kind, "failure");
  if (result.outcome.kind !== "failure") return;
  assert.equal(result.outcome.normalizedFailureCode, "TOOL_RESULT_CONTRACT_FAILED");
  assert.equal(result.outcome.effectState, "committed");
  assert.equal(result.outcome.retryable, false);
});

test("ambiguous external-effect handler failures remain terminal", async () => {
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.external.throwing",
    description: "Throws after an external dispatch may have started.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    runtimeOutputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("external_side_effect"),
    presentation: presentation("External throwing"),
    handlerId: "test:external-throwing:handler:v1",
    resultNormalizerId: "test:external-throwing:normalizer:v1",
    handler: async () => {
      throw createRuntimeFailure("REMOTE_WRITE_FAILED", "Remote response was lost.", {
        recoverable: true,
      });
    },
  });
  const result = await executeTestToolCall({
    gateway: new AllowlistedToolGateway([module]),
    toolName: "test.external.throwing",
    toolInput: {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.outcome.kind, "failure");
  assert.equal(result.outcome.effectState, "unknown");
  assert.equal(result.outcome.retryable, false);
});

test("external effects persist committed evidence when cancellation races after handler return", async () => {
  const abortController = new AbortController();
  const module = createEmbeddedToolModuleV1({
    ownerId: "kestrel.tests",
    toolId: "test.external.cancel-race",
    description: "Cancellation settlement test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: capability("external_side_effect"),
    presentation: presentation("External cancellation"),
    handlerId: "test:external-cancel-race:handler:v1",
    resultNormalizerId: "test:external-cancel-race:normalizer:v1",
    handler: async () => {
      abortController.abort();
      return {};
    },
  });
  const gateway = new AllowlistedToolGateway([module]);
  const prepared = await prepareTestToolCall({
    gateway,
    toolName: "test.external.cancel-race",
    toolInput: {},
  });

  const result = await gateway.executePreparedToolCall(prepared, {
    signal: abortController.signal,
  });

  assert.equal(result.status, "OK");
  assert.equal(result.outcome.kind, "success");
  assert.equal(result.outcome.effectState, "committed");
});

async function prepareModelIntent(
  registry: UnifiedToolRegistry,
  intent: ResolvedModelToolIntentV1,
): Promise<PreparedToolCallV1> {
  return registry.prepareToolCall({
    runId: "run-1",
    sessionId: "session-1",
    callId: intent.modelToolCallId,
    activation: intent.activation,
    origin: {
      kind: "model",
      snapshotId: intent.snapshotId,
      modelToolCallId: intent.modelToolCallId,
    },
    rawInput: intent.rawInput,
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ source: "test", intent }),
    },
  });
}

function capability(executionClass: "read_only" | "external_side_effect") {
  return {
    freshnessClass: "static" as const,
    latencyClass: "low" as const,
    costClass: "free" as const,
    executionClass,
    capabilityClasses: ["test"],
  };
}

function presentation(displayName: string) {
  return {
    displayName,
    aliases: [displayName.toLowerCase()],
    keywords: ["test"],
    provider: "test",
    toolFamily: "test",
  };
}
