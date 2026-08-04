import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import {
  parseBudgetLedgerEntryV1,
  type BudgetLedgerEntryV1,
} from "../kestrel/contracts/budget.js";
import {
  assertBudgetLedgerAppendOnly,
  assertBudgetLedgerAuthorityMatchesState,
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

interface BudgetLedgerRow extends Record<string, unknown> {
  sequence: number | string;
  entry_json: unknown;
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
      const authoritativeLedger = await readAuthoritativeLedger(tx, this.repositoryId);
      assertBudgetLedgerAuthorityMatchesState(before, authoritativeLedger);
      const outcome = await operation(structuredClone(before));
      const next = parseBudgetRepositoryState(structuredClone(outcome.state));
      assertBudgetLedgerAppendOnly(before, next);
      const newEntries = next.ledger.slice(before.ledger.length);
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
    if (this.db.transaction === undefined) {
      throw new Error("PostgreSQL budget repository requires transactional SQL execution.");
    }
    return this.db.transaction(async (tx) => {
      const selected = await tx.query<BudgetStateRow>(
        `SELECT state_json, revision
           FROM budget_repository_states
          WHERE repository_id = $1
          FOR SHARE`,
        [this.repositoryId],
      );
      const authoritativeLedger = await readAuthoritativeLedger(tx, this.repositoryId);
      const row = selected.rows[0];
      if (row === undefined) {
        if (authoritativeLedger.length > 0) {
          throw new Error("Budget repository ledger exists without its authoritative state.");
        }
        return createEmptyBudgetRepositoryState();
      }
      const state = parseBudgetRepositoryState(row.state_json);
      assertBudgetLedgerAuthorityMatchesState(state, authoritativeLedger);
      return state;
    });
  }
}

async function readAuthoritativeLedger(
  db: SqlExecutor,
  repositoryId: string,
): Promise<BudgetLedgerEntryV1[]> {
  const selected = await db.query<BudgetLedgerRow>(
    `SELECT sequence, entry_json
       FROM budget_ledger_entries
      WHERE repository_id = $1
      ORDER BY sequence ASC`,
    [repositoryId],
  );
  return selected.rows.map((row, index) => {
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence !== index + 1) {
      throw new Error("Authoritative budget ledger sequence is not contiguous.");
    }
    const entry = parseBudgetLedgerEntryV1(row.entry_json);
    if (entry.sequence !== sequence) {
      throw new Error("Authoritative budget ledger row sequence does not match its entry contract.");
    }
    return entry;
  });
}

function requireRepositoryId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)) {
    throw new Error("Budget repository id must be a bounded exact identifier.");
  }
  return value;
}
