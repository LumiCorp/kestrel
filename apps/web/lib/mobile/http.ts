import { NextResponse } from "next/server";
import { ZodError } from "zod";

type PublicErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "ORGANIZATION_MEMBERSHIP_REQUIRED"
  | "ORGANIZATION_CONFIGURATION_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const publicMessages: Record<PublicErrorCode, string> = {
  BAD_REQUEST: "The request could not be completed.",
  UNAUTHORIZED: "Please sign in again.",
  ORGANIZATION_MEMBERSHIP_REQUIRED:
    "You are not a member of the requested organization.",
  ORGANIZATION_CONFIGURATION_ERROR:
    "The organization is not configured for mobile access.",
  FORBIDDEN: "You do not have access to this resource.",
  NOT_FOUND: "The requested resource is unavailable.",
  CONFLICT: "This resource changed before the request completed.",
  SERVICE_UNAVAILABLE: "Kestrel One is temporarily unavailable.",
  INTERNAL_ERROR: "Kestrel One could not complete the request.",
};

export function mobileErrorResponse(error: unknown, fallbackStatus = 500) {
  const internalCode =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null;
  const message = error instanceof Error ? error.message : "";
  let status = fallbackStatus;
  let code: PublicErrorCode = "INTERNAL_ERROR";

  if (internalCode === "UNAUTHORIZED") {
    status = 401;
    code = "UNAUTHORIZED";
  } else if (internalCode === "ORGANIZATION_MEMBERSHIP_REQUIRED") {
    status = 403;
    code = "ORGANIZATION_MEMBERSHIP_REQUIRED";
  } else if (internalCode === "ORGANIZATION_CONFIGURATION_ERROR") {
    status = 503;
    code = "ORGANIZATION_CONFIGURATION_ERROR";
  } else if (internalCode?.endsWith("_FORBIDDEN") || message === "Forbidden") {
    status = 403;
    code = "FORBIDDEN";
  } else if (internalCode?.endsWith("_NOT_FOUND") || fallbackStatus === 404) {
    status = 404;
    code = "NOT_FOUND";
  } else if (
    internalCode === "TURN_CONFLICT" ||
    internalCode === "QUEUE_PAUSED" ||
    internalCode?.endsWith("_CONFLICT")
  ) {
    status = 409;
    code = "CONFLICT";
  } else if (error instanceof ZodError || fallbackStatus === 400) {
    status = 400;
    code = "BAD_REQUEST";
  } else if (fallbackStatus === 503) {
    status = 503;
    code = "SERVICE_UNAVAILABLE";
  }

  return NextResponse.json(
    {
      error: {
        code,
        message: publicMessages[code],
        retryable: status >= 500,
      },
    },
    { status }
  );
}
