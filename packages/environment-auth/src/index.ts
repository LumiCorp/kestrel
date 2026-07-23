import { sign, verify } from "node:crypto";

export * from "./gateway-config.js";
export * from "./preview-relay.js";
export * from "./workspace-readiness.js";

export const ENVIRONMENT_ROUTER_AUDIENCE = "kestrel-environment-router";
export const ENVIRONMENT_TICKET_VERSION = 1;
export const ENVIRONMENT_TICKET_MAX_TTL_SECONDS = 300;
export const ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE =
  "kestrel-environment-tool-broker";
export const ENVIRONMENT_TOOL_CREDENTIAL_VERSION = 1;
export const ENVIRONMENT_TOOL_CREDENTIAL_MAX_TTL_SECONDS = 60;

export type EnvironmentExecutionTicket = {
  version: 1;
  audience: typeof ENVIRONMENT_ROUTER_AUDIENCE;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  actorId: string;
  agentId: string;
  flyAppName: string;
  flyMachineId: string;
  capabilities: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type EnvironmentToolCredentialTicket = {
  version: 1;
  audience: typeof ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  actorId: string;
  agentId: string;
  providerKey: string;
  resourceId: string;
  capability: string;
  operation: string;
  operationBinding: string | null;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export class EnvironmentTicketError extends Error {
  constructor(
    readonly code:
      | "TICKET_INVALID"
      | "TICKET_EXPIRED"
      | "TICKET_AUDIENCE_INVALID"
      | "TICKET_TTL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentTicketError";
  }
}

export function signEnvironmentExecutionTicket(input: {
  ticket: EnvironmentExecutionTicket;
  privateKey: string;
}): string {
  const privateKey = requireKey(input.privateKey, "private");
  validateTicket(input.ticket, input.ticket.issuedAt);
  const header = encodeJson({ algorithm: "EdDSA", type: "KET", version: 1 });
  const payload = encodeJson(input.ticket);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

export function verifyEnvironmentExecutionTicket(input: {
  token: string;
  publicKey: string;
  now?: number;
}): EnvironmentExecutionTicket {
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
    decodedHeader.algorithm !== "EdDSA" ||
    decodedHeader.type !== "KET" ||
    decodedHeader.version !== 1
  ) {
    throw invalidTicket();
  }
  const ticket = parseTicket(decodeJson(payload));
  validateTicket(ticket, input.now ?? Math.floor(Date.now() / 1000));
  return ticket;
}

export function signEnvironmentToolCredential(input: {
  ticket: EnvironmentToolCredentialTicket;
  privateKey: string;
}): string {
  const privateKey = requireKey(
    input.privateKey,
    "private",
    "Environment tool credential",
  );
  validateToolCredential(input.ticket, input.ticket.issuedAt);
  const header = encodeJson({ algorithm: "EdDSA", type: "KTC", version: 1 });
  const payload = encodeJson(input.ticket);
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

export function verifyEnvironmentToolCredential(input: {
  token: string;
  publicKey: string;
  now?: number;
}): EnvironmentToolCredentialTicket {
  const publicKey = requireKey(
    input.publicKey,
    "public",
    "Environment tool credential",
  );
  const parts = input.token.split(".");
  if (parts.length !== 3) throw invalidToolCredential();
  const [header, payload, suppliedSignature] = parts;
  if (!(header && payload && suppliedSignature)) throw invalidToolCredential();
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw invalidToolCredential();
  }
  if (!verify(null, Buffer.from(signingInput), publicKey, signature)) {
    throw invalidToolCredential();
  }
  const decodedHeader = decodeJson(header);
  if (
    !isRecord(decodedHeader) ||
    decodedHeader.algorithm !== "EdDSA" ||
    decodedHeader.type !== "KTC" ||
    decodedHeader.version !== 1
  ) {
    throw invalidToolCredential();
  }
  const ticket = parseToolCredential(decodeJson(payload));
  validateToolCredential(ticket, input.now ?? Math.floor(Date.now() / 1000));
  return ticket;
}

function validateTicket(ticket: EnvironmentExecutionTicket, now: number) {
  if (ticket.audience !== ENVIRONMENT_ROUTER_AUDIENCE) {
    throw new EnvironmentTicketError(
      "TICKET_AUDIENCE_INVALID",
      "Execution ticket audience is invalid.",
    );
  }
  if (
    ticket.expiresAt <= ticket.issuedAt ||
    ticket.expiresAt - ticket.issuedAt > ENVIRONMENT_TICKET_MAX_TTL_SECONDS ||
    ticket.issuedAt > now + 30
  ) {
    throw new EnvironmentTicketError(
      "TICKET_TTL_INVALID",
      "Execution ticket lifetime is invalid.",
    );
  }
  if (ticket.expiresAt <= now) {
    throw new EnvironmentTicketError(
      "TICKET_EXPIRED",
      "Execution ticket has expired.",
    );
  }
}

function validateToolCredential(
  ticket: EnvironmentToolCredentialTicket,
  now: number,
) {
  if (ticket.audience !== ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE) {
    throw new EnvironmentTicketError(
      "TICKET_AUDIENCE_INVALID",
      "Environment tool credential audience is invalid.",
    );
  }
  if (
    ticket.expiresAt <= ticket.issuedAt ||
    ticket.expiresAt - ticket.issuedAt >
      ENVIRONMENT_TOOL_CREDENTIAL_MAX_TTL_SECONDS ||
    ticket.issuedAt > now + 30
  ) {
    throw new EnvironmentTicketError(
      "TICKET_TTL_INVALID",
      "Environment tool credential lifetime is invalid.",
    );
  }
  if (ticket.expiresAt <= now) {
    throw new EnvironmentTicketError(
      "TICKET_EXPIRED",
      "Environment tool credential has expired.",
    );
  }
}

function parseTicket(value: unknown): EnvironmentExecutionTicket {
  if (!isRecord(value)) throw invalidTicket();
  const requiredStrings = [
    "organizationId",
    "environmentId",
    "workspaceId",
    "threadId",
    "runId",
    "actorId",
    "agentId",
    "flyAppName",
    "flyMachineId",
    "nonce",
  ] as const;
  if (
    value.version !== ENVIRONMENT_TICKET_VERSION ||
    value.audience !== ENVIRONMENT_ROUTER_AUDIENCE ||
    requiredStrings.some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    ) ||
    typeof value.issuedAt !== "number" ||
    !Number.isInteger(value.issuedAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isInteger(value.expiresAt) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length === 0 ||
    value.capabilities.some(
      (capability) => typeof capability !== "string" || !capability,
    )
  ) {
    throw invalidTicket();
  }
  return value as EnvironmentExecutionTicket;
}

function parseToolCredential(value: unknown): EnvironmentToolCredentialTicket {
  if (!isRecord(value)) throw invalidToolCredential();
  const requiredStrings = [
    "organizationId",
    "environmentId",
    "workspaceId",
    "threadId",
    "runId",
    "actorId",
    "agentId",
    "providerKey",
    "resourceId",
    "capability",
    "operation",
    "nonce",
  ] as const;
  if (
    value.version !== ENVIRONMENT_TOOL_CREDENTIAL_VERSION ||
    value.audience !== ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE ||
    requiredStrings.some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    ) ||
    (value.operationBinding !== null &&
      (typeof value.operationBinding !== "string" ||
        value.operationBinding.length === 0)) ||
    typeof value.issuedAt !== "number" ||
    !Number.isInteger(value.issuedAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isInteger(value.expiresAt)
  ) {
    throw invalidToolCredential();
  }
  return value as EnvironmentToolCredentialTicket;
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

function requireKey(
  value: string,
  kind: "private" | "public",
  credentialName = "Execution ticket",
) {
  if (!value.includes(`BEGIN ${kind.toUpperCase()} KEY`)) {
    throw new EnvironmentTicketError(
      "TICKET_INVALID",
      `${credentialName} ${kind} key is not configured.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTicket() {
  return new EnvironmentTicketError(
    "TICKET_INVALID",
    "Execution ticket is invalid.",
  );
}

function invalidToolCredential() {
  return new EnvironmentTicketError(
    "TICKET_INVALID",
    "Environment tool credential is invalid.",
  );
}
