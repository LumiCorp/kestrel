import { ZodError } from "zod";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { DesktopUserAuthorizationError } from "@/lib/desktop-account";
import { ReceivingConfigError } from "./receiving-config";

export function getSafeReceivingAdminError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 422,
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
    return safeConfigError(error);
  }
  if (error instanceof DesktopUserAuthorizationError) {
    return {
      status: 401,
      body: { code: "UNAUTHORIZED", error: "Unauthorized" },
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
    body: {
      code: "RESEND_RECEIVING_OPERATION_FAILED",
      error: "Inbound receiving operation failed.",
    },
  };
}

function safeConfigError(error: ReceivingConfigError) {
  switch (error.code) {
    case "RESEND_RECEIVING_CREDENTIAL_INSUFFICIENT":
      return {
        status: 409,
        body: {
          code: error.code,
          error: "Resend receiving requires a Full access API key.",
        },
      };
    case "RESEND_RECEIVING_PROVIDER_UNAVAILABLE":
      return {
        status: 503,
        body: {
          code: error.code,
          error: "Resend receiving is temporarily unavailable.",
        },
      };
    case "RESEND_RECEIVING_RESPONSE_INVALID":
      return {
        status: 502,
        body: {
          code: error.code,
          error: "Resend returned an invalid receiving response.",
        },
      };
    case "RESEND_RECEIVING_CREDENTIAL_REQUIRED":
      return {
        status: 422,
        body: {
          code: error.code,
          error: "Enter a Resend Full access API key.",
        },
      };
    case "RESEND_RECEIVING_CREDENTIAL_CHANGED":
      return {
        status: 422,
        body: {
          code: error.code,
          error:
            "The Resend credential changed while receiving was being saved. Refresh and try again.",
        },
      };
    case "RESEND_RECEIVING_DOMAIN_INVALID":
      return {
        status: 422,
        body: {
          code: error.code,
          error: "The selected Resend resource is unavailable.",
        },
      };
    case "RESEND_RECEIVING_DOMAIN_NOT_READY":
      return {
        status: 422,
        body: {
          code: error.code,
          error:
            "Choose a verified Resend receiving domain with healthy MX records.",
        },
      };
    case "RESEND_RECEIVING_REQUEST_INVALID":
      return {
        status: 422,
        body: {
          code: error.code,
          error: "Resend rejected the receiving request.",
        },
      };
    default:
      return {
        status: 500,
        body: {
          code: "RESEND_RECEIVING_OPERATION_FAILED",
          error: "Inbound receiving operation failed.",
        },
      };
  }
}
