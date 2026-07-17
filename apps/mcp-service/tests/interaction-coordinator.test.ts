import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import type { AuthorizedMcpGrant } from "../src/contracts.js";
import { PostgresMcpInteractionCoordinator } from "../src/interaction-coordinator.js";

const grant: AuthorizedMcpGrant = {
  id: "grant-1",
  runExecutionId: "run-1",
  workspaceId: "workspace-1",
  organizationId: "organization-1",
  environmentId: "environment-1",
  projectId: null,
  threadId: "thread-1",
  policyDigest: "sha256:policy",
  expiresAt: new Date(Date.now() + 60_000),
  capabilities: [
    {
      id: "sampling-1",
      kind: "sampling",
      capabilityKey: "sampling/createMessage",
      toolCapabilityKey: null,
      approvalMode: "ask",
      definition: {},
      serverId: "server-1",
    },
  ],
  servers: [],
};

function createPool(input?: {
  checkpoint?: {
    status: string;
    response_envelope: unknown;
    failure_code: string | null;
    failure_message: string | null;
    processing_expires_at: Date | null;
  };
  checkpoints?: Array<{
    status: string;
    response_envelope: unknown;
    failure_code: string | null;
    failure_message: string | null;
    processing_expires_at: Date | null;
  }>;
}) {
  const queries: string[] = [];
  const checkpoints = [...(input?.checkpoints ?? [])];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      release: () => {},
    }),
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT status, response_envelope")) {
        const checkpoint = checkpoints.shift() ?? input?.checkpoint;
        return { rows: checkpoint ? [checkpoint] : [] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test("interaction coordinator propagates failed sampling without relabeling it as a denial", async () => {
  const { pool, queries } = createPool({
    checkpoint: {
      status: "failed",
      response_envelope: null,
      failure_code: "MCP_SAMPLING_FAILED",
      failure_message: "Provider rejected the request.",
      processing_expires_at: null,
    },
  });
  const coordinator = new PostgresMcpInteractionCoordinator(pool, 0);

  await assert.rejects(
    coordinator.request({
      grant,
      serverId: "server-1",
      kind: "sampling",
      request: { messages: [] },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "MCP_SAMPLING_FAILED");
      assert.equal(error.message, "Provider rejected the request.");
      return true;
    }
  );
  assert.equal(
    queries.some((sql) => sql.includes("SET status = 'denied'")),
    false
  );
});

test("interaction coordinator follows claimed sampling through grant expiry", async () => {
  const { pool, queries } = createPool({
    checkpoints: [
      {
        status: "processing",
        response_envelope: null,
        failure_code: null,
        failure_message: null,
        processing_expires_at: new Date(Date.now() + 60_000),
      },
      {
        status: "completed",
        response_envelope: { role: "assistant", content: [] },
        failure_code: null,
        failure_message: null,
        processing_expires_at: new Date(Date.now() + 60_000),
      },
    ],
  });
  const coordinator = new PostgresMcpInteractionCoordinator(pool, 0);
  const result = await coordinator.request({
    grant: { ...grant, expiresAt: new Date(Date.now() - 1) },
    serverId: "server-1",
    kind: "sampling",
    request: { messages: [] },
  });
  assert.deepEqual(result, { role: "assistant", content: [] });
  assert.equal(
    queries.some((sql) => sql.includes("WITH cancelled_checkpoint AS")),
    false
  );
});

test("interaction coordinator terminalizes an expired processing claim", async () => {
  const { pool, queries } = createPool({
    checkpoints: [
      {
        status: "processing",
        response_envelope: null,
        failure_code: null,
        failure_message: null,
        processing_expires_at: new Date(Date.now() - 1),
      },
      {
        status: "failed",
        response_envelope: null,
        failure_code: "MCP_SAMPLING_TIMEOUT",
        failure_message: "MCP sampling exceeded its processing deadline.",
        processing_expires_at: new Date(Date.now() - 1),
      },
    ],
  });
  const coordinator = new PostgresMcpInteractionCoordinator(pool, 0);
  await assert.rejects(
    coordinator.request({
      grant,
      serverId: "server-1",
      kind: "sampling",
      request: { messages: [] },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "MCP_SAMPLING_TIMEOUT");
      return true;
    }
  );
  assert.ok(
    queries.some((sql) => sql.includes("WITH failed_checkpoint AS"))
  );
});

test("interaction cancellation cannot overwrite a processing checkpoint", async () => {
  const { pool, queries } = createPool();
  const coordinator = new PostgresMcpInteractionCoordinator(pool, 0);
  const controller = new AbortController();
  controller.abort(new Error("caller stopped waiting"));

  await assert.rejects(
    coordinator.request({
      grant,
      serverId: "server-1",
      kind: "sampling",
      request: { messages: [] },
      signal: controller.signal,
    }),
    /caller stopped waiting/u
  );
  const cancellation = queries.find((sql) =>
    sql.includes("WITH cancelled_checkpoint AS")
  );
  assert.ok(cancellation);
  assert.match(cancellation, /status IN \('requested', 'approved'\)/u);
  assert.doesNotMatch(cancellation, /'processing'/u);
});
