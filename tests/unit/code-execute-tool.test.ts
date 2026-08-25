import test from "node:test";
import assert from "node:assert/strict";

import { codeExecuteTool } from "../../tools/code/execute.js";
import {
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeModeProfileConfig,
  type CodeExecutionServicePort,
} from "../../src/code/contracts.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../../src/security/ExecutionBoundaryPolicy.js";
import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";


test("code.execute forwards parsed request to execution service", async () => {
  let capturedConfig: CodeModeProfileConfig | undefined;
  let capturedRequest: CodeExecutionRequest | undefined;
  let capturedSignal: AbortSignal | undefined;
  const controller = new AbortController();

  const service: CodeExecutionServicePort = {
    async execute(config, request, options): Promise<CodeExecutionResult> {
      capturedConfig = config;
      capturedRequest = request;
      capturedSignal = options?.signal;
      return {
        status: "ok",
        exitCode: 0,
        stdout: "hi",
        stderr: "",
        durationMs: 10,
        artifacts: [],
        summary: "ok",
        policy: {
          enabled: true,
          approvalMode: "auto",
          executor: "docker",
          language: "javascript",
          timeoutMs: 1000,
          memoryMb: 256,
          cpuShares: 256,
          pidsLimit: 64,
          workspaceSizeMb: 64,
          workspaceInodes: 8_192,
          tmpSizeMb: 32,
          tmpInodes: 2_048,
          network: "off",
          allowDependencyInstall: false,
          maxOutputBytes: 100,
          maxArtifacts: 1,
          maxArtifactBytes: 100,
        },
        retention: {
          persistSummary: true,
          persistArtifacts: true,
        },
      };
    },
  };

  const handler = codeExecuteTool.createHandler({
    codeExecutionService: service,
    codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG,
    signal: controller.signal,
  });

  const result = await handler({
    language: "javascript",
    code: "console.log('hi')",
    timeoutMs: 1234,
    args: ["--flag"],
  });

  assert.equal((result as { status: string }).status, "ok");
  assert.equal(capturedConfig?.enabled, true);
  assert.equal(capturedRequest?.language, "javascript");
  assert.equal(capturedRequest?.timeoutMs, 1234);
  assert.deepEqual(capturedRequest?.args, ["--flag"]);
  assert.equal(capturedSignal, controller.signal);
});

test("code.execute rejects invalid inputs", async () => {
  const handler = codeExecuteTool.createHandler({
    codeExecutionService: {
      async execute(_config, _request) {
        throw new Error("should not execute");
      },
    },
    codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG,
  });

  await assert.rejects(
    () => handler({ language: "javascript" }),
    /Missing required string field 'code'|requires non-empty 'code'/,
  );
  await assert.rejects(
    () => handler({ code: "print('x')" }),
    /requires language|requires 'language'/,
  );
});

test("code.execute exposes only the selector input and carries the exact prepared call identity", async () => {
  const capability = {
    version: 1 as const, capabilityId: "tavily.search.read" as const, operations: ["search"] as ["search"],
    resource: "https://api.tavily.com/search" as const,
    audience: { tenantId: "tenant-a", environmentId: "env-a" }, maxRequests: 1 as const,
    maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000,
    brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
  };
  let capturedOptions: Parameters<CodeExecutionServicePort["execute"]>[2];
  const handler = codeExecuteTool.createHandler({
    codeMode: { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [capability] },
    runtime: { runId: "run-a", sessionId: "session-a", toolCallId: "tool-call-a" },
    sandboxCapabilityRuntime: {
      tenantId: "tenant-a", environmentId: "env-a",
      profileFingerprint: "a".repeat(64),
      capabilityCatalogFingerprint: "c".repeat(64),
      executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
      brokerAuthority: capability.brokerAuthority,
      credentialSnapshot: { credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" },
      preparedPolicy: { decision: "allow", policyRevision: "policy-r1" },
    },
    codeExecutionService: { async execute(_config, _request, options) { capturedOptions = options; return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [], summary: "ok", policy: { enabled: true, approvalMode: "auto", executor: "docker", language: "javascript", timeoutMs: 1000, memoryMb: 128, cpuShares: 128, pidsLimit: 64, workspaceSizeMb: 32, workspaceInodes: 100, tmpSizeMb: 16, tmpInodes: 100, network: "off", allowDependencyInstall: false, maxOutputBytes: 1000, maxArtifacts: 1, maxArtifactBytes: 1000 }, retention: { persistSummary: true, persistArtifacts: true } }; } },
  });
  await handler({ language: "javascript", code: "x", capability: { version: 2, capabilityId: "tavily.search.read", operation: "search", input: { query: "q" } } });
  assert.equal(capturedOptions?.capabilityRuntime?.toolCallId, "tool-call-a");
  await assert.rejects(() => handler({ language: "javascript", code: "x", capability: { version: 2, capabilityId: "tavily.search.read", operation: "search", input: { query: "q" }, credentialReference: "forged" } }), /unknown field/u);
  const capabilitySchema = (codeExecuteTool.definition.inputSchema.properties as Record<string, unknown>).capability;
  assert.equal(JSON.stringify(capabilitySchema).includes("credential"), false);
  assert.equal(JSON.stringify(capabilitySchema).includes("destination"), false);
});

