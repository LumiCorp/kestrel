export class GatewayCredentialSourceError extends Error {
  readonly code: string;

  constructor(
    code = "GATEWAY_CREDENTIAL_SOURCE_INVALID",
    message = "A gateway credential must use either a stored secret or an environment variable, not both."
  ) {
    super(message);
    this.name = "GatewayCredentialSourceError";
    this.code = code;
  }
}

export function normalizeGatewayStoredCredential(
  value: string | null | undefined
) {
  if (value === undefined || value === null) {
    return value;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new GatewayCredentialSourceError(
      "GATEWAY_CREDENTIAL_EMPTY",
      "Gateway credential must not be empty."
    );
  }
  return normalized;
}

export function resolveGatewayEnvironmentCredential(input: {
  apiKeyEnvVar: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  const envVar = input.apiKeyEnvVar?.trim();
  if (!envVar) {
    return null;
  }
  return (input.env ?? process.env)[envVar]?.trim() || null;
}

export function selectGatewayCredentialEnvVarForCreate(input: {
  apiKey: string | null | undefined;
  apiKeyEnvVar: string | null | undefined;
  defaultApiKeyEnvVar: string | null;
}) {
  assertExclusiveGatewayCredentialSource(input);
  if (input.apiKeyEnvVar !== undefined) {
    return input.apiKeyEnvVar;
  }
  return input.apiKey?.trim() ? null : input.defaultApiKeyEnvVar;
}

export function selectGatewayCredentialEnvVarForUpdate(input: {
  apiKey: string | null | undefined;
  apiKeyEnvVar: string | null | undefined;
}) {
  assertExclusiveGatewayCredentialSource(input);
  if (input.apiKeyEnvVar !== undefined) {
    return input.apiKeyEnvVar;
  }
  return input.apiKey !== undefined ? null : undefined;
}

export function shouldClearStoredGatewayCredentialForUpdate(input: {
  apiKey: string | null | undefined;
  apiKeyEnvVar: string | null | undefined;
}) {
  assertExclusiveGatewayCredentialSource(input);
  return input.apiKey === undefined && Boolean(input.apiKeyEnvVar?.trim());
}

function assertExclusiveGatewayCredentialSource(input: {
  apiKey: string | null | undefined;
  apiKeyEnvVar: string | null | undefined;
}) {
  if (input.apiKey?.trim() && input.apiKeyEnvVar?.trim()) {
    throw new GatewayCredentialSourceError();
  }
}
