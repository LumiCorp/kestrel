import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import * as pty from "node-pty";
import type { IPty } from "node-pty";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { agentChildEnvironment } from "../runtime/agentChildEnvironment.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;

export type UserTerminalStatus = "running" | "exited" | "stopped" | "lost";

export interface UserTerminalRecord {
  terminalId: string;
  kind: "user_terminal";
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  cwd: string;
  shellPath: string;
  pid?: number | undefined;
  status: UserTerminalStatus;
  cols: number;
  rows: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  exitCode?: number | undefined;
  signal?: number | undefined;
  durationMs?: number | undefined;
}

export interface UserTerminalReadResult {
  terminal: UserTerminalRecord;
  output: string;
  cursor: number;
  nextCursor: number;
  truncated: boolean;
}

interface OutputChunk {
  cursor: number;
  nextCursor: number;
  text: string;
  byteLength: number;
}

interface ActiveTerminal {
  record: UserTerminalRecord;
  process: IPty;
  chunks: OutputChunk[];
  outputBytes: number;
  nextCursor: number;
}

interface PersistedUserTerminalStore {
  version: 1;
  terminals: UserTerminalRecord[];
}

export class UserTerminalService {
  private readonly terminals = new Map<string, ActiveTerminal>();
  private readonly records = new Map<string, UserTerminalRecord>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    metadataPath: string;
    maxOutputBytes?: number | undefined;
    now?: (() => Date) | undefined;
  }) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.options.metadataPath), { recursive: true });
    const persisted = await readPersistedStore(this.options.metadataPath);
    const now = this.now().toISOString();
    for (const record of persisted.terminals) {
      const recovered = record.status === "running"
        ? {
            ...record,
            status: "lost" as const,
            updatedAt: now,
            completedAt: now,
            durationMs: Math.max(0, this.now().getTime() - new Date(record.startedAt).getTime()),
          }
        : record;
      this.records.set(recovered.terminalId, recovered);
    }
    await this.persist();
  }

  async start(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    cwd?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    shellPath?: string | undefined;
  }): Promise<UserTerminalRecord> {
    const sessionId = requireIdentifier(input.sessionId, "sessionId");
    const threadId = requireIdentifier(input.threadId, "threadId");
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const cwd = await realpath(path.resolve(workspaceRoot, input.cwd ?? "."));
    assertPathInside(workspaceRoot, cwd, "cwd");
    const shellPath = await resolveShellPath(input.shellPath);
    const cols = terminalDimension(input.cols, DEFAULT_COLS, "cols");
    const rows = terminalDimension(input.rows, DEFAULT_ROWS, "rows");
    const terminalId = randomUUID();
    const startedAt = this.now().toISOString();
    const child = pty.spawn(shellPath, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnvironment(process.env),
    });
    const record: UserTerminalRecord = {
      terminalId,
      kind: "user_terminal",
      sessionId,
      threadId,
      workspaceRoot,
      cwd,
      shellPath,
      pid: child.pid,
      status: "running",
      cols,
      rows,
      startedAt,
      updatedAt: startedAt,
    };
    const active: ActiveTerminal = {
      record,
      process: child,
      chunks: [],
      outputBytes: 0,
      nextCursor: 0,
    };
    this.terminals.set(terminalId, active);
    this.records.set(terminalId, record);
    child.onData((text) => this.appendOutput(active, text));
    child.onExit(({ exitCode, signal }) => {
      void this.settle(active, active.record.status === "stopped" ? "stopped" : "exited", exitCode, signal);
    });
    await this.persist();
    return { ...record };
  }

  list(input: { sessionId: string; threadId?: string | undefined }): UserTerminalRecord[] {
    const sessionId = requireIdentifier(input.sessionId, "sessionId");
    const threadId = input.threadId === undefined ? undefined : requireIdentifier(input.threadId, "threadId");
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId && (threadId === undefined || record.threadId === threadId))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((record) => ({ ...record }));
  }

  read(input: { terminalId: string; sessionId: string; cursor?: number | undefined }): UserTerminalReadResult {
    const record = this.requireOwnedRecord(input.terminalId, input.sessionId);
    const active = this.terminals.get(record.terminalId);
    if (active === undefined) {
      return { terminal: record, output: "", cursor: 0, nextCursor: 0, truncated: false };
    }
    const requestedCursor = nonNegativeInteger(input.cursor, 0, "cursor");
    const firstCursor = active.chunks[0]?.cursor ?? active.nextCursor;
    const truncated = requestedCursor < firstCursor;
    const cursor = truncated ? firstCursor : requestedCursor;
    return {
      terminal: { ...active.record },
      output: active.chunks.filter((chunk) => chunk.nextCursor > cursor).map((chunk) => chunk.text).join(""),
      cursor,
      nextCursor: active.nextCursor,
      truncated,
    };
  }

  write(input: { terminalId: string; sessionId: string; data: string }): UserTerminalRecord {
    const active = this.requireActiveOwnedTerminal(input.terminalId, input.sessionId);
    if (typeof input.data !== "string" || input.data.length === 0 || Buffer.byteLength(input.data, "utf8") > 64 * 1024) {
      throw createRuntimeFailure("USER_TERMINAL_INPUT_INVALID", "Terminal input must contain at most 64 KB.", {
        subsystem: "terminal",
        classification: "input",
        recoverable: true,
      });
    }
    active.process.write(input.data);
    active.record = { ...active.record, updatedAt: this.now().toISOString() };
    this.records.set(active.record.terminalId, active.record);
    return { ...active.record };
  }

  resize(input: { terminalId: string; sessionId: string; cols: number; rows: number }): UserTerminalRecord {
    const active = this.requireActiveOwnedTerminal(input.terminalId, input.sessionId);
    const cols = terminalDimension(input.cols, DEFAULT_COLS, "cols");
    const rows = terminalDimension(input.rows, DEFAULT_ROWS, "rows");
    active.process.resize(cols, rows);
    active.record = { ...active.record, cols, rows, updatedAt: this.now().toISOString() };
    this.records.set(active.record.terminalId, active.record);
    void this.persist();
    return { ...active.record };
  }

  async stop(input: { terminalId: string; sessionId: string }): Promise<UserTerminalRecord> {
    const record = this.requireOwnedRecord(input.terminalId, input.sessionId);
    const active = this.terminals.get(record.terminalId);
    if (active === undefined || active.record.status !== "running") {
      return record;
    }
    active.record = { ...active.record, status: "stopped", updatedAt: this.now().toISOString() };
    this.records.set(active.record.terminalId, active.record);
    active.process.kill("SIGTERM");
    await this.persist();
    return { ...active.record };
  }

  async close(): Promise<void> {
    for (const active of this.terminals.values()) {
      if (active.record.status === "running") {
        active.record = { ...active.record, status: "stopped", updatedAt: this.now().toISOString() };
        active.process.kill("SIGTERM");
      }
    }
    await this.persist();
  }

  private appendOutput(active: ActiveTerminal, text: string): void {
    if (text.length === 0) {
      return;
    }
    const chunk: OutputChunk = {
      cursor: active.nextCursor,
      nextCursor: active.nextCursor + 1,
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
    };
    active.nextCursor = chunk.nextCursor;
    active.chunks.push(chunk);
    active.outputBytes += chunk.byteLength;
    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    while (active.outputBytes > maxOutputBytes && active.chunks.length > 1) {
      const removed = active.chunks.shift();
      active.outputBytes -= removed?.byteLength ?? 0;
    }
    active.record = { ...active.record, updatedAt: this.now().toISOString() };
    this.records.set(active.record.terminalId, active.record);
  }

  private async settle(
    active: ActiveTerminal,
    status: "exited" | "stopped",
    exitCode: number,
    signal: number | undefined,
  ): Promise<void> {
    if (this.terminals.get(active.record.terminalId) !== active) {
      return;
    }
    const completedAt = this.now().toISOString();
    active.record = {
      ...active.record,
      status,
      updatedAt: completedAt,
      completedAt,
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
      durationMs: Math.max(0, this.now().getTime() - new Date(active.record.startedAt).getTime()),
    };
    this.records.set(active.record.terminalId, active.record);
    await this.persist();
  }

  private requireOwnedRecord(terminalIdValue: string, sessionIdValue: string): UserTerminalRecord {
    const terminalId = requireIdentifier(terminalIdValue, "terminalId");
    const sessionId = requireIdentifier(sessionIdValue, "sessionId");
    const record = this.records.get(terminalId);
    if (record === undefined || record.sessionId !== sessionId) {
      throw createRuntimeFailure("USER_TERMINAL_NOT_FOUND", "Terminal session is unavailable.", {
        subsystem: "terminal",
        classification: "state",
        recoverable: true,
        terminalId,
      });
    }
    return { ...record };
  }

  private requireActiveOwnedTerminal(terminalId: string, sessionId: string): ActiveTerminal {
    const record = this.requireOwnedRecord(terminalId, sessionId);
    const active = this.terminals.get(record.terminalId);
    if (active === undefined || active.record.status !== "running") {
      throw createRuntimeFailure("USER_TERMINAL_NOT_RUNNING", "Terminal session is not running.", {
        subsystem: "terminal",
        classification: "state",
        recoverable: true,
        terminalId: record.terminalId,
        status: record.status,
      });
    }
    return active;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedUserTerminalStore = {
      version: 1,
      terminals: [...this.records.values()].map((record) => ({ ...record })),
    };
    const tempPath = `${this.options.metadataPath}.tmp`;
    this.persistTail = this.persistTail.then(async () => {
      await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.options.metadataPath);
    });
    await this.persistTail;
  }
}

