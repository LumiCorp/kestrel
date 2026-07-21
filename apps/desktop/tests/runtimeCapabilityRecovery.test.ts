import assert from "node:assert/strict";

import type { DesktopRunnerEvent } from "../src/contracts.js";
import { extractTerminalFailure } from "../renderer/src/runtimeCapabilityRecovery.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


function failed(code: string, details?: Record<string, unknown>): DesktopRunnerEvent {
  return {
    type: "run.failed",
    id: "event-1",
    ts: new Date().toISOString(),
    payload: {
      result: {} as never,
      error: { code, message: `${code} happened`, ...(details !== undefined ? { details } : {}) },
    },
  } as DesktopRunnerEvent;
}

contractTest("desktop.hermetic", "runtime failures route exact MCP, shell, database, and model contracts to Settings", () => {
  assert.equal(extractTerminalFailure(failed("MCP_ENV_VAR_REQUIRED"), "openrouter")?.capabilityId, "connections.mcp");
  assert.equal(extractTerminalFailure(failed("DEV_SHELL_SHELL_UNAVAILABLE"), "openrouter")?.capabilityId, "local.developer_shell");
  assert.equal(extractTerminalFailure(failed("DATABASE_UNREACHABLE"), "openrouter")?.capabilityId, "data.database");
  assert.equal(extractTerminalFailure(failed("IO_MODEL_FAILED"), "anthropic")?.capabilityId, "model.anthropic");
});

contractTest("desktop.hermetic", "runtime failure-provided capability ownership takes precedence", () => {
  assert.equal(
    extractTerminalFailure(failed("TOOL_PROVIDER_FAILED", { capabilityId: "tools.internet.tavily" }), "openrouter")?.capabilityId,
    "tools.internet.tavily",
  );
});
