import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY,
  SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL,
  SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS,
  SDK_AGENT_SHAKEDOWN_SCENARIOS,
  readSdkAgentShakedownToolObservation,
  selectSdkAgentShakedownScenarios,
  summarizeSdkAgentShakedownLifecycle,
  validateCodingLifecycleObservation,
  validateSdkAgentShakedownObservation,
  type SdkAgentShakedownScenario,
  type SdkAgentShakedownToolObservation,
} from "../../scripts/lib/sdk-agent-shakedown.js";
import {
  seedSdkAgentShakedownWorkspace,
  verifySdkAgentShakedownCodingWorkspace,
} from "../../scripts/sdk-agent-shakedown.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "SDK agent shake-down receives the project environment in managed worktrees", async () => {
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
  assert.match(script, /KESTREL_CORE_HOME: undefined/u);
  assert.match(script, /KESTREL_LOCAL_CORE_DIRECT: "0"/u);
  assert.match(script, /KESTREL_CORE_PLATFORM: "linux"/u);
  assert.match(script, /KESTREL_STORE_DRIVER: "sqlite"/u);
  assert.match(script, /new ModelPolicyStore\(isolatedCoreHome\)\.write\(/u);
  assert.match(script, /stopLocalCoreFromLock\(isolatedCorePaths\.lockPath\)/u);
  assert.doesNotMatch(script, /git-common-dir|resolvePrimaryCheckoutRoot/u);
});

contractTest("runtime.hermetic", "SDK agent shake-down uses the mini model and explicit core scenario matrix", () => {
  assert.equal(SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL, "openai/gpt-5.4-mini");
  assert.deepEqual(
    SDK_AGENT_SHAKEDOWN_SCENARIOS.map((scenario) => scenario.id),
    ["read", "filesystem", "exec", "coding"],
  );
  assert.deepEqual(
    selectSdkAgentShakedownScenarios(["exec", "read"]).map((scenario) => scenario.id),
    ["read", "exec"],
  );
  assert.deepEqual(
    selectSdkAgentShakedownScenarios(["coding"]).map((scenario) => scenario.id),
    ["coding"],
  );
  assert.throws(
    () => selectSdkAgentShakedownScenarios(["provider-write"]),
    /Unknown SDK shake-down scenario/u,
  );
});

contractTest("runtime.hermetic", "SDK agent shake-down requires each exact public tool contract", () => {
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
      visibleTodos: completedVisibleTodos(),
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
      visibleTodos: completedVisibleTodos(),
      tools: withoutTrace,
    }).join("\n"),
    /Expected 1 repo\.trace observation/u,
  );
});

