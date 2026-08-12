import test from "node:test";
import assert from "node:assert/strict";

import type { AgentToolResult } from "../../src/kestrel/contracts/model-io.js";
import { finalizeAnswerTool } from "../../tools/runtime/finalizeAnswer.js";
import type { DevProcessRetainInput, DevShellServicePort } from "../../src/devshell/contracts.js";

test("FinalizeAnswer preserves console artifact content as presentation metadata", async () => {
  const handler = finalizeAnswerTool.createHandler({} as never);
  const result = await handler({
    message: "The command finished.",
    data: {
      ui: {
        artifacts: [
          {
            id: "dev-shell-console-process-1",
            kind: "console",
            title: "Dev Shell Output",
            status: "FAILED",
            exitCode: 7,
            stdout: "before failure\n",
            stderr: "failure details\n",
            text: "combined output\n",
            chunk: "chunk\n",
            chunkPreview: "preview\n",
            truncated: true,
            durationMs: 123,
            toolContext: { processId: "process-1", command: "false" },
          },
        ],
      },
    },
  }) as AgentToolResult;

  assert.deepEqual(result.presentation?.artifacts?.[0]?.metadata, {
    status: "FAILED",
    stdout: "before failure\n",
    stderr: "failure details\n",
    text: "combined output\n",
    chunk: "chunk\n",
    chunkPreview: "preview\n",
    exitCode: 7,
    durationMs: 123,
    truncated: true,
    toolContext: { processId: "process-1", command: "false" },
  });
});

test("FinalizeAnswer establishes a fixed standalone lease for an unleased retained process", async () => {
  const retained: DevProcessRetainInput[] = [];
  const now = Date.now;
  Date.now = () => Date.parse("2026-08-12T12:00:00.000Z");
  try {
    const handler = finalizeAnswerTool.createHandler({
      runtime: { runId: "run-1", sessionId: "session-1" },
      devShellService: {
        async retainProcess(input: DevProcessRetainInput) {
          retained.push(input);
          return { status: "active" as const, processId: input.processId, lifecycle: "retained" as const, leases: [] };
        },
      } as unknown as DevShellServicePort,
    });

    await handler({
      message: "The app remains available.",
      data: { keepRunningSessionIds: ["process-1"] },
    });

    assert.deepEqual(retained, [{
      processId: "process-1",
      leaseId: "finalize:run-1:process-1",
      kind: "standalone",
      expiresAt: "2026-08-12T12:30:00.000Z",
      ifUnleased: true,
    }]);
  } finally {
    Date.now = now;
  }
});
