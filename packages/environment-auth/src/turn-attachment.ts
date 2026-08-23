import { sign, verify } from "node:crypto";

/**
 * A deliberately separate credential for the durable-turn attachment
 * resolver. It carries no environment, user, Thread, or file authority: the
 * web process derives those values from the turn row before signing URLs.
 */
export const TURN_ATTACHMENT_RESOLUTION_TICKET_AUDIENCE =
  "kestrel-turn-attachment-resolver";
export const TURN_ATTACHMENT_RESOLUTION_TICKET_VERSION = 1;
export const TURN_ATTACHMENT_RESOLUTION_TICKET_MAX_TTL_SECONDS = 60;
export const TURN_ATTACHMENT_RESOLUTION_TICKET_CLOCK_SKEW_SECONDS = 30;

export type TurnAttachmentResolutionTicket = {
  version: typeof TURN_ATTACHMENT_RESOLUTION_TICKET_VERSION;
  audience: typeof TURN_ATTACHMENT_RESOLUTION_TICKET_AUDIENCE;
  turnId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export class TurnAttachmentResolutionTicketError extends Error {
  constructor(
    readonly code:
      | "TICKET_INVALID"
      | "TICKET_EXPIRED"
      | "TICKET_AUDIENCE_INVALID"
      | "TICKET_TTL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "TurnAttachmentResolutionTicketError";
  }
}

export function signTurnAttachmentResolutionTicket(input: {
  ticket: TurnAttachmentResolutionTicket;
  privateKey: string;
}): string {
  const privateKey = requireKey(input.privateKey, "private");
  const ticket = parseTurnAttachmentResolutionTicket(input.ticket);
  validateTurnAttachmentResolutionTicket(ticket, ticket.issuedAt, false);
  const header = encodeJson({
    algorithm: "EdDSA",
    type: "KTA",
    version: TURN_ATTACHMENT_RESOLUTION_TICKET_VERSION,
  });
  const payload = encodeJson(ticket);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

export function verifyTurnAttachmentResolutionTicket(input: {
  token: string;
  publicKey: string;
  now?: number;
}): TurnAttachmentResolutionTicket {
  const publicKey = requireKey(input.publicKey, "public");
  const parts = input.token.split(".");
  if (parts.length !== 3) throw invalidTicket();
  const [header, payload, suppliedSignature] = parts;
  if (!(header && payload && suppliedSignature)) throw invalidTicket();
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw invalidTicket();
  }
  if (!verify(null, Buffer.from(signingInput), publicKey, signature)) {
    throw invalidTicket();
  }
  const decodedHeader = decodeJson(header);
  if (
    !isRecord(decodedHeader) ||
    Object.keys(decodedHeader).length !== 3 ||
    decodedHeader.algorithm !== "EdDSA" ||
    decodedHeader.type !== "KTA" ||
    decodedHeader.version !== TURN_ATTACHMENT_RESOLUTION_TICKET_VERSION
  ) {
    throw invalidTicket();
  }
  const ticket = parseTurnAttachmentResolutionTicket(decodeJson(payload));
  validateTurnAttachmentResolutionTicket(
    ticket,
    input.now ?? Math.floor(Date.now() / 1000),
    true,
  );
  return ticket;
}

function parseTurnAttachmentResolutionTicket(
  value: unknown,
): TurnAttachmentResolutionTicket {
  if (!isRecord(value)) throw invalidTicket();
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "audience",
    "expiresAt",
    "issuedAt",
    "nonce",
    "turnId",
    "version",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.version !== TURN_ATTACHMENT_RESOLUTION_TICKET_VERSION ||
    value.audience !== TURN_ATTACHMENT_RESOLUTION_TICKET_AUDIENCE ||
    typeof value.turnId !== "string" ||
    value.turnId.length === 0 ||
    value.turnId.length > 200 ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    value.nonce.length > 200 ||
    typeof value.issuedAt !== "number" ||
    !Number.isInteger(value.issuedAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isInteger(value.expiresAt)
  ) {
    throw invalidTicket();
  }
  return value as TurnAttachmentResolutionTicket;
}

function validateTurnAttachmentResolutionTicket(
  ticket: TurnAttachmentResolutionTicket,
  now: number,
  enforceCurrentTime: boolean,
) {
  if (ticket.audience !== TURN_ATTACHMENT_RESOLUTION_TICKET_AUDIENCE) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_AUDIENCE_INVALID",
      "Attachment resolution ticket audience is invalid.",
    );
  }
  if (
    ticket.expiresAt <= ticket.issuedAt ||
    ticket.expiresAt - ticket.issuedAt >
      TURN_ATTACHMENT_RESOLUTION_TICKET_MAX_TTL_SECONDS
  ) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_TTL_INVALID",
      "Attachment resolution ticket lifetime is invalid.",
    );
  }
  if (!enforceCurrentTime) return;
  if (ticket.issuedAt > now + TURN_ATTACHMENT_RESOLUTION_TICKET_CLOCK_SKEW_SECONDS) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_TTL_INVALID",
      "Attachment resolution ticket lifetime is invalid.",
    );
  }
  if (ticket.expiresAt <= now) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_EXPIRED",
      "Attachment resolution ticket has expired.",
    );
  }
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidTicket();
  }
}

function requireKey(value: string, kind: "private" | "public") {
  if (!value.includes(`BEGIN ${kind.toUpperCase()} KEY`)) {
    throw new TurnAttachmentResolutionTicketError(
      "TICKET_INVALID",
      `Attachment resolution ticket ${kind} key is not configured.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTicket() {
  return new TurnAttachmentResolutionTicketError(
    "TICKET_INVALID",
    "Attachment resolution ticket is invalid.",
  );
}
