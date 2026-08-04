import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_BOUNDARIES,
  digestCanonicalValue,
  parseExecutionBoundaryDecisionEvidenceV1,
} from "../../src/kestrel/contracts/execution-boundary-policy.js";
import {
  EXECUTION_BOUNDARY_ADAPTERS,
  ExecutionBoundaryPolicyRuntime,
} from "../../src/security/ExecutionBoundaryPolicy.js";
import {
  EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS,
  EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS_VERSION,
  EXECUTION_BOUNDARY_CORPUS_SECRET,
} from "../proof/execution-boundary-adversarial-corpus.js";
import { buildDockerCreateCommand } from "../../src/code/DockerSandboxExecutor.js";
import type { SandboxExecutionInput } from "../../src/code/contracts.js";

test("execution-boundary corpus and registered adapters cover the canonical boundary set", () => {
  assert.deepEqual(
    EXECUTION_BOUNDARY_ADAPTERS.map((adapter) => adapter.boundary),
    EXECUTION_BOUNDARIES,
  );
  assert.equal(
    new Set(EXECUTION_BOUNDARY_ADAPTERS.map((adapter) => adapter.boundary)).size,
    EXECUTION_BOUNDARIES.length,
  );
  for (const fixture of EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS) {
    assert.equal(fixture.version, EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS_VERSION);
    assert.deepEqual(fixture.boundaries, EXECUTION_BOUNDARIES);
  }
});

test("every adversarial fixture traverses each declared boundary without gaining authority", () => {
  const runtime = corpusRuntime();
  for (const fixture of EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS) {
    for (const boundary of fixture.boundaries) {
      const source = boundary === "user_input"
        ? "user"
        : boundary.startsWith("tool_")
          ? "tool"
          : boundary.startsWith("model_")
            ? "model"
            : "runtime";
      const evaluated = runtime.evaluate({
        boundary,
        identity: {
          runId: `run:${fixture.id}`,
          sessionId: "session:corpus",
          callId: `call:${boundary}`,
        },
        source,
        trust: "data",
        sourceId: `fixture:${fixture.id}:${boundary}`,
        value: fixture.value,
      });
      const expectedOutcome = fixture.containsRegisteredSecret
        ? boundary === "assembly_change" || boundary === "tool_request"
          ? "QUARANTINE"
          : "REDACT"
        : "ALLOW";
      assert.equal(evaluated.decision.outcome, expectedOutcome, `${fixture.id}:${boundary}`);
      assert.equal(evaluated.decision.provenance.trust, "data");
      assert.equal(evaluated.decision.policyRevision, runtime.policy.revision);
      if (expectedOutcome === "REDACT") {
        assert.equal(JSON.stringify(evaluated.value).includes(EXECUTION_BOUNDARY_CORPUS_SECRET), false);
      } else if (!fixture.containsRegisteredSecret) {
        assert.deepEqual(evaluated.value, fixture.value);
      }
    }
  }
});

test("direct, child, retry, recovery, batch, wait, and replay contexts use the same adapter contract", () => {
  const runtime = corpusRuntime();
  const contexts = [
    "direct_adapter",
    "internal_operation",
    "child_agent",
    "provider_retry",
    "recovery_candidate",
    "batched_tool",
    "durable_wait",
    "recorded_replay",
  ] as const;
  for (const context of contexts) {
    const evaluated = runtime.evaluate({
      boundary: "tool_request",
      identity: { runId: `run:${context}`, sessionId: "session:contexts" },
      source: "model",
      trust: "data",
      sourceId: `context:${context}`,
      value: { context, input: EXECUTION_BOUNDARY_CORPUS_SECRET },
    });
    assert.equal(evaluated.decision.outcome, "QUARANTINE", context);
  }
});

test("replay evidence binds exactly one current decision to the persisted safe projection", () => {
  const runtime = corpusRuntime();
  const evaluated = runtime.evaluate({
    boundary: "tool_result",
    identity: {
      runId: "run:replay",
      sessionId: "session:replay",
      callId: "call:replay",
    },
    source: "tool",
    trust: "data",
    sourceId: "tool-result:replay",
    value: { output: EXECUTION_BOUNDARY_CORPUS_SECRET },
  });
  const expectation = {
    runId: "run:replay",
    sessionId: "session:replay",
    callId: "call:replay",
    policyId: runtime.policy.policyId,
    policyRevision: runtime.policy.revision,
    boundary: "tool_result" as const,
    outputDigest: digestCanonicalValue(evaluated.value),
  };
  assert.deepEqual(
    parseExecutionBoundaryDecisionEvidenceV1([evaluated.decision], expectation),
    evaluated.decision,
  );
  assert.throws(() => parseExecutionBoundaryDecisionEvidenceV1([], expectation), /exactly one/u);
  assert.throws(
    () => parseExecutionBoundaryDecisionEvidenceV1(
      [evaluated.decision, evaluated.decision],
      expectation,
    ),
    /exactly one/u,
  );
  assert.throws(
    () => parseExecutionBoundaryDecisionEvidenceV1(
      [{ ...evaluated.decision, policyRevision: `sha256:${"0".repeat(64)}` }],
      expectation,
    ),
    /does not match/u,
  );
  assert.throws(
    () => parseExecutionBoundaryDecisionEvidenceV1(
      [{ ...evaluated.decision, outputDigest: "malformed" }],
      expectation,
    ),
    /canonical SHA-256/u,
  );
  assert.throws(
    () => parseExecutionBoundaryDecisionEvidenceV1(
      [{ ...evaluated.decision, boundary: "assistant_output" }],
      expectation,
    ),
    /does not match/u,
  );
});

test("Docker execution keeps every adversarial fixture out of sandbox authority flags", () => {
  for (const fixture of EXECUTION_BOUNDARY_ADVERSARIAL_CORPUS) {
    const input: SandboxExecutionInput = {
      request: {
        language: "javascript",
        code: `const fixture = ${JSON.stringify(fixture.value)}; console.log(typeof fixture);`,
      },
      policy: {
        enabled: true,
        approvalMode: "auto",
        executor: "docker",
        language: "javascript",
        timeoutMs: 5_000,
        memoryMb: 128,
        cpuShares: 128,
        pidsLimit: 64,
        workspaceSizeMb: 32,
        workspaceInodes: 1_024,
        tmpSizeMb: 16,
        tmpInodes: 512,
        network: "off",
        allowDependencyInstall: false,
        maxOutputBytes: 32_000,
        maxArtifacts: 20,
        maxArtifactBytes: 64_000,
      },
    };
    const command = buildDockerCreateCommand(input, `corpus-${fixture.id}`);
    assert.equal(command.includes("--read-only"), true, fixture.id);
    assert.equal(argumentAfter(command, "--cap-drop"), "ALL", fixture.id);
    assert.equal(argumentAfter(command, "--security-opt"), "no-new-privileges", fixture.id);
    assert.equal(argumentAfter(command, "--network"), "none", fixture.id);
    assert.equal(command.join(" ").includes(JSON.stringify(fixture.value)), false, fixture.id);
  }
});

function corpusRuntime(): ExecutionBoundaryPolicyRuntime {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  runtime.sensitiveValues.register({
    reference: {
      referenceId: "credential:corpus",
      kind: "credential",
      scope: "conformance",
    },
    value: EXECUTION_BOUNDARY_CORPUS_SECRET,
  });
  return runtime;
}

function argumentAfter(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index < 0 ? undefined : command[index + 1];
}
