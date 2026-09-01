import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const HOSTED_BROWSER_UPLOAD_PREPARATION_CAPABILITY_VERSION =
  "hosted_browser_upload_preparation_capability_v1" as const;

export interface HostedBrowserUploadPreparationClaimsV1 {
  version: typeof HOSTED_BROWSER_UPLOAD_PREPARATION_CAPABILITY_VERSION;
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  turnId: string;
  runId: string;
  sessionId: string;
  generation: number;
  attachmentId: string;
  snapshotId: string;
  targetRef: string;
  effectRevision: string;
  expiresAt: string;
}

export function issueHostedBrowserUploadPreparationCapability(input: {
  claims: HostedBrowserUploadPreparationClaimsV1;
  privateKeyPem: string;
  now?: Date | undefined;
}): string {
  validate(input.claims, input.now ?? new Date());
  const payload = Buffer.from(canonical(input.claims), "utf8").toString("base64url");
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Browser upload signing key is invalid.");
  return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
}

export function verifyHostedBrowserUploadPreparationCapability(input: {
  token: string;
  publicKeyPem: string;
  now?: Date | undefined;
}): HostedBrowserUploadPreparationClaimsV1 {
  const [payload, signature, extra] = input.token.split(".");
  if (!(payload && signature) || extra !== undefined) throw new Error("Browser upload capability is malformed.");
  const key = createPublicKey(input.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))
  ) throw new Error("Browser upload capability signature is invalid.");
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("Browser upload capability payload is invalid."); }
  validate(claims, input.now ?? new Date());
  return claims;
}

function validate(
  value: unknown,
  now: Date,
): asserts value is HostedBrowserUploadPreparationClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser upload claims are invalid.");
  const claims = value as Record<string, unknown>;
  const keys = [
    "version", "organizationId", "environmentId", "projectId", "userId",
    "threadId", "turnId", "runId", "sessionId", "generation", "attachmentId",
    "snapshotId", "targetRef", "effectRevision", "expiresAt",
  ];
  if (Object.keys(claims).length !== keys.length || keys.some((key) => !(key in claims))) {
    throw new Error("Browser upload claims shape is invalid.");
  }
  if (claims.version !== HOSTED_BROWSER_UPLOAD_PREPARATION_CAPABILITY_VERSION) throw new Error("Browser upload claims version is invalid.");
  for (const field of keys.filter((key) => key !== "version" && key !== "generation")) {
    if (typeof claims[field] !== "string" || claims[field] === "") throw new Error(`Browser upload ${field} is invalid.`);
  }
  if (!Number.isSafeInteger(claims.generation) || Number(claims.generation) < 1) throw new Error("Browser upload generation is invalid.");
  if (Date.parse(String(claims.expiresAt)) <= now.getTime()) throw new Error("Browser upload capability expired.");
}

function canonical(claims: HostedBrowserUploadPreparationClaimsV1) {
  return JSON.stringify({
    version: claims.version,
    organizationId: claims.organizationId,
    environmentId: claims.environmentId,
    projectId: claims.projectId,
    userId: claims.userId,
    threadId: claims.threadId,
    turnId: claims.turnId,
    runId: claims.runId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    attachmentId: claims.attachmentId,
    snapshotId: claims.snapshotId,
    targetRef: claims.targetRef,
    effectRevision: claims.effectRevision,
    expiresAt: claims.expiresAt,
  });
}
