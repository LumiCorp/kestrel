import type { GatewayProtocolProvider } from "./gateway-utils";

export const GATEWAY_CREDENTIAL_STATUSES = [
  "unverified",
  "ready",
  "invalid",
  "not_required",
] as const;

export type GatewayCredentialStatus =
  (typeof GATEWAY_CREDENTIAL_STATUSES)[number];

export function initialGatewayCredentialStatus(
  provider: GatewayProtocolProvider,
): GatewayCredentialStatus {
  return provider === "ollama" ? "not_required" : "unverified";
}

export function isGatewayCredentialReadyForRuntime(input: {
  provider: GatewayProtocolProvider;
  credentialStatus: GatewayCredentialStatus;
  credentialValidatedAt?: Date | string | null;
  hasRequiredCredential: boolean;
}) {
  if (input.provider === "ollama") {
    return input.credentialStatus === "not_required";
  }
  return (
    input.hasRequiredCredential &&
    input.credentialStatus === "ready" &&
    Boolean(input.credentialValidatedAt)
  );
}

export function shouldInvalidateGatewayCredential(input: {
  failureCode?: string | null;
  grantCredentialRevision?: number | null;
  gatewayCredentialRevision?: number | null;
}) {
  return (
    input.failureCode === "MODEL_AUTH_ERROR" &&
    input.grantCredentialRevision !== null &&
    input.grantCredentialRevision !== undefined &&
    input.grantCredentialRevision === input.gatewayCredentialRevision
  );
}

export function isGatewayModelSyncAuthenticationFailure(error: unknown) {
  return (
    error instanceof GatewayModelSyncHttpError &&
    (error.status === 401 || error.status === 403)
  );
}

export class GatewayModelSyncHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Gateway model sync failed (${status}).`);
    this.name = "GatewayModelSyncHttpError";
    this.status = status;
  }
}
