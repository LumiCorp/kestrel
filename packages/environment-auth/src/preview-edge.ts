import { sign, verify } from "node:crypto";

export const PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE =
  "kestrel-preview-edge-route" as const;
export const PREVIEW_EDGE_ROUTE_TICKET_VERSION = 1 as const;
export const PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS = 300;
export const PREVIEW_EDGE_ROUTE_TICKET_CLOCK_SKEW_SECONDS = 30;
export const PREVIEW_EDGE_AUTHORIZATION_HEADER =
  "x-kestrel-preview-edge-authorization" as const;

export type PreviewEdgeRouteTicket = {
  version: typeof PREVIEW_EDGE_ROUTE_TICKET_VERSION;
  audience: typeof PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  flyAppName: string;
  previewId: string;
  hostname: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export function signPreviewEdgeRouteTicket(input: {
  ticket: PreviewEdgeRouteTicket;
  privateKey: string;
}) {
  validatePreviewEdgeRouteTicket(input.ticket, input.ticket.issuedAt);
  const header = encode({ algorithm: "EdDSA", type: "KPE", version: 1 });
  const payload = encode(input.ticket);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`;
}

export function verifyPreviewEdgeRouteTicket(input: {
  token: string;
  publicKey: string;
  now?: number | undefined;
}) {
  const [header, payload, signature, ...extra] = input.token.split(".");
  if (!(header && payload && signature) || extra.length > 0) throw invalid();
  const signingInput = `${header}.${payload}`;
  if (
    !verify(
      null,
      Buffer.from(signingInput),
      input.publicKey,
      Buffer.from(signature, "base64url")
    )
  ) {
    throw invalid();
  }
  const parsedHeader = decode(header);
  const parsed = decode(payload);
  if (
    !isRecord(parsedHeader) ||
    parsedHeader.algorithm !== "EdDSA" ||
    parsedHeader.type !== "KPE" ||
    parsedHeader.version !== 1 ||
    !isRecord(parsed)
  ) {
    throw invalid();
  }
  return parsePreviewEdgeRouteTicket(
    parsed,
    input.now ?? Math.floor(Date.now() / 1000)
  );
}

function validatePreviewEdgeRouteTicket(
  ticket: PreviewEdgeRouteTicket,
  now: number
) {
  parsePreviewEdgeRouteTicket(ticket, now);
}

function parsePreviewEdgeRouteTicket(
  value: unknown,
  now: number
): PreviewEdgeRouteTicket {
  if (!isRecord(value)) throw invalid();
  const expectedKeys = [
    "version",
    "audience",
    "organizationId",
    "environmentId",
    "workspaceId",
    "flyAppName",
    "previewId",
    "hostname",
    "issuedAt",
    "expiresAt",
    "nonce",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalid();
  }
  const stringFields = [
    "audience",
    "organizationId",
    "environmentId",
    "workspaceId",
    "flyAppName",
    "previewId",
    "hostname",
    "nonce",
  ] as const;
  if (
    stringFields.some(
      (field) =>
        typeof value[field] !== "string" || value[field].length === 0
    ) ||
    value.version !== PREVIEW_EDGE_ROUTE_TICKET_VERSION ||
    value.audience !== PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw invalid();
  }
  const ticket = {
    version: value.version,
    audience: value.audience,
    organizationId: value.organizationId,
    environmentId: value.environmentId,
    workspaceId: value.workspaceId,
    flyAppName: value.flyAppName,
    previewId: value.previewId,
    hostname: value.hostname,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    nonce: value.nonce,
  } as PreviewEdgeRouteTicket;
  if (
    ticket.version !== PREVIEW_EDGE_ROUTE_TICKET_VERSION ||
    ticket.audience !== PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE ||
    !ticket.organizationId ||
    !ticket.environmentId ||
    !ticket.workspaceId ||
    !ticket.flyAppName ||
    !ticket.previewId ||
    !validHostname(ticket.hostname) ||
    ticket.expiresAt <= ticket.issuedAt ||
    ticket.expiresAt - ticket.issuedAt >
      PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS ||
    ticket.issuedAt > now + PREVIEW_EDGE_ROUTE_TICKET_CLOCK_SKEW_SECONDS ||
    ticket.expiresAt <= now ||
    ticket.expiresAt >
      now +
        PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS +
        PREVIEW_EDGE_ROUTE_TICKET_CLOCK_SKEW_SECONDS
  ) {
    throw invalid();
  }
  return ticket;
}

function validHostname(value: string) {
  return (
    value === value.toLowerCase() &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      value
    )
  );
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalid() {
  return new Error("Preview Edge route ticket is invalid or expired.");
}
