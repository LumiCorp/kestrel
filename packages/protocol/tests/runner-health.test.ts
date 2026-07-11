import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_HEALTH_VERSION,
  RUNNER_RUN_STREAM_EVENT_TYPES,
  createRunnerHealthV1,
  parseRunnerHealthV1,
} from "../src/index.js";

test("runner health contract round-trips through the canonical parser", () => {
  const health = createRunnerHealthV1({ serviceVersion: "0.5.0-beta.0" });
  assert.deepEqual(parseRunnerHealthV1(health), health);
  assert.equal(health.version, RUNNER_HEALTH_VERSION);
  assert.equal(health.contracts.command, RUNNER_COMMAND_CONTRACT_VERSION);
  assert.equal(health.contracts.events, RUNNER_EVENT_CONTRACT_VERSION);
  assert.equal(health.capabilities.includes("run.stream"), true);
  assert.equal(health.capabilities.includes("operator.inspect"), true);
});

test("runner health contract rejects legacy unversioned payloads", () => {
  assert.throws(
    () => parseRunnerHealthV1({ ok: true }),
    /health\.version/u,
  );
});

test("public run stream event names include tool and console activity", () => {
  assert.deepEqual(RUNNER_RUN_STREAM_EVENT_TYPES, [
    "run.started",
    "run.cancelled",
    "run.tool.started",
    "run.tool.completed",
    "run.tool.failed",
    "run.log",
    "run.console",
    "run.progress",
    "run.reasoning",
    "run.completed",
    "run.failed",
    "runner.error",
    "task.updated",
  ]);
});
