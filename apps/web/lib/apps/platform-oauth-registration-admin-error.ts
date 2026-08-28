import { ZodError } from "zod";
import { GatewayCredentialEncryptionError } from "@/lib/ai/gateway-credential-crypto";
import { PlatformOAuthRegistrationError } from "./platform-oauth-registrations";

export function getSafePlatformOAuthRegistrationAdminError(error: unknown) {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: "OAUTH_REGISTRATION_REQUEST_INVALID",
        error: "Invalid OAuth registration request.",
      },
    };
  }
  if (error instanceof GatewayCredentialEncryptionError) {
    return {
      status: 503,
      body: {
        code: "OAUTH_REGISTRATION_ENCRYPTION_UNAVAILABLE",
        error: "OAuth credential encryption is unavailable.",
      },
    };
  }
  if (error instanceof PlatformOAuthRegistrationError) {
    return { status: 409, body: { code: error.code, error: error.message } };
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
      code: "OAUTH_REGISTRATION_OPERATION_FAILED",
      error: "OAuth registration operation failed.",
    },
  };
}