test("UnifiedToolRegistry preserves capability selection and binds the prepared call ID", async () => {
  const capability = {
    version: 1 as const, capabilityId: "tavily.search.read" as const, operations: ["search"] as ["search"], resource: "https://api.tavily.com/search" as const,
    audience: { tenantId: "tenant-a", environmentId: "env-a" }, maxRequests: 1 as const, maxQueryChars: 100, maxResults: 3, maxResponseBytes: 4096,
    timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "broker-a", revision: "broker-r1" },
  };
  let capturedRequest: CodeExecutionRequest | undefined;
  let capturedOptions: Parameters<CodeExecutionServicePort["execute"]>[2];
  const registry = new UnifiedToolRegistry({ allowlist: ["code.execute"], context: {
    codeMode: { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [capability] },
    sandboxCapabilityRuntime: {
      tenantId: "tenant-a", environmentId: "env-a", profileFingerprint: "b".repeat(64), capabilityCatalogFingerprint: "c".repeat(64), executionBoundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
      brokerAuthority: capability.brokerAuthority, credentialSnapshot: { credentialId: "tool.tavily.default", revision: "credential-r1", secret: "secret" },
    },
    codeExecutionService: { async execute(_config, request, options) { capturedRequest = request; capturedOptions = options; return { status: "ok", exitCode: 0, stdout: "", stderr: "", durationMs: 1, artifacts: [], summary: "ok", policy: { enabled: true, approvalMode: "auto", executor: "docker", language: "javascript", timeoutMs: 1000, memoryMb: 128, cpuShares: 128, pidsLimit: 64, workspaceSizeMb: 32, workspaceInodes: 100, tmpSizeMb: 16, tmpInodes: 100, network: "off", allowDependencyInstall: false, maxOutputBytes: 1000, maxArtifacts: 1, maxArtifactBytes: 1000 }, retention: { persistSummary: true, persistArtifacts: true } }; } },
  } });
  const snapshot = await registry.createToolSurfaceSnapshot({ toolNames: ["code.execute"] });
  const intent = registry.resolveModelToolIntent({ snapshot, toolCall: { id: "prepared-call-exact", name: "code.execute", input: { language: "javascript", code: "x", capability: { version: 2, capabilityId: "tavily.search.read", operation: "search", input: { query: "q" } } } } });
  const prepared = await registry.prepareToolCall({ runId: "run-a", sessionId: "session-a", callId: intent.modelToolCallId, activation: intent.activation, origin: { kind: "model", snapshotId: intent.snapshotId, modelToolCallId: intent.modelToolCallId }, rawInput: intent.rawInput, policy: { decision: "allow", policyRevision: hashCanonical({ test: "code-execute-capability" }) } });
  const result = await registry.executePreparedToolCall(prepared);
  assert.equal(result.status, "OK", JSON.stringify(result));
  assert.equal(capturedRequest?.capability?.capabilityId, "tavily.search.read");
  assert.equal(capturedOptions?.capabilityRuntime?.toolCallId, "prepared-call-exact");
  for (const forged of ["authority", "credentialReference", "lease", "unknown"]) {
    const forgedIntent = registry.resolveModelToolIntent({ snapshot, toolCall: { id: `forged-${forged}`, name: "code.execute", input: { language: "javascript", code: "x", [forged]: "forged" } } });
    await assert.rejects(() => registry.prepareToolCall({ runId: "run-a", sessionId: "session-a", callId: forgedIntent.modelToolCallId, activation: forgedIntent.activation, origin: { kind: "model", snapshotId: forgedIntent.snapshotId, modelToolCallId: forgedIntent.modelToolCallId }, rawInput: forgedIntent.rawInput, policy: { decision: "allow", policyRevision: hashCanonical({ forged }) } }), /unknown fields/u);
  }
});

test("UnifiedToolRegistry advertises capability only when authored by the resolved profile", () => {
  const absent = new UnifiedToolRegistry({ allowlist: ["code.execute"], context: { codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG } });
  const absentSchema = absent.getModelTools().find((tool) => tool.name === "code.execute")?.inputSchema as { properties: Record<string, unknown> };
  assert.equal("capability" in absentSchema.properties, false);
  const capability = { version: 1 as const, capabilityId: "tavily.search.read" as const, operations: ["search"] as ["search"], resource: "https://api.tavily.com/search" as const, audience: { tenantId: "t", environmentId: "e" }, maxRequests: 1 as const, maxQueryChars: 100, maxResults: 2, maxResponseBytes: 4096, timeoutMs: 1000, maxExpiryMs: 5000, brokerAuthority: { authorityId: "b", revision: "r" } };
  const authored = new UnifiedToolRegistry({ allowlist: ["code.execute"], context: { codeMode: { ...DEFAULT_CODE_MODE_ENABLED_CONFIG, capabilities: [capability] } } });
  const schema = authored.getModelTools().find((tool) => tool.name === "code.execute")?.inputSchema as {
    properties: Record<string, { oneOf?: Array<{ properties?: Record<string, { const?: unknown }> }> }>;
  };
  assert.equal(schema.properties.capability?.oneOf?.length, 1);
  assert.equal(schema.properties.capability?.oneOf?.[0]?.properties?.version?.const, 2);
  assert.equal(schema.properties.capability?.oneOf?.[0]?.properties?.capabilityId?.const, "tavily.search.read");
  assert.equal(schema.properties.capability?.oneOf?.[0]?.properties?.operation?.const, "search");
});
