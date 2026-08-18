import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_BOUNDARIES,
  createExecutionBoundaryPolicyV1,
  parseBoundaryContentProvenanceV1,
  parseExecutionBoundaryDecisionV1,
  parseExecutionBoundaryPolicyV1,
} from "../../src/kestrel/contracts/execution-boundary-policy.js";
import {
  DeterministicStreamingRedactor,
  ExecutionBoundaryPolicyRuntime,
  KESTREL_EXECUTION_BOUNDARY_POLICY,
  SensitiveValueRegistry,
  deriveSensitiveRepresentations,
} from "../../src/security/ExecutionBoundaryPolicy.js";
import { fingerprintResolvedProfile } from "../../src/profile/kestrelOnePolicy.js";
import type { TuiProfile } from "../../cli/contracts.js";

test("execution-boundary policy is canonical, immutable, and rejects unsupported authoring", () => {
  const recreated = createExecutionBoundaryPolicyV1({
    policyId: KESTREL_EXECUTION_BOUNDARY_POLICY.policyId,
    owner: KESTREL_EXECUTION_BOUNDARY_POLICY.owner,
    changeId: KESTREL_EXECUTION_BOUNDARY_POLICY.changeId,
    supersedesRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.supersedesRevision,
    enforcement: "enforce",
    boundaries: [...EXECUTION_BOUNDARIES],
  });
  assert.deepEqual(recreated, KESTREL_EXECUTION_BOUNDARY_POLICY);
  assert.equal(recreated.changeId, "execution-boundary-integrity-v2");
  assert.match(recreated.supersedesRevision ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.throws(
    () => parseExecutionBoundaryPolicyV1({
      ...recreated,
      exceptions: [{ boundary: "tool_request" }],
    }),
    /unsupported field 'exceptions'/u,
  );
  assert.throws(
    () => parseExecutionBoundaryPolicyV1({
      ...recreated,
      patterns: ["secret"],
    }),
    /unsupported field 'patterns'/u,
  );
  assert.throws(
    () => parseExecutionBoundaryPolicyV1({
      ...recreated,
      owner: "different-owner",
    }),
    /revision does not match/u,
  );
  assert.throws(
    () => createExecutionBoundaryPolicyV1({
      policyId: recreated.policyId,
      owner: recreated.owner,
      changeId: "missing-boundary",
      enforcement: "enforce",
      boundaries: EXECUTION_BOUNDARIES.slice(1),
    }),
    /exact canonical boundary order/u,
  );
});

test("only runtime provenance may carry control trust", () => {
  assert.throws(
    () => parseBoundaryContentProvenanceV1({
      version: "boundary_content_provenance_v1",
      source: "user",
      trust: "control",
      sourceId: "forged-control",
      contentDigest: `sha256:${"a".repeat(64)}`,
    }),
    /Only runtime provenance/u,
  );
});

test("missing policy boundary declarations fail closed at evaluation", () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  runtime.policy.boundaries.splice(
    runtime.policy.boundaries.indexOf("tool_request"),
    1,
  );
  assert.throws(
    () => runtime.evaluate({
      boundary: "tool_request",
      identity: { runId: "run-missing-policy", sessionId: "session-missing-policy" },
      source: "model",
      trust: "data",
      sourceId: "missing-policy",
      value: { command: "safe" },
    }),
    /does not declare 'tool_request'/u,
  );
});

