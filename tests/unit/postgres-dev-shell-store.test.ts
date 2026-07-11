import test from "node:test";
import assert from "node:assert/strict";

import { PostgresDevShellStore } from "../../src/devshell/PostgresDevShellStore.js";
import type {
  DevShellProcessRecord,
  DevShellSourceWriteGuardResult,
} from "../../src/devshell/contracts.js";
import { ScriptedSqlExecutor } from "../helpers/ScriptedSqlExecutor.js";

test("PostgresDevShellStore persists source-write guard JSON on upsert", async () => {
  const sql = new ScriptedSqlExecutor([
    { match: /^INSERT INTO dev_shell_processes/u, rowCount: 1 },
  ]);
  const store = new PostgresDevShellStore(sql);
  const sourceWriteGuard = buildSourceWriteGuard();

  await store.upsertProcess(buildProcessRecord({ sourceWriteGuard }));

  assert.equal(sql.queries.length, 1);
  const query = sql.queries[0]!;
  assert.match(query.text, /source_write_guard_json/u);
  assert.equal(query.values?.[21], JSON.stringify(sourceWriteGuard));
  sql.assertExhausted();
});

test("PostgresDevShellStore maps source-write guard JSON from getProcess", async () => {
  const sourceWriteGuard = buildSourceWriteGuard();
  const sql = new ScriptedSqlExecutor([
    {
      match: /FROM dev_shell_processes\s+WHERE process_id = \$1/u,
      rows: [buildDevShellProcessRow({ source_write_guard_json: sourceWriteGuard })],
      rowCount: 1,
    },
  ]);
  const store = new PostgresDevShellStore(sql);

  const record = await store.getProcess("proc-1");

  assert.deepEqual(record?.sourceWriteGuard, sourceWriteGuard);
  sql.assertExhausted();
});

test("PostgresDevShellStore maps source-write guard JSON from listProcesses", async () => {
  const sourceWriteGuard = buildSourceWriteGuard();
  const sql = new ScriptedSqlExecutor([
    {
      match: /FROM dev_shell_processes/u,
      rows: [buildDevShellProcessRow({ source_write_guard_json: sourceWriteGuard })],
      rowCount: 1,
    },
  ]);
  const store = new PostgresDevShellStore(sql);

  const records = await store.listProcesses();

  assert.deepEqual(records[0]?.sourceWriteGuard, sourceWriteGuard);
  sql.assertExhausted();
});

function buildProcessRecord(input: {
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
} = {}): DevShellProcessRecord {
  const now = new Date("2026-05-16T12:00:00.000Z").toISOString();
  return {
    processId: "proc-1",
    command: "true",
    status: "COMPLETED",
    workspaceRoot: "/workspace",
    cwd: "/workspace",
    shellPath: "/bin/sh",
    idleTimeoutMs: 1000,
    maxReadBytes: 4096,
    readiness: {
      workspaceRootExists: true,
      cwdExists: true,
      cwdWithinWorkspace: true,
      shellResolved: true,
      tools: [],
      env: [],
    },
    requestedTools: [],
    envNames: [],
    transcriptPath: "/tmp/transcript.log",
    outputCursor: 0,
    submittedAt: now,
    startedAt: now,
    updatedAt: now,
    expiresAt: now,
    completedAt: now,
    exitCode: 0,
    ...(input.sourceWriteGuard !== undefined ? { sourceWriteGuard: input.sourceWriteGuard } : {}),
  };
}

function buildDevShellProcessRow(input: {
  source_write_guard_json?: DevShellSourceWriteGuardResult | null;
} = {}): Record<string, unknown> {
  const record = buildProcessRecord();
  return {
    process_id: record.processId,
    command_text: record.command,
    status: record.status,
    workspace_root: record.workspaceRoot,
    cwd: record.cwd,
    shell_path: record.shellPath,
    idle_timeout_ms: record.idleTimeoutMs,
    max_read_bytes: record.maxReadBytes,
    readiness_json: record.readiness,
    requested_tools_json: record.requestedTools,
    env_names_json: record.envNames,
    transcript_path: record.transcriptPath,
    output_cursor: record.outputCursor,
    submitted_at: record.submittedAt,
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt,
    completed_at: record.completedAt ?? null,
    exit_code: record.exitCode ?? null,
    stop_signal: record.stopSignal ?? null,
    failure_reason: record.failureReason ?? null,
    source_write_guard_json: input.source_write_guard_json ?? null,
  };
}

function buildSourceWriteGuard(): DevShellSourceWriteGuardResult {
  return {
    enabled: true,
    mode: "source_readonly",
    sourceRoots: ["."],
    allowedWriteRoots: [],
    unauthorizedSourceWrites: [
      { path: "app/page.tsx", kind: "modified", restored: true },
    ],
    restored: true,
    finalCheckCompleted: true,
  };
}
