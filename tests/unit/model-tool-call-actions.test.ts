import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelToolAliasRegistry,
  normalizeModelToolCallsToAgentTurn as normalizeModelToolCallsToAgentTurnRaw,
  providerToolAliasForCanonicalName,
} from "../../agents/reference-react/src/modelToolCallActions.js";
import type { ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

const workspaceTools: ModelToolSpec[] = [
  {
    name: "dev.shell.run",
    description: "Run a bounded shell command.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "exec_command",
    description: "Run terminal work.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "fs.read_text",
    description: "Read a text file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
];

function normalizeModelToolCallsToAgentTurn(
  input: Parameters<typeof normalizeModelToolCallsToAgentTurnRaw>[0],
): ReturnType<typeof normalizeModelToolCallsToAgentTurnRaw> {
  return normalizeModelToolCallsToAgentTurnRaw({
    ...input,
    toolIntents: input.toolIntents.map((intent) => ({
      ...intent,
      input: {
        assistantProgress: "I am continuing the requested work.",
        ...intent.input,
      },
    })),
  });
}

test("provider aliases are transport-only and canonical tool names stay dotted", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  assert.equal(providerToolAliasForCanonicalName("exec_command"), "exec_command");
  assert.equal(registry.byProviderName.get("exec_command")?.canonicalName, "exec_command");
  assert.match(
    registry.requestTools.find((tool) => tool.name === "exec_command")?.description ?? "",
    /^Run terminal work\. Include assistantProgress:/u,
  );
  assert.equal(registry.byProviderName.has("dev_shell_run"), false);
  assert.equal(registry.requestTools.some((tool) => tool.name === "dev_shell_run"), false);

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        id: "call_1",
        name: "exec_command",
        input: { command: "pnpm create vite@latest app -- --template react-ts" },
      },
    ],
  });

  assert.deepEqual(normalized.action, {
    kind: "tool",
    name: "exec_command",
    input: { command: "pnpm create vite@latest app -- --template react-ts" },
  });
  assert.deepEqual(normalized.provenance, {
    providerToolCallIds: ["call_1"],
    providerNames: ["exec_command"],
    canonicalNames: ["exec_command"],
  });
});

test("missing assistant progress does not reject an otherwise valid action", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);
  const normalized = normalizeModelToolCallsToAgentTurnRaw({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "fs_read_text",
        input: { path: "package.json" },
      },
    ],
  });

  assert.deepEqual(normalized.action, {
    kind: "tool",
    name: "fs.read_text",
    input: { path: "package.json" },
  });
  assert.equal(normalized.assistantProgress, "I’m continuing the requested work.");
});

test("finalize control tool description stays prose closeout guidance", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);
  const finalizeTool = registry.requestTools.find((tool) => tool.name === "kestrel_finalize");
  const inputSchema = finalizeTool?.inputSchema as Record<string, unknown> | undefined;
  const properties = inputSchema?.properties as Record<string, unknown> | undefined;
  const required = inputSchema?.required as string[] | undefined;
  const statusSchema = properties?.status as Record<string, unknown> | undefined;
  const dataSchema = properties?.data as Record<string, unknown> | undefined;

  assert.match(finalizeTool?.description ?? "", /Finish the run with a user-facing answer/u);
  assert.match(finalizeTool?.description ?? "", /requested outcome and explicit constraints are supported by observed evidence/u);
  assert.match(finalizeTool?.description ?? "", /Claim only checks that actually ran/u);
  assert.match(finalizeTool?.description ?? "", /data\.openGap or data\.knownWarnings/u);
  assert.match(finalizeTool?.description ?? "", /otherwise keep working or report the concrete blocker/u);
  assert.match(finalizeTool?.description ?? "", /data\.keepRunningSessionIds/u);
  assert.match(finalizeTool?.description ?? "", /Do not retain tests, installers, validation commands, or accidental watchers/u);
  assert.match(finalizeTool?.description ?? "", /Do not put changedFiles, checksRun, or checksFailed in data/u);
  assert.match(String(dataSchema?.description), /runtime evidence owns those facts/u);
  const dataProperties = dataSchema?.properties as Record<string, unknown> | undefined;
  const keepRunningSchema = dataProperties?.keepRunningSessionIds as Record<string, unknown> | undefined;
  assert.equal(keepRunningSchema?.type, "array");
  assert.equal(keepRunningSchema?.uniqueItems, true);
  assert.doesNotMatch(finalizeTool?.description ?? "", /swe-verified|sweValidation|benchmark|validation proof|edited tests/i);
  assert.deepEqual(statusSchema?.enum, ["goal_satisfied", "out_of_scope"]);
  assert.equal(properties?.assistantProgress, undefined);
  assert.equal(required?.includes("assistantProgress"), false);

  const normalized = normalizeModelToolCallsToAgentTurnRaw({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "kestrel_finalize",
        input: { status: "goal_satisfied", message: "The exact answer." },
      },
    ],
  });
  assert.equal(normalized.action?.kind, "finalize");
  assert.equal(normalized.assistantProgress, undefined);
});