contractTest("runtime.hermetic", "SDK agent shake-down distinguishes a returned running process from completion", () => {
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

contractTest("runtime.hermetic", "SDK agent shake-down rejects internal replay-compatible terminal tools", () => {
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

contractTest("runtime.hermetic", "SDK agent shake-down reads canonical result and process status from public tool events", () => {
  assert.deepEqual(
    readSdkAgentShakedownToolObservation({
      type: "run.tool.completed",
      payload: {
        update: {
          seq: 7,
          stepIndex: 4,
          toolName: "exec_command",
          phase: "completed",
          durationMs: 12,
          input: {
            command: "npm test",
            cwd: "coding-fixture",
            yieldTimeMs: 25,
          },
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
      seq: 7,
      stepIndex: 4,
      input: {
        command: "npm test",
        cwd: "coding-fixture",
        yieldTimeMs: 25,
      },
      resultStatus: "OK",
      outputStatus: "running",
      durationMs: 12,
      sessionId: "process-1",
      changedFiles: ["a.txt"],
    },
  );
});

contractTest("runtime.hermetic", "SDK agent shake-down unwraps compiled effect tool results", () => {
  assert.deepEqual(
    readSdkAgentShakedownToolObservation({
      type: "run.tool.completed",
      payload: {
        update: {
          seq: 8,
          stepIndex: 5,
          toolName: "effect_result_lookup",
          phase: "completed",
          durationMs: 2,
          output: {
            status: "OK",
            auditRecord: {
              output: {
                status: "DONE",
                output: {
                  toolName: "exec_command",
                  status: "OK",
                  auditRecord: {
                    toolName: "exec_command",
                    durationMs: 18,
                    input: { sessionId: "process-2" },
                    output: {
                      status: "running",
                      sessionId: "process-2",
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    {
      toolName: "exec_command",
      phase: "completed",
      seq: 8,
      stepIndex: 5,
      input: { sessionId: "process-2" },
      resultStatus: "OK",
      outputStatus: "running",
      durationMs: 18,
      sessionId: "process-2",
    },
  );
});

contractTest("runtime.hermetic", "SDK agent shake-down validates the ordered coding lifecycle", () => {
  const tools = successfulCodingLifecycle();
  assert.deepEqual(validateCodingLifecycleObservation(tools), []);
  assert.deepEqual(summarizeSdkAgentShakedownLifecycle(tools), {
    execStarts: 2,
    execContinuations: 2,
    runningObservations: 2,
    terminalSettlements: 2,
    observedMutationEvents: 2,
  });
  const directFilesystemResults = tools.map((tool) => ({ ...tool, changedFiles: undefined }));
  assert.deepEqual(validateCodingLifecycleObservation(directFilesystemResults), []);
  assert.equal(summarizeSdkAgentShakedownLifecycle(directFilesystemResults).observedMutationEvents, 2);
});

contractTest("runtime.hermetic", "SDK agent shake-down allows settled failed iterations but requires the final source repair to be targeted and validated", () => {
  const tools = successfulCodingLifecycle();
  const firstSourceMutationIndex = tools.findIndex((tool) => tool.toolName === "fs.replace_text");
  assert.notEqual(firstSourceMutationIndex, -1);
  const iterative = [
    ...tools.slice(0, firstSourceMutationIndex + 1),
    codingTestStart("failed-repair-session", 5),
    {
      toolName: "exec_command",
      phase: "completed",
      stepIndex: 6,
      input: { sessionId: "failed-repair-session" },
      resultStatus: "OK",
      outputStatus: "failed",
    } satisfies SdkAgentShakedownToolObservation,
    {
      toolName: "fs.replace_text",
      phase: "completed",
      stepIndex: 7,
      input: { path: "coding-fixture/src/inventory.mjs" },
      resultStatus: "OK",
      outputStatus: "ok",
      changedFiles: ["coding-fixture/src/inventory.mjs"],
    } satisfies SdkAgentShakedownToolObservation,
    ...tools.slice(firstSourceMutationIndex + 1).map((tool) => ({
      ...tool,
      stepIndex: (tool.stepIndex ?? 0) + 4,
    })),
  ];
  assert.deepEqual(validateCodingLifecycleObservation(iterative), []);

  const overwritten = iterative.map((tool, index) =>
    index === firstSourceMutationIndex + 3
      ? { ...tool, toolName: "fs.write_text" }
      : tool
  );
  assert.match(
    validateCodingLifecycleObservation(overwritten).join("\n"),
    /requires a successful targeted fs\.replace_text repair/u,
  );
});

contractTest("runtime.hermetic", "SDK agent shake-down rejects unsettled and same-step coding lifecycle evidence", () => {
  const sameStepRead = successfulCodingLifecycle().map((tool) =>
    tool.toolName === "fs.read_text" ? { ...tool, stepIndex: 7 } : tool
  );
  assert.match(
    validateCodingLifecycleObservation(sameStepRead).join("\n"),
    /later runtime step/u,
  );

  const noChangeRepair = successfulCodingLifecycle().map((tool) =>
    tool.toolName === "fs.replace_text"
      ? { ...tool, outputStatus: "no_change", changedFiles: undefined }
      : tool
  );
  assert.match(
    validateCodingLifecycleObservation(noChangeRepair).join("\n"),
    /source mutation/u,
  );
  assert.match(
    validateSdkAgentShakedownObservation(scenarioById("coding"), {
      terminalType: "run.completed",
      outputStatus: "COMPLETED",
      assistantText: "SHAKEDOWN_CODING_OK",
      visibleTodos: completedVisibleTodos(),
      tools: noChangeRepair,
    }).join("\n"),
    /fs\.replace_text observation.*OK\/ok/u,
  );

  const unsettled = successfulCodingLifecycle().filter((tool) =>
    tool.input?.sessionId !== "passing-session"
  );
  const unsettledErrors = validateCodingLifecycleObservation(unsettled).join("\n");
  assert.match(unsettledErrors, /No test session after the final inventory source mutation was continued to terminal completed status/u);
  assert.match(unsettledErrors, /has no later terminal continuation/u);
});

contractTest("runtime.hermetic", "SDK agent shake-down coding fixture fails before the fix and passes the hidden oracle after it", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "sdk-shakedown-coding-fixture-"));
  try {
    await seedSdkAgentShakedownWorkspace(workspaceRoot);
    const baselineErrors = await verifySdkAgentShakedownCodingWorkspace(workspaceRoot);
    assert.match(baselineErrors.join("\n"), /tests failed/u);
    assert.match(baselineErrors.join("\n"), /changelog entry exactly once/u);

    await writeFile(
      path.join(workspaceRoot, "coding-fixture", "src", "inventory.mjs"),
      [
        "export function formatInventory(items) {",
        "  return items.map((item) => `${item.name.trim()}=${item.quantity}`).join(\"\\n\");",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, "coding-fixture", "CHANGELOG.md"),
      `# Changelog\n${SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY}\n`,
      "utf8",
    );
    assert.deepEqual(await verifySdkAgentShakedownCodingWorkspace(workspaceRoot), []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function successfulCodingLifecycle(): SdkAgentShakedownToolObservation[] {
  return [
    codingTestStart("baseline-session", 2),
    {
      toolName: "exec_command",
      phase: "completed",
      stepIndex: 3,
      input: { sessionId: "baseline-session" },
      resultStatus: "OK",
      outputStatus: "failed",
    },
    {
      toolName: "fs.replace_text",
      phase: "completed",
      stepIndex: 4,
      input: { path: "coding-fixture/src/inventory.mjs" },
      resultStatus: "OK",
      outputStatus: "ok",
      changedFiles: ["coding-fixture/src/inventory.mjs"],
    },
    codingTestStart("passing-session", 5),
    {
      toolName: "exec_command",
      phase: "completed",
      stepIndex: 6,
      input: { sessionId: "passing-session" },
      resultStatus: "OK",
      outputStatus: "completed",
    },
    {
      toolName: "fs.write_text",
      phase: "completed",
      stepIndex: 7,
      input: { path: "coding-fixture/CHANGELOG.md" },
      resultStatus: "OK",
      changedFiles: ["coding-fixture/CHANGELOG.md"],
    },
    {
      toolName: "fs.read_text",
      phase: "completed",
      stepIndex: 8,
      input: { path: "coding-fixture/CHANGELOG.md" },
      resultStatus: "OK",
    },
  ];
}

function codingTestStart(sessionId: string, stepIndex: number): SdkAgentShakedownToolObservation {
  return {
    toolName: "exec_command",
    phase: "completed",
    stepIndex,
    input: { command: "npm test", cwd: "coding-fixture", yieldTimeMs: 25 },
    resultStatus: "OK",
    outputStatus: "running",
    sessionId,
  };
}

function completedVisibleTodos() {
  return {
    objective: "Run the systems check",
    items: [{ id: "check", text: "Complete the check", status: "done" }],
  };
}

function readScenario(): SdkAgentShakedownScenario {
  return scenarioById("read");
}

function scenarioById(id: SdkAgentShakedownScenario["id"]): SdkAgentShakedownScenario {
  const scenario = SDK_AGENT_SHAKEDOWN_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario);
  return scenario;
}
