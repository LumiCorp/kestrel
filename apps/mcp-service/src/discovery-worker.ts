import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Pool, PoolClient } from "pg";

import type { AuthorizedMcpServer } from "./contracts.js";
import type { McpCredentialStore } from "./credential-store.js";
import { connectOciMcpDiscoveryClient } from "./oci-runtime.js";
import { connectRemoteMcpClient } from "./upstream.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_DISCOVERY_CLAIM_TIMEOUT_MS = 5 * 60_000;
const MCP_DISCOVERY_CLAIM_HEARTBEAT_MS = 60_000;
const MCP_DISCOVERY_MAX_ATTEMPTS = 5;

type DiscoveryJob = {
  id: string;
  claimAttempt: number;
  organizationId: string;
  environmentId: string;
  server: AuthorizedMcpServer & {
    slug: string;
    providerKey: string;
  };
};

type DiscoveredCapability = {
  kind:
    | "tool"
    | "resource"
    | "resource_template"
    | "prompt"
    | "root"
    | "sampling"
    | "elicitation"
    | "completion"
    | "logging"
    | "task";
  capabilityKey: string;
  toolCapabilityKey: string | null;
  displayName: string | null;
  description: string | null;
  definition: Record<string, unknown>;
  accessMode?: "read" | "write" | "internal" | undefined;
};

