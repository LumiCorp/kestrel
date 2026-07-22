import assert from "node:assert/strict";

import type { AgentToolResult } from "../../src/kestrel/contracts/model-io.js";
import { contractTest } from "../helpers/contract-test.js";
import { finalizeAnswerTool } from "../../tools/runtime/finalizeAnswer.js";

contractTest("runtime.hermetic", "FinalizeAnswer preserves console artifact content as presentation metadata", async () => {
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
