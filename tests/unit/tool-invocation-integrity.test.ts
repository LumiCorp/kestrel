import test from "node:test";
import assert from "node:assert/strict";

import {
  AllowlistedToolGateway,
  createEmbeddedToolModuleV1,
} from "../../src/io/ToolGateway.js";
import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";
import type {
  PreparedToolCallV1,
  ResolvedModelToolIntentV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
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
    return { content: [{ type: "text", text: this.version }] } as T;
  }

  pinTool(name: string) {
    assert.equal(name, TOOL_ID);
    const pinnedVersion = this.version;
    let references = 1;
    this.references += 1;
    return {
      call: async <T>(_input: unknown) => ({
        content: [{ type: "text", text: pinnedVersion }],
      }) as T,
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