test("cannot_satisfy description rejects unfinished build progress as a blocker", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);
  const cannotSatisfyTool = registry.requestTools.find((tool) => tool.name === "kestrel_cannot_satisfy");

  assert.match(cannotSatisfyTool?.description ?? "", /concrete blocker that prevents progress/u);
  assert.match(cannotSatisfyTool?.description ?? "", /Do not use this because work is unfinished/u);
  assert.match(cannotSatisfyTool?.description ?? "", /checks are still failing/u);
  assert.match(cannotSatisfyTool?.description ?? "", /more tool steps are needed/u);
  assert.match(cannotSatisfyTool?.description ?? "", /in build mode, continue with tools or ask the user/u);
  assert.doesNotMatch(cannotSatisfyTool?.description ?? "", /Terminal-Bench|overfull|LaTeX|benchmark|evidenceIds|artifactVerification/i);
});

test("cannot_satisfy parser honors advertised narrowed reason enum", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools, {
    controlToolNames: ["kestrel.cannot_satisfy"],
    cannotSatisfyReasonCodes: ["missing_required_capability", "requested_tool_unavailable"],
  });

  assert.throws(
    () => normalizeModelToolCallsToAgentTurn({
      aliasRegistry: registry,
      sourceRunId: "run_1",
      toolIntents: [
        {
          name: "kestrel_cannot_satisfy",
          input: {
            reasonCode: "insufficient_horizon",
            message: "The task needs more work.",
          },
        },
      ],
    }),
    /kestrel\.cannot_satisfy reasonCode is invalid/u,
  );

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "kestrel_cannot_satisfy",
        input: {
          reasonCode: "requested_tool_unavailable",
          message: "The requested browser tool is unavailable.",
          details: {
            requestedTool: "browser.open",
          },
        },
      },
    ],
  });

  assert.deepEqual(normalized.action, {
    kind: "cannot_satisfy",
    reasonCode: "requested_tool_unavailable",
    message: "The requested browser tool is unavailable.",
    details: {
      requestedTool: "browser.open",
    },
  });
});

test("handoff_to_build preserves optional handoff data", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools, {
    controlToolNames: ["kestrel.handoff_to_build"],
  });

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "kestrel_handoff_to_build",
        input: {
          message: "Ready to build.",
          continuation: {
            objective: "Fix the bug.",
            requiredToolClass: "sandboxed_only",
            requiredCapabilities: ["workspace.write"],
          },
          data: {
            proposedNextAction: "Patch src/bug.ts and run parser tests.",
          },
        },
      },
    ],
  });

  assert.equal(normalized.action?.kind, "handoff_to_build");
  assert.deepEqual(normalized.action?.data, {
    proposedNextAction: "Patch src/bug.ts and run parser tests.",
  });
});

test("switch_mode preserves the explicit requested mode without assistant progress", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools, {
    controlToolNames: ["kestrel.switch_mode"],
  });

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "kestrel_switch_mode",
        input: {
          mode: "plan",
          message: "Switched to Plan mode.",
        },
      },
    ],
  });

  assert.deepEqual(normalized.action, {
    kind: "switch_mode",
    mode: "plan",
    message: "Switched to Plan mode.",
  });
  assert.equal(normalized.assistantProgress, undefined);
});