async function resolveShellPath(requested: string | undefined): Promise<string> {
  const candidate = requested?.trim() || process.env.SHELL?.trim() || (process.platform === "win32" ? process.env.COMSPEC : "/bin/sh");
  if (candidate === undefined || path.isAbsolute(candidate) === false || candidate.includes("\u0000")) {
    throw createRuntimeFailure("USER_TERMINAL_SHELL_INVALID", "Terminal shell path is invalid.", {
      subsystem: "terminal",
      classification: "configuration",
      recoverable: true,
    });
  }
  await access(candidate);
  return realpath(candidate);
}

function terminalEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentChildEnvironment(environment)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || value.includes("\u0000")) {
    throw createRuntimeFailure("USER_TERMINAL_INPUT_INVALID", `Terminal ${field} is invalid.`, {
      subsystem: "terminal",
      classification: "input",
      recoverable: true,
      field,
    });
  }
  return value.trim();
}

function terminalDimension(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (Number.isInteger(normalized) === false || normalized < 2 || normalized > 1000) {
    throw createRuntimeFailure("USER_TERMINAL_INPUT_INVALID", `Terminal ${field} is invalid.`, {
      subsystem: "terminal",
      classification: "input",
      recoverable: true,
      field,
    });
  }
  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (Number.isInteger(normalized) === false || normalized < 0) {
    throw createRuntimeFailure("USER_TERMINAL_INPUT_INVALID", `Terminal ${field} is invalid.`, {
      subsystem: "terminal",
      classification: "input",
      recoverable: true,
      field,
    });
  }
  return normalized;
}

