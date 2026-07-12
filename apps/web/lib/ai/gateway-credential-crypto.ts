import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_PREFIX = "kgc:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export const GATEWAY_CREDENTIAL_ACTIVE_KEY_ID_ENV =
  "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID";
export const GATEWAY_CREDENTIAL_KEYS_ENV = "KESTREL_GATEWAY_CREDENTIAL_KEYS";

type CredentialKeyring = {
  activeKeyId: string;
  keys: Map<string, Buffer>;
};

export class GatewayCredentialEncryptionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayCredentialEncryptionError";
    this.code = code;
  }
}

export function isEncryptedGatewayCredential(value: string) {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function encryptGatewayCredential(input: {
  gatewayId: string;
  plaintext: string;
  env?: NodeJS.ProcessEnv;
}) {
  const plaintext = input.plaintext.trim();
  if (!plaintext) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_EMPTY",
      "Gateway credential must not be empty."
    );
  }

  const keyring = readCredentialKeyring(input.env);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_ACTIVE_KEY_MISSING",
      `Gateway credential active key '${keyring.activeKeyId}' is unavailable.`
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(getCredentialAad(input.gatewayId), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX,
    encodeEnvelopePart(keyring.activeKeyId),
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptGatewayCredential(input: {
  gatewayId: string;
  encrypted: string;
  env?: NodeJS.ProcessEnv;
}) {
  const parts = input.encrypted.split(":");
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== ENVELOPE_PREFIX) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_PLAINTEXT_REJECTED",
      "Stored gateway credential is not an encrypted Kestrel credential envelope."
    );
  }

  const [, , encodedKeyId, encodedIv, encodedAuthTag, encodedCiphertext] =
    parts;
  const keyId = decodeEnvelopePart(encodedKeyId ?? "");
  const keyring = readCredentialKeyring(input.env);
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEY_UNKNOWN",
      `Gateway credential key '${keyId}' is unavailable.`
    );
  }

  try {
    const iv = Buffer.from(encodedIv ?? "", "base64url");
    const authTag = Buffer.from(encodedAuthTag ?? "", "base64url");
    const ciphertext = Buffer.from(encodedCiphertext ?? "", "base64url");
    if (
      iv.length !== IV_BYTES ||
      authTag.length !== 16 ||
      ciphertext.length < 1
    ) {
      throw new Error("invalid envelope lengths");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(getCredentialAad(input.gatewayId), "utf8"));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_DECRYPT_FAILED",
      "Stored gateway credential could not be authenticated or decrypted."
    );
  }
}

export function assertGatewayCredentialEncryptionConfigured(
  env?: NodeJS.ProcessEnv
) {
  readCredentialKeyring(env);
}

function readCredentialKeyring(
  env: NodeJS.ProcessEnv = process.env
): CredentialKeyring {
  const activeKeyId = env[GATEWAY_CREDENTIAL_ACTIVE_KEY_ID_ENV]?.trim();
  const rawKeys = env[GATEWAY_CREDENTIAL_KEYS_ENV]?.trim();
  if (!(activeKeyId && rawKeys)) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_ENCRYPTION_NOT_CONFIGURED",
      `Gateway credential encryption requires ${GATEWAY_CREDENTIAL_ACTIVE_KEY_ID_ENV} and ${GATEWAY_CREDENTIAL_KEYS_ENV}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEYS_INVALID",
      `${GATEWAY_CREDENTIAL_KEYS_ENV} must be a JSON object of key IDs to base64-encoded 32-byte keys.`
    );
  }
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_KEYS_INVALID",
      `${GATEWAY_CREDENTIAL_KEYS_ENV} must be a JSON object.`
    );
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encodedKey] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) ||
      typeof encodedKey !== "string"
    ) {
      throw new GatewayCredentialEncryptionError(
        "GATEWAY_CREDENTIAL_KEYS_INVALID",
        `${GATEWAY_CREDENTIAL_KEYS_ENV} contains an invalid key entry.`
      );
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== KEY_BYTES) {
      throw new GatewayCredentialEncryptionError(
        "GATEWAY_CREDENTIAL_KEY_LENGTH_INVALID",
        `Gateway credential key '${keyId}' must decode to 32 bytes.`
      );
    }
    keys.set(keyId, key);
  }

  if (!keys.has(activeKeyId)) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_ACTIVE_KEY_MISSING",
      `Gateway credential active key '${activeKeyId}' is not present in ${GATEWAY_CREDENTIAL_KEYS_ENV}.`
    );
  }
  return { activeKeyId, keys };
}

function getCredentialAad(gatewayId: string) {
  const normalized = gatewayId.trim();
  if (!normalized) {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_GATEWAY_ID_REQUIRED",
      "Gateway ID is required for credential encryption."
    );
  }
  return `kestrel-one:gateway-credential:${normalized}`;
}

function encodeEnvelopePart(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeEnvelopePart(value: string) {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(decoded)) {
      throw new Error("invalid key id");
    }
    return decoded;
  } catch {
    throw new GatewayCredentialEncryptionError(
      "GATEWAY_CREDENTIAL_ENVELOPE_INVALID",
      "Stored gateway credential has an invalid key ID."
    );
  }
}
