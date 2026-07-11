import {
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeModeProfileConfig,
  type SandboxExecutionOutput,
  type SandboxExecutor,
} from "./contracts.js";
import { DockerSandboxExecutor, DockerUnavailableError } from "./DockerSandboxExecutor.js";
import { evaluateExecutionPolicy } from "./PolicyEngine.js";

export interface CodeExecutionServiceOptions {
  executor?: SandboxExecutor | undefined;
}

export class CodeExecutionService {
  private readonly executor: SandboxExecutor;

  constructor(options: CodeExecutionServiceOptions = {}) {
    this.executor = options.executor ?? new DockerSandboxExecutor();
  }

  async execute(
    config: CodeModeProfileConfig | undefined,
    request: CodeExecutionRequest,
  ): Promise<CodeExecutionResult> {
    const policyDecision = evaluateExecutionPolicy(config, request);
    if (policyDecision.ok === false) {
      return policyDecision.result;
    }

    try {
      const output = await this.executor.execute({
        request: policyDecision.request,
        policy: policyDecision.policy,
      });

      return {
        status: output.status,
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        durationMs: output.durationMs,
        artifacts: output.artifacts,
        summary: summarizeExecutionResult(output),
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
      };
    } catch (error) {
      if (error instanceof DockerUnavailableError) {
        return {
          status: "runtime_unavailable",
          exitCode: null,
          stdout: "",
          stderr: error.message,
          durationMs: 0,
          artifacts: [],
          summary: "Code runtime unavailable: Docker is not installed or not reachable.",
          policy: policyDecision.policy,
          retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
        };
      }

      return {
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        artifacts: [],
        summary: "Code execution failed before completion due to an internal runtime error.",
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
      };
    }
  }
}

function summarizeExecutionResult(output: SandboxExecutionOutput): string {
  if (output.status === "timeout") {
    return `Execution timed out after ${output.durationMs}ms.`;
  }

  const base =
    output.status === "ok"
      ? `Execution completed successfully in ${output.durationMs}ms.`
      : `Execution failed with exit code ${output.exitCode ?? "unknown"} in ${output.durationMs}ms.`;

  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  if (stdout.length === 0 && stderr.length === 0) {
    return `${base} No console output.`;
  }

  const snippets: string[] = [];
  if (stdout.length > 0) {
    snippets.push(`stdout: ${clip(stdout, 180)}`);
  }
  if (stderr.length > 0) {
    snippets.push(`stderr: ${clip(stderr, 180)}`);
  }

  return `${base} ${snippets.join(" ")}`;
}

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
