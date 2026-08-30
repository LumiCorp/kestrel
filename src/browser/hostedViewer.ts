import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  parseDesktopBrowserViewerInputRequest,
  type DesktopBrowserViewerInputV1,
} from "../desktopShell/contracts.js";
import {
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  type HostedBrowserViewerClientMessageV1,
} from "./hostedViewerProtocol.js";

export {
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  type HostedBrowserViewerClientMessageV1,
  type HostedBrowserViewerServerMessageV1,
} from "./hostedViewerProtocol.js";
export const HOSTED_BROWSER_VIEWER_TICKET_VERSION =
  "hosted_browser_viewer_ticket_v1" as const;
export const HOSTED_BROWSER_VIEWER_AUDIENCE =
  "kestrel-one-browser-viewer" as const;
export const HOSTED_BROWSER_VIEWER_TICKET_TTL_MS = 60_000;

export interface HostedBrowserViewerTicketClaimsV1 {
  version: typeof HOSTED_BROWSER_VIEWER_TICKET_VERSION;
  audience: typeof HOSTED_BROWSER_VIEWER_AUDIENCE;
  organizationId: string;
  environmentId: string;
  projectId: string;
  threadId: string;
  sessionId: string;
  generation: number;
  actorId: string;
  connectionId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function issueHostedBrowserViewerTicket(input: {
  claims: HostedBrowserViewerTicketClaimsV1;
  privateKeyPem: string;
  now?: Date | undefined;
}): string {
  validateClaims(input.claims, input.now ?? new Date());
  const payload = Buffer.from(JSON.stringify(canonicalClaims(input.claims)), "utf8").toString("base64url");
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return `${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
}

export function verifyHostedBrowserViewerTicket(input: {
  token: string;
  publicKeyPem: string;
  now?: Date | undefined;
}): HostedBrowserViewerTicketClaimsV1 {
  const [payload, signature, extra] = input.token.split(".");
  if (!(payload && signature) || extra !== undefined) throw new Error("BROWSER_SESSION_LOST");
  const key = createPublicKey(input.publicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))
  ) throw new Error("BROWSER_SESSION_LOST");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("BROWSER_SESSION_LOST");
  }
  validateClaims(claims, input.now ?? new Date());
  return claims;
}

export function parseHostedBrowserViewerClientMessage(value: unknown): HostedBrowserViewerClientMessageV1 {
  const record = requireRecord(value);
  if (record.version !== HOSTED_BROWSER_VIEWER_ROUTE_VERSION || typeof record.type !== "string") {
    throw new Error("BROWSER_SESSION_LOST");
  }
  if (record.type === "authenticate" && exactKeys(record, ["version", "type", "ticket"]) && text(record.ticket)) {
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "authenticate", ticket: record.ticket as string };
  }
  if ((record.type === "accept_takeover" || record.type === "close_session") && exactKeys(record, ["version", "type"])) {
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: record.type };
  }
  if ((record.type === "renew_lease" || record.type === "return_control") && exactKeys(record, ["version", "type", "leaseId"]) && text(record.leaseId)) {
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: record.type, leaseId: record.leaseId as string };
  }
  if (record.type === "input" && exactKeys(record, ["version", "type", "leaseId", "input"]) && text(record.leaseId)) {
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "input", leaseId: record.leaseId as string, input: parseViewerInput(record.input) };
  }
  throw new Error("BROWSER_SESSION_LOST");
}

function validateClaims(value: unknown, now: Date): asserts value is HostedBrowserViewerTicketClaimsV1 {
  const claims = requireRecord(value);
  if (!exactKeys(claims, ["version", "audience", "organizationId", "environmentId", "projectId", "threadId", "sessionId", "generation", "actorId", "connectionId", "nonce", "issuedAt", "expiresAt"]) ||
    claims.version !== HOSTED_BROWSER_VIEWER_TICKET_VERSION ||
    claims.audience !== HOSTED_BROWSER_VIEWER_AUDIENCE ||
    !Number.isSafeInteger(claims.generation) || Number(claims.generation) < 1) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  for (const field of ["organizationId", "environmentId", "projectId", "threadId", "sessionId", "actorId", "connectionId", "nonce", "issuedAt", "expiresAt"] as const) {
    if (!text(claims[field])) throw new Error("BROWSER_SESSION_LOST");
  }
  const issuedAt = Date.parse(claims.issuedAt as string);
  const expiresAt = Date.parse(claims.expiresAt as string);
  if (!(Number.isFinite(issuedAt) && Number.isFinite(expiresAt) ) || expiresAt - issuedAt !== HOSTED_BROWSER_VIEWER_TICKET_TTL_MS || issuedAt > now.getTime() + 5000 || expiresAt <= now.getTime()) {
    throw new Error("BROWSER_SESSION_LOST");
  }
}

function canonicalClaims(claims: HostedBrowserViewerTicketClaimsV1): HostedBrowserViewerTicketClaimsV1 {
  return {
    version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
    audience: HOSTED_BROWSER_VIEWER_AUDIENCE,
    organizationId: claims.organizationId,
    environmentId: claims.environmentId,
    projectId: claims.projectId,
    threadId: claims.threadId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    actorId: claims.actorId,
    connectionId: claims.connectionId,
    nonce: claims.nonce,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

function parseViewerInput(value: unknown): DesktopBrowserViewerInputV1 {
  // The shared parser owns the typed input boundary, including extra-key rejection.
  try {
    return parseDesktopBrowserViewerInputRequest({
      version: "desktop_browser_viewer_request_v1",
      threadId: "hosted-viewer-boundary",
      projectId: "hosted-viewer-boundary",
      sessionId: "hosted-viewer-boundary",
      generation: 1,
      connectionId: "hosted-viewer-boundary",
      leaseId: "hosted-viewer-boundary",
      input: value,
    }).input;
  } catch {
    throw new Error("BROWSER_SESSION_LOST");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROWSER_SESSION_LOST");
  return value as Record<string, unknown>;
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => key in record);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
