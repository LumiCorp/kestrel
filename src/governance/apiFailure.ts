import { asRuntimeError } from "../runtime/RuntimeFailure.js";
import type { ApiFailure, FailureDiagnosticsSummary } from "./contracts.js";

export function toApiFailure(
  error: unknown,
  fallback: {
    code: string;
    message: string;
    details?: Record<string, unknown> | undefined;
    subsystem?: FailureDiagnosticsSummary["subsystem"] | undefined;
    classification?: FailureDiagnosticsSummary["classification"] | undefined;
  },
): ApiFailure {
  const runtime = asRuntimeError(error);
  const normalizedCode =
    runtime.code === "RUNTIME_ERROR" || runtime.code === "UNKNOWN_ERROR"
      ? fallback.code
      : runtime.code;
  const normalizedMessage =
    runtime.message.trim().length > 0 ? runtime.message : fallback.message;
  const details = mergeDetails(fallback.details, runtime.details);
  const inferredSubsystem = inferSubsystem(normalizedCode, details) ?? fallback.subsystem;
  const inferredClassification =
    inferClassification(normalizedCode, details) ?? fallback.classification;

  return {
    code: normalizedCode,
    message: normalizedMessage,
    ...(details !== undefined ? { details } : {}),
    ...(inferredSubsystem !== undefined ? { subsystem: inferredSubsystem } : {}),
    ...(inferredClassification !== undefined
      ? { classification: inferredClassification }
      : {}),
  };
}

function mergeDetails(
  fallback: Record<string, unknown> | undefined,
  runtime: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = {
    ...(fallback ?? {}),
    ...(runtime ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function inferSubsystem(
  code: string,
  details: Record<string, unknown> | undefined,
): FailureDiagnosticsSummary["subsystem"] | undefined {
  const explicit = asString(details?.subsystem);
  if (
    explicit === "react" ||
    explicit === "tooling" ||
    explicit === "decision" ||
    explicit === "runtime"
  ) {
    return explicit;
  }
  if (code.startsWith("REACT_")) {
    return "react";
  }
  if (code.startsWith("TOOL_")) {
    return "tooling";
  }
  if (code.startsWith("DECISION_")) {
    return "decision";
  }
  if (
    code.startsWith("RUN_") ||
    code.startsWith("REGION_") ||
    code.startsWith("EFFECT_") ||
    code.startsWith("IO_") ||
    code.startsWith("WEB_")
  ) {
    return "runtime";
  }
  return ;
}

function inferClassification(
  code: string,
  details: Record<string, unknown> | undefined,
): FailureDiagnosticsSummary["classification"] | undefined {
  const explicit = asString(details?.classification);
  if (
    explicit === "recoverable" ||
    explicit === "configuration" ||
    explicit === "determinism" ||
    explicit === "policy" ||
    explicit === "schema" ||
    explicit === "runtime"
  ) {
    return explicit;
  }
  if (code.includes("DETERMINISM")) {
    return "determinism";
  }
  if (code.includes("POLICY")) {
    return "policy";
  }
  if (code.includes("SCHEMA") || code.includes("PARSE") || code.includes("INVALID")) {
    return "schema";
  }
  if (code.includes("CONFIG") || code.includes("ALLOWLIST")) {
    return "configuration";
  }
  if (code.startsWith("DECISION_")) {
    return "recoverable";
  }
  if (
    code.startsWith("RUN_") ||
    code.startsWith("WEB_") ||
    code.startsWith("STORE_")
  ) {
    return "runtime";
  }
  return ;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
