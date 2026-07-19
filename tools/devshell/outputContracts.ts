import type { ModelToolContract } from "../../src/kestrel/contracts/model-io.js";


const COMMON_PROCESS_READ_FIELDS: ModelToolContract["fields"] = {
  processId: { type: "string" },
  status: { type: "string" },
  text: { type: "string" },
  truncated: { type: "boolean" },
  cursor: { type: "number" },
  nextCursor: { type: "number" },
  command: { type: "string" },
  cwd: { type: "string" },
  workspaceRoot: { type: "string" },
  submittedAt: { type: "string" },
  startedAt: { type: "string" },
  updatedAt: { type: "string" },
  completedAt: { type: "string" },
  exitCode: { type: "number" },
  securityMode: { type: "string" },
  failureReason: { type: "string" },
  failurePhase: { type: "string" },
  commandKind: { type: "string" },
  strictModeApplied: { type: "boolean" },
  strictModeReason: { type: "string" },
  preflight: { type: "object" },
  sourceWriteGuard: { type: "object" },
  unauthorizedSourceWrites: { type: "array" },
};

export const DEV_SHELL_RUN_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "text", "truncated"],
  fields: {
    status: { type: "string" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    text: { type: "string" },
    truncated: { type: "boolean" },
    command: { type: "string" },
    cwd: { type: "string" },
    workspaceRoot: { type: "string" },
    submittedAt: { type: "string" },
    startedAt: { type: "string" },
    updatedAt: { type: "string" },
    completedAt: { type: "string" },
    exitCode: { type: "number" },
    securityMode: { type: "string" },
    failureReason: { type: "string" },
    failurePhase: { type: "string" },
    commandKind: { type: "string" },
    strictModeApplied: { type: "boolean" },
    strictModeReason: { type: "string" },
    preflight: { type: "object" },
    sourceWriteGuard: { type: "object" },
    unauthorizedSourceWrites: { type: "array" },
  },
};

export const DEV_PROCESS_START_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "text", "truncated", "cursor", "nextCursor"],
  fields: COMMON_PROCESS_READ_FIELDS,
};

export const DEV_PROCESS_READ_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "text", "truncated", "cursor", "nextCursor"],
  fields: COMMON_PROCESS_READ_FIELDS,
};

export const DEV_PROCESS_STOP_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "text", "truncated", "cursor", "nextCursor"],
  fields: COMMON_PROCESS_READ_FIELDS,
};

export const DEV_PROCESS_WRITE_AND_READ_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "text", "truncated", "cursor", "nextCursor", "bytesWritten"],
  fields: {
    ...COMMON_PROCESS_READ_FIELDS,
    bytesWritten: { type: "number" },
  },
};

export const DEV_PROCESS_WRITE_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["processId", "status", "bytesWritten"],
  fields: {
    processId: { type: "string" },
    status: { type: "string", enum: ["ACCEPTED", "FAILED"] },
    bytesWritten: { type: "number" },
    message: { type: "string" },
  },
};

export const EXEC_COMMAND_OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "output", "durationMs", "truncated"],
  fields: {
    status: {
      type: "string",
      enum: ["completed", "running", "timeout", "failed", "stopped"],
    },
    sessionId: { type: "string" },
    output: { type: "string" },
    exitCode: { type: "number" },
    durationMs: { type: "number" },
    truncated: { type: "boolean" },
    cursor: { type: "number" },
    command: { type: "string" },
    cwd: { type: "string" },
    workspaceRoot: { type: "string" },
    sourceWriteGuard: { type: "object" },
    unauthorizedSourceWrites: { type: "array" },
    changedFiles: { type: "array" },
    patchRef: { type: "string" },
    baseRevisions: { type: "object" },
    failureReason: { type: "string" },
  },
};
