import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const HOSTED_BROWSER_CAPABILITY_VERSION =
  "hosted_browser_operation_capability_v1" as const;

export interface HostedBrowserOperationClaimsV1 {
  version: typeof HOSTED_BROWSER_CAPABILITY_VERSION;
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  sessionId: string;
  generation: number;
  operationId: string;
  effectiveAllowlistRevision: string;
  expiresAt: string;
}

export function issueHostedBrowserOperationCapability(input: {
  claims: HostedBrowserOperationClaimsV1;
  privateKeyPem: string;
  now?: Date | undefined;
}): string {
  validateClaims(input.claims, input.now ?? new Date());
  const payload = Buffer.from(canonicalClaims(input.claims), "utf8").toString(
    "base64url",
  );
  const signature = signPayload(payload, input.privateKeyPem);
  return `${payload}.${signature}`;
}

export function verifyHostedBrowserOperationCapability(input: {
  token: string;
  expected: Omit<HostedBrowserOperationClaimsV1, "expiresAt">;
  publicKeyPem: string;
  now?: Date | undefined;
  allowExpired?: boolean | undefined;
}): HostedBrowserOperationClaimsV1 {
  const parsed = verifyHostedBrowserCapabilitySignature(input);
  const expected = input.expected;
  for (const field of [
    "version",
    "organizationId",
    "environmentId",
    "projectId",
    "userId",
    "threadId",
    "sessionId",
    "generation",
    "operationId",
    "effectiveAllowlistRevision",
  ] as const) {
    if (parsed[field] !== expected[field]) {
      throw new Error(`Hosted Browser capability ${field} does not match.`);
    }
  }
  return parsed;
}

export function verifyHostedBrowserCapabilitySignature(input: {
  token: string;
  publicKeyPem: string;
  now?: Date | undefined;
  allowExpired?: boolean | undefined;
}): HostedBrowserOperationClaimsV1 {
  const [payload, signature, extra] = input.token.split(".");
  if (!(payload && signature) || extra !== undefined) {
    throw new Error("Hosted Browser capability is malformed.");
  }
  if (!verifyPayload(payload, signature, input.publicKeyPem)) {
    throw new Error("Hosted Browser capability signature is invalid.");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Hosted Browser capability payload is invalid.");
  }
  validateClaims(claims, input.now ?? new Date(), input.allowExpired === true);
  return claims;
}

function validateClaims(
  value: unknown,
  now: Date,
  allowExpired = false,
): asserts value is HostedBrowserOperationClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hosted Browser capability claims are invalid.");
  }
  const claims = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    "organizationId",
    "environmentId",
    "projectId",
    "userId",
    "threadId",
    "sessionId",
    "generation",
    "operationId",
    "effectiveAllowlistRevision",
    "expiresAt",
  ];
  if (
    Object.keys(claims).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in claims))
  ) {
    throw new Error("Hosted Browser capability claims have an invalid shape.");
  }
  if (claims.version !== HOSTED_BROWSER_CAPABILITY_VERSION) {
    throw new Error("Hosted Browser capability version is invalid.");
  }
  for (const field of [
    "organizationId",
    "environmentId",
    "projectId",
    "userId",
    "threadId",
    "sessionId",
    "operationId",
    "effectiveAllowlistRevision",
  ]) {
    if (typeof claims[field] !== "string" || claims[field] === "") {
      throw new Error(`Hosted Browser capability ${field} is invalid.`);
    }
  }
  if (!Number.isInteger(claims.generation) || Number(claims.generation) < 1) {
    throw new Error("Hosted Browser capability generation is invalid.");
  }
  if (typeof claims.expiresAt !== "string") {
    throw new Error("Hosted Browser capability expiry is invalid.");
  }
  const expiry = new Date(claims.expiresAt);
  if (
    !Number.isFinite(expiry.getTime()) ||
    (!allowExpired && expiry.getTime() <= now.getTime())
  ) {
    throw new Error("Hosted Browser capability has expired.");
  }
}

function canonicalClaims(claims: HostedBrowserOperationClaimsV1): string {
  return JSON.stringify({
    version: claims.version,
    organizationId: claims.organizationId,
    environmentId: claims.environmentId,
    projectId: claims.projectId,
    userId: claims.userId,
    threadId: claims.threadId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    operationId: claims.operationId,
    effectiveAllowlistRevision: claims.effectiveAllowlistRevision,
    expiresAt: claims.expiresAt,
  });
}

function signPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Hosted Browser capability signing key must be Ed25519.");
  }
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

function verifyPayload(
  payload: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Hosted Browser capability verification key must be Ed25519.");
  }
  return verify(
    null,
    Buffer.from(payload, "utf8"),
    key,
    Buffer.from(signature, "base64url"),
  );
}
