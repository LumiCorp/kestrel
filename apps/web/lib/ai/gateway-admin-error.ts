import { ZodError } from "zod";
import { GatewayCredentialEncryptionError } from "./gateway-credential-crypto";
import { GatewayCredentialSourceError } from "./gateway-credential-source";

type GatewayAdminErrorBody = {
  code: string;
  error: string;
};

export function getSafeGatewayAdminError(
  error: unknown,
  fallbackStatus = 500
): { body: GatewayAdminErrorBody; status: number } {
  if (error instanceof ZodError) {
    return {
      body: {
        code: "GATEWAY_REQUEST_INVALID",
        error: "Invalid gateway request.",
      },
      status: 400,
    };
  }

  if (error instanceof GatewayCredentialEncryptionError) {
    return {
      body: {
        code: error.code,
        error: "Gateway credential encryption is unavailable.",
      },
      status: 503,
    };
  }

  if (error instanceof GatewayCredentialSourceError) {
    return {
      body: {
        code: error.code,
        error: "Gateway credential source is invalid.",
      },
      status: 400,
    };
  }

  const message = error instanceof Error ? error.message : "";
  if (message === "Unauthorized") {
    return {
      body: { code: "UNAUTHORIZED", error: "Unauthorized" },
      status: 401,
    };
  }
  if (message === "Forbidden") {
    return {
      body: { code: "FORBIDDEN", error: "Forbidden" },
      status: 403,
    };
  }
  if (message === "Gateway not found") {
    return {
      body: { code: "GATEWAY_NOT_FOUND", error: "Gateway not found" },
      status: 404,
    };
  }

  return {
    body: {
      code: "GATEWAY_OPERATION_FAILED",
      error: "Gateway operation failed.",
    },
    status: fallbackStatus,
  };
}
