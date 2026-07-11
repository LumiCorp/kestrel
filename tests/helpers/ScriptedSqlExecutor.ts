import type { SqlExecutor } from "../../src/store/PostgresSessionStore.js";

interface ScriptStep {
  match?: RegExp;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  error?: Error;
}

export class ScriptedSqlExecutor implements SqlExecutor {
  private readonly script: ScriptStep[];
  readonly queries: Array<{ text: string; values: unknown[] | undefined }> = [];

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ text, values });

    const step = this.script.shift();
    if (step === undefined) {
      throw new Error(`Unexpected query: ${text}`);
    }

    if (step.match !== undefined && step.match.test(text) === false) {
      throw new Error(`Query did not match script: ${text}`);
    }

    if (step.error !== undefined) {
      throw step.error;
    }

    const rows = (step.rows ?? []) as Row[];
    return {
      rows,
      rowCount: step.rowCount ?? rows.length,
    };
  }

  assertExhausted(): void {
    if (this.script.length > 0) {
      throw new Error(`Unconsumed script steps: ${this.script.length}`);
    }
  }
}