export class McpDiscoveryWorker {
  private polling = false;
  private lastPollAt: Date | null = null;
  private lastCompletedJobAt: Date | null = null;
  private lastPollFailureAt: Date | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly credentialStore?: McpCredentialStore | undefined,
  ) {}

  async pollOnce(): Promise<boolean> {
    if (this.polling) {
      return false;
    }
    this.polling = true;
    this.lastPollAt = new Date();
    try {
      const job = await this.claimNextJob();
      if (!job) {
        return false;
      }
      await this.execute(job);
      this.lastCompletedJobAt = new Date();
      return true;
    } catch (error) {
      this.lastPollFailureAt = new Date();
      throw error;
    } finally {
      this.polling = false;
    }
  }

  getStatus(): {
    polling: boolean;
    lastPollAt: string | null;
    lastCompletedJobAt: string | null;
    lastPollFailureAt: string | null;
  } {
    return {
      polling: this.polling,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastCompletedJobAt: this.lastCompletedJobAt?.toISOString() ?? null,
      lastPollFailureAt: this.lastPollFailureAt?.toISOString() ?? null,
    };
  }

  private async execute(job: DiscoveryJob): Promise<void> {
    let connected: { client: Client; close: () => Promise<void> } | undefined;
    let claimLost = false;
    const heartbeat = setInterval(() => {
      void this.pool
        .query(
          `UPDATE mcp_discovery_jobs
              SET claimed_at = now(), updated_at = now()
            WHERE id = $1
              AND status = 'running'
              AND attempt_count = $2`,
          [job.id, job.claimAttempt],
        )
        .then((result) => {
          if (result.rowCount === 1) return;
          claimLost = true;
          void connected?.close().catch(() => {});
        })
        .catch(() => {});
    }, MCP_DISCOVERY_CLAIM_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      connected =
        job.server.sourceType === "remote"
          ? await connectRemoteMcpClient({
              organizationId: job.organizationId,
              environmentId: job.environmentId,
              server: job.server,
              credentialStore: this.credentialStore,
            })
          : await connectOciMcpDiscoveryClient({
              jobId: job.id,
              server: job.server,
            });
      if (claimLost) return;
      const discovery = await discoverCapabilities({
        client: connected.client,
        serverSlug: job.server.slug,
      });
      if (claimLost) return;
      await this.persistDiscovery(job, discovery);
    } catch {
      await this.failJob(job);
    } finally {
      clearInterval(heartbeat);
      await connected?.close().catch(() => {});
    }
  }

  private async claimNextJob(): Promise<DiscoveryJob | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const abandonedBefore = new Date(
        Date.now() - MCP_DISCOVERY_CLAIM_TIMEOUT_MS,
      );
      await client.query(
        `WITH exhausted AS (
           UPDATE mcp_discovery_jobs
              SET status = 'failed',
                  completed_at = now(),
                  failure_code = 'MCP_DISCOVERY_RETRY_EXHAUSTED',
                  failure_message = 'MCP capability discovery exhausted its claim retries.',
                  updated_at = now()
            WHERE status = 'running'
              AND claimed_at <= $1
              AND attempt_count >= $2
            RETURNING server_id
         )
         UPDATE mcp_servers server
            SET status = CASE
                  WHEN EXISTS (
                    SELECT 1
                      FROM mcp_capability_snapshots snapshot
                     WHERE snapshot.server_id = server.id
                       AND snapshot.status = 'approved'
                  ) THEN 'ready'
                  ELSE 'degraded'
                END,
                failure_code = 'MCP_DISCOVERY_RETRY_EXHAUSTED',
                failure_message = 'MCP capability discovery exhausted its claim retries.',
                updated_at = now()
          WHERE server.id IN (SELECT server_id FROM exhausted)`,
        [abandonedBefore, MCP_DISCOVERY_MAX_ATTEMPTS],
      );
      const result = await client.query<{
        job_id: string;
        organization_id: string;
        environment_id: string;
        server_id: string;
        provider_key: string;
        name: string;
        slug: string;
        launch_arguments: unknown;
        egress_allowlist: unknown;
        cpu_millicores: number;
        memory_mib: number;
        pids_limit: number;
        auth_mode: "none" | "oauth" | "secret_headers";
        credential_id: string | null;
        credential_kind: "oauth" | "secret_headers" | null;
        encrypted_payload: string | null;
        source_type: "remote" | "oci";
        transport: "streamable_http" | "stdio";
        remote_url: string | null;
        oci_image_reference: string | null;
        oci_digest: string | null;
      }>(
        `SELECT job.id AS job_id,
                job.organization_id,
                job.environment_id,
                server.id AS server_id,
                server.provider_key,
                server.name,
                server.slug,
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
           FROM mcp_discovery_jobs job
           JOIN mcp_servers server ON server.id = job.server_id
           LEFT JOIN mcp_credentials credential
             ON credential.id = server.credential_id
            AND credential.environment_id = server.environment_id
            AND credential.status = 'active'
          WHERE (
                  job.status = 'queued'
                  OR (
                    job.status = 'running'
                    AND job.claimed_at <= $1
                  )
                )
            AND job.attempt_count < $2
          ORDER BY CASE WHEN job.status = 'queued' THEN 0 ELSE 1 END,
                   job.created_at
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1`,
        [abandonedBefore, MCP_DISCOVERY_MAX_ATTEMPTS],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return;
      }
      const claimed = await client.query<{ attempt_count: number }>(
        `UPDATE mcp_discovery_jobs
            SET status = 'running',
                attempt_count = attempt_count + 1,
                claimed_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING attempt_count`,
        [row.job_id],
      );
      await client.query("COMMIT");
      return {
        id: row.job_id,
        claimAttempt: claimed.rows[0]!.attempt_count,
        organizationId: row.organization_id,
        environmentId: row.environment_id,
        server: parseDiscoveryServer(row),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistDiscovery(
    job: DiscoveryJob,
    discovery: {
      serverInfo: Record<string, unknown>;
      capabilities: DiscoveredCapability[];
      digest: string;
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockOwnedClaim(client, job))) {
        await client.query("COMMIT");
        return;
      }
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM mcp_capability_snapshots
          WHERE server_id = $1 AND capability_digest = $2`,
        [job.server.id, discovery.digest],
      );
      if (existing.rows[0]) {
        await completeJob(client, job);
        await setServerAfterDiscovery(client, job.server.id);
        await client.query("COMMIT");
        return;
      }
      const previous = await loadPreviousCapabilities(client, job.server.id);
      const snapshotId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mcp_capability_snapshots
          (id, server_id, protocol_version, capability_digest, server_info,
           status, discovered_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending_review', now(), now())`,
        [
          snapshotId,
          job.server.id,
          MCP_PROTOCOL_VERSION,
          discovery.digest,
          discovery.serverInfo,
        ],
      );
      for (const capability of discovery.capabilities) {
        if (capability.kind === "tool" && capability.toolCapabilityKey) {
          await upsertToolCapability(
            client,
            job.server.providerKey,
            capability,
          );
        }
        const prior = previous.get(capabilityIdentity(capability));
        const unchanged =
          prior?.definitionDigest === digestJson(capability.definition);
        await client.query(
          `INSERT INTO mcp_capabilities
            (id, snapshot_id, provider_key, tool_capability_key, kind,
             capability_key, display_name, description, definition,
             environment_enabled, approval_mode, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())`,
          [
            crypto.randomUUID(),
            snapshotId,
            job.server.providerKey,
            capability.toolCapabilityKey,
            capability.kind,
            capability.capabilityKey,
            capability.displayName,
            capability.description,
            capability.definition,
            unchanged ? prior?.environmentEnabled : false,
            unchanged ? prior?.approvalMode : "deny",
          ],
        );
      }
      await completeJob(client, job);
      await setServerAfterDiscovery(client, job.server.id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async failJob(job: DiscoveryJob): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockOwnedClaim(client, job))) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `WITH approved AS (
         SELECT 1
           FROM mcp_capability_snapshots
          WHERE server_id = $1 AND status = 'approved'
          LIMIT 1
       )
       UPDATE mcp_servers
          SET status = CASE WHEN EXISTS (SELECT 1 FROM approved)
                            THEN 'ready' ELSE 'degraded' END,
              failure_code = 'MCP_DISCOVERY_FAILED',
              failure_message = 'MCP capability discovery failed.',
              updated_at = now()
        WHERE id = $1`,
        [job.server.id],
      );
      await client.query(
        `UPDATE mcp_discovery_jobs
          SET status = 'failed',
              completed_at = now(),
              failure_code = 'MCP_DISCOVERY_FAILED',
              failure_message = 'MCP capability discovery failed.',
              updated_at = now()
        WHERE id = $1
          AND status = 'running'
          AND attempt_count = $2`,
        [job.id, job.claimAttempt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function discoverCapabilities(input: {
  client: Pick<
    Client,
    | "getServerCapabilities"
    | "getServerVersion"
    | "getInstructions"
    | "listTools"
    | "listResources"
    | "listResourceTemplates"
    | "listPrompts"
  >;
  serverSlug: string;
}): Promise<{
  serverInfo: Record<string, unknown>;
  capabilities: DiscoveredCapability[];
  digest: string;
}> {
  const serverCapabilities = input.client.getServerCapabilities() ?? {};
  const capabilities: DiscoveredCapability[] = [];
  if (serverCapabilities.tools) {
    for (const tool of await collectPages((cursor) =>
      input.client.listTools(cursor ? { cursor } : undefined),
    )) {
      const definition = asJsonRecord(tool);
      capabilities.push({
        kind: "tool",
        capabilityKey: tool.name,
        toolCapabilityKey: buildHostedToolName(input.serverSlug, tool.name),
        displayName: tool.title ?? tool.name,
        description: tool.description ?? null,
        definition,
        accessMode: tool.annotations?.readOnlyHint === true ? "read" : "write",
      });
    }
  }
  if (serverCapabilities.resources) {
    for (const resource of await collectPages((cursor) =>
      input.client.listResources(cursor ? { cursor } : undefined),
    )) {
      capabilities.push({
        kind: "resource",
        capabilityKey: resource.uri,
        toolCapabilityKey: null,
        displayName: resource.title ?? resource.name,
        description: resource.description ?? null,
        definition: asJsonRecord(resource),
      });
    }
    for (const template of await collectPages((cursor) =>
      input.client.listResourceTemplates(cursor ? { cursor } : undefined),
    )) {
      capabilities.push({
        kind: "resource_template",
        capabilityKey: template.uriTemplate,
        toolCapabilityKey: null,
        displayName: template.title ?? template.name,
        description: template.description ?? null,
        definition: asJsonRecord(template),
      });
    }
  }
  if (serverCapabilities.prompts) {
    for (const prompt of await collectPages((cursor) =>
      input.client.listPrompts(cursor ? { cursor } : undefined),
    )) {
      capabilities.push({
        kind: "prompt",
        capabilityKey: prompt.name,
        toolCapabilityKey: null,
        displayName: prompt.title ?? prompt.name,
        description: prompt.description ?? null,
        definition: asJsonRecord(prompt),
      });
    }
  }
  capabilities.push(
    {
      kind: "root",
      capabilityKey: "root",
      toolCapabilityKey: null,
      displayName: "Workspace roots",
      description:
        "Allows this MCP server to inspect the current run workspace root.",
      definition: { method: "roots/list" },
    },
    {
      kind: "sampling",
      capabilityKey: "sampling",
      toolCapabilityKey: null,
      displayName: "Model sampling",
      description:
        "Allows this MCP server to request model sampling through Kestrel.",
      definition: { method: "sampling/createMessage" },
    },
    {
      kind: "elicitation",
      capabilityKey: "elicitation",
      toolCapabilityKey: null,
      displayName: "User elicitation",
      description:
        "Allows this MCP server to request information from the user.",
      definition: { method: "elicitation/create" },
    },
  );
  for (const [kind, definition] of [
    ["completion", serverCapabilities.completions],
    ["logging", serverCapabilities.logging],
    ["task", serverCapabilities.tasks],
  ] as const) {
    if (definition) {
      capabilities.push({
        kind,
        capabilityKey: kind,
        toolCapabilityKey: null,
        displayName: kind,
        description: null,
        definition: asJsonRecord(definition),
      });
    }
  }
  capabilities.sort((left, right) =>
    capabilityIdentity(left).localeCompare(capabilityIdentity(right)),
  );
  assertUniqueToolProjections(capabilities);
  const serverInfo = canonicalize({
    implementation: input.client.getServerVersion() ?? {},
    instructions: input.client.getInstructions() ?? null,
    capabilities: serverCapabilities,
  }) as Record<string, unknown>;
  const digest = digestJson({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo,
    capabilities: capabilities.map((capability) => ({
      kind: capability.kind,
      capabilityKey: capability.capabilityKey,
      displayName: capability.displayName,
      description: capability.description,
      definition: capability.definition,
      toolCapabilityKey: capability.toolCapabilityKey,
    })),
  });
  return { serverInfo, capabilities, digest };
}

async function collectPages<T>(
  load: (cursor: string | undefined) => Promise<{
    nextCursor?: string | undefined;
    tools?: T[] | undefined;
    resources?: T[] | undefined;
    resourceTemplates?: T[] | undefined;
    prompts?: T[] | undefined;
  }>,
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await load(cursor);
    collected.push(
      ...(result.tools ??
        result.resources ??
        result.resourceTemplates ??
        result.prompts ??
        []),
    );
    if (!result.nextCursor) {
      return collected;
    }
    cursor = result.nextCursor;
  }
  throw new Error("MCP capability discovery exceeded the pagination limit.");
}

async function loadPreviousCapabilities(client: PoolClient, serverId: string) {
  const result = await client.query<{
    kind: string;
    capability_key: string;
    definition: Record<string, unknown>;
    environment_enabled: boolean;
    approval_mode: "auto" | "ask" | "deny";
  }>(
    `SELECT capability.kind,
            capability.capability_key,
            capability.definition,
            capability.environment_enabled,
            capability.approval_mode
       FROM mcp_capabilities capability
       JOIN mcp_capability_snapshots snapshot
         ON snapshot.id = capability.snapshot_id
      WHERE snapshot.server_id = $1 AND snapshot.status = 'approved'`,
    [serverId],
  );
  return new Map(
    result.rows.map((row) => [
      `${row.kind}:${row.capability_key}`,
      {
        definitionDigest: digestJson(row.definition),
        environmentEnabled: row.environment_enabled,
        approvalMode: row.approval_mode,
      },
    ]),
  );
}

async function upsertToolCapability(
  client: PoolClient,
  providerKey: string,
  capability: DiscoveredCapability,
) {
  await client.query(
    `INSERT INTO tool_capabilities
      (provider_key, key, runtime_name, display_name, description, access_mode,
       default_enabled, default_approval_mode, default_surface_access,
       default_rate_limit_mode, default_logging_mode, default_settings,
       metadata, created_at, updated_at)
     VALUES ($1, $2, $2, $3, $4, $5, false, 'deny',
             '{"chat":true,"admin":false}'::jsonb, 'default', 'full',
             '{}'::jsonb, '{"category":"mcp"}'::jsonb, now(), now())
     ON CONFLICT (provider_key, key) DO UPDATE
       SET display_name = excluded.display_name,
           description = excluded.description,
           access_mode = excluded.access_mode,
           updated_at = now()`,
    [
      providerKey,
      capability.toolCapabilityKey,
      capability.displayName ?? capability.capabilityKey,
      capability.description,
      capability.accessMode ?? "internal",
    ],
  );
}

async function lockOwnedClaim(
  client: PoolClient,
  job: Pick<DiscoveryJob, "id" | "claimAttempt">,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM mcp_discovery_jobs
      WHERE id = $1
        AND status = 'running'
        AND attempt_count = $2
      FOR UPDATE`,
    [job.id, job.claimAttempt],
  );
  return result.rowCount === 1;
}

async function completeJob(client: PoolClient, job: DiscoveryJob) {
  await client.query(
    `UPDATE mcp_discovery_jobs
        SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND attempt_count = $2`,
    [job.id, job.claimAttempt],
  );
}

async function setServerAfterDiscovery(client: PoolClient, serverId: string) {
  await client.query(
    `UPDATE mcp_servers
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM mcp_capability_snapshots
                 WHERE server_id = $1 AND status = 'approved'
              ) THEN 'ready'
              ELSE 'draft'
            END,
            failure_code = null,
            failure_message = null,
            last_health_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [serverId],
  );
}

