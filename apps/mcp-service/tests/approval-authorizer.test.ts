import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresMcpApprovalAuthorizer } from "../src/approval-authorizer.js";
import type { AuthorizedMcpGrant } from "../src/contracts.js";

test("MCP approval lookup is Thread scoped, active, unexpired, and capability bound", async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [{ approved: true }] };
    },
  } as unknown as Pool;
  const authorizer = new PostgresMcpApprovalAuthorizer(pool);
  const approved = await authorizer.isApproved({
    grant: { threadId: "thread-1" } as AuthorizedMcpGrant,
    capability: {} as AuthorizedMcpGrant["capabilities"][number],
  });

  assert.equal(approved, true);
  assert.deepEqual(queries[0]?.values, ["thread-1"]);
  assert.match(queries[0]?.text ?? "", /status = 'ACTIVE'/u);
  assert.match(queries[0]?.text ?? "", /mcp\.invoke/u);
  assert.match(queries[0]?.text ?? "", /expires_at/u);
});
