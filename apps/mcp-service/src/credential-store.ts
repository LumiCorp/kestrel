import type { Pool } from "pg";

export interface McpCredentialStore {
  updateRefreshedCredential(input: {
    credentialId: string;
    encryptedPayload: string;
    expiresAt: Date | null;
  }): Promise<void>;
  markRefreshRequired(credentialId: string): Promise<void>;
}

export class PostgresMcpCredentialStore implements McpCredentialStore {
  constructor(private readonly pool: Pool) {}

  async updateRefreshedCredential(input: {
    credentialId: string;
    encryptedPayload: string;
    expiresAt: Date | null;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE mcp_credentials
          SET encrypted_payload = $2,
              expires_at = $3,
              status = 'active',
              last_used_at = now(),
              updated_at = now()
        WHERE id = $1 AND status <> 'revoked'`,
      [input.credentialId, input.encryptedPayload, input.expiresAt]
    );
    if (result.rowCount !== 1) {
      throw new Error("MCP OAuth credential is unavailable for refresh.");
    }
  }

  async markRefreshRequired(credentialId: string): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_credentials
          SET status = 'refresh_required', updated_at = now()
        WHERE id = $1 AND status = 'active'`,
      [credentialId]
    );
  }
}