function buildHostedToolName(serverSlug: string, toolName: string): string {
  const readable = sanitizeSegment(toolName).slice(0, 48);
  const digest = createHash("sha256")
    .update(`${serverSlug}\0${toolName}`)
    .digest("hex")
    .slice(0, 16);
  return `mcp.${sanitizeSegment(serverSlug)}.${readable}.${digest}`;
}

function assertUniqueToolProjections(
  capabilities: readonly DiscoveredCapability[],
): void {
  const projected = new Set<string>();
  for (const capability of capabilities) {
    if (capability.kind !== "tool" || !capability.toolCapabilityKey) continue;
    if (projected.has(capability.toolCapabilityKey)) {
      throw new Error(
        `MCP discovery produced duplicate tool projection '${capability.toolCapabilityKey}'.`,
      );
    }
    projected.add(capability.toolCapabilityKey);
  }
}

function sanitizeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/gu, "_") || "unknown";
}

function capabilityIdentity(capability: {
  kind: string;
  capabilityKey: string;
}): string {
  return `${capability.kind}:${capability.capabilityKey}`;
}

function digestJson(value: unknown): string {
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
        .map(([key, entry]) => [key, canonicalize(entry)]),
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
  throw new Error("MCP discovery results must contain JSON values only.");
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return canonicalize(value) as Record<string, unknown>;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Stored MCP server list is invalid.");
  }
  return value as string[];
}

