import test from "node:test";
import assert from "node:assert/strict";

import type { AgentToolResult, ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import type { RecoveryModelCandidateV1 } from "../../src/kestrel/contracts/recovery.js";
import {
  RecoveryModelRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  createDefaultRecoveryToolResultNormalizers,
  registerDefaultRecoveryWorkflowHandlers,
} from "../../src/engine/recovery/RecoveryRegistries.js";

test("registered recovery models, tools, normalizers, and workflows pass one conformance harness", async () => {
  const policyRevision = `sha256:${"a".repeat(64)}`;
  const models = new RecoveryModelRegistry();
  const modelCalls: string[] = [];
  for (const candidate of [
    modelCandidate("primary", "openai", "gpt-primary"),
    modelCandidate("alternate", "anthropic", "claude-alternate"),
  ]) {
    const gateway: ModelGateway = {
      call: async <T>() => {
        modelCalls.push(candidate.candidateId);
        return { candidateId: candidate.candidateId } as T;
      },
    };
    models.register({ candidate, policyRevision, gateway });
  }

  for (const registration of models.list()) {
    const resolved = models.resolve({
      candidate: registration.candidate,
      policyRevision,
    });
    assert.ok(resolved, registration.candidate.candidateId);
    assert.deepEqual(await resolved.gateway.call({ input: "conformance" }), {
      candidateId: registration.candidate.candidateId,
    });
  }
  assert.deepEqual(modelCalls, ["primary", "alternate"]);

  const adapters = new RecoveryToolAdapterRegistry();
  adapters.register({
    adapterId: "code-to-shell",
    sourceToolId: "code.execute",
    targetToolId: "dev.exec",
    targetAuthority: {
      toolClass: "sandboxed_only",
      capabilities: ["shell.exec"],
      revision: "dev-exec-v1",
    },
    validateSource: (input) => {
      assert.deepEqual(input, { code: "echo ready" });
    },
    transformInput: () => ({ command: "echo ready" }),
    normalizeResult: (result) => result,
  });
  for (const adapter of adapters.list()) {
    const context = {
      runId: "run-conformance",
      sessionId: "session-conformance",
      sourceToolId: adapter.sourceToolId,
      targetToolId: adapter.targetToolId,
    };
    const resolved = adapters.resolve(adapter);
    assert.ok(resolved, adapter.adapterId);
    resolved.validateSource({ code: "echo ready" }, context);
    assert.deepEqual(resolved.transformInput({ code: "echo ready" }, context), {
      command: "echo ready",
    });
    assert.equal(resolved.normalizeResult(toolResult("ok"), context).status, "OK");
  }

  const normalizers = createDefaultRecoveryToolResultNormalizers();
  const normalizerFixtures: Record<string, AgentToolResult> = {
    "code.execute": toolResult("runtime_unavailable"),
  };
  for (const toolId of normalizers.listToolIds()) {
    const fixture = normalizerFixtures[toolId];
    assert.ok(fixture, `Missing conformance fixture for ${toolId}`);
    assert.deepEqual(normalizers.normalize(toolId, fixture), {
      status: "failure",
      failureCode: "SANDBOX_UNAVAILABLE",
    });
  }

  const workflows = new RecoveryWorkflowHandlerRegistry();
  registerDefaultRecoveryWorkflowHandlers(workflows);
  for (const handlerId of workflows.listHandlerIds()) {
    const handler = workflows.resolve(handlerId);
    assert.ok(handler, handlerId);
    assert.equal(await handler({
      runId: "run-conformance",
      sessionId: "session-conformance",
      failureCode: "CONFORMANCE_PROBE",
      execute: async () => handlerId,
    }), handlerId);
  }
  assert.deepEqual(workflows.listHandlerIds(), [
    "context.compaction",
    "run.continuation",
    "run.loop_recovery",
    "evaluation.revise",
  ]);
});

function modelCandidate(
  candidateId: string,
  provider: RecoveryModelCandidateV1["provider"],
  model: string,
): RecoveryModelCandidateV1 {
  return {
    candidateId,
    provider,
    model,
    capabilities: {
      visionInputEnabled: false,
      toolCallingEnabled: true,
      structuredOutputEnabled: true,
      reasoningModes: ["off", "summary"],
    },
  };
}

function toolResult(status: string): AgentToolResult {
  return {
    toolName: "code.execute",
    status: "OK",
    modelContext: { text: "", rawOutputRef: "conformance", truncated: false },
    auditRecord: {
      toolName: "code.execute",
      input: {},
      output: { status },
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      durationMs: 1000,
      status: "OK",
    },
  };
}
