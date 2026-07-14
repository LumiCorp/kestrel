import type { IncomingHttpHeaders } from "node:http";
import {
  EnvironmentTicketError,
  verifyEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import type { AuthorizedMcpGrant, McpGrantStore } from "./contracts.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type McpRequestAuthorization =
  | { ok: true; grant: AuthorizedMcpGrant }
  | { ok: false; status: 401 | 403; code: string };

export async function authorizeMcpRequest(input: {
  headers: IncomingHttpHeaders;
  publicKey: string;
  grantStore: McpGrantStore;
  now?: Date | undefined;
}): Promise<McpRequestAuthorization> {
  const grantId = readSingleHeader(input.headers["x-kestrel-mcp-grant-id"]);
  const token = readBearerToken(input.headers.authorization);
  if (!(grantId && UUID_PATTERN.test(grantId) && token)) {
    return { ok: false, status: 401, code: "MCP_AUTH_REQUIRED" };
  }
  const now = input.now ?? new Date();
  let ticket;
  try {
    ticket = verifyEnvironmentExecutionTicket({
      token,
      publicKey: input.publicKey,
      now: Math.floor(now.getTime() / 1000),
    });
  } catch (error) {
    const code =
      error instanceof EnvironmentTicketError ? error.code : "TICKET_INVALID";
    return { ok: false, status: 401, code };
  }
  const grant = await input.grantStore.activateGrant({
    grantId,
    runExecutionId: ticket.runId,
    organizationId: ticket.organizationId,
    environmentId: ticket.environmentId,
    threadId: ticket.threadId,
    now,
  });
  if (!grant) {
    return { ok: false, status: 403, code: "MCP_GRANT_INVALID" };
  }
  return { ok: true, grant };
}

export function isAllowedOrigin(input: {
  origin: string | undefined;
  allowedOrigins: ReadonlySet<string>;
}): boolean {
  if (input.origin === undefined) {
    return true;
  }
  try {
    return input.allowedOrigins.has(new URL(input.origin).origin);
  } catch {
    return false;
  }
}

function readBearerToken(value: string | undefined): string | undefined {
  if (!value?.startsWith("Bearer ")) {
    return;
  }
  const token = value.slice("Bearer ".length).trim();
  return token || undefined;
}

function readSingleHeader(
  value: string | string[] | undefined
): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  return normalized || undefined;
}