test("sensitive registry derives the closed encoding set and redacts without serializing material", () => {
  const secret = "boundary-secret-ÿÿ";
  const representations = deriveSensitiveRepresentations(secret);
  assert.ok(representations.includes(secret));
  assert.ok(representations.includes(Buffer.from(secret).toString("base64")));
  assert.ok(representations.includes(Buffer.from(secret).toString("base64url")));
  assert.ok(representations.includes(Buffer.from(secret).toString("hex")));
  assert.ok(representations.includes(Buffer.from(secret).toString("hex").toUpperCase()));
  assert.ok(representations.includes(encodeURIComponent(secret)));

  const registry = new SensitiveValueRegistry();
  registry.register({
    reference: {
      referenceId: "credential:test",
      kind: "credential",
      scope: "test",
    },
    value: secret,
  });
  const result = registry.redact({
    raw: secret,
    base64: Buffer.from(secret).toString("base64"),
    nested: [{ value: Buffer.from(secret).toString("hex").toUpperCase() }],
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.value, {
    raw: "[REDACTED]",
    base64: "[REDACTED]",
    nested: [{ value: "[REDACTED]" }],
  });
  assert.deepEqual(result.references.map((reference) => reference.referenceId), [
    "credential:test",
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("streaming redactor catches a registered value split across chunks", () => {
  const registry = new SensitiveValueRegistry();
  registry.register({
    reference: {
      referenceId: "credential:stream",
      kind: "credential",
      scope: "test",
    },
    value: "stream-secret-value",
  });
  const stream = new DeterministicStreamingRedactor(registry);
  const output = [
    stream.push("prefix stream-se"),
    stream.push("cret-value suffix"),
    stream.flush(),
  ].join("");
  assert.equal(output, "prefix [REDACTED] suffix");
});

test("live execution boundaries redact split values without durable decisions", async () => {
  const registry = new SensitiveValueRegistry();
  registry.register({
    reference: {
      referenceId: "credential:live-stream",
      kind: "credential",
      scope: "test",
    },
    value: "live-stream-secret",
  });
  const runtime = new ExecutionBoundaryPolicyRuntime({ sensitiveValues: registry });
  const stream = runtime.openLiveStream({
    boundary: "model_stream",
    identity: { runId: "run-live", sessionId: "session-live", stepIndex: 1 },
    source: "model",
    trust: "data",
    sourceId: "reasoning:run-live:1:summary",
  });

  const output = [
    stream.push("prefix live-stream-se"),
    stream.push("cret suffix"),
    stream.close(),
  ].join("");

  assert.equal(output, "prefix [REDACTED] suffix");
  assert.throws(() => stream.push("late"), /already closed/u);
  assert.throws(() => stream.close(), /already closed/u);
  await assert.rejects(
    () => runtime.evaluateAndPersist({
      boundary: "model_stream",
      identity: { runId: "run-live", sessionId: "session-live" },
      source: "model",
      trust: "data",
      sourceId: "reasoning:run-live:1:summary",
      value: "safe",
      persist: async () => {},
    }),
    /live enforcement/u,
  );
  assert.throws(
    () => runtime.openLiveStream({
      boundary: "model_request",
      identity: { runId: "run-live", sessionId: "session-live" },
      source: "runtime",
      trust: "data",
      sourceId: "request:run-live:1",
    }),
    /durable decision/u,
  );
});

test("discarded live execution boundaries release buffered material and close", () => {
  const registry = new SensitiveValueRegistry();
  registry.register({
    reference: {
      referenceId: "credential:discarded-stream",
      kind: "credential",
      scope: "test",
    },
    value: "discarded-stream-secret",
  });
  const runtime = new ExecutionBoundaryPolicyRuntime({ sensitiveValues: registry });
  const stream = runtime.openLiveStream({
    boundary: "tool_stream",
    identity: { runId: "run-discard", sessionId: "session-discard", callId: "tool-1" },
    source: "tool",
    trust: "data",
    sourceId: "tool-stream:tool-1:dev.shell.run",
  });

  assert.equal(stream.push("discarded-stream-se"), "");
  stream.discard();
  assert.throws(() => stream.push("cret"), /already closed/u);
  assert.throws(() => stream.close(), /already closed/u);
});

test("boundary decisions redact output, quarantine executable input, and persist before return", async () => {
  const registry = new SensitiveValueRegistry();
  registry.register({
    reference: {
      referenceId: "credential:runtime",
      kind: "credential",
      scope: "runtime",
    },
    value: "registered-secret",
  });
  const runtime = new ExecutionBoundaryPolicyRuntime({ sensitiveValues: registry });
  const persisted: unknown[] = [];
  const redacted = await runtime.evaluateAndPersist({
    boundary: "model_request",
    identity: { runId: "run-1", sessionId: "session-1", callId: "call-1" },
    source: "runtime",
    trust: "data",
    sourceId: "request-1",
    value: { input: "registered-secret" },
    persist: (decision) => {
      persisted.push(decision);
    },
  });
  assert.deepEqual(redacted.value, { input: "[REDACTED]" });
  assert.equal(redacted.decision.outcome, "REDACT");
  assert.equal(JSON.stringify(redacted.decision).includes("registered-secret"), false);
  assert.deepEqual(parseExecutionBoundaryDecisionV1(persisted[0]), redacted.decision);

  const quarantined = runtime.evaluate({
    boundary: "tool_request",
    identity: { runId: "run-1", sessionId: "session-1", callId: "tool-1" },
    source: "model",
    trust: "data",
    sourceId: "tool-1",
    value: { command: "send registered-secret" },
  });
  assert.equal(quarantined.decision.outcome, "QUARANTINE");
  assert.deepEqual(quarantined.value, { command: "send registered-secret" });

  let crossed = false;
  await assert.rejects(
    runtime.evaluateAndPersist({
      boundary: "assistant_output",
      identity: { runId: "run-1", sessionId: "session-1" },
      source: "runtime",
      trust: "data",
      sourceId: "assistant-1",
      value: "registered-secret",
      persist: async () => {
        throw new Error("persistence unavailable");
      },
    }).then(() => {
      crossed = true;
    }),
    /persistence unavailable/u,
  );
  assert.equal(crossed, false);
});

test("boundary crossing remains blocked until durable decision persistence settles", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let crossed = false;
  const pending = runtime.evaluateAndPersist({
    boundary: "model_request",
    identity: { runId: "run-interrupt", sessionId: "session-interrupt" },
    source: "runtime",
    trust: "data",
    sourceId: "request-interrupt",
    value: { prompt: "safe" },
    persist: () => persistenceGate,
  }).then((result) => {
    crossed = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(crossed, false);
  releasePersistence?.();
  await pending;
  assert.equal(crossed, true);
});

test("resolved profile fingerprints include the execution-boundary policy revision", () => {
  const profile = {
    id: "profile",
    label: "Profile",
    agent: "reference-react",
    sessionPrefix: "profile",
  } satisfies TuiProfile;
  const fingerprint = fingerprintResolvedProfile(profile);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(
    fingerprintResolvedProfile(profile),
    fingerprint,
  );
  assert.notEqual(
    fingerprintResolvedProfile(profile, { sourceRevision: "different" }),
    fingerprint,
  );
});
