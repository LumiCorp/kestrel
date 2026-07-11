import test from "node:test";
import assert from "node:assert/strict";

import { codeExecuteTool } from "../../tools/code/execute.js";
import {
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeModeProfileConfig,
  type CodeExecutionServicePort,
} from "../../src/code/contracts.js";

test("code.execute forwards parsed request to execution service", async () => {
  let capturedConfig: CodeModeProfileConfig | undefined;
  let capturedRequest: CodeExecutionRequest | undefined;

  const service: CodeExecutionServicePort = {
    async execute(config, request): Promise<CodeExecutionResult> {
      capturedConfig = config;
      capturedRequest = request;
      return {
        status: "ok",
        exitCode: 0,
        stdout: "hi",
        stderr: "",
        durationMs: 10,
        artifacts: [],
        summary: "ok",
        policy: {
          enabled: true,
          approvalMode: "auto",
          executor: "docker",
          language: "javascript",
          timeoutMs: 1000,
          memoryMb: 256,
          cpuShares: 256,
          network: "off",
          allowDependencyInstall: false,
          maxOutputBytes: 100,
          maxArtifacts: 1,
          maxArtifactBytes: 100,
        },
        retention: {
          persistSummary: true,
          persistArtifacts: true,
        },
      };
    },
  };

  const handler = codeExecuteTool.createHandler({
    codeExecutionService: service,
    codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG,
  });

  const result = await handler({
    language: "javascript",
    code: "console.log('hi')",
    timeoutMs: 1234,
    args: ["--flag"],
  });

  assert.equal((result as { status: string }).status, "ok");
  assert.equal(capturedConfig?.enabled, true);
  assert.equal(capturedRequest?.language, "javascript");
  assert.equal(capturedRequest?.timeoutMs, 1234);
  assert.deepEqual(capturedRequest?.args, ["--flag"]);
});

test("code.execute rejects invalid inputs", async () => {
  const handler = codeExecuteTool.createHandler({
    codeExecutionService: {
      async execute(_config, _request) {
        throw new Error("should not execute");
      },
    },
    codeMode: DEFAULT_CODE_MODE_ENABLED_CONFIG,
  });

  await assert.rejects(
    () => handler({ language: "javascript" }),
    /Missing required string field 'code'|requires non-empty 'code'/,
  );
  await assert.rejects(
    () => handler({ code: "print('x')" }),
    /requires language|requires 'language'/,
  );
});
