import assert from "node:assert/strict";

import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_CAPABILITIES,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_HEALTH_VERSION,
  RUNNER_RUN_STREAM_EVENT_TYPES,
  RUNNER_WAITING_PROMPT_HISTORY_KIND,
  RunnerProtocolContractError,
  createRunnerHealthV1,
  parseRunnerResultV2,
  parseRunnerTerminalPayloadV2,
  parseRunnerHealthV1,
} from "../src/index.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("packages.hermetic", "runner health contract round-trips through the canonical parser", () => {
  const health = createRunnerHealthV1({ serviceVersion: "0.5.0-beta.0" });
  assert.deepEqual(parseRunnerHealthV1(health), health);
  assert.equal(health.version, RUNNER_HEALTH_VERSION);
  assert.equal(health.contracts.execution, EXECUTION_PROTOCOL_VERSION);
  assert.equal(health.contracts.command, RUNNER_COMMAND_CONTRACT_VERSION);
  assert.equal(health.contracts.events, RUNNER_EVENT_CONTRACT_VERSION);
  assert.equal(health.capabilities.includes("run.stream"), true);
  assert.equal(health.capabilities.includes("operator.inspect"), true);
  for (const capability of [
    "events.cursor",
    "job.run",
    "run.continue_on_disconnect",
    "workspace.promotion",
  ]) {
    assert.equal(
      health.capabilities.includes(capability),
      true,
      `runner health must advertise ${capability}`,
    );
    assert.equal(new Set<string>(RUNNER_CAPABILITIES).has(capability), true);
  }
});

contractTest("packages.hermetic", "runner health contract rejects legacy unversioned payloads", () => {
  assert.throws(
    () => parseRunnerHealthV1({ ok: true }),
    (error: unknown) => (
      error instanceof RunnerProtocolContractError
      && error.code === "RUNNER_HEALTH_INVALID"
      && /health\.version/u.test(error.message)
    ),
  );
});

contractTest("packages.hermetic", "runner health rejects the v1 event contract", () => {
  const health = createRunnerHealthV1({ serviceVersion: "0.6.0-beta.0" });
  assert.throws(
    () => parseRunnerHealthV1({
      ...health,
      contracts: { ...health.contracts, events: "dotted-runtime-events-v1" },
    }),
    /dotted-runtime-events-v3/u,
  );
});

contractTest("packages.hermetic", "runner health requires the aggregate Execution Protocol v3 contract", () => {
  const health = createRunnerHealthV1({ serviceVersion: "0.6.0-beta.0" });
  const { execution: _execution, ...withoutExecution } = health.contracts;
  assert.throws(
    () => parseRunnerHealthV1({
      ...health,
      contracts: withoutExecution,
    }),
    /execution-protocol-v3/u,
  );
  assert.throws(
    () => parseRunnerHealthV1({
      ...health,
      contracts: {
        ...health.contracts,
        execution: "execution-protocol-v1",
      },
    }),
    /execution-protocol-v3/u,
  );
});

contractTest("packages.hermetic", "v2 runner results require explicit assistant text without interpreting structured output", () => {
  const finalizedPayload = {
    message: "must not become assistant text",
    content: "also structured",
    text: "still structured",
  };
  const parsed = parseRunnerResultV2({
    output: { status: "COMPLETED" },
    assistantText: null,
    finalizedPayload,
  });
  assert.equal(parsed.assistantText, null);
  assert.equal(parsed.finalizedPayload, finalizedPayload);
  assert.throws(
    () => parseRunnerResultV2({ output: {}, finalizedPayload }),
    /assistantText is required/u,
  );
  assert.throws(
    () => parseRunnerResultV2({ output: {}, assistantText: "   " }),
    /null or a non-empty string/u,
  );
  assert.equal(
    parseRunnerResultV2({ output: {}, assistantText: "  committed response  " }).assistantText,
    "committed response",
  );
});

contractTest("packages.hermetic", "every v2 terminal payload requires a result while operator results are validated when present", () => {
  for (const type of ["run.completed", "run.failed", "run.cancelled"]) {
    assert.throws(
      () => parseRunnerTerminalPayloadV2(type, {}),
      /runner result must be an object/u,
    );
  }
  assert.deepEqual(
    parseRunnerTerminalPayloadV2("operator.controlled", { threadId: "thread-1" }),
    { threadId: "thread-1" },
  );
  assert.throws(
    () => parseRunnerTerminalPayloadV2("operator.controlled", {
      threadId: "thread-1",
      result: { output: {}, assistantText: "" },
    }),
    /non-empty string/u,
  );
});

contractTest("packages.hermetic", "public run stream event names separate operational, provider, and agent activity", () => {
  assert.equal(RUNNER_WAITING_PROMPT_HISTORY_KIND, "runtime.waiting_prompt");
  assert.deepEqual(RUNNER_RUN_STREAM_EVENT_TYPES, [
    "run.started",
    "run.cancelled",
    "run.tool.started",
    "run.tool.completed",
    "run.tool.failed",
    "run.log",
    "run.console",
    "run.progress",
    "run.model.reasoning.started",
    "run.model.reasoning.delta",
    "run.model.reasoning.completed",
    "run.model.reasoning.failed",
    "run.model.reasoning.unavailable",
    "run.agent_progress",
    "run.completed",
    "run.failed",
    "runner.error",
    "task.updated",
  ]);
});
