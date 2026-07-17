import type { Pool } from "pg";
import type { AuthorizedMcpGrant, McpGrantStore } from "./contracts.js";

type GrantRow = {
  id: string;
  run_execution_id: string;
  workspace_id: string;
  organization_id: string;
  environment_id: string;
  project_id: string | null;
  thread_id: string;
  policy_digest: string;
  expires_at: Date;
  effective_capabilities: unknown;
  effective_policy: unknown;
};

type CapabilityRow = {
  id: string;
  kind: AuthorizedMcpGrant["capabilities"][number]["kind"];
  capability_key: string;
  tool_capability_key: string | null;
  definition: Record<string, unknown>;
  server_id: string;
};

type ServerRow = {
  id: string;
  name: string;
  source_type: "remote" | "oci";
  transport: "streamable_http" | "stdio";
  remote_url: string | null;
  oci_image_reference: string | null;
  oci_digest: string | null;
  launch_arguments: unknown;
  egress_allowlist: unknown;
  cpu_millicores: number;
  memory_mib: number;
  pids_limit: number;
  auth_mode: "none" | "oauth" | "secret_headers";
  credential_id: string | null;
  credential_kind: "oauth" | "secret_headers" | null;
  encrypted_payload: string | null;
};

export class PostgresMcpGrantStore implements McpGrantStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async activateGrant(input: {
    grantId: string;
    runExecutionId: string;
    organizationId: string;
    environmentId: string;
    threadId: string;
    now: Date;
  }): Promise<AuthorizedMcpGrant | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const grantResult = await client.query<GrantRow>(
        `SELECT grant.id,
                grant.run_execution_id,
                execution.workspace_id,
                grant.organization_id,
                grant.environment_id,
                grant.project_id,
                grant.thread_id,
                grant.policy_digest,
                grant.expires_at,
                grant.effective_capabilities,
                grant.effective_policy
           FROM mcp_run_grants grant
           JOIN environment_run_executions execution
             ON execution.id = grant.run_execution_id
          WHERE grant.id = $1
            AND grant.run_execution_id = $2
            AND grant.organization_id = $3
            AND grant.environment_id = $4
            AND grant.thread_id = $5
            AND grant.status IN ('issued', 'active')
            AND grant.expires_at > $6
            AND execution.status IN ('routed', 'running')
          FOR UPDATE OF grant`,
        [
          input.grantId,
          input.runExecutionId,
          input.organizationId,
          input.environmentId,
          input.threadId,
          input.now,
        ]
      );
      const row = grantResult.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const capabilityIds = parseCapabilityIds(row.effective_capabilities);
      const effectivePolicy = parseEffectivePolicy(row.effective_policy);
      if (
        effectivePolicy.size !== capabilityIds.length ||
        capabilityIds.some((capabilityId) => !effectivePolicy.has(capabilityId))
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const capabilityResult = await client.query<CapabilityRow>(
        `SELECT capability.id,
                capability.kind,
                capability.capability_key,
                capability.tool_capability_key,
                capability.definition,
                server.id AS server_id
           FROM mcp_capabilities capability
           JOIN mcp_capability_snapshots snapshot
             ON snapshot.id = capability.snapshot_id
           JOIN mcp_servers server
             ON server.id = snapshot.server_id
          WHERE capability.id = ANY($1::text[])
            AND capability.environment_enabled = true
            AND capability.approval_mode <> 'deny'
            AND snapshot.status = 'approved'
            AND server.organization_id = $2
            AND server.environment_id = $3
            AND server.status = 'ready'`,
        [capabilityIds, row.organization_id, row.environment_id]
      );
      if (capabilityResult.rows.length !== capabilityIds.length) {
        await client.query("ROLLBACK");
        return null;
      }
      const serverIds = [
        ...new Set(
          capabilityResult.rows.map((capability) => capability.server_id)
        ),
      ];
      const serverResult = await client.query<ServerRow>(
        `SELECT server.id,
                server.name,
                server.source_type,
                server.transport,
                server.remote_url,
                server.oci_image_reference,
                server.oci_digest,
                server.launch_arguments,
                server.egress_allowlist,
                server.cpu_millicores,
                server.memory_mib,
                server.pids_limit,
                server.auth_mode,
                credential.id AS credential_id,
                credential.kind AS credential_kind,
                credential.encrypted_payload
           FROM mcp_servers server
           LEFT JOIN mcp_credentials credential
             ON credential.id = server.credential_id
            AND credential.environment_id = server.environment_id
            AND credential.status = 'active'
          WHERE server.id = ANY($1::text[])
            AND server.organization_id = $2
            AND server.environment_id = $3
            AND server.status = 'ready'`,
        [serverIds, row.organization_id, row.environment_id]
      );
      if (serverResult.rows.length !== serverIds.length) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE mcp_run_grants
            SET status = 'active',
                activated_at = COALESCE(activated_at, $2)
          WHERE id = $1`,
        [row.id, input.now]
      );
      await client.query("COMMIT");
      return {
        id: row.id,
        runExecutionId: row.run_execution_id,
        workspaceId: row.workspace_id,
        organizationId: row.organization_id,
        environmentId: row.environment_id,
        projectId: row.project_id,
        threadId: row.thread_id,
        policyDigest: row.policy_digest,
        expiresAt: row.expires_at,
        capabilities: capabilityResult.rows.map((capability) => ({
          id: capability.id,
          kind: capability.kind,
          capabilityKey: capability.capability_key,
          toolCapabilityKey: capability.tool_capability_key,
          approvalMode: effectivePolicy.get(capability.id)!,
          definition: capability.definition,
          serverId: capability.server_id,
        })),
        servers: serverResult.rows.map(parseServer),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseServer(row: ServerRow): AuthorizedMcpGrant["servers"][number] {
  const credential = parseServerCredential(row);
  const common = {
    id: row.id,
    name: row.name,
    transport: row.transport,
    launchArguments: parseStringArray(row.launch_arguments, "launch arguments"),
    egressAllowlist: parseStringArray(row.egress_allowlist, "egress allowlist"),
    resources: {
      cpuMillicores: requirePositiveInteger(row.cpu_millicores, "CPU limit"),
      memoryMib: requirePositiveInteger(row.memory_mib, "memory limit"),
      pidsLimit: requirePositiveInteger(row.pids_limit, "PID limit"),
    },
    credential,
  };
  if (row.source_type === "remote") {
    if (!(row.transport === "streamable_http" && row.remote_url)) {
      throw new Error("Authorized remote MCP server is invalid.");
    }
    return {
      ...common,
      sourceType: "remote",
      transport: "streamable_http",
      remoteUrl: row.remote_url,
    };
  }
  if (!(row.oci_image_reference && row.oci_digest)) {
    throw new Error("Authorized OCI MCP server is invalid.");
  }
  return {
    ...common,
    sourceType: "oci",
    imageReference: row.oci_image_reference,
    digest: row.oci_digest,
  };
}

function parseServerCredential(
  row: ServerRow
): AuthorizedMcpGrant["servers"][number]["credential"] {
  if (row.auth_mode === "none") {
    if (row.credential_id || row.credential_kind || row.encrypted_payload) {
      throw new Error("Credential-free MCP server has an unexpected credential.");
    }
    return;
  }
  if (
    !((row.credential_id &&row.credential_kind ) &&row.encrypted_payload ) ||
    row.credential_kind !== row.auth_mode
  ) {
    throw new Error("Authorized MCP server credential is unavailable or mismatched.");
  }
  return {
    id: row.credential_id,
    kind: row.credential_kind,
    encryptedPayload: row.encrypted_payload,
  };
}

function parseCapabilityIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error("MCP grant capability snapshot is invalid.");
  }
  return [...new Set(value)];
}

function parseEffectivePolicy(value: unknown): Map<string, "auto" | "ask"> {
  if (!Array.isArray(value)) {
    throw new Error("MCP grant effective policy is invalid.");
  }
  const policy = new Map<string, "auto" | "ask">();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).capabilityId !== "string" ||
      !["auto", "ask"].includes(
        String((entry as Record<string, unknown>).approvalMode)
      )
    ) {
      throw new Error("MCP grant effective policy is invalid.");
    }
    const record = entry as {
      capabilityId: string;
      approvalMode: "auto" | "ask";
    };
    if (policy.has(record.capabilityId)) {
      throw new Error("MCP grant effective policy contains duplicates.");
    }
    policy.set(record.capabilityId, record.approvalMode);
  }
  return policy;
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(`MCP server ${fieldName} is invalid.`);
  }
  return value;
}

function requirePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MCP server ${fieldName} is invalid.`);
  }
  return value;
}
