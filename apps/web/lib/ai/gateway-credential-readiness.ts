import {
  assertGatewayCredentialEncryptionConfigured,
  decryptGatewayCredential,
  GatewayCredentialEncryptionError,
  isEncryptedGatewayCredential,
} from "./gateway-credential-crypto";

export type GatewayCredentialAuthorityHealth = {
  ok: boolean;
  code: string | null;
};

export function getGatewayCredentialAuthorityHealth(
  env: NodeJS.ProcessEnv = process.env
): GatewayCredentialAuthorityHealth {
  if (!env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN?.trim()) {
    return {
      ok: false,
      code: "GATEWAY_CREDENTIAL_BROKER_NOT_CONFIGURED",
    };
  }
  try {
    assertGatewayCredentialEncryptionConfigured(env);
    return { ok: true, code: null };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof GatewayCredentialEncryptionError
          ? error.code
          : "GATEWAY_CREDENTIAL_ENCRYPTION_INVALID",
    };
  }
}

export function getGatewayCredentialStorageHealth(
  rows: Array<{
    id: string;
    apiKey: string | null;
    apiKeyEnvVar: string | null;
  }>,
  env: NodeJS.ProcessEnv = process.env
): GatewayCredentialAuthorityHealth {
  for (const row of rows) {
    const stored = row.apiKey?.trim();
    if (!stored) {
      continue;
    }
    if (row.apiKeyEnvVar?.trim()) {
      return {
        ok: false,
        code: "GATEWAY_CREDENTIAL_SOURCE_NOT_CUT_OVER",
      };
    }
    if (!isEncryptedGatewayCredential(stored)) {
      return { ok: false, code: "GATEWAY_CREDENTIAL_PLAINTEXT_REJECTED" };
    }
    try {
      decryptGatewayCredential({
        gatewayId: row.id,
        encrypted: stored,
        env,
      });
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof GatewayCredentialEncryptionError
            ? error.code
            : "GATEWAY_CREDENTIAL_DECRYPT_FAILED",
      };
    }
  }
  return { ok: true, code: null };
}
