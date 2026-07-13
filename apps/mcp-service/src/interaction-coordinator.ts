import type { Pool } from "pg";
import type { AuthorizedMcpGrant } from "./contracts.js";
import { digestJson } from "./invocation-audit.js";

export type McpInteractionKind = "sampling" | "elicitation";

export interface McpInteractionCoordinator {
  request(input: {
    grant: AuthorizedMcpGrant;
    serverId: string;
    kind: McpInteractionKind;
    request: unknown;
    signal?: AbortSignal | undefined;
  }): Promise<unknown>;
}

export class PostgresMcpInteractionCoordinator
  implements McpInteractionCoordinator
{
  constructor(
    private readonly pool: Pool,
    private readonly pollIntervalMs = 250
  ) {}

  async request(input: {
    grant: AuthorizedMcpGrant;
    serverId: string;
    kind: McpInteractionKind;
    request: unknown;
    signal?: AbortSignal | undefined;
  }): Promise<unknown> {
    const capability = input.grant.capabilities.find(
      (candidate) =>
        candidate.serverId === input.serverId && candidate.kind === input.kind
    );
    if (!capability) {
      throw new Error(
        `The run grant does not authorize MCP ${input.kind}.`
      );
    }
    const requestDigest = digestJson(input.request);
    const interactionDigest = digestJson({
      grantId: input.grant.id,
      serverId: input.serverId,
      kind: input.kind,
      requestDigest,
    }).slice("sha256:".length);
    const invocationId = `interaction-${interactionDigest}`;
    const checkpointId = `checkpoint-${interactionDigest}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO mcp_invocations
          (id, grant_id, server_id, capability_id, request_id, method,
           request_digest, status, replay_evidence, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (id) DO NOTHING`,
        [
          invocationId,
          input.grant.id,
          input.serverId,
          capability.id,
          invocationId,
          input.kind === "sampling"
            ? "sampling/createMessage"
            : "elicitation/create",
          requestDigest,
          input.kind === "sampling"
            ? "waiting_sampling"
            : "waiting_elicitation",
          {
            version: 1,
            waitState: input.kind,
            policyDigest: input.grant.policyDigest,
            requestDigest,
            checkpointId,
          },
        ]
      );
      await client.query(
        `INSERT INTO mcp_interaction_checkpoints
          (id, invocation_id, thread_id, kind, status, request_envelope,
           replay_cursor)
         VALUES ($1, $2, $3, $4, 'requested', $5, $6)
         ON CONFLICT (invocation_id) DO NOTHING`,
        [
          checkpointId,
          invocationId,
          input.grant.threadId,
          input.kind,
          input.request,
          {
            version: 1,
            grantId: input.grant.id,
            invocationId,
            requestDigest,
            policyDigest: input.grant.policyDigest,
          },
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.waitForResponse({
      checkpointId,
      invocationId,
      expiresAt: input.grant.expiresAt,
      signal: input.signal,
    });
  }

  private async waitForResponse(input: {
    checkpointId: string;
    invocationId: string;
    expiresAt: Date;
    signal?: AbortSignal | undefined;
  }): Promise<unknown> {
    while (true) {
      if (input.signal?.aborted) {
        await this.cancel(input.checkpointId, input.invocationId);
        throw input.signal.reason ?? new Error("MCP interaction cancelled.");
      }
      const result = await this.pool.query<{
        status:
          | "requested"
          | "approved"
          | "processing"
          | "denied"
          | "completed"
          | "failed";
        response_envelope: unknown;
        failure_code: string | null;
        failure_message: string | null;
        processing_expires_at: Date | null;
      }>(
        `SELECT status, response_envelope, failure_code, failure_message,
                processing_expires_at
           FROM mcp_interaction_checkpoints
          WHERE id = $1`,
        [input.checkpointId]
      );
      const checkpoint = result.rows[0];
      if (!checkpoint) throw new Error("MCP interaction checkpoint disappeared.");
      if (checkpoint.status === "denied") {
        await this.cancel(input.checkpointId, input.invocationId);
        throw new Error("MCP interaction was denied.");
      }
      if (checkpoint.status === "failed") {
        throw Object.assign(
          new Error(checkpoint.failure_message ?? "MCP interaction failed."),
          { code: checkpoint.failure_code ?? "MCP_INTERACTION_FAILED" }
        );
      }
      if (checkpoint.status === "completed") {
        if (checkpoint.response_envelope === null) {
          throw new Error("MCP interaction response is missing.");
        }
        const responseDigest = digestJson(checkpoint.response_envelope);
        await this.pool.query(
          `UPDATE mcp_invocations
              SET status = 'completed', response_digest = $2,
                  replay_evidence = replay_evidence || $3::jsonb,
                  completed_at = now(), updated_at = now()
            WHERE id = $1`,
          [input.invocationId, responseDigest, { responseDigest }]
        );
        return checkpoint.response_envelope;
      }
      if (checkpoint.status === "processing") {
        if (!checkpoint.processing_expires_at) {
          throw new Error("MCP sampling processing deadline is missing.");
        }
        if (Date.now() >= checkpoint.processing_expires_at.getTime()) {
          await this.failTimedOutProcessing(
            input.checkpointId,
            input.invocationId
          );
          continue;
        }
      } else if (Date.now() >= input.expiresAt.getTime()) {
        await this.cancel(input.checkpointId, input.invocationId);
        throw new Error("MCP interaction grant expired before it was resolved.");
      }
      await delay(this.pollIntervalMs, input.signal);
    }
  }

  private async failTimedOutProcessing(
    checkpointId: string,
    invocationId: string
  ) {
    await this.pool.query(
      `WITH failed_checkpoint AS (
         UPDATE mcp_interaction_checkpoints
            SET status = 'failed',
                failure_code = 'MCP_SAMPLING_TIMEOUT',
                failure_message = 'MCP sampling exceeded its processing deadline.',
                resolved_at = now(), updated_at = now()
          WHERE id = $1
            AND status = 'processing'
            AND processing_expires_at <= now()
          RETURNING id
       )
       UPDATE mcp_invocations
          SET status = 'failed',
              error_code = 'MCP_SAMPLING_TIMEOUT',
              error_message = 'MCP sampling exceeded its processing deadline.',
              completed_at = now(), updated_at = now()
        WHERE id = $2
          AND EXISTS (SELECT 1 FROM failed_checkpoint)`,
      [checkpointId, invocationId]
    );
  }

  private async cancel(checkpointId: string, invocationId: string) {
    await this.pool.query(
      `WITH cancelled_checkpoint AS (
         UPDATE mcp_interaction_checkpoints
            SET status = 'denied', updated_at = now()
          WHERE id = $1 AND status IN ('requested', 'approved')
          RETURNING id
       )
       UPDATE mcp_invocations
          SET status = 'cancelled', completed_at = now(), updated_at = now()
        WHERE id = $2
          AND status IN ('waiting_sampling', 'waiting_elicitation')
          AND EXISTS (SELECT 1 FROM cancelled_checkpoint)`,
      [checkpointId, invocationId]
    );
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("MCP interaction cancelled."));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("MCP interaction cancelled."));
      },
      { once: true }
    );
  });
}
