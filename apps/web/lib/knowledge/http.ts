import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { classifyDbError } from "@/lib/db/runtime";

export function errorResponse(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null;
  let status = fallbackStatus;
  let details: unknown;
  const dbError = classifyDbError(error);

  if (error instanceof ZodError) {
    status = 400;
    details = error.flatten();
  }

  if (
    message === "Unauthorized" ||
    message === "Invalid API key." ||
    code === "UNAUTHORIZED"
  ) {
    status = 401;
  } else if (code === "PROJECT_NOT_FOUND") {
    status = 404;
  } else if (code === "PROJECT_FORBIDDEN") {
    status = 403;
  } else if (
    code === "ENVIRONMENT_NOT_FOUND" ||
    code === "ENVIRONMENT_BINDING_NOT_FOUND"
  ) {
    status = 404;
  } else if (
    code === "ENVIRONMENT_FORBIDDEN" ||
    code === "WORKSPACE_SOURCE_FORBIDDEN"
  ) {
    status = 403;
  } else if (
    code === "PROJECT_CONTEXT_CONFLICT" ||
    code === "PROJECT_LAST_OWNER" ||
    code === "ENVIRONMENT_INVALID_TRANSITION" ||
    code === "WORKSPACE_INVALID_TRANSITION" ||
    code === "ENVIRONMENT_UNAVAILABLE"
  ) {
    status = 409;
  } else if (message === "Forbidden") {
    status = 403;
  } else if (message === "Active organization required") {
    status = 400;
  } else if (message === "Source not found") {
    status = 404;
  } else if (
    message === "Snapshot unavailable" ||
    message === "No active knowledge snapshot is available" ||
    message === "No active snapshot is available"
  ) {
    status = 409;
  } else if (
    message === "Discord guild already bound to another organization"
  ) {
    status = 409;
  } else if (message === "Invalid body" || message === "Invalid query") {
    status = 400;
  } else if (
    message.includes("credentials are not configured") ||
    message.includes("credentials not configured") ||
    message.includes("environment variable is not set") ||
    message.includes("must be set") ||
    message.includes("is required")
  ) {
    status = status === 500 ? 503 : status;
  }

  if (dbError.category !== "unknown" && status === 500) {
    status =
      dbError.category === "query_failed"
        ? 500
        : dbError.category === "misconfigured_database" ||
            dbError.category === "authentication_failed" ||
            dbError.retryable
          ? 503
          : status;
  }

  const body = details ? { error: message, details } : { error: message };

  if (dbError.category !== "unknown") {
    Object.assign(body, { category: dbError.category });
  }

  return NextResponse.json(body, { status });
}
