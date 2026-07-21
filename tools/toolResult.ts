import { createHash } from "node:crypto";

import type {
  AgentToolPresentation,
  AgentToolResult,
} from "../src/kestrel/contracts/model-io.js";
import { buildKestrelAgentToolModelContext } from "../src/runtime/KestrelAgentContextBuilder.js";
import { RunCancelledError, RuntimeFailure } from "../src/runtime/RuntimeFailure.js";
import { sanitizeJsonValue, stringifySanitizedJson } from "../src/runtime/jsonSanitizer.js";
import { storeJsonArtifact } from "./runtime/artifactStore.js";

export type AgentToolRawHandler = (input: unknown) => Promise<unknown>;

export interface AgentToolResultInput {
  toolName: string;
  input: unknown;
  output: unknown;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  presentation?: AgentToolPresentation | undefined;
}

export interface AgentToolFailureInput {
  toolName: string;
  input: unknown;
  error: unknown;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface AgentToolFailedOutputInput {
  toolName: string;
  input: unknown;
  output: unknown;
  error?: unknown | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  const record = asRecord(value);
  return typeof record?.toolName === "string" &&
    (record.status === "OK" || record.status === "FAILED") &&
    asRecord(record.modelContext) !== undefined &&
    asRecord(record.auditRecord) !== undefined;
}

export function unwrapAgentToolOutput(value: unknown): unknown {
  return isAgentToolResult(value) ? value.auditRecord.output : value;
}

export async function runAgentTool(input: {
  toolName: string;
  toolInput: unknown;
  handler: AgentToolRawHandler;
}): Promise<AgentToolResult> {
  const startedAt = new Date().toISOString();
  try {
    const output = await input.handler(input.toolInput);
    if (isAgentToolResult(output)) {
      return output;
    }
    return buildAgentToolSuccessResult({
      toolName: input.toolName,
      input: input.toolInput,
      output,
      startedAt,
    });
  } catch (error) {
    if (shouldRethrowToolError(error)) {
      throw error;
    }
    return buildAgentToolFailureResult({
      toolName: input.toolName,
      input: input.toolInput,
      error,
      startedAt,
    });
  }
}

export function buildAgentToolSuccessResult(input: AgentToolResultInput): AgentToolResult {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt = input.completedAt ?? new Date().toISOString();
  const output = sanitizeJsonValue(input.output);
  const rawOutputRef = rawOutputRefFor(output);
  storeJsonArtifact(rawOutputRef, output);
  return {
    toolName: input.toolName,
    status: "OK",
    modelContext: buildModelContext({
      toolName: input.toolName,
      input: input.input,
      output,
      rawOutputRef,
      status: "OK",
    }),
    auditRecord: {
      toolName: input.toolName,
      input: sanitizeJsonValue(input.input),
      output,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      status: "OK",
    },
    ...(input.presentation !== undefined
      ? { presentation: input.presentation }
      : {}),
  };
}

export function replaceAgentToolResultOutput(
  result: AgentToolResult,
  nextOutput: unknown,
): AgentToolResult {
  const output = sanitizeJsonValue(nextOutput);
  const error = result.auditRecord.error;
  const rawOutputRef = rawOutputRefFor(
    result.status === "FAILED" ? { error, output } : output,
  );
  storeJsonArtifact(rawOutputRef, result.status === "FAILED" ? { error, output } : output);
  return {
    ...result,
    modelContext: buildModelContext({
      toolName: result.toolName,
      input: result.auditRecord.input,
      output,
      rawOutputRef,
      status: result.status,
      ...(error !== undefined ? { error } : {}),
    }),
    auditRecord: {
      ...result.auditRecord,
      output,
    },
  };
}

export function buildAgentToolFailureResult(input: AgentToolFailureInput): AgentToolResult {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt = input.completedAt ?? new Date().toISOString();
  const error = normalizeToolError(input.error);
  const output = buildVisibleFailureOutput(input.toolName, input.input, error);
  const rawOutputRef = rawOutputRefFor({ error, output });
  storeJsonArtifact(rawOutputRef, { error, output });
  return {
    toolName: input.toolName,
    status: "FAILED",
    modelContext: buildModelContext({
      toolName: input.toolName,
      input: input.input,
      output,
      rawOutputRef,
      status: "FAILED",
      error,
    }),
    auditRecord: {
      toolName: input.toolName,
      input: sanitizeJsonValue(input.input),
      output,
      error,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      status: "FAILED",
    },
  };
}

export function buildAgentToolFailedOutputResult(input: AgentToolFailedOutputInput): AgentToolResult {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const completedAt = input.completedAt ?? new Date().toISOString();
  const output = sanitizeJsonValue(input.output);
  const outputRecord = asRecord(output);
  const error = normalizeToolError(input.error ?? {
    code: asString(outputRecord?.errorCode) ?? "TOOL_EXECUTION_FAILED",
    message:
      asString(outputRecord?.message) ??
      asString(outputRecord?.failureReason) ??
      "Tool execution failed.",
  });
  const rawOutputRef = rawOutputRefFor({ error, output });
  storeJsonArtifact(rawOutputRef, { error, output });
  return {
    toolName: input.toolName,
    status: "FAILED",
    modelContext: buildModelContext({
      toolName: input.toolName,
      input: input.input,
      output,
      rawOutputRef,
      status: "FAILED",
      error,
    }),
    auditRecord: {
      toolName: input.toolName,
      input: sanitizeJsonValue(input.input),
      output,
      error,
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      status: "FAILED",
    },
  };
}

export function rawOutputRefFor(value: unknown): string {
  return `tool-output:${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16)}`;
}

function buildModelContext(input: {
  toolName: string;
  input: unknown;
  output: unknown;
  rawOutputRef: string;
  status: "OK" | "FAILED";
  error?: unknown | undefined;
}) {
  return buildKestrelAgentToolModelContext({
    toolName: input.toolName,
    toolInput: input.input,
    toolOutput: input.output,
    rawOutputRef: input.rawOutputRef,
    status: input.status,
    ...(input.error !== undefined ? { error: input.error } : {}),
  });
}

function buildVisibleFailureOutput(toolName: string, input: unknown, error: Record<string, unknown>): Record<string, unknown> {
  const details = asRecord(error.details);
  const output = asRecord(error.output) ?? asRecord(details?.output);
  return compactDefined({
    status: "FAILED",
    toolName,
    errorCode: asString(error.code) ?? "TOOL_EXECUTION_FAILED",
    message: asString(error.message) ?? "Tool execution failed.",
    recoverable: details?.recoverable !== false && error.recoverable !== false,
    bootstrapReason: details?.bootstrapReason,
    reasonCode: details?.reasonCode,
    entrypointPath: details?.entrypointPath,
    statusMessage: details?.statusMessage,
    path: firstString(details?.path, asRecord(input)?.path),
    sourcePath: firstString(details?.sourcePath, asRecord(input)?.sourcePath),
    destinationPath: firstString(details?.destinationPath, asRecord(input)?.destinationPath),
    command: firstString(details?.command, output?.command, asRecord(input)?.command),
    cwd: firstString(details?.cwd, output?.cwd, asRecord(input)?.cwd),
    workspaceRoot: firstString(details?.workspaceRoot, output?.workspaceRoot, asRecord(input)?.workspaceRoot),
    requestedCwd: details?.requestedCwd,
    activeSessions: details?.activeSessions,
    nextSuggestedAction: details?.nextSuggestedAction,
    processId: firstString(details?.processId, output?.processId, asRecord(input)?.processId),
    statusCode: details?.statusCode,
    exitCode: details !== undefined && Object.hasOwn(details, "exitCode")
      ? details.exitCode
      : output?.exitCode,
    failureReason: details?.failureReason ?? output?.failureReason,
    failurePhase: details?.failurePhase ?? output?.failurePhase,
    commandKind: details?.commandKind ?? output?.commandKind,
    strictModeApplied: details?.strictModeApplied ?? output?.strictModeApplied,
    strictModeReason: details?.strictModeReason ?? output?.strictModeReason,
    field: details?.field,
    expected: details?.expected,
    stdout: details?.stdout ?? output?.stdout,
    stderr: details?.stderr ?? output?.stderr,
    text: details?.text ?? output?.text,
    validationErrors: details?.validationErrors,
    missingEnvNames: details?.missingEnvNames,
    unauthorizedSourceWrites: details?.unauthorizedSourceWrites,
  });
}

function normalizeToolError(error: unknown): Record<string, unknown> {
  if (error instanceof RuntimeFailure) {
    return compactDefined({
      code: error.code,
      message: normalizeErrorMessage(error.message),
      details: sanitizeJsonValue(error.details),
    });
  }
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown; details?: unknown; recoverable?: unknown; output?: unknown };
    return compactDefined({
      code: typeof coded.code === "string" ? coded.code : "TOOL_EXECUTION_FAILED",
      message: normalizeErrorMessage(error.message),
      details: sanitizeJsonValue(coded.details),
      recoverable: coded.recoverable,
      output: sanitizeJsonValue(coded.output),
    });
  }
  const record = asRecord(error);
  if (record !== undefined) {
    return compactDefined({
      code: asString(record.code) ?? "TOOL_EXECUTION_FAILED",
      message: normalizeErrorMessage(record.message),
      details: sanitizeJsonValue(record.details),
      recoverable: record.recoverable,
      output: sanitizeJsonValue(record.output),
    });
  }
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: normalizeErrorMessage(error),
  };
}

function normalizeErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed !== "[object Object]") {
      return value;
    }
  }
  return "Tool execution failed.";
}

function shouldRethrowToolError(error: unknown): boolean {
  if (error instanceof RunCancelledError) {
    return true;
  }
  if (error instanceof RuntimeFailure) {
    return asRecord(error.details)?.recoverable === false;
  }
  return false;
}

function stableStringify(value: unknown): string {
  try {
    return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
  } catch {
    return String(value);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function durationMs(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return ;
}

function compactDefined(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
