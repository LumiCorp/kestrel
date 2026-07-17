import type { SubAgentResultEnvelope } from "../kestrel/contracts/orchestration.js";

export type SubAgentResultStatus = SubAgentResultEnvelope["status"];

const VALID_STATUSES = new Set<SubAgentResultStatus>(["completed", "blocked", "failed"]);

export function normalizeSubAgentResultEnvelope(
  payload: unknown,
  fallbackStatus: SubAgentResultStatus,
  fallbackError?: SubAgentResultEnvelope["error"] | undefined,
): SubAgentResultEnvelope {
  const record = asRecord(payload);
  const status = normalizeStatus(record?.status, fallbackStatus);
  const result = normalizeResult(payload, record);
  const references = normalizeReferences(record?.references);
  const error = normalizeError(record?.error) ?? fallbackError;
  return {
    status,
    result,
    ...(references !== undefined ? { references } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function readSubAgentResultEnvelope(value: unknown): SubAgentResultEnvelope | undefined {
  const record = asRecord(value);
  if (record === undefined || isSubAgentResultStatus(record.status) === false || typeof record.result !== "string") {
    return ;
  }
  const references = normalizeReferences(record.references);
  const error = normalizeError(record.error);
  return {
    status: record.status,
    result: record.result,
    ...(references !== undefined ? { references } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function normalizeStatus(value: unknown, fallbackStatus: SubAgentResultStatus): SubAgentResultStatus {
  return isSubAgentResultStatus(value) ? value : fallbackStatus;
}

function isSubAgentResultStatus(value: unknown): value is SubAgentResultStatus {
  return typeof value === "string" && VALID_STATUSES.has(value as SubAgentResultStatus);
}

function normalizeResult(payload: unknown, record: Record<string, unknown> | undefined): string {
  if (typeof record?.result === "string") {
    return record.result;
  }
  if (typeof record?.message === "string") {
    return record.message;
  }
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const stringified = JSON.stringify(payload);
    if (typeof stringified === "string") {
      return stringified;
    }
  } catch {
  }
  return String(payload);
}

function normalizeReferences(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const references = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return references.length > 0 ? references : undefined;
}

function normalizeError(value: unknown): SubAgentResultEnvelope["error"] | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.code !== "string" || typeof record.message !== "string") {
    return ;
  }
  return {
    code: record.code,
    message: record.message,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
