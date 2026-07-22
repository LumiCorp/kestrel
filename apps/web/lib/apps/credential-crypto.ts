import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const ENVELOPE_PREFIX = "kapp:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export const APP_CREDENTIAL_ACTIVE_KEY_ID_ENV =
  "KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID";
export const APP_CREDENTIAL_KEYS_ENV = "KESTREL_APP_CREDENTIAL_KEYS";
const LEGACY_ACTIVE_KEY_ID_ENV = "KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID";
const LEGACY_KEYS_ENV = "KESTREL_MCP_CREDENTIAL_KEYS";

const RESERVED_SECRET_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const secretHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
    z.string().min(1).max(16_384)
  )
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (RESERVED_SECRET_HEADERS.has(name.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Header '${name}' is reserved by the App gateway.`,
        });
      }
    }
  });

const httpsUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    context.addIssue({
      code: "custom",
      message: "Credential endpoints must use credential-free HTTPS URLs.",
    });
  }
});

export const appCredentialPayloadSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("api_key"),
      apiKey: z.string().trim().min(1).max(16_384),
      projectId: z.string().trim().min(1).max(256).optional(),
      baseUrl: httpsUrlSchema.optional(),
    }),
    z.object({
      kind: z.literal("oauth"),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      tokenType: z.literal("Bearer"),
      scopes: z.array(z.string().min(1)).default([]),
      expiresAt: z.string().datetime().optional(),
      tokenEndpoint: httpsUrlSchema.optional(),
      resource: httpsUrlSchema.optional(),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      tokenEndpointAuthMethod: z
        .enum(["none", "client_secret_basic", "client_secret_post"])
        .default("none"),
    }),
    z.object({
      kind: z.literal("secret_headers"),
      headers: secretHeadersSchema,
    }),
    z.object({
      kind: z.literal("ngrok_agent"),
      authtoken: z.string().trim().min(1).max(16_384),
      wildcardDomain: z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(
          /^\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
        ),
    }),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "oauth") return;
    if (value.refreshToken && !(value.tokenEndpoint && value.clientId)) {
      context.addIssue({
        code: "custom",
        path: ["refreshToken"],
        message:
          "OAuth refresh credentials require a token endpoint and client ID.",
      });
    }
    if (
      value.tokenEndpointAuthMethod !== "none" &&
      !value.clientSecret
    ) {
      context.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "OAuth client authentication requires a client secret.",
      });
    }
  });

export type AppCredentialPayload = z.infer<typeof appCredentialPayloadSchema>;

type CredentialKeyring = {
  activeKeyId: string;
  keys: Map<string, Buffer>;
};

export class AppCredentialEncryptionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppCredentialEncryptionError";
    this.code = code;
  }
}

export function isEncryptedAppCredential(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function encryptAppCredential(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  credentialId: string;
  payload: AppCredentialPayload;
  env?: NodeJS.ProcessEnv | undefined;
}): string {
  const payload = appCredentialPayloadSchema.parse(input.payload);
  const keyring = readCredentialKeyring(input.env);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_ACTIVE_KEY_MISSING",
      `App credential active key '${keyring.activeKeyId}' is unavailable.`
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(getCredentialAad(input), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    ENVELOPE_PREFIX,
    encodeEnvelopePart(keyring.activeKeyId),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptAppCredential(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  credentialId: string;
  encrypted: string;
  env?: NodeJS.ProcessEnv | undefined;
}): AppCredentialPayload {
  const parts = input.encrypted.split(":");
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== ENVELOPE_PREFIX) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_PLAINTEXT_REJECTED",
      "Stored App credential is not an encrypted Kestrel App envelope."
    );
  }
  const [, , encodedKeyId, encodedIv, encodedAuthTag, encodedCiphertext] =
    parts;
  const keyId = decodeEnvelopePart(encodedKeyId ?? "");
  const key = readCredentialKeyring(input.env).keys.get(keyId);
  if (!key) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_KEY_UNKNOWN",
      `App credential key '${keyId}' is unavailable.`
    );
  }
  try {
    const iv = Buffer.from(encodedIv ?? "", "base64url");
    const authTag = Buffer.from(encodedAuthTag ?? "", "base64url");
    const ciphertext = Buffer.from(encodedCiphertext ?? "", "base64url");
    if (iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length < 1) {
      throw new Error("invalid envelope lengths");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(getCredentialAad(input), "utf8"));
    decipher.setAuthTag(authTag);
    const decoded = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return appCredentialPayloadSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_DECRYPT_FAILED",
      "Stored App credential could not be authenticated or decrypted."
    );
  }
}

export function assertAppCredentialEncryptionConfigured(
  env?: NodeJS.ProcessEnv | undefined
): void {
  readCredentialKeyring(env);
}

function readCredentialKeyring(
  env: NodeJS.ProcessEnv = process.env
): CredentialKeyring {
  const activeKeyId =
    env[APP_CREDENTIAL_ACTIVE_KEY_ID_ENV]?.trim() ||
    env[LEGACY_ACTIVE_KEY_ID_ENV]?.trim();
  const rawKeys =
    env[APP_CREDENTIAL_KEYS_ENV]?.trim() || env[LEGACY_KEYS_ENV]?.trim();
  if (!(activeKeyId && rawKeys)) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_ENCRYPTION_NOT_CONFIGURED",
      `App credential encryption requires ${APP_CREDENTIAL_ACTIVE_KEY_ID_ENV} and ${APP_CREDENTIAL_KEYS_ENV}.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_KEYS_INVALID",
      `${APP_CREDENTIAL_KEYS_ENV} must be a JSON object of key IDs to base64-encoded 32-byte keys.`
    );
  }
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_KEYS_INVALID",
      `${APP_CREDENTIAL_KEYS_ENV} must be a JSON object.`
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encodedKey] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) || typeof encodedKey !== "string") {
      throw new AppCredentialEncryptionError(
        "APP_CREDENTIAL_KEYS_INVALID",
        `${APP_CREDENTIAL_KEYS_ENV} contains an invalid key entry.`
      );
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== KEY_BYTES) {
      throw new AppCredentialEncryptionError(
        "APP_CREDENTIAL_KEY_LENGTH_INVALID",
        `App credential key '${keyId}' must decode to 32 bytes.`
      );
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_ACTIVE_KEY_MISSING",
      `App credential active key '${activeKeyId}' is not present in the configured keyring.`
    );
  }
  return { activeKeyId, keys };
}

function getCredentialAad(input: {
  organizationId: string;
  environmentId: string;
  appKey: string;
  credentialId: string;
}): string {
  const identity = [
    input.organizationId,
    input.environmentId,
    input.appKey,
    input.credentialId,
  ].map((value) => value.trim());
  if (identity.some((value) => !value)) {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_IDENTITY_REQUIRED",
      "Organization, Environment, App, and credential IDs are required for App credential encryption."
    );
  }
  return `kestrel-one:app-credential:${identity.join(":")}`;
}

function encodeEnvelopePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeEnvelopePart(value: string): string {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(decoded)) {
      throw new Error("invalid key id");
    }
    return decoded;
  } catch {
    throw new AppCredentialEncryptionError(
      "APP_CREDENTIAL_ENVELOPE_INVALID",
      "Stored App credential has an invalid key ID."
    );
  }
}
