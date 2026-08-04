import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";
import { BudgetCoordinator } from "../src/budget/BudgetCoordinator.js";
import { PostgresBudgetRepository } from "../src/budget/PostgresBudgetRepository.js";
import { BUDGET_SCOPE_VERSION, createBudgetPolicyV1 } from "../src/kestrel/contracts/budget.js";
import { PgSqlExecutor } from "../src/store/PgSqlExecutor.js";

const databaseUrl = process.env.KESTREL_PRODUCT_RUNNER_DATABASE_URL?.trim();

test("PostgreSQL budget repository serializes contention and survives coordinator restart", async () => {
  assert.ok(databaseUrl, "KESTREL_PRODUCT_RUNNER_DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const repositoryId = `budget-${randomUUID()}`;
  const executor = new PgSqlExecutor(pool);
  const tenant = { version: BUDGET_SCOPE_VERSION, segments: [{ kind: "tenant" as const, id: "tenant-postgres" }] };
  const policy = createBudgetPolicyV1({
    policyId: "postgres-budget-policy",
    allocations: [{ allocationKey: "tenant", scope: tenant, limits: { toolCalls: 1 } }],
  });
  const input = (reservationId: string) => ({
    allocationId: "allocation-postgres",
    allocationRevision: 0,
    policyRevision: policy.revision,
    reservationId,
    scope: tenant,
    amounts: { toolCalls: 1 },
    idempotencyKey: `reserve-${reservationId}`,
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  try {
    const coordinator = new BudgetCoordinator({
      policy,
      repository: new PostgresBudgetRepository(executor, repositoryId),
    });
    await coordinator.openAllocation({
      allocationId: "allocation-postgres",
      allocationKey: "tenant",
      policyRevision: policy.revision,
      idempotencyKey: "open-postgres",
      openedAt: "2026-08-04T12:00:00.000Z",
    });
    const concurrent = await Promise.allSettled([
      coordinator.reserve(input("postgres-a")),
      coordinator.reserve(input("postgres-b")),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    const restarted = new BudgetCoordinator({
      policy,
      repository: new PostgresBudgetRepository(executor, repositoryId),
    });
    const snapshot = await restarted.snapshot({
      allocationId: "allocation-postgres",
      allocationRevision: 1,
      policyRevision: policy.revision,
    });
    assert.equal(snapshot.reserved.toolCalls, 1);
    const ledger = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM budget_ledger_entries WHERE repository_id = $1",
      [repositoryId],
    );
    assert.equal(Number(ledger.rows[0]?.count), 2);
  } finally {
    await pool.query("DELETE FROM budget_ledger_entries WHERE repository_id = $1", [repositoryId]);
    await pool.query("DELETE FROM budget_repository_states WHERE repository_id = $1", [repositoryId]);
    await pool.end();
  }
});
