import { Pool } from "pg";

import type { SqlExecutor } from "./PostgresSessionStore.js";

export class PgSqlExecutor implements SqlExecutor {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const result = await this.pool.query(text, values);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async transaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    const txExecutor: SqlExecutor = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: Row[]; rowCount: number }> => {
        const result = await client.query(text, values);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount ?? 0,
        };
      },
    };

    try {
      await client.query("BEGIN");
      const result = await operation(txExecutor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
  });
}
