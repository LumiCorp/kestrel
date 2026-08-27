import { ZodError } from "zod";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { ReceivingConfigError } from "./receiving-config";

export function getSafeReceivingAdminError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: "RESEND_RECEIVING_REQUEST_INVALID",
        error: "Invalid inbound receiving request.",
      },
    };
  }
  if (error instanceof GatewayCredentialEncryptionError) {
    return {
      status: 503,
      body: {
        code: "RESEND_RECEIVING_ENCRYPTION_UNAVAILABLE",
        error: "Inbound receiving credential encryption is unavailable.",
      },
    };
  }
  if (error instanceof ReceivingConfigError) {
    const status =
      error.code === "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT" ? 409 : 422;
    return { status, body: { code: error.code, error: error.message } };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "Unauthorized") {
    return { status: 401, body: { code: "UNAUTHORIZED", error: "Unauthorized" } };
  }
  if (message === "Forbidden") {
    return { status: 403, body: { code: "FORBIDDEN", error: "Forbidden" } };
  }
  return {
    status: 500,
    body: {
      code: "RESEND_RECEIVING_OPERATION_FAILED",
      error: "Inbound receiving operation failed.",
    },
  };
}
