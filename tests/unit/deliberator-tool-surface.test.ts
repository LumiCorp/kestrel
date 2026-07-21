import assert from "node:assert/strict";

import { filterDeliberatorToolsForContext } from "../../agents/reference-react/src/deliberatorToolSurface.js";
import type { ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";
import { contractTest } from "../helpers/contract-test.js";


function tool(name: string): ModelToolSpec {
  return {
    name,
    description: `${name} test tool.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

contractTest("runtime.hermetic", "deliberator tool surface hides live-process controls during normal coding turns", () => {
  const filtered = filterDeliberatorToolsForContext([
    tool("exec_command"),
    tool("dev.shell.run"),
    tool("dev.process.start"),
    tool("dev.process.read"),
    tool("dev.process.write"),
    tool("dev.process.write_and_read"),
    tool("dev.process.stop"),
    tool("fs.read_text"),
    tool("fs.write_text"),
  ]);

  assert.deepEqual(filtered.availability.allowedToolNames, [
    "exec_command",
    "fs.read_text",
    "fs.write_text",
  ]);
  assert.deepEqual(
    filtered.availability.hiddenTools.map((entry) => entry.name).sort(),
    [
      "dev.process.read",
      "dev.process.start",
      "dev.process.stop",
      "dev.process.write",
      "dev.process.write_and_read",
      "dev.shell.run",
    ],
  );
});

contractTest("runtime.hermetic", "deliberator tool surface keeps internal process controls hidden for an active live process", () => {
  const filtered = filterDeliberatorToolsForContext(
    [
      tool("dev.shell.run"),
      tool("dev.process.read"),
      tool("dev.process.write"),
      tool("dev.process.write_and_read"),
      tool("dev.process.stop"),
    ],
    {
      devShellProcesses: [{ processId: "proc-1", status: "RUNNING" }],
      latestProcessToolState: {
        toolName: "dev.process.start",
        status: "RUNNING",
        processId: "proc-1",
      },
    },
  );

  assert.deepEqual(filtered.availability.allowedToolNames, []);
});

contractTest("runtime.hermetic", "deliberator tool surface keeps managed-entrypoint process start internal", () => {
  const filtered = filterDeliberatorToolsForContext(
    [tool("dev.shell.run"), tool("dev.process.start")],
    {
      managedEntrypoints: [
        {
          path: "game.py",
          command: "python game.py",
          cwd: "/workspace",
          securityMode: "protected_entrypoint",
          requiredTransport: "dev.process.start",
        },
      ],
    },
  );

  assert.deepEqual(filtered.availability.allowedToolNames, []);
});
