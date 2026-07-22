import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BlockList, isIP, isIPv4 } from "node:net";
import { z } from "zod";

const ENVELOPE_PREFIX = "kmcp:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export const MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV =
  "KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID";
export const MCP_CREDENTIAL_KEYS_ENV = "KESTREL_MCP_CREDENTIAL_KEYS";

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

export type McpResolvedAddress = { address: string; family: 4 | 6 };

export function normalizeMcpResolutionHostname(hostname: string): string {
  if (
    hostname.startsWith("[") &&
    hostname.endsWith("]") &&
    isIP(hostname.slice(1, -1)) === 6
  ) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

const nonPublicIpv4Addresses = new BlockList();
const nonPublicIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // Publicly routable IPv6 unicast is allocated from 2000::/3. Evaluate
  // IPv4-mapped addresses separately before applying these ranges.
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  nonPublicIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export function assertPublicMcpResolvedAddresses(
  addresses: readonly McpResolvedAddress[],
): void {
  if (addresses.length === 0) {
    throw new Error("MCP endpoint did not resolve to an address.");
  }
  for (const address of addresses) {
    const mappedIpv4 =
      address.family === 6 ? readMappedIpv4Address(address.address) : undefined;
    const isNonPublic = mappedIpv4
      ? nonPublicIpv4Addresses.check(mappedIpv4, "ipv4")
      : address.family === 4
        ? nonPublicIpv4Addresses.check(address.address, "ipv4")
        : nonPublicIpv6Addresses.check(address.address, "ipv6");
    if (isNonPublic) {
      throw new Error("MCP endpoint resolved to a non-public address.");
    }
  }
}

function readMappedIpv4Address(address: string): string | undefined {
  const normalized = address.toLowerCase();
  const suffix = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized.startsWith("0:0:0:0:0:ffff:")
      ? normalized.slice("0:0:0:0:0:ffff:".length)
      : undefined;
  if (!suffix) return;
  if (isIPv4(suffix)) return suffix;
  const words = suffix.split(":");
  if (words.length !== 2) return;
  const high = Number.parseInt(words[0] ?? "", 16);
  const low = Number.parseInt(words[1] ?? "", 16);
  if (
    !(/^[0-9a-f]{1,4}$/u.test(words[0] ?? "") &&/^[0-9a-f]{1,4}$/u.test(words[1] ?? "") ) ||
    high > 0xff_ff ||
    low > 0xff_ff
  ) {
    return;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

const secretHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
    z.string().min(1).max(16_384),
  )
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      if (RESERVED_SECRET_HEADERS.has(name.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Header '${name}' is reserved by the MCP gateway.`,
        });
      }
    }
  });

export const mcpCredentialPayloadSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("oauth"),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      tokenType: z.literal("Bearer"),
      scopes: z.array(z.string().min(1)).default([]),
      expiresAt: z.string().datetime().optional(),
      tokenEndpoint: z.string().url().optional(),
      resource: z.string().url().optional(),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      tokenEndpointAuthMethod: z
        .enum(["none", "client_secret_basic", "client_secret_post"])
        .default("none"),
      acceptedProviderTokenTypes: z
        .array(z.string().trim().min(1).max(40))
        .min(1)
        .max(5)
        .optional(),
    }),
    z.object({
      kind: z.literal("secret_headers"),
      headers: secretHeadersSchema,
    }),
  ])
  .superRefine((value, context) => {
    if (value.kind !== "oauth") {
      return;
    }
    if (value.refreshToken && !(value.tokenEndpoint && value.clientId)) {
      context.addIssue({
        code: "custom",
        path: ["refreshToken"],
        message:
          "OAuth refresh credentials require tokenEndpoint and clientId.",
      });
    }
    if (value.tokenEndpoint) {
      const endpoint = new URL(value.tokenEndpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password
      ) {
        context.addIssue({
          code: "custom",
          path: ["tokenEndpoint"],
          message: "OAuth token endpoint must be credential-free HTTPS.",
        });
      }
    }
    if (value.tokenEndpointAuthMethod !== "none" && !value.clientSecret) {
      context.addIssue({
        code: "custom",
        path: ["clientSecret"],
        message: "OAuth client authentication requires clientSecret.",
      });
    }
  });
export type McpCredentialPayload = z.infer<typeof mcpCredentialPayloadSchema>;

type CredentialKeyring = {
  activeKeyId: string;
  keys: Map<string, Buffer>;
};

export class McpCredentialEncryptionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpCredentialEncryptionError";
    this.code = code;
  }
}

export function isEncryptedMcpCredential(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function encryptMcpCredential(input: {
  organizationId: string;
  environmentId: string;
  credentialId: string;
  payload: McpCredentialPayload;
  env?: NodeJS.ProcessEnv | undefined;
}): string {
  const payload = mcpCredentialPayloadSchema.parse(input.payload);
  const keyring = readCredentialKeyring(input.env);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_ACTIVE_KEY_MISSING",
      `MCP credential active key '${keyring.activeKeyId}' is unavailable.`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(getCredentialAad(input), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
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

export function decryptMcpCredential(input: {
  organizationId: string;
  environmentId: string;
  credentialId: string;
  encrypted: string;
  env?: NodeJS.ProcessEnv | undefined;
}): McpCredentialPayload {
  const parts = input.encrypted.split(":");
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== ENVELOPE_PREFIX) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_PLAINTEXT_REJECTED",
      "Stored MCP credential is not an encrypted Kestrel credential envelope.",
    );
  }

  const [, , encodedKeyId, encodedIv, encodedAuthTag, encodedCiphertext] =
    parts;
  const keyId = decodeEnvelopePart(encodedKeyId ?? "");
  const keyring = readCredentialKeyring(input.env);
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_KEY_UNKNOWN",
      `MCP credential key '${keyId}' is unavailable.`,
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
    decipher.setAAD(Buffer.from(getCredentialAad(input), "utf8"));
    decipher.setAuthTag(authTag);
    const decoded = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return mcpCredentialPayloadSchema.parse(JSON.parse(decoded));
  } catch {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_DECRYPT_FAILED",
      "Stored MCP credential could not be authenticated or decrypted.",
    );
  }
}

export function assertMcpCredentialEncryptionConfigured(
  env?: NodeJS.ProcessEnv | undefined,
): void {
  readCredentialKeyring(env);
}

function readCredentialKeyring(
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeyring {
  const activeKeyId = env[MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV]?.trim();
  const rawKeys = env[MCP_CREDENTIAL_KEYS_ENV]?.trim();
  if (!(activeKeyId && rawKeys)) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_ENCRYPTION_NOT_CONFIGURED",
      `MCP credential encryption requires ${MCP_CREDENTIAL_ACTIVE_KEY_ID_ENV} and ${MCP_CREDENTIAL_KEYS_ENV}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_KEYS_INVALID",
      `${MCP_CREDENTIAL_KEYS_ENV} must be a JSON object of key IDs to base64-encoded 32-byte keys.`,
    );
  }
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_KEYS_INVALID",
      `${MCP_CREDENTIAL_KEYS_ENV} must be a JSON object.`,
    );
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encodedKey] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) ||
      typeof encodedKey !== "string"
    ) {
      throw new McpCredentialEncryptionError(
        "MCP_CREDENTIAL_KEYS_INVALID",
        `${MCP_CREDENTIAL_KEYS_ENV} contains an invalid key entry.`,
      );
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== KEY_BYTES) {
      throw new McpCredentialEncryptionError(
        "MCP_CREDENTIAL_KEY_LENGTH_INVALID",
        `MCP credential key '${keyId}' must decode to 32 bytes.`,
      );
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_ACTIVE_KEY_MISSING",
      `MCP credential active key '${activeKeyId}' is not present in ${MCP_CREDENTIAL_KEYS_ENV}.`,
    );
  }
  return { activeKeyId, keys };
}

function getCredentialAad(input: {
  organizationId: string;
  environmentId: string;
  credentialId: string;
}): string {
  const identity = [
    input.organizationId,
    input.environmentId,
    input.credentialId,
  ].map((value) => value.trim());
  if (identity.some((value) => !value)) {
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_IDENTITY_REQUIRED",
      "Organization, Environment, and credential IDs are required for MCP credential encryption.",
    );
  }
  return `kestrel-one:mcp-credential:${identity.join(":")}`;
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
    throw new McpCredentialEncryptionError(
      "MCP_CREDENTIAL_ENVELOPE_INVALID",
      "Stored MCP credential has an invalid key ID.",
    );
  }
}
