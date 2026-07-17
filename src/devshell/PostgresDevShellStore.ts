import type { SqlExecutor } from "../store/PostgresSessionStore.js";
import type {
  DevShellProcessRecord,
  DevShellProcessStatus,
  DevShellProcessStore,
} from "./contracts.js";
import { DEFAULT_DEV_SHELL_DISABLED_CONFIG } from "./contracts.js";

export class PostgresDevShellStore implements DevShellProcessStore {
  constructor(private readonly db: SqlExecutor) {}

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO dev_shell_processes
         (process_id, command_text, status, workspace_root, cwd, shell_path, idle_timeout_ms, max_read_bytes,
          readiness_json, requested_tools_json, env_names_json, transcript_path, output_cursor,
          submitted_at, started_at, updated_at, expires_at, completed_at, exit_code, stop_signal, failure_reason,
          source_write_guard_json)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)
       ON CONFLICT (process_id) DO UPDATE
       SET command_text = EXCLUDED.command_text,
           status = EXCLUDED.status,
           workspace_root = EXCLUDED.workspace_root,
           cwd = EXCLUDED.cwd,
           shell_path = EXCLUDED.shell_path,
           idle_timeout_ms = EXCLUDED.idle_timeout_ms,
           max_read_bytes = EXCLUDED.max_read_bytes,
           readiness_json = EXCLUDED.readiness_json,
           requested_tools_json = EXCLUDED.requested_tools_json,
           env_names_json = EXCLUDED.env_names_json,
           transcript_path = EXCLUDED.transcript_path,
           output_cursor = EXCLUDED.output_cursor,
           submitted_at = EXCLUDED.submitted_at,
           started_at = EXCLUDED.started_at,
           updated_at = EXCLUDED.updated_at,
           expires_at = EXCLUDED.expires_at,
           completed_at = EXCLUDED.completed_at,
           exit_code = EXCLUDED.exit_code,
           stop_signal = EXCLUDED.stop_signal,
           failure_reason = EXCLUDED.failure_reason,
           source_write_guard_json = EXCLUDED.source_write_guard_json`,
      [
        record.processId,
        record.command,
        record.status,
        record.workspaceRoot,
        record.cwd,
        record.shellPath,
        record.idleTimeoutMs,
        record.maxReadBytes,
        JSON.stringify(record.readiness),
        JSON.stringify(record.requestedTools),
        JSON.stringify(record.envNames),
        record.transcriptPath,
        record.outputCursor,
        record.submittedAt,
        record.startedAt,
        record.updatedAt,
        record.expiresAt,
        record.completedAt ?? null,
        record.exitCode ?? null,
        record.stopSignal ?? null,
        record.failureReason ?? null,
        JSON.stringify(record.sourceWriteGuard ?? null),
      ],
    );
  }

  async getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    const result = await this.db.query<DevShellProcessRow>(
      `SELECT process_id, command_text, status, workspace_root, cwd, shell_path, idle_timeout_ms,
              max_read_bytes, readiness_json, requested_tools_json, env_names_json, transcript_path,
              output_cursor, submitted_at, started_at, updated_at, expires_at, completed_at,
              exit_code, stop_signal, failure_reason, source_write_guard_json
         FROM dev_shell_processes
        WHERE process_id = $1`,
      [processId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProcessRow(row);
  }

  async listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    const values: unknown[] = [];
    let where = "";
    if (input?.status !== undefined && input.status.length > 0) {
      values.push(input.status);
      where = "WHERE status = ANY($1::text[])";
    }
    const result = await this.db.query<DevShellProcessRow>(
      `SELECT process_id, command_text, status, workspace_root, cwd, shell_path, idle_timeout_ms,
              max_read_bytes, readiness_json, requested_tools_json, env_names_json, transcript_path,
              output_cursor, submitted_at, started_at, updated_at, expires_at, completed_at,
              exit_code, stop_signal, failure_reason, source_write_guard_json
         FROM dev_shell_processes
         ${where}
        ORDER BY updated_at DESC`,
      values,
    );
    return result.rows.map((row) => mapProcessRow(row));
  }
}

interface DevShellProcessRow extends Record<string, unknown> {
  process_id: string;
  command_text: string;
  status: DevShellProcessStatus;
  workspace_root: string;
  cwd: string;
  shell_path: string;
  idle_timeout_ms: number;
  max_read_bytes: number;
  readiness_json: Record<string, unknown>;
  requested_tools_json: string[] | null;
  env_names_json: string[] | null;
  transcript_path: string;
  output_cursor: number;
  submitted_at: string;
  started_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
  exit_code: number | null;
  stop_signal: string | null;
  failure_reason: string | null;
  source_write_guard_json: Record<string, unknown> | null;
}

function mapProcessRow(row: DevShellProcessRow): DevShellProcessRecord {
  const idleTimeoutMs =
    typeof row.idle_timeout_ms === "number" && Number.isFinite(row.idle_timeout_ms)
      ? Math.trunc(row.idle_timeout_ms)
      : 30 * 60_000;
  const maxReadBytes =
    typeof row.max_read_bytes === "number" && Number.isFinite(row.max_read_bytes)
      ? Math.trunc(row.max_read_bytes)
      : (DEFAULT_DEV_SHELL_DISABLED_CONFIG.maxReadBytes ?? 131_072);
  return {
    processId: row.process_id,
    command: row.command_text,
    status: row.status,
    workspaceRoot: row.workspace_root,
    cwd: row.cwd,
    shellPath: row.shell_path,
    idleTimeoutMs,
    maxReadBytes,
    readiness: row.readiness_json as unknown as DevShellProcessRecord["readiness"],
    requestedTools: Array.isArray(row.requested_tools_json) ? row.requested_tools_json : [],
    envNames: Array.isArray(row.env_names_json) ? row.env_names_json : [],
    transcriptPath: row.transcript_path,
    outputCursor:
      typeof row.output_cursor === "number" && Number.isFinite(row.output_cursor)
        ? Math.max(0, Math.trunc(row.output_cursor))
        : 0,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
    ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
    ...(typeof row.stop_signal === "string" ? { stopSignal: row.stop_signal } : {}),
    ...(typeof row.failure_reason === "string" ? { failureReason: row.failure_reason } : {}),
    ...(row.source_write_guard_json !== null
      ? { sourceWriteGuard: row.source_write_guard_json as unknown as DevShellProcessRecord["sourceWriteGuard"] }
      : {}),
  };
}
