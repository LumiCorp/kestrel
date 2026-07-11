import type { PGlite, Transaction as PGliteTransaction } from "@electric-sql/pglite";

import type { SqlExecutor } from "./PostgresSessionStore.js";

interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

class PGliteTransactionExecutor implements SqlExecutor {
  private readonly tx: PGliteTransaction;

  constructor(tx: PGliteTransaction) {
    this.tx = tx;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.tx.query<Row>(text, values);
    return {
      rows: result.rows,
      rowCount:
        typeof result.affectedRows === "number" ? result.affectedRows : result.rows.length,
    };
  }
}

export class PGliteSqlExecutor implements SqlExecutor {
  private readonly db: PGlite;

  constructor(db: PGlite) {
    this.db = db;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.db.query<Row>(text, values);
    return {
      rows: result.rows,
      rowCount:
        typeof result.affectedRows === "number" ? result.affectedRows : result.rows.length,
    };
  }

  async transaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => operation(new PGliteTransactionExecutor(tx)));
  }
}
