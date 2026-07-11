import { Pool } from "pg";

import { buildCorruptedNextActionInspectionReport } from "../src/runtime/corruptedNextActionInspection.js";

async function main(): Promise<void> {
  const databaseUrl = readDatabaseUrl(process.argv.slice(2), process.env);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const sessions = await pool.query<{
      sessionId: string;
      latestVersion: number;
      currentStepAgent: string | null;
      currentState: Record<string, unknown>;
    }>(`
      WITH affected_sessions AS (
        SELECT session_id
          FROM sessions
         WHERE current_state_json #>> '{agent,nextAction}' = '[Circular]'
        UNION
        SELECT session_id
          FROM session_versions
         WHERE state_json #>> '{agent,nextAction}' = '[Circular]'
            OR state_patch_json #>> '{agent,nextAction}' = '[Circular]'
      )
      SELECT s.session_id AS "sessionId",
             s.current_version AS "latestVersion",
             s.current_step_agent AS "currentStepAgent",
             s.current_state_json AS "currentState"
        FROM sessions s
        JOIN affected_sessions affected ON affected.session_id = s.session_id
       ORDER BY s.session_id ASC
    `);
    const versions = await pool.query<{
      sessionId: string;
      version: number;
      state: Record<string, unknown>;
      statePatch: Record<string, unknown>;
    }>(`
      SELECT session_id AS "sessionId",
             version,
             COALESCE(state_json, '{}'::jsonb) AS "state",
             COALESCE(state_patch_json, '{}'::jsonb) AS "statePatch"
        FROM session_versions
       WHERE state_json #>> '{agent,nextAction}' = '[Circular]'
          OR state_patch_json #>> '{agent,nextAction}' = '[Circular]'
       ORDER BY session_id ASC, version ASC
    `);

    const report = buildCorruptedNextActionInspectionReport({
      sessions: sessions.rows.map((row) => ({
        sessionId: row.sessionId,
        latestVersion: Number(row.latestVersion),
        ...(row.currentStepAgent !== null ? { currentStepAgent: row.currentStepAgent } : {}),
        currentState: row.currentState,
      })),
      versions: versions.rows.map((row) => ({
        sessionId: row.sessionId,
        version: Number(row.version),
        state: row.state,
        statePatch: row.statePatch,
      })),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

function readDatabaseUrl(args: string[], env: NodeJS.ProcessEnv): string {
  const flagIndex = args.indexOf("--database-url");
  const fromFlag = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const databaseUrl = fromFlag ?? env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL or --database-url is required for dry-run inspection.");
  }
  return databaseUrl;
}

await main();
