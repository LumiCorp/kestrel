import { spawnSync } from "node:child_process";
import type { TuiProfile } from "../../cli/contracts.js";
import {
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
  UnifiedToolRegistry,
} from "../index.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { InMemorySessionStore } from "../store/InMemorySessionStore.js";
import { unwrapAgentToolOutput } from "../../tools/toolResult.js";

export interface CodeModeTurnAssertionResult {
  label: string;
  passed: boolean;
  attempts: number;
  outputStatus: string;
  hasCodeExecuteCall: boolean;
  toolCalls: number;
  persistedArtifacts: number;
  generatedFileArtifacts: number;
  finalizedMessage: string;
  outputErrors: string[];
  decisionRejects: string[];
  runFailures: string[];
  failureReason?: string | undefined;
  lastToolStatus?: string | undefined;
}

export interface CodeModeE2ESummary {
  passed: boolean;
  durationMs: number;
  results: CodeModeTurnAssertionResult[];
  infraErrors?: string[] | undefined;
}

interface TurnExpectations {
  requireCompleted?: boolean | undefined;
  requireCodeExecuteCall?: boolean | undefined;
  expectedToolStatus?: string | undefined;
  minGeneratedFileArtifacts?: number | undefined;
}

export async function runLiveCodeModeE2E(): Promise<CodeModeE2ESummary> {
  const prerequisiteCheck = validateCodeModePrerequisites();
  if (prerequisiteCheck.ok === false) {
    return {
      passed: false,
      durationMs: 0,
      infraErrors: prerequisiteCheck.errors,
      results: [
        {
          label: "code_runtime_prerequisites",
          passed: false,
          attempts: 1,
          outputStatus: "FAILED",
          hasCodeExecuteCall: false,
          toolCalls: 0,
          persistedArtifacts: 0,
          generatedFileArtifacts: 0,
          finalizedMessage: "",
          outputErrors: [...prerequisiteCheck.errors],
          decisionRejects: [],
          runFailures: [],
          failureReason: prerequisiteCheck.errors.join(" | "),
          lastToolStatus: "runtime_unavailable",
        },
      ],
    };
  }

  const profile: TuiProfile = {
    id: "live-code-mode-e2e",
    label: "Live Code-Mode E2E",
    agent: "reference-react",
    sessionPrefix: "live-code",
    toolAllowlist: ["code.execute"],
    codeMode: {
      ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
      enabled: true,
      sandbox: {
        ...DEFAULT_CODE_MODE_ENABLED_CONFIG.sandbox,
        timeoutMs: 25_000,
        networkDefault: "off",
        allowDependencyInstall: false,
      },
      retention: {
        persistSummary: true,
        persistArtifacts: true,
      },
      approvalMode: "auto",
    },
  };

  const store = new InMemorySessionStore();
  const registry = new UnifiedToolRegistry({
    allowlist: profile.toolAllowlist ?? ["code.execute"],
    context: {
      store,
      codeMode: profile.codeMode,
    },
  });
  const startedAt = Date.now();

  try {
    const results: CodeModeTurnAssertionResult[] = [];

    results.push(
      await runTurnWithRetries({
        registry,
        label: "python_artifact_success",
        request: {
          language: "python",
          code: "with open('fib.txt','w') as f:\n    f.write('1\\n1\\n2\\n3\\n5\\n8\\n13\\n21\\n34\\n55\\n89\\n')\nprint('done')",
        },
        expectations: {
          requireCompleted: true,
          requireCodeExecuteCall: true,
          minGeneratedFileArtifacts: 1,
        },
      }),
    );

    results.push(
      await runTurnWithRetries({
        registry,
        label: "bash_success",
        request: {
          language: "bash",
          code: "printf '9\\n2\\n5\\n1\\n' > nums.txt\nsort -n nums.txt",
        },
        expectations: {
          requireCompleted: true,
          requireCodeExecuteCall: true,
        },
      }),
    );

    results.push(
      await runTurnWithRetries({
        registry,
        label: "policy_blocked_dependencies",
        request: {
          language: "javascript",
          code: "console.log('x')",
          network: "on",
          dependencies: ["left-pad"],
        },
        expectations: {
          requireCompleted: true,
          requireCodeExecuteCall: true,
          expectedToolStatus: "blocked",
        },
      }),
    );

    return {
      passed: results.every((item) => item.passed),
      durationMs: Date.now() - startedAt,
      results,
    };
  } finally {
    await registry.close();
  }
}

export function validateCodeModePrerequisites(): {
  ok: boolean;
  errors: string[];
} {
  const result = spawnSync("docker", ["info", "--format", "{{json .ServerVersion}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    const message =
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Docker CLI is not installed or not on PATH."
        : result.error.message;
    return { ok: false, errors: [message] };
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      errors: [
        stderr.length > 0
          ? `Docker daemon is not reachable: ${stderr}`
          : "Docker daemon is not reachable.",
      ],
    };
  }

  return {
    ok: true,
    errors: [],
  };
}

