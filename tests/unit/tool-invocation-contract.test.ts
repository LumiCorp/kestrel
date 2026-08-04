import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  parseAgentToolResultV2,
  parsePreparedToolCallV1,
  parseRunToolUpdateV2,
  parseToolExecutionOutcomeV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

const descriptor = defaultToolCatalog.getDescriptorRef("FinalizeAnswer");
if (descriptor === undefined) throw new Error("FinalizeAnswer descriptor missing");
const activation = createToolActivationRefV1({
  descriptor,
  registryGeneration: "generation-1",
  scopeFingerprint: fingerprintToolScopeV1({
    tenant: "tenant-a",
    environment: "environment-a",
    gateway: "local-core",
    authorizationScope: ["runtime"],
  }),
});
const timestamp = "2026-08-03T12:00:00.000Z";

test("prepared calls accept only exact model or trusted-runtime origins", () => {
  const prepared = parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "session-1",
    callId: "call-1",
    activation,
    origin: {
      kind: "model",
      snapshotId: hashCanonical({ request: "model-1" }),
      modelToolCallId: "model-call-1",
    },
    effectiveInput: { message: "done" },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ policy: "v1" }),
    },
    preparedAt: timestamp,
  });
  assert.equal(prepared.origin.kind, "model");
  assert.equal(Object.isFrozen(prepared), true);

  assert.throws(
    () =>
      parsePreparedToolCallV1({
        ...prepared,
        origin: { kind: "trusted_runtime", producerId: "recovery" },
      }),
    /adapterId/u,
  );
  assert.throws(
    () =>
      parsePreparedToolCallV1({
        ...prepared,
        origin: { kind: "replay", evidenceId: "old" },
      }),
    /origin (?:contains unknown field|kind is invalid)/u,
  );
});

test("tool outcomes require normalized terminal evidence and forbid retry after commit", () => {
  const failure = parseToolExecutionOutcomeV1({
    version: "v1",
    callId: "call-1",
    activation,
    kind: "failure",
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_started",
    normalizedFailureCode: "TOOL_RESULT_CONTRACT_FAILED",
    retryable: false,
    error: { message: "output rejected" },
  });
  assert.equal(failure.kind, "failure");
  assert.throws(
    () =>
      parseToolExecutionOutcomeV1({
        ...failure,
        effectState: "committed",
        retryable: true,
      }),
    /committed external effect cannot be retryable/u,
  );
  assert.throws(
    () =>
      parseToolExecutionOutcomeV1({
        ...failure,
        kind: "cancellation",
        normalizedFailureCode: "SOMETHING_ELSE",
      }),
    /must be TOOL_CANCELLED and terminal/u,
  );
});

test("V2 result and run updates require one agreeing activation identity", () => {
  const outcome = parseToolExecutionOutcomeV1({
    version: "v1",
    callId: "call-1",
    activation,
    kind: "success",
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_applicable",
    rawOutput: { accepted: true },
  });
  const result = parseAgentToolResultV2({
    version: "v2",
    toolName: "FinalizeAnswer",
    status: "OK",
    toolCallId: "call-1",
    activation,
    outcome,
    modelContext: {
      text: "accepted",
      rawOutputRef: "sha256:artifact",
      truncated: false,
    },
    auditRecord: {
      toolName: "FinalizeAnswer",
      input: { message: "done" },
      output: { accepted: true },
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      status: "OK",
    },
  });
  assert.equal(result.activation.descriptor.contractRevision, descriptor.contractRevision);

  const update = parseRunToolUpdateV2({
    version: "v2",
    runId: "run-1",
    sessionId: "session-1",
    ts: timestamp,
    seq: 1,
    toolCallId: "call-1",
    toolName: "FinalizeAnswer",
    activation,
    phase: "completed",
    outcome,
    output: { accepted: true },
  });
  assert.equal(update.outcome?.kind, "success");

  assert.throws(
    () => parseAgentToolResultV2({ ...result, toolCallId: "call-other" }),
    /evidence identities do not agree/u,
  );
  assert.throws(
    () =>
      parseRunToolUpdateV2({
        ...update,
        activation: {
          ...activation,
          descriptor: { ...descriptor, toolId: "other" },
        },
      }),
    /activation does not match toolName/u,
  );
});
