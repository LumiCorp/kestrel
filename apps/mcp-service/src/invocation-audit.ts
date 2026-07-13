import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuthorizedMcpGrant } from "./contracts.js";

export type InvocationIdentity = {
  grant: AuthorizedMcpGrant;
  serverId: string;
  capabilityId: string;
  method: string;
  request: unknown;
};

export interface InvocationAudit {
  execute<T>(
    identity: InvocationIdentity,
    operation: () => Promise<T>
  ): Promise<T>;
  markWaitingApproval(identity: InvocationIdentity): Promise<string>;
}

export class PostgresInvocationAudit implements InvocationAudit {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async execute<T>(
    identity: InvocationIdentity,
    operation: () => Promise<T>
  ): Promise<T> {
    const invocationId = randomUUID();
    const requestDigest = digestJson(identity.request);
    const startedAt = new Date();
    await this.pool.query(
      `INSERT INTO mcp_invocations (
         id, grant_id, server_id, capability_id, request_id, method,
         request_digest, status, replay_evidence, started_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9)`,
      [
        invocationId,
        identity.grant.id,
        identity.serverId,
        identity.capabilityId,
        invocationId,
        identity.method,
        requestDigest,
        {
          version: 1,
          policyDigest: identity.grant.policyDigest,
          requestDigest,
          capabilityId: identity.capabilityId,
          serverId: identity.serverId,
          method: identity.method,
        },
        startedAt,
      ]
    );
    try {
      const result = await operation();
      const responseDigest = digestJson(result);
      await this.pool.query(
        `UPDATE mcp_invocations
            SET status = 'completed',
                response_digest = $2,
                replay_evidence = replay_evidence || $3::jsonb,
                completed_at = $4,
                updated_at = $4
          WHERE id = $1`,
        [
          invocationId,
          responseDigest,
          { responseDigest },
          new Date(),
        ]
      );
      return result;
    } catch (error) {
      await this.pool.query(
        `UPDATE mcp_invocations
            SET status = 'failed',
                error_code = 'MCP_UPSTREAM_FAILED',
                error_message = 'Upstream MCP invocation failed.',
                completed_at = $2,
                updated_at = $2
          WHERE id = $1`,
        [invocationId, new Date()]
      );
      throw error;
    }
  }

  async markWaitingApproval(identity: InvocationIdentity): Promise<string> {
    const invocationId = randomUUID();
    const requestDigest = digestJson(identity.request);
    await this.pool.query(
      `INSERT INTO mcp_invocations (
         id, grant_id, server_id, capability_id, request_id, method,
         request_digest, status, replay_evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting_approval', $8)`,
      [
        invocationId,
        identity.grant.id,
        identity.serverId,
        identity.capabilityId,
        invocationId,
        identity.method,
        requestDigest,
        {
          version: 1,
          policyDigest: identity.grant.policyDigest,
          requestDigest,
          capabilityId: identity.capabilityId,
          serverId: identity.serverId,
          method: identity.method,
          waitState: "approval",
        },
      ]
    );
    return invocationId;
  }
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("MCP audit evidence must contain JSON values only.");
}