function parseDiscoveryCredential(row: {
  auth_mode: "none" | "oauth" | "secret_headers";
  credential_id: string | null;
  credential_kind: "oauth" | "secret_headers" | null;
  encrypted_payload: string | null;
}): AuthorizedMcpServer["credential"] {
  if (row.auth_mode === "none") {
    return;
  }
  if (
    !row.credential_id ||
    !row.credential_kind ||
    !row.encrypted_payload ||
    row.credential_kind !== row.auth_mode
  ) {
    throw new Error("MCP discovery credential is unavailable or mismatched.");
  }
  return {
    id: row.credential_id,
    kind: row.credential_kind,
    encryptedPayload: row.encrypted_payload,
  };
}

function parseDiscoveryServer(row: {
  server_id: string;
  provider_key: string;
  name: string;
  slug: string;
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
}): DiscoveryJob["server"] {
  const common = {
    id: row.server_id,
    name: row.name,
    slug: row.slug,
    providerKey: row.provider_key,
    launchArguments: parseStringArray(row.launch_arguments),
    egressAllowlist: parseStringArray(row.egress_allowlist),
    resources: {
      cpuMillicores: row.cpu_millicores,
      memoryMib: row.memory_mib,
      pidsLimit: row.pids_limit,
    },
    credential: parseDiscoveryCredential(row),
  };
  if (row.source_type === "remote") {
    if (row.transport !== "streamable_http" || !row.remote_url) {
      throw new Error("Stored remote MCP discovery server is invalid.");
    }
    return {
      ...common,
      sourceType: "remote",
      transport: "streamable_http",
      remoteUrl: row.remote_url,
    };
  }
  if (
    row.transport !== "stdio" ||
    !(row.oci_image_reference && row.oci_digest)
  ) {
    throw new Error("Stored OCI MCP discovery server is invalid.");
  }
  return {
    ...common,
    sourceType: "oci",
    transport: "stdio",
    imageReference: row.oci_image_reference,
    digest: row.oci_digest,
  };
}
