import assert from "node:assert/strict";
import test from "node:test";

import { filterDeliberatorToolsForContext } from "../../agents/reference-react/src/deliberatorToolSurface.js";
import type { ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

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

test("deliberator tool surface hides live-process controls during normal coding turns", () => {
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
    "dev.shell.run",
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
    ],
  );
});

test("deliberator tool surface allows process controls for an active live process", () => {
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

  assert.deepEqual(filtered.availability.allowedToolNames, [
    "dev.shell.run",
    "dev.process.read",
    "dev.process.write",
    "dev.process.write_and_read",
    "dev.process.stop",
  ]);
});

test("deliberator tool surface preserves managed-entrypoint process start when required", () => {
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

  assert.deepEqual(filtered.availability.allowedToolNames, [
    "dev.shell.run",
    "dev.process.start",
  ]);
});