function assertPathInside(root: string, candidate: string, field: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative.startsWith("..") === false && path.isAbsolute(relative) === false)) {
    return;
  }
  throw createRuntimeFailure("USER_TERMINAL_PATH_OUTSIDE_WORKSPACE", `Terminal ${field} must stay within the workspace.`, {
    subsystem: "terminal",
    classification: "authorization",
    recoverable: false,
    root,
    candidate,
  });
}

async function readPersistedStore(metadataPath: string): Promise<PersistedUserTerminalStore> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<PersistedUserTerminalStore>;
    if (parsed.version !== 1 || Array.isArray(parsed.terminals) === false) {
      return { version: 1, terminals: [] };
    }
    return {
      version: 1,
      terminals: parsed.terminals.filter(isUserTerminalRecord),
    };
  } catch {
    return { version: 1, terminals: [] };
  }
}

function isUserTerminalRecord(value: unknown): value is UserTerminalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === "user_terminal"
    && typeof record.terminalId === "string"
    && typeof record.sessionId === "string"
    && typeof record.threadId === "string"
    && typeof record.workspaceRoot === "string"
    && typeof record.cwd === "string"
    && typeof record.shellPath === "string"
    && (record.status === "running" || record.status === "exited" || record.status === "stopped" || record.status === "lost")
    && typeof record.cols === "number"
    && typeof record.rows === "number"
    && typeof record.startedAt === "string"
    && typeof record.updatedAt === "string";
}
