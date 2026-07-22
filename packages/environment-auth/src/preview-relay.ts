import { sign, verify } from "node:crypto";

export const PREVIEW_RELAY_TICKET_AUDIENCE = "kestrel-preview-relay" as const;
export const PREVIEW_RELAY_TICKET_VERSION = 1 as const;
export const PREVIEW_RELAY_TICKET_MAX_TTL_SECONDS = 300;

export type PreviewRelayTicket = {
  version: typeof PREVIEW_RELAY_TICKET_VERSION;
  audience: typeof PREVIEW_RELAY_TICKET_AUDIENCE;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  flyAppName: string;
  flyMachineId: string;
  previewId: string;
  hostname: string;
  port: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export function signPreviewRelayTicket(input: {
  ticket: PreviewRelayTicket;
  privateKey: string;
}) {
  validatePreviewRelayTicket(input.ticket, input.ticket.issuedAt);
  const header = encode({ algorithm: "EdDSA", type: "KPR", version: 1 });
  const payload = encode(input.ticket);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`;
}

export function verifyPreviewRelayTicket(input: {
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
    parsedHeader.type !== "KPR" ||
    parsedHeader.version !== 1 ||
    !isRecord(parsed)
  ) {
    throw invalid();
  }
  const ticket = parsed as PreviewRelayTicket;
  validatePreviewRelayTicket(ticket, input.now ?? Math.floor(Date.now() / 1000));
  return ticket;
}

function validatePreviewRelayTicket(ticket: PreviewRelayTicket, now: number) {
  if (
    ticket.version !== PREVIEW_RELAY_TICKET_VERSION ||
    ticket.audience !== PREVIEW_RELAY_TICKET_AUDIENCE ||
    !ticket.organizationId ||
    !ticket.environmentId ||
    !ticket.workspaceId ||
    !ticket.flyAppName ||
    !ticket.flyMachineId ||
    !ticket.previewId ||
    !ticket.hostname ||
    !Number.isInteger(ticket.port) ||
    ticket.port < 1024 ||
    ticket.port > 65_535 ||
    ticket.expiresAt <= ticket.issuedAt ||
    ticket.expiresAt - ticket.issuedAt > PREVIEW_RELAY_TICKET_MAX_TTL_SECONDS ||
    ticket.issuedAt > now + 30 ||
    ticket.expiresAt <= now ||
    !ticket.nonce
  ) {
    throw invalid();
  }
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
  return new Error("Preview relay ticket is invalid or expired.");
}