test("todo update description explains code-change notes without benchmark policy", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);
  const todoTool = registry.requestTools.find((tool) => tool.name === "kestrel_todo_update");

  assert.match(todoTool?.description ?? "", /Update the visible live checklist for multi-step work/u);
  assert.match(todoTool?.description ?? "", /concrete task work, checks, results, and blockers/u);
  assert.match(todoTool?.description ?? "", /do not add finalization or reporting itself as a todo item/u);
  const todoSchema = todoTool?.inputSchema as Record<string, unknown>;
  const todoProperties = todoSchema.properties as Record<string, unknown>;
  const itemsSchema = todoProperties.items as Record<string, unknown>;
  const itemSchema = itemsSchema.items as Record<string, unknown>;
  const itemProperties = itemSchema.properties as Record<string, unknown>;
  assert.match(
    String((itemProperties.text as Record<string, unknown>).description),
    /Never use a todo item for closing todos, finalization, or reporting itself/u,
  );
  assert.match(todoTool?.description ?? "", /combine final completed updates with kestrel\.finalize/u);
  assert.doesNotMatch(todoTool?.description ?? "", /what must be true at the end/u);
  assert.doesNotMatch(todoTool?.description ?? "", /existing test file and assertion found when available/u);
  assert.doesNotMatch(todoTool?.description ?? "", /Command exited 0 is not enough/u);
  assert.doesNotMatch(todoTool?.description ?? "", /planned validation command or direct check/u);
  assert.doesNotMatch(todoTool?.description ?? "", /goal_satisfied/u);
  assert.doesNotMatch(todoTool?.description ?? "", /proxy check/u);
  assert.doesNotMatch(todoTool?.description ?? "", /final edited state was checked/u);
  assert.doesNotMatch(todoTool?.description ?? "", /main requested final result passed/u);
  assert.doesNotMatch(todoTool?.description ?? "", /swe-verified|sweValidation|benchmark|runtime policy|behavior surface|evidenceIds|artifactVerification/i);
});

test("multiple workspace tool calls become an ordered canonical tool batch", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      { name: "fs_read_text", input: { path: "package.json" } },
      { name: "exec_command", input: { command: "pnpm test" } },
    ],
  });

  assert.deepEqual(normalized.action, {
    kind: "tool_batch",
    items: [
      { name: "fs.read_text", input: { path: "package.json" } },
      { name: "exec_command", input: { command: "pnpm test" } },
    ],
  });
});

test("todo update can be combined with workspace work", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  const normalized = normalizeModelToolCallsToAgentTurn({
    aliasRegistry: registry,
    sourceRunId: "run_1",
    toolIntents: [
      {
        name: "kestrel_todo_update",
        input: {
          objective: "Build the app",
          items: [
            { id: "scaffold", text: "Scaffold the app", status: "in_progress" },
          ],
        },
      },
      { name: "exec_command", input: { command: "pnpm create vite@latest app -- --template react-ts" } },
    ],
  });

  assert.equal(normalized.visibleTodos?.objective, "Build the app");
  assert.deepEqual(normalized.action, {
    kind: "tool",
    name: "exec_command",
    input: { command: "pnpm create vite@latest app -- --template react-ts" },
  });
});

test("terminal control tools are exclusive", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  assert.throws(
    () => normalizeModelToolCallsToAgentTurn({
      aliasRegistry: registry,
      sourceRunId: "run_1",
      toolIntents: [
        { name: "exec_command", input: { command: "pnpm test" } },
        { name: "kestrel_finalize", input: { status: "goal_satisfied", message: "Done." } },
      ],
    }),
    /Terminal control tools cannot be mixed/u,
  );
});

test("finalize control tool rejects model-facing policy_blocked status", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  assert.throws(
    () => normalizeModelToolCallsToAgentTurn({
      aliasRegistry: registry,
      sourceRunId: "run_1",
      toolIntents: [
        { name: "kestrel_finalize", input: { status: "policy_blocked", message: "Policy blocks this." } },
      ],
    }),
    /kestrel\.finalize requires status goal_satisfied or out_of_scope/u,
  );
});

test("unknown provider aliases fail before dispatch", () => {
  const registry = buildModelToolAliasRegistry(workspaceTools);

  assert.throws(
    () => normalizeModelToolCallsToAgentTurn({
      aliasRegistry: registry,
      sourceRunId: "run_1",
      toolIntents: [
        { name: "dev.shell.run", input: { command: "pnpm test" } },
      ],
    }),
    /Unknown model tool/u,
  );
});
