import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

export async function throwIfExecutionAuthorizationRejected(input: {
  response: Response;
  body?: unknown;
  toolName: string;
}) {
  if (input.response.status !== 401) return;
  const body = input.body ?? await input.response.clone().json().catch(() => undefined);
  const error = asRecord(asRecord(body)?.error);
  if (!isExecutionAuthorizationExpiredCode(error?.code)) return;
  throw createRuntimeFailure(
    "EXECUTION_AUTH_EXPIRED",
    "Execution authorization expired before provider dispatch.",
    {
      subsystem: "tooling",
      toolName: input.toolName,
      classification: "authorization",
      recoverable: true,
    },
  );
}

export function isExecutionAuthorizationExpiredCode(value: unknown): boolean {
  return value === "EXECUTION_AUTH_EXPIRED" || value === "TICKET_EXPIRED";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
