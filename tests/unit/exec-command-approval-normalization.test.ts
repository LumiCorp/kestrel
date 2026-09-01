import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolActionInput } from "../../tools/runtime/normalizeToolInput.js";

test("exec_command preparation materializes its exact remembered scope", () => {
  assert.deepEqual(
    normalizeToolActionInput(
      "exec_command",
      {
        command: "  pnpm run something  ",
        envNames: ["TAVILY_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY"],
      },
      "/workspace",
      {
        workspaceAppRoot: "apps/web",
        devShellEnvMode: "allowlist",
      },
    ),
    {
      command: "pnpm run something",
      cwd: "apps/web",
      envNames: ["OPENROUTER_API_KEY", "TAVILY_API_KEY"],
      envMode: "allowlist",
    },
  );
});

test("exec_command process-handle operations remain handle-only", () => {
  assert.deepEqual(
    normalizeToolActionInput(
      "exec_command",
      { sessionId: "process-1", stdin: "yes\n", yieldTimeMs: 500 },
      "/workspace",
      { workspaceAppRoot: "apps/web", devShellEnvMode: "allowlist" },
    ),
    { sessionId: "process-1", stdin: "yes\n", yieldTimeMs: 500 },
  );
});
