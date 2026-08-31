import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const HOSTED_BROWSER_DOWNLOAD_PREPARATION_CAPABILITY_VERSION =
  "hosted_browser_download_preparation_capability_v1" as const;

export interface HostedBrowserDownloadPreparationClaimsV1 {
  version: typeof HOSTED_BROWSER_DOWNLOAD_PREPARATION_CAPABILITY_VERSION;
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  runId: string;
  sessionId: string;
  generation: number;
  pendingDownloadId: string;
  effectRevision: string;
  expiresAt: string;
}

export function issueHostedBrowserDownloadPreparationCapability(input: {
  claims: HostedBrowserDownloadPreparationClaimsV1;
  privateKeyPem: string;
  now?: Date;
}): string {
  validate(input.claims, input.now ?? new Date());
  const payload = Buffer.from(canonical(input.claims), "utf8").toString("base64url");
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Browser download signing key is invalid.");
  return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
}

export function verifyHostedBrowserDownloadPreparationCapability(input: {
  token: string;
  publicKeyPem: string;
  now?: Date;
}): HostedBrowserDownloadPreparationClaimsV1 {
  const [payload, signature, extra] = input.token.split(".");
  if (!(payload && signature) || extra !== undefined) throw new Error("Browser download capability is malformed.");
  const key = createPublicKey(input.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))
  ) throw new Error("Browser download capability signature is invalid.");
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("Browser download capability payload is invalid."); }
  validate(claims, input.now ?? new Date());
  return claims;
}

function validate(
  value: unknown,
  now: Date,
): asserts value is HostedBrowserDownloadPreparationClaimsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser download claims are invalid.");
  const claims = value as Record<string, unknown>;
  const keys = [
    "version", "organizationId", "environmentId", "projectId", "userId",
    "threadId", "runId", "sessionId", "generation", "pendingDownloadId",
    "effectRevision", "expiresAt",
  ];
  if (Object.keys(claims).length !== keys.length || keys.some((key) => !(key in claims))) {
    throw new Error("Browser download claims shape is invalid.");
  }
  if (claims.version !== HOSTED_BROWSER_DOWNLOAD_PREPARATION_CAPABILITY_VERSION) throw new Error("Browser download claims version is invalid.");
  for (const field of keys.filter((key) => key !== "version" && key !== "generation")) {
    if (typeof claims[field] !== "string" || claims[field] === "") throw new Error(`Browser download ${field} is invalid.`);
  }
  if (!Number.isSafeInteger(claims.generation) || Number(claims.generation) < 1) throw new Error("Browser download generation is invalid.");
  if (Date.parse(String(claims.expiresAt)) <= now.getTime()) throw new Error("Browser download capability expired.");
}

function canonical(claims: HostedBrowserDownloadPreparationClaimsV1): string {
  return JSON.stringify({
    version: claims.version,
    organizationId: claims.organizationId,
    environmentId: claims.environmentId,
    projectId: claims.projectId,
    userId: claims.userId,
    threadId: claims.threadId,
    runId: claims.runId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    pendingDownloadId: claims.pendingDownloadId,
    effectRevision: claims.effectRevision,
    expiresAt: claims.expiresAt,
  });
}
