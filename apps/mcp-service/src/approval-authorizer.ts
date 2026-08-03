import { createHash } from "node:crypto";
import { serializeCanonicalApprovalPayload } from "@kestrel-agents/protocol";
import type { Pool } from "pg";
import type { AuthorizedMcpGrant } from "./contracts.js";
import type { ApprovalAuthorizer } from "./grant-server.js";

export class PostgresMcpApprovalAuthorizer implements ApprovalAuthorizer {
  constructor(private readonly pool: Pool) {}

  async consume(input: {
    grant: AuthorizedMcpGrant;
    capability: AuthorizedMcpGrant["capabilities"][number];
    actionKey: string;
    payload: unknown;
  }): Promise<boolean> {
    if (
      input.capability.kind !== "tool" ||
      input.capability.toolCapabilityKey !== input.actionKey
    ) {
      return false;
    }
    const payloadHash = `sha256:${createHash("sha256")
      .update(serializeCanonicalApprovalPayload(input.payload))
      .digest("hex")}`;
    const result = await this.pool.query<{ grant_id: string }>(
      `UPDATE orchestration_approval_grants approval
          SET status = 'CONSUMED',
              consumed_at = now()
        WHERE approval.grant_id = (
          SELECT candidate.grant_id
            FROM orchestration_approval_grants candidate
           WHERE candidate.thread_id = $1
             AND candidate.action_key = $2
             AND candidate.payload_hash = $3
             AND candidate.tool_class = 'external_side_effect'
             AND candidate.authority_kind = 'hosted_mcp_grant'
             AND candidate.authority_revision = $4
             AND candidate.status = 'ACTIVE'
             AND candidate.expires_at > now()
             AND candidate.allowed_tool_classes_json @> '["external_side_effect"]'::jsonb
             AND candidate.allowed_capabilities_json @> '["mcp.invoke"]'::jsonb
           ORDER BY candidate.issued_at DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING approval.grant_id`,
      [input.grant.threadId, input.actionKey, payloadHash, input.grant.id]
    );
    return result.rows.length === 1;
  }
}
