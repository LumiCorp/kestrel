import assert from "node:assert/strict";
import test from "node:test";

import { CodeExecutionService } from "../../src/code/CodeExecutionService.js";
import {
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  type SandboxCapabilityGrant,
  type SandboxExecutionInput,
  type SandboxExecutor,
} from "../../src/code/contracts.js";

test("CodeExecutionService forwards a trusted capability outside the authored request", async () => {
  const capability: SandboxCapabilityGrant = {
    transport: "docker-shared-loopback-v1",
    lease: "opaque-service-boundary-lease",
    operation: "search",
    destination: "api.tavily.com",
    response: { answer: "trusted-stub-ok" },
  };
  let observed: SandboxExecutionInput | undefined;
  const executor: SandboxExecutor = {
    async execute(input) {
      observed = input;
      return {
        status: "ok",
        exitCode: 0,
        stdout: "trusted-stub-ok",
        stderr: "",
        durationMs: 1,
        artifacts: [],
      };
    },
  };
  const service = new CodeExecutionService({ executor });
  const request = {
    language: "javascript" as const,
    code: "console.log('capability proof')",
  };

  const result = await service.execute(
    DEFAULT_CODE_MODE_ENABLED_CONFIG,
    request,
    { capability },
  );

  assert.equal(result.status, "ok");
  assert.equal("capability" in request, false);
  assert.equal(observed === undefined ? true : "capability" in observed.request, false);
  assert.equal(observed?.request.code, request.code);
  assert.equal(observed?.capability, capability);
});
