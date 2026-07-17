import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL,
  SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS,
  SDK_AGENT_SHAKEDOWN_SCENARIOS,
  readSdkAgentShakedownToolObservation,
  selectSdkAgentShakedownScenarios,
  validateSdkAgentShakedownObservation,
  type SdkAgentShakedownScenario,
  type SdkAgentShakedownToolObservation,
} from "../../scripts/lib/sdk-agent-shakedown.js";

test("SDK agent shake-down receives the project environment in managed worktrees", async () => {
  const worktreeIncludes = (await readFile(
    new URL("../../.worktreeinclude", import.meta.url),
    "utf8",
  ))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith("#") === false);
  const script = await readFile(
    new URL("../../scripts/sdk-agent-shakedown.ts", import.meta.url),
    "utf8",
  );

  assert.ok(worktreeIncludes.includes(".env"));
  assert.match(script, /loadShellAndDotEnv\(process\.cwd\(\),/u);
  assert.doesNotMatch(script, /git-common-dir|resolvePrimaryCheckoutRoot/u);
});

test("SDK agent shake-down uses the mini model and explicit core scenario matrix", () => {
  assert.equal(SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL, "openai/gpt-5.4-mini");
  assert.deepEqual(
    SDK_AGENT_SHAKEDOWN_SCENARIOS.map((scenario) => scenario.id),
    ["read", "filesystem", "exec"],
  );
  assert.deepEqual(
    selectSdkAgentShakedownScenarios(["exec", "read"]).map((scenario) => scenario.id),
    ["read", "exec"],
  );
  assert.throws(
    () => selectSdkAgentShakedownScenarios(["provider-write"]),
    /Unknown SDK shake-down scenario/u,
  );
});

test("SDK agent shake-down requires each exact public tool contract", () => {
  const scenario = readScenario();
  const tools = scenario.requiredTools.flatMap((requirement) =>
    Array.from({ length: requirement.minCount ?? 1 }, () => ({
      toolName: requirement.toolName,
      phase: requirement.phase ?? "completed",
      ...(requirement.resultStatus !== undefined ? { resultStatus: requirement.resultStatus } : {}),
      ...(requirement.outputStatus !== undefined ? { outputStatus: requirement.outputStatus } : {}),
    } satisfies SdkAgentShakedownToolObservation)),
  );
  assert.deepEqual(
    validateSdkAgentShakedownObservation(scenario, {
      terminalType: "run.completed",
      outputStatus: "COMPLETED",
      assistantText: scenario.marker,
      tools,
    }),
    [],
  );

  const withoutTrace = tools.filter((tool) => tool.toolName !== "repo.trace");
  assert.match(
    validateSdkAgentShakedownObservation(scenario, {
      terminalType: "run.completed",
      outputStatus: "COMPLETED",
      assistantText: scenario.marker,
      tools: withoutTrace,
    }).join("\n"),
    /Expected 1 repo\.trace observation/u,
  );
});

test("SDK agent shake-down distinguishes a returned running process from completion", () => {
  const scenario = scenarioById("exec");
  const completedOnly = scenario.requiredTools.flatMap((requirement) => {
    if (requirement.outputStatus === "running") {
      return [];
    }
    return Array.from({ length: requirement.minCount ?? 1 }, () => ({
      toolName: requirement.toolName,
      phase: requirement.phase ?? "completed",
      ...(requirement.resultStatus !== undefined ? { resultStatus: requirement.resultStatus } : {}),
      ...(requirement.outputStatus !== undefined ? { outputStatus: requirement.outputStatus } : {}),
    } satisfies SdkAgentShakedownToolObservation));
  });
  const errors = validateSdkAgentShakedownObservation(scenario, {
    terminalType: "run.completed",
    outputStatus: "COMPLETED",
    assistantText: scenario.marker,
    tools: completedOnly,
  });
  assert.match(errors.join("\n"), /exec_command.*completed\/OK\/running/u);
});

test("SDK agent shake-down rejects internal replay-compatible terminal tools", () => {
  const scenario = readScenario();
  const errors = validateSdkAgentShakedownObservation(scenario, {
    terminalType: "run.completed",
    outputStatus: "COMPLETED",
    assistantText: scenario.marker,
    tools: [
      ...scenario.requiredTools.map((requirement) => ({
        toolName: requirement.toolName,
        phase: requirement.phase ?? "completed",
        resultStatus: requirement.resultStatus,
      } satisfies SdkAgentShakedownToolObservation)),
      {
        toolName: SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS[0],
        phase: "completed",
        resultStatus: "OK",
      },
    ],
  });
  assert.match(errors.join("\n"), /Model used internal terminal tool\(s\): dev\.shell\.run/u);
});

test("SDK agent shake-down reads canonical result and process status from public tool events", () => {
  assert.deepEqual(
    readSdkAgentShakedownToolObservation({
      type: "run.tool.completed",
      payload: {
        update: {
          toolName: "exec_command",
          phase: "completed",
          durationMs: 12,
          output: {
            status: "OK",
            auditRecord: {
              output: {
                status: "running",
                sessionId: "process-1",
                changedFiles: ["a.txt"],
              },
            },
          },
        },
      },
    }),
    {
      toolName: "exec_command",
      phase: "completed",
      resultStatus: "OK",
      outputStatus: "running",
      durationMs: 12,
      sessionId: "process-1",
      changedFiles: ["a.txt"],
    },
  );
});

function readScenario(): SdkAgentShakedownScenario {
  return scenarioById("read");
}

function scenarioById(id: SdkAgentShakedownScenario["id"]): SdkAgentShakedownScenario {
  const scenario = SDK_AGENT_SHAKEDOWN_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario);
  return scenario;
}
