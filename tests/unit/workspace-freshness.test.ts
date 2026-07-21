import assert from "node:assert/strict";

import {
  deriveActiveExecCommandSessions,
  deriveWorkspaceFreshness,
} from "../../src/runtime/workspaceFreshness.js";
import { contractTest } from "../helpers/contract-test.js";


function entry(input: {
  id: string;
  stepIndex?: number;
  kind: string;
  status: string;
  toolName: string;
  summary?: string;
  facts?: Record<string, unknown>;
  target?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    version: "v1",
    createdAt: `2026-07-17T00:00:0${input.stepIndex ?? 0}.000Z`,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    source: "tool",
    kind: input.kind,
    status: input.status,
    summary: input.summary ?? input.id,
    facts: { toolName: input.toolName, ...(input.facts ?? {}) },
    ...(input.target !== undefined ? { target: input.target } : {}),
  };
}

contractTest("runtime.hermetic", "workspace freshness is not applicable without an observed mutation", () => {
  assert.deepEqual(deriveWorkspaceFreshness([]), { status: "not_applicable" });
});

contractTest("runtime.hermetic", "workspace freshness stays stale for same-step evidence", () => {
  const ledger = [
    entry({
      id: "mutation",
      stepIndex: 3,
      kind: "file_write",
      status: "passed",
      toolName: "fs.write_text",
      facts: { changedFiles: ["src/app.ts"] },
    }),
    entry({
      id: "same-step-check",
      stepIndex: 3,
      kind: "process_result",
      status: "passed",
      toolName: "exec_command",
      facts: { command: "pnpm test" },
    }),
  ];
  assert.equal(deriveWorkspaceFreshness(ledger).status, "stale");
});

contractTest("runtime.hermetic", "later successful process evidence makes the workspace fresh", () => {
  const ledger = [
    entry({
      id: "mutation",
      stepIndex: 3,
      kind: "file_write",
      status: "passed",
      toolName: "fs.write_text",
      facts: { changedFiles: ["src/app.ts"] },
    }),
    entry({
      id: "later-check",
      stepIndex: 4,
      kind: "process_result",
      status: "passed",
      toolName: "exec_command",
      facts: { command: "pnpm test" },
    }),
  ];
  assert.equal(deriveWorkspaceFreshness(ledger).status, "fresh");
});

contractTest("runtime.hermetic", "the mutating process cannot validate its own resulting state", () => {
  const ledger = [
    entry({
      id: "running-mutation",
      stepIndex: 3,
      kind: "process_state",
      status: "running",
      toolName: "exec_command",
      facts: {
        command: "node generator.js",
        sessionId: "proc-1",
        changedFiles: ["generated.json"],
      },
    }),
    entry({
      id: "same-process-exit",
      stepIndex: 4,
      kind: "process_result",
      status: "passed",
      toolName: "exec_command",
      facts: { command: "node generator.js", sessionId: "proc-1" },
    }),
  ];
  assert.equal(deriveWorkspaceFreshness(ledger).status, "stale");
});

contractTest("runtime.hermetic", "failed validation is unresolved until a later successful rerun supersedes it", () => {
  const mutation = entry({
    id: "mutation",
    stepIndex: 1,
    kind: "file_write",
    status: "passed",
    toolName: "fs.write_text",
    facts: { changedFiles: ["src/app.ts"] },
  });
  const failed = entry({
    id: "failed-check",
    stepIndex: 2,
    kind: "process_result",
    status: "failed",
    toolName: "exec_command",
    facts: { command: "pnpm test" },
  });
  assert.equal(deriveWorkspaceFreshness([mutation, failed]).status, "attempted_unresolved");
  const passed = entry({
    id: "passed-check",
    stepIndex: 3,
    kind: "process_result",
    status: "passed",
    toolName: "exec_command",
    facts: { command: "pnpm test" },
  });
  assert.equal(deriveWorkspaceFreshness([mutation, failed, passed]).status, "fresh");
});

contractTest("runtime.hermetic", "a later mutation makes previously fresh evidence stale again", () => {
  const ledger = [
    entry({
      id: "mutation-1",
      stepIndex: 1,
      kind: "file_write",
      status: "passed",
      toolName: "fs.write_text",
      facts: { changedFiles: ["src/app.ts"] },
    }),
    entry({
      id: "check",
      stepIndex: 2,
      kind: "process_result",
      status: "passed",
      toolName: "exec_command",
      facts: { command: "pnpm test" },
    }),
    entry({
      id: "mutation-2",
      stepIndex: 3,
      kind: "file_write",
      status: "passed",
      toolName: "fs.write_text",
      facts: { changedFiles: ["src/other.ts"] },
    }),
  ];
  assert.equal(deriveWorkspaceFreshness(ledger).status, "stale");
});

contractTest("runtime.hermetic", "legacy mutation evidence without step identity cannot prove freshness", () => {
  const ledger = [
    entry({
      id: "legacy-mutation",
      kind: "file_write",
      status: "passed",
      toolName: "fs.write_text",
      facts: { changedFiles: ["src/app.ts"] },
    }),
    entry({
      id: "check",
      stepIndex: 2,
      kind: "process_result",
      status: "passed",
      toolName: "exec_command",
      facts: { command: "pnpm test" },
    }),
  ];
  assert.equal(deriveWorkspaceFreshness(ledger).status, "stale");
});

contractTest("runtime.hermetic", "active exec_command sessions use the latest process evidence", () => {
  const running = entry({
    id: "running",
    stepIndex: 1,
    kind: "process_state",
    status: "running",
    toolName: "exec_command",
    facts: {
      sessionId: "proc-1",
      command: "npm test",
      cwd: "/host/workspace/coding-fixture",
      workspaceRoot: "/host/workspace",
    },
  });
  assert.deepEqual(deriveActiveExecCommandSessions([running]), [{
    evidenceId: "running",
    stepIndex: 1,
    toolName: "exec_command",
    processId: "proc-1",
    command: "npm test",
    cwd: "coding-fixture",
    status: "running",
    summary: "running",
  }]);
  const stopped = entry({
    id: "stopped",
    stepIndex: 2,
    kind: "process_result",
    status: "failed",
    toolName: "exec_command",
    facts: { sessionId: "proc-1" },
  });
  assert.deepEqual(deriveActiveExecCommandSessions([running, stopped]), []);
});

contractTest("runtime.hermetic", "active exec_command sessions resolve relative cwd from the evidence workspace root", () => {
  const running = entry({
    id: "running-relative-cwd",
    stepIndex: 1,
    kind: "process_state",
    status: "running",
    toolName: "exec_command",
    facts: {
      sessionId: "proc-relative",
      command: "npm test",
      cwd: "coding-fixture",
      workspaceRoot: "/host/workspace",
    },
  });

  assert.deepEqual(deriveActiveExecCommandSessions([running]), [{
    evidenceId: "running-relative-cwd",
    stepIndex: 1,
    toolName: "exec_command",
    processId: "proc-relative",
    command: "npm test",
    cwd: "coding-fixture",
    status: "running",
    summary: "running-relative-cwd",
  }]);
});