function buildFailureMessage(results: CodeModeTurnAssertionResult[]): string {
  return [
    "Expected all live code-mode scenarios to satisfy assertions.",
    ...results
      .filter((item) => item.passed === false)
      .map((item) =>
        `${item.label}: ${item.failureReason ?? "unknown failure"}; ` +
        `status=${item.outputStatus}, toolCalls=${item.toolCalls}, hasCodeExecute=${item.hasCodeExecuteCall}, ` +
        `lastToolStatus=${item.lastToolStatus ?? "n/a"}, errors=${item.outputErrors.join(" | ") || "none"}`),
  ].join("\n");
}

export function assertLiveCodeModeE2E(summary: CodeModeE2ESummary): void {
  if (summary.passed) {
    return;
  }

  throw createRuntimeFailure(
    "LIVE_CODE_MODE_E2E_FAILED",
    buildFailureMessage(summary.results),
    {
      failedScenarios: summary.results
        .filter((item) => item.passed === false)
        .map((item) => item.label),
    },
  );
}

async function runTurnWithRetries(input: {
  registry: UnifiedToolRegistry;
  label: string;
  request: Record<string, unknown>;
  expectations: TurnExpectations;
}): Promise<CodeModeTurnAssertionResult> {
  const maxAttempts = 3;
  let lastAttempt: CodeModeTurnAssertionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let toolOutput: Record<string, unknown> | undefined;
    let outputStatus = "FAILED";
    let lastToolStatus: string | undefined;
    let generatedFileArtifacts = 0;
    let outputErrors: string[] = [];

    try {
      const result = await input.registry.call(
        "code.execute",
        input.request,
      );
      const output = unwrapAgentToolOutput(result);
      toolOutput = asRecord(output);
      outputStatus = "COMPLETED";
      lastToolStatus = readString(toolOutput, "status");
      generatedFileArtifacts = Array.isArray(toolOutput?.artifacts) ? toolOutput.artifacts.length : 0;
    } catch (error) {
      outputErrors = [
        error instanceof Error
          ? `${(error as { code?: string }).code ?? error.name}: ${error.message}`
          : String(error),
      ];
    }

    const evaluation = evaluateTurn({
      outputStatus,
      hasCodeExecuteCall: true,
      lastToolStatus,
      generatedFileArtifacts,
    }, input.expectations);

    lastAttempt = {
      label: input.label,
      passed: evaluation.ok,
      attempts: attempt,
      outputStatus,
      hasCodeExecuteCall: true,
      toolCalls: 1,
      persistedArtifacts: 0,
      generatedFileArtifacts,
      finalizedMessage: readString(toolOutput, "summary") ?? "",
      outputErrors,
      decisionRejects: [],
      runFailures: [],
      ...(evaluation.reason !== undefined ? { failureReason: evaluation.reason } : {}),
      ...(lastToolStatus !== undefined ? { lastToolStatus } : {}),
    };

    if (evaluation.ok) {
      return lastAttempt;
    }
  }

  if (lastAttempt !== undefined) {
    return lastAttempt;
  }

  return {
    label: input.label,
    passed: false,
    attempts: 0,
    outputStatus: "FAILED",
    hasCodeExecuteCall: false,
    toolCalls: 0,
    persistedArtifacts: 0,
    generatedFileArtifacts: 0,
    finalizedMessage: "",
    outputErrors: [],
    decisionRejects: [],
    runFailures: [],
    failureReason: "No attempts were executed.",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function evaluateTurn(
  actual: {
    outputStatus: string;
    hasCodeExecuteCall: boolean;
    lastToolStatus: string | undefined;
    generatedFileArtifacts: number;
  },
  expected: TurnExpectations,
): { ok: boolean; reason?: string } {
  if (expected.requireCompleted !== false && actual.outputStatus !== "COMPLETED") {
    return { ok: false, reason: `expected status COMPLETED, got ${actual.outputStatus}` };
  }

  if (expected.requireCodeExecuteCall !== false && actual.hasCodeExecuteCall === false) {
    return { ok: false, reason: "expected code.execute to be called" };
  }

  if (expected.expectedToolStatus !== undefined && actual.lastToolStatus !== expected.expectedToolStatus) {
    return {
      ok: false,
      reason: `expected last tool status '${expected.expectedToolStatus}', got '${actual.lastToolStatus ?? "undefined"}'`,
    };
  }

  if (
    typeof expected.minGeneratedFileArtifacts === "number" &&
    actual.generatedFileArtifacts < expected.minGeneratedFileArtifacts
  ) {
    return {
      ok: false,
      reason: `expected at least ${expected.minGeneratedFileArtifacts} generated artifact(s), got ${actual.generatedFileArtifacts}`,
    };
  }

  return { ok: true };
}
