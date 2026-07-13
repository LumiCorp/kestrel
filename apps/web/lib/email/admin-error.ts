import { ZodError } from "zod";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { EmailConfigError } from "./config";
import { EmailDeliveryError } from "./service";

export function getSafeEmailAdminError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: "EMAIL_REQUEST_INVALID",
        error: "Invalid email configuration request.",
      },
    };
  }
  if (error instanceof GatewayCredentialEncryptionError) {
    return {
      status: 503,
      body: {
        code: "EMAIL_ENCRYPTION_UNAVAILABLE",
        error: "Email credential encryption is unavailable.",
      },
    };
  }
  if (error instanceof EmailConfigError) {
    return { status: 409, body: { code: error.code, error: error.message } };
  }
  if (error instanceof EmailDeliveryError) {
    return {
      status: 503,
      body: {
        code: error.code,
        error: "Email delivery is temporarily unavailable.",
      },
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "Unauthorized") {
    return {
      status: 401,
      body: { code: "UNAUTHORIZED", error: "Unauthorized" },
    };
  }
  if (message === "Forbidden") {
    return { status: 403, body: { code: "FORBIDDEN", error: "Forbidden" } };
  }
  return {
    status: 500,
    body: { code: "EMAIL_OPERATION_FAILED", error: "Email operation failed." },
  };
}
