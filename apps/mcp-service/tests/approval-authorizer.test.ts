import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PostgresMcpApprovalAuthorizer } from "../src/approval-authorizer.js";
import type { AuthorizedMcpGrant } from "../src/contracts.js";


test("MCP approval consumption is exact, atomic, and action bound", async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [{ grant_id: "approval-grant-1" }] };
    },
  } as unknown as Pool;
  const authorizer = new PostgresMcpApprovalAuthorizer(pool);
  const approved = await authorizer.consume({
    grant: { id: "hosted-grant-1", threadId: "thread-1" } as AuthorizedMcpGrant,
    capability: {
      kind: "tool",
      toolCapabilityKey: "hosted.tool",
    } as AuthorizedMcpGrant["capabilities"][number],
    actionKey: "hosted.tool",
    payload: { z: 1, a: true },
  });

  assert.equal(approved, true);
  assert.equal(queries[0]?.values?.[0], "thread-1");
  assert.equal(queries[0]?.values?.[1], "hosted.tool");
  assert.match(String(queries[0]?.values?.[2]), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(queries[0]?.values?.[3], "hosted-grant-1");
  assert.match(queries[0]?.text ?? "", /status = 'ACTIVE'/u);
  assert.match(queries[0]?.text ?? "", /status = 'CONSUMED'/u);
  assert.match(queries[0]?.text ?? "", /FOR UPDATE SKIP LOCKED/u);
  assert.match(queries[0]?.text ?? "", /mcp\.invoke/u);
  assert.match(queries[0]?.text ?? "", /expires_at/u);
});
