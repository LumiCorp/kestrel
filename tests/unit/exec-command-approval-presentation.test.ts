import assert from "node:assert/strict";
import test from "node:test";
import { buildToolApprovalPresentation } from "../../src/runtime/toolApprovalPresentation.js";

test("exec_command approval shows exact normalized input without secret values", () => {
  const presentation = buildToolApprovalPresentation({
    toolName: "exec_command",
    effectiveInput: {
      command: "pnpm run dev:all",
      cwd: ".",
      envNames: ["OPENROUTER_API_KEY", "TAVILY_API_KEY"],
      envMode: "inherit",
    },
  });
  assert.equal(presentation.title, "Run command");
  assert.deepEqual(presentation.fields, [
    { label: "Command", value: "pnpm run dev:all" },
    { label: "Working directory", value: "." },
    { label: "Environment access", value: "OPENROUTER_API_KEY, TAVILY_API_KEY" },
  ]);
  assert.doesNotMatch(JSON.stringify(presentation), /sk-or-|tvly-/u);
  assert.match(presentation.warnings.join(" "), /exact command/u);
});
