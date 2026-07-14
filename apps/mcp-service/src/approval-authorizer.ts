import type { Pool } from "pg";
import type { AuthorizedMcpGrant } from "./contracts.js";
import type { ApprovalAuthorizer } from "./grant-server.js";

export class PostgresMcpApprovalAuthorizer implements ApprovalAuthorizer {
  constructor(private readonly pool: Pool) {}

  async isApproved(input: {
    grant: AuthorizedMcpGrant;
    capability: AuthorizedMcpGrant["capabilities"][number];
  }): Promise<boolean> {
    const result = await this.pool.query<{ approved: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM orchestration_approval_grants approval
          WHERE approval.thread_id = $1
            AND approval.status = 'ACTIVE'
            AND (approval.expires_at IS NULL OR approval.expires_at > now())
            AND approval.allowed_capabilities_json @> '["mcp.invoke"]'::jsonb
       ) AS approved`,
      [input.grant.threadId]
    );
    return result.rows[0]?.approved === true;
  }
}
