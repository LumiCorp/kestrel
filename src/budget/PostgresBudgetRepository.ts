import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import {
  createEmptyBudgetRepositoryState,
  parseBudgetRepositoryState,
  type BudgetRepositoryStateV1,
  type BudgetRepositoryTransactionResult,
  type BudgetRepositoryV1,
} from "./repository.js";

interface BudgetStateRow extends Record<string, unknown> {
  state_json: unknown;
  revision: number | string;
}

export class PostgresBudgetRepository implements BudgetRepositoryV1 {
  private readonly db: SqlExecutor;
  private readonly repositoryId: string;

  constructor(db: SqlExecutor, repositoryId = "runtime") {
    this.db = db;
    this.repositoryId = requireRepositoryId(repositoryId);
  }

  async transaction<T>(
    operation: (state: BudgetRepositoryStateV1) =>
      Promise<BudgetRepositoryTransactionResult<T>> | BudgetRepositoryTransactionResult<T>,
  ): Promise<T> {
    if (this.db.transaction === undefined) {
      throw new Error("PostgreSQL budget repository requires transactional SQL execution.");
    }
    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO budget_repository_states (repository_id, state_json, revision)
         VALUES ($1, $2::jsonb, 0)
         ON CONFLICT (repository_id) DO NOTHING`,
        [this.repositoryId, JSON.stringify(createEmptyBudgetRepositoryState())],
      );
      const selected = await tx.query<BudgetStateRow>(
        `SELECT state_json, revision
           FROM budget_repository_states
          WHERE repository_id = $1
          FOR UPDATE`,
        [this.repositoryId],
      );
      const row = selected.rows[0];
      if (row === undefined) throw new Error("Budget repository state could not be locked.");
      const before = parseBudgetRepositoryState(row.state_json);
      const outcome = await operation(structuredClone(before));
      const next = parseBudgetRepositoryState(structuredClone(outcome.state));
      const newEntries = next.ledger.slice(before.ledger.length);
      if (newEntries.some((entry, index) => entry.sequence !== before.ledger.length + index + 1)) {
        throw new Error("Budget repository transaction attempted to rewrite ledger history.");
      }
      for (const entry of newEntries) {
        await tx.query(
          `INSERT INTO budget_ledger_entries
             (repository_id, sequence, entry_id, allocation_id, operation, entry_json, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
          [this.repositoryId, entry.sequence, entry.entryId, entry.allocationId, entry.operation, JSON.stringify(entry), entry.recordedAt],
        );
      }
      const revision = Number(row.revision);
      const updated = await tx.query(
        `UPDATE budget_repository_states
            SET state_json = $2::jsonb, revision = revision + 1, updated_at = NOW()
          WHERE repository_id = $1 AND revision = $3`,
        [this.repositoryId, JSON.stringify(next), revision],
      );
      if (updated.rowCount !== 1) throw new Error("Budget repository revision changed during its locked transaction.");
      return structuredClone(outcome.result);
    });
  }

  async read(): Promise<BudgetRepositoryStateV1> {
    const selected = await this.db.query<BudgetStateRow>(
      `SELECT state_json, revision
         FROM budget_repository_states
        WHERE repository_id = $1`,
      [this.repositoryId],
    );
    return selected.rows[0] === undefined
      ? createEmptyBudgetRepositoryState()
      : parseBudgetRepositoryState(selected.rows[0].state_json);
  }
}

function requireRepositoryId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) {
    throw new Error("Budget repository id must be a bounded exact identifier.");
  }
  return value;
}
