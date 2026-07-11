import path from "node:path";
import { resolveKestrelHomePath } from "./kestrelHome.js";

export const PLAN_DOCUMENT_ROOT = "~/.kestrel/sessions";
export const PLAN_DOCUMENT_FILENAME = "PLAN.md";
export const PLAN_DOCUMENT_HOME_ROOT = "sessions";

export type RuntimePlanStatus = "draft" | "approved" | "executing" | "complete";

export interface RuntimePlanState {
  path: string;
  status: RuntimePlanStatus;
}

export interface RuntimePlanDocumentSnapshot {
  path: string;
  exists: boolean;
  content?: string | undefined;
}

export interface RuntimePlanValidationError {
  code: "RUNTIME_PLAN_INVALID";
  message: string;
  path: string;
}

const VALID_PLAN_STATUSES = new Set<RuntimePlanStatus>(["draft", "approved", "executing", "complete"]);

export function buildPlanDocumentRelativePath(sessionId: unknown): string | undefined {
  const segment = sanitizePlanDocumentSessionSegment(sessionId);
  return segment === undefined ? undefined : `~/.kestrel/${PLAN_DOCUMENT_HOME_ROOT}/${segment}/${PLAN_DOCUMENT_FILENAME}`;
}

export function isPlanDocumentPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizePlanDocumentPath(value);
  return normalized.startsWith(`~/.kestrel/${PLAN_DOCUMENT_HOME_ROOT}/`) &&
    normalized.endsWith(`/${PLAN_DOCUMENT_FILENAME}`) &&
    normalized.split("/").includes("..") === false;
}

export function resolvePlanDocumentAbsolutePath(value: unknown, homePath = resolveKestrelHomePath()): string | undefined {
  if (isPlanDocumentPath(value) === false) {
    return undefined;
  }
  const normalized = normalizePlanDocumentPath(value);
  const relativeToHome = normalized.slice("~/.kestrel/".length);
  return path.join(homePath, relativeToHome);
}

export function sanitizePlanDocumentSessionSegment(sessionId: unknown): string | undefined {
  const raw = normalizeString(sessionId);
  if (raw === undefined) {
    return undefined;
  }
  const sanitized = raw
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^[._-]+/u, "")
    .replace(/_+/gu, "_")
    .slice(0, 96);
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return undefined;
  }
  return sanitized;
}

export function validateRuntimePlanState(
  value: unknown,
): { ok: true; value: RuntimePlanState } | { ok: false; error: RuntimePlanValidationError } {
  const record = asRecord(value);
  if (record === undefined) {
    return invalid("plan", "state.agent.plan must be an object");
  }
  const extraKey = readUnexpectedKey(record, ["path", "status"]);
  if (extraKey !== undefined) {
    return invalid(`plan.${extraKey}`, "state.agent.plan contains an unsupported field");
  }
  const planPath = normalizeString(record.path);
  if (planPath === undefined || isPlanDocumentPath(planPath) === false) {
    return invalid("plan.path", "state.agent.plan.path must be a session-scoped PLAN.md path");
  }
  if (typeof record.status !== "string" || VALID_PLAN_STATUSES.has(record.status as RuntimePlanStatus) === false) {
    return invalid("plan.status", "state.agent.plan.status is invalid");
  }
  return {
    ok: true,
    value: {
      path: normalizePlanDocumentPath(planPath),
      status: record.status as RuntimePlanStatus,
    },
  };
}

export function normalizeRuntimePlanState(value: unknown): RuntimePlanState | undefined {
  const result = validateRuntimePlanState(value);
  return result.ok ? result.value : undefined;
}

export function normalizeRuntimePlanDocumentSnapshot(value: unknown): RuntimePlanDocumentSnapshot | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const planPath = normalizeString(record.path);
  if (planPath === undefined || isPlanDocumentPath(planPath) === false) {
    return undefined;
  }
  if (typeof record.exists !== "boolean") {
    return undefined;
  }
  return {
    path: normalizePlanDocumentPath(planPath),
    exists: record.exists,
    ...(normalizeString(record.content) !== undefined ? { content: normalizeString(record.content) } : {}),
  };
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePlanDocumentPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readUnexpectedKey(record: Record<string, unknown>, allowed: string[]): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(record).find((key) => allowedSet.has(key) === false);
}

function invalid(path: string, message: string): { ok: false; error: RuntimePlanValidationError } {
  return {
    ok: false,
    error: {
      code: "RUNTIME_PLAN_INVALID",
      message,
      path,
    },
  };
}
