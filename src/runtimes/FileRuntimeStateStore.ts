import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  RuntimeNativeSessionStore,
  RuntimeNativeSessionV1,
} from "./contracts.js";

export class FileRuntimeNativeSessionStore
  implements RuntimeNativeSessionStore
{
  constructor(private readonly rootPath: string) {}

  async load(bindingId: string): Promise<RuntimeNativeSessionV1 | undefined> {
    const value = await readJson(this.filePath(bindingId));
    return isNativeSession(value) ? value : undefined;
  }

  async save(session: RuntimeNativeSessionV1): Promise<void> {
    await writeJson(this.filePath(session.bindingId), session);
  }

  async release(bindingId: string): Promise<void> {
    const existing = await this.load(bindingId);
    if (existing === undefined) return;
    await this.save({
      ...existing,
      status: "released",
      updatedAt: new Date().toISOString(),
    });
  }

  private filePath(bindingId: string): string {
    return path.join(this.rootPath, "bindings", `${digest(bindingId)}.json`);
  }
}

export class FileClaudeSessionStore implements SessionStore {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const filePath = this.filePath(key);
    const previous = this.writes.get(filePath) ?? Promise.resolve();
    const current = previous.then(async () => {
      const existing = asSessionEntries(await readJson(filePath));
      const knownIds = new Set(
        existing.flatMap((entry) =>
          typeof entry.uuid === "string" ? [entry.uuid] : [],
        ),
      );
      const next = [...existing];
      for (const entry of entries) {
        if (typeof entry.uuid === "string" && knownIds.has(entry.uuid)) continue;
        next.push(entry);
        if (typeof entry.uuid === "string") knownIds.add(entry.uuid);
      }
      await writeJson(filePath, next);
    });
    this.writes.set(filePath, current);
    try {
      await current;
    } finally {
      if (this.writes.get(filePath) === current) this.writes.delete(filePath);
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await this.writes.get(this.filePath(key));
    const value = await readJson(this.filePath(key));
    return value === undefined ? null : asSessionEntries(value);
  }

  private filePath(key: SessionKey): string {
    const scope = `${key.projectKey}\0${key.sessionId}\0${key.subpath ?? ""}`;
    return path.join(this.rootPath, "claude", `${digest(scope)}.json`);
  }
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNativeSession(value: unknown): value is RuntimeNativeSessionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === "runtime_native_session_v1" &&
    typeof record.bindingId === "string" &&
    (record.runtimeId === "codex" || record.runtimeId === "claude") &&
    typeof record.nativeSessionId === "string" &&
    typeof record.nativeVersion === "string" &&
    (record.status === "ready" ||
      record.status === "degraded" ||
      record.status === "released") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function asSessionEntries(value: unknown): SessionStoreEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SessionStoreEntry =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof (entry as { type?: unknown }).type === "string",
  );
}
