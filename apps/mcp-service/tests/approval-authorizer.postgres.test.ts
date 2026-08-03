import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";
import { Pool } from "pg";

import { PostgresMcpApprovalAuthorizer } from "../src/approval-authorizer.js";
import type { AuthorizedMcpGrant } from "../src/contracts.js";

const databaseUrl = process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();

test("exact MCP approval consumption is atomic and single-use", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const suffix = randomUUID();
  const sessionId = `mcp-approval-session-${suffix}`;
  const threadId = `mcp-approval-thread-${suffix}`;
  const requestId = `mcp-approval-request-${suffix}`;
  const grantId = `mcp-approval-grant-${suffix}`;
  const hostedGrantId = `hosted-grant-${suffix}`;
  const actionKey = "hosted.tool";
  const payload = { repository: "acme/widgets", issue: 42 };
  const payloadHash = `sha256:${createHash("sha256")
    .update(serializeCanonicalApprovalPayload(payload))
    .digest("hex")}`;
  const binding = {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: `runtime-approval-${suffix}`,
    threadId,
    runId: `run-${suffix}`,
    actionKey,
    payloadHash,
    toolClass: "external_side_effect" as const,
    capabilities: ["mcp.invoke"],
    authorityKind: "hosted_mcp_grant" as const,
    authorityRevision: hostedGrantId,
    requestedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  try {
    await pool.query("INSERT INTO sessions (session_id) VALUES ($1)", [sessionId]);
    await pool.query(
      `INSERT INTO orchestration_threads
         (thread_id, session_id, title, status)
       VALUES ($1, $2, 'MCP approval', 'WAITING')`,
      [threadId, sessionId],
    );
    await pool.query(
      `INSERT INTO orchestration_interaction_requests
         (request_id, thread_id, kind, status, event_type)
       VALUES ($1, $2, 'approval', 'RESOLVED', 'user.approval')`,
      [requestId, threadId],
    );
    await pool.query(
      `INSERT INTO orchestration_approval_grants
         (grant_id, thread_id, request_id, scope, status,
          allowed_tool_classes_json, allowed_capabilities_json, expires_at,
          issued_by, issued_at, approval_id, action_key, payload_hash,
          tool_class, authority_kind, authority_revision, binding_json,
          decision_actor_json)
       VALUES (
          $1, $2, $3, 'turn', 'ACTIVE',
          '["external_side_effect"]'::jsonb, '["mcp.invoke"]'::jsonb, $4,
          'user-1', now(), $5, $6, $7,
          'external_side_effect', 'hosted_mcp_grant', $8, $9::jsonb,
          '{"actorType":"end_user","actorId":"user-1"}'::jsonb
       )`,
      [
        grantId,
        threadId,
        requestId,
        binding.expiresAt,
        binding.approvalId,
        actionKey,
        payloadHash,
        hostedGrantId,
        JSON.stringify(binding),
      ],
    );

    const authorizer = new PostgresMcpApprovalAuthorizer(pool);
    const grant = { id: hostedGrantId, threadId } as AuthorizedMcpGrant;
    const capability = {
      kind: "tool",
      toolCapabilityKey: actionKey,
    } as AuthorizedMcpGrant["capabilities"][number];
    const outcomes = await Promise.all([
      authorizer.consume({ grant, capability, actionKey, payload }),
      authorizer.consume({ grant, capability, actionKey, payload }),
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal(
      await authorizer.consume({
        grant,
        capability,
        actionKey,
        payload: { ...payload, issue: 43 },
      }),
      false,
    );
    const consumed = await pool.query<{ status: string; consumedAt: Date | null }>(
      `SELECT status, consumed_at AS "consumedAt"
       FROM orchestration_approval_grants WHERE grant_id = $1`,
      [grantId],
    );
    assert.equal(consumed.rows[0]?.status, "CONSUMED");
    assert.ok(consumed.rows[0]?.consumedAt);
  } finally {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    await pool.end();
  }
});
