import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const HOSTED_BROWSER_ARTIFACT_UPLOAD_CAPABILITY_VERSION =
  "hosted_browser_artifact_upload_capability_v1" as const;

export interface HostedBrowserArtifactUploadClaimsV1 {
  version: typeof HOSTED_BROWSER_ARTIFACT_UPLOAD_CAPABILITY_VERSION;
  organizationId: string;
  userId: string;
  threadId: string;
  runId: string;
  sessionId: string;
  generation: number;
  callId: string;
  artifactId: string;
  artifactKind: "browser-screenshot";
  byteLength: number;
  sha256: string;
  expiresAt: string;
}

export type HostedBrowserArtifactIdentityV1 = Omit<
  HostedBrowserArtifactUploadClaimsV1,
  "version" | "artifactId" | "expiresAt"
>;

export function deriveHostedBrowserArtifactId(
  identity: HostedBrowserArtifactIdentityV1,
): string {
  validateIdentity(identity);
  return `file-browser-${createHash("sha256")
    .update(canonicalIdentity(identity), "utf8")
    .digest("hex")}`;
}

export function issueHostedBrowserArtifactUploadCapability(input: {
  identity: HostedBrowserArtifactIdentityV1;
  expiresAt: string;
  privateKeyPem: string;
  now?: Date | undefined;
}): { token: string; claims: HostedBrowserArtifactUploadClaimsV1 } {
  const claims: HostedBrowserArtifactUploadClaimsV1 = {
    version: HOSTED_BROWSER_ARTIFACT_UPLOAD_CAPABILITY_VERSION,
    ...input.identity,
    artifactId: deriveHostedBrowserArtifactId(input.identity),
    expiresAt: input.expiresAt,
  };
  validateClaims(claims, input.now ?? new Date());
  const payload = Buffer.from(canonicalClaims(claims), "utf8").toString(
    "base64url",
  );
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Hosted Browser artifact signing key must be Ed25519.");
  }
  const signature = sign(null, Buffer.from(payload, "utf8"), key).toString(
    "base64url",
  );
  return { token: `${payload}.${signature}`, claims };
}

export function verifyHostedBrowserArtifactUploadCapability(input: {
  token: string;
  publicKeyPem: string;
  now?: Date | undefined;
}): HostedBrowserArtifactUploadClaimsV1 {
  const [payload, signature, extra] = input.token.split(".");
  if (!(payload && signature) || extra !== undefined) {
    throw new Error("Hosted Browser artifact capability is malformed.");
  }
  const key = createPublicKey(input.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("Hosted Browser artifact capability is invalid.");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Hosted Browser artifact capability payload is invalid.");
  }
  validateClaims(claims, input.now ?? new Date());
  return claims;
}

function validateClaims(
  value: unknown,
  now: Date,
): asserts value is HostedBrowserArtifactUploadClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hosted Browser artifact claims are invalid.");
  }
  const claims = value as Record<string, unknown>;
  const keys = [
    "version",
    "organizationId",
    "userId",
    "threadId",
    "runId",
    "sessionId",
    "generation",
    "callId",
    "artifactId",
    "artifactKind",
    "byteLength",
    "sha256",
    "expiresAt",
  ];
  if (
    Object.keys(claims).length !== keys.length ||
    keys.some((key) => !(key in claims)) ||
    claims.version !== HOSTED_BROWSER_ARTIFACT_UPLOAD_CAPABILITY_VERSION
  ) {
    throw new Error("Hosted Browser artifact claims have an invalid shape.");
  }
  const identity = identityFromClaims(claims);
  if (claims.artifactId !== deriveHostedBrowserArtifactId(identity)) {
    throw new Error("Hosted Browser artifact ID does not match its authority.");
  }
  const expiry = typeof claims.expiresAt === "string"
    ? new Date(claims.expiresAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new Error("Hosted Browser artifact capability has expired.");
  }
}

function validateIdentity(
  value: HostedBrowserArtifactIdentityV1,
): void {
  for (const field of [
    "organizationId",
    "userId",
    "threadId",
    "runId",
    "sessionId",
    "callId",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Hosted Browser artifact ${field} is invalid.`);
    }
  }
  if (
    value.artifactKind !== "browser-screenshot" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    throw new Error("Hosted Browser artifact identity is invalid.");
  }
}

function identityFromClaims(
  claims: Record<string, unknown>,
): HostedBrowserArtifactIdentityV1 {
  const identity = {
    organizationId: claims.organizationId,
    userId: claims.userId,
    threadId: claims.threadId,
    runId: claims.runId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    callId: claims.callId,
    artifactKind: claims.artifactKind,
    byteLength: claims.byteLength,
    sha256: claims.sha256,
  } as HostedBrowserArtifactIdentityV1;
  validateIdentity(identity);
  return identity;
}

function canonicalIdentity(identity: HostedBrowserArtifactIdentityV1): string {
  return JSON.stringify({
    organizationId: identity.organizationId,
    userId: identity.userId,
    threadId: identity.threadId,
    runId: identity.runId,
    sessionId: identity.sessionId,
    generation: identity.generation,
    callId: identity.callId,
    artifactKind: identity.artifactKind,
    byteLength: identity.byteLength,
    sha256: identity.sha256,
  });
}

function canonicalClaims(claims: HostedBrowserArtifactUploadClaimsV1): string {
  return JSON.stringify({
    version: claims.version,
    organizationId: claims.organizationId,
    userId: claims.userId,
    threadId: claims.threadId,
    runId: claims.runId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    callId: claims.callId,
    artifactKind: claims.artifactKind,
    byteLength: claims.byteLength,
    sha256: claims.sha256,
    artifactId: claims.artifactId,
    expiresAt: claims.expiresAt,
  });
}
