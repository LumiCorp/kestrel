import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  CodexRolloutCheckpointStore,
  RuntimeBindingCorrelationStore,
  RuntimeBindingCorrelationV1,
  RuntimeBindingV1,
  RuntimeNativeSessionStore,
  RuntimeNativeSessionV1,
} from "./contracts.js";
import {
  assertBindingCorrelationTransition,
  assertNativeSessionTransition,
  releasedNativeSession,
} from "./contracts.js";

export class FileRuntimeNativeSessionStore
  implements RuntimeNativeSessionStore
{
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async load(bindingId: string): Promise<RuntimeNativeSessionV1 | undefined> {
    const value = await readJson(this.filePath(bindingId));
    return parseNativeSession(value);
  }

  async save(session: RuntimeNativeSessionV1): Promise<void> {
    await this.serialize(session.bindingId, async () => {
      const existing = await this.load(session.bindingId);
      assertNativeSessionTransition(existing, session);
      await writeJson(this.filePath(session.bindingId), session);
    });
  }

  async release(bindingId: string): Promise<void> {
    await this.serialize(bindingId, async () => {
      const existing = await this.load(bindingId);
      if (existing === undefined || existing.status === "released") return;
      await writeJson(
        this.filePath(bindingId),
        releasedNativeSession(existing),
      );
    });
  }

  private filePath(bindingId: string): string {
    return path.join(this.rootPath, "bindings", `${digest(bindingId)}.json`);
  }

  private async serialize(
    bindingId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.writes.get(bindingId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.writes.set(bindingId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(bindingId) === current) this.writes.delete(bindingId);
    }
  }
}

interface CodexCheckpointMetadataV1 {
  version: "codex_rollout_checkpoint_v1";
  relativePath: string;
}

export class FileCodexRolloutCheckpointStore
  implements CodexRolloutCheckpointStore
{
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async capture(input: {
    bindingId: string;
    codexHome: string;
    rolloutPath: string;
  }): Promise<void> {
    await this.serialize(input.bindingId, async () => {
      const codexHome = await realpath(input.codexHome);
      const rolloutPath = await realpath(input.rolloutPath);
      assertContained(codexHome, rolloutPath, "Codex rollout");
      const stat = await lstat(rolloutPath);
      if (!stat.isFile()) throw new Error("Codex rollout checkpoint is not a file.");
      const relativePath = path.relative(codexHome, rolloutPath);
      assertSafeRelativePath(relativePath);
      const directory = this.checkpointDirectory(input.bindingId);
      await mkdir(directory, { recursive: true });
      const temporaryPath = path.join(
        directory,
        `rollout.${process.pid}.${randomUUID()}.tmp`,
      );
      await copyFile(rolloutPath, temporaryPath);
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path.join(directory, "rollout.jsonl"));
      await writeJson(path.join(directory, "metadata.json"), {
        version: "codex_rollout_checkpoint_v1",
        relativePath,
      } satisfies CodexCheckpointMetadataV1);
    });
  }

  async materialize(input: {
    bindingId: string;
    codexHome: string;
  }): Promise<"materialized" | "same_root" | "missing"> {
    let result: "materialized" | "same_root" | "missing" = "missing";
    await this.serialize(input.bindingId, async () => {
      const directory = this.checkpointDirectory(input.bindingId);
      const metadata = asCodexCheckpointMetadata(
        await readJson(path.join(directory, "metadata.json")),
      );
      const checkpointPath = path.join(directory, "rollout.jsonl");
      if (metadata === undefined) return;
      const codexHome = path.resolve(input.codexHome);
      await mkdir(codexHome, { recursive: true });
      if (!(await isRegularFile(checkpointPath))) return;
      assertSafeRelativePath(metadata.relativePath);
      const targetPath = path.resolve(codexHome, metadata.relativePath);
      assertContained(codexHome, targetPath, "Codex rollout target");
      await mkdir(path.dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
      await copyFile(checkpointPath, temporaryPath);
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, targetPath);
      result = "materialized";
    });
    return result;
  }

  async release(bindingId: string): Promise<void> {
    await this.serialize(bindingId, async () => {
      await rm(this.checkpointDirectory(bindingId), {
        recursive: true,
        force: true,
      });
    });
  }

  private checkpointDirectory(bindingId: string): string {
    return path.join(this.rootPath, "codex", "checkpoints", digest(bindingId));
  }

  private async serialize(
    bindingId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.writes.get(bindingId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.writes.set(bindingId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(bindingId) === current) this.writes.delete(bindingId);
    }
  }
}

export class FileRuntimeBindingCorrelationStore
  implements RuntimeBindingCorrelationStore
{
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async load(bindingId: string): Promise<RuntimeBindingCorrelationV1 | undefined> {
    return parseBindingCorrelation(await readJson(this.filePath(bindingId)));
  }

  async register(binding: RuntimeBindingV1): Promise<void> {
    if (binding.runtimeId === "kestrel") return;
    const runtimeId = binding.runtimeId;
    await this.serialize(binding.bindingId, async () => {
      const existing = await this.load(binding.bindingId);
      if (existing !== undefined) {
        assertBindingCorrelationTransition(existing, binding, "active");
        return;
      }
      const now = new Date().toISOString();
      await writeJson(this.filePath(binding.bindingId), {
        version: "runtime_binding_correlation_v1",
        bindingId: binding.bindingId,
        runtimeId,
        threadId: binding.threadId,
        participantId: binding.participantId,
        environmentId: binding.environmentId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      } satisfies RuntimeBindingCorrelationV1);
    });
  }

  async release(binding: RuntimeBindingV1): Promise<void> {
    if (binding.runtimeId === "kestrel") return;
    await this.serialize(binding.bindingId, async () => {
      const existing = await this.load(binding.bindingId);
      if (existing === undefined) {
        throw new Error("Runtime binding correlation was not registered.");
      }
      assertBindingCorrelationTransition(existing, binding, "released");
      if (existing.status === "released") return;
      await writeJson(this.filePath(binding.bindingId), {
        ...existing,
        status: "released",
        updatedAt: new Date().toISOString(),
      } satisfies RuntimeBindingCorrelationV1);
    });
  }

  private filePath(bindingId: string): string {
    return path.join(
      this.rootPath,
      "binding-correlations",
      `${digest(bindingId)}.json`,
    );
  }

  private async serialize(
    bindingId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.writes.get(bindingId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.writes.set(bindingId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(bindingId) === current) this.writes.delete(bindingId);
    }
  }
}

export class FileClaudeSessionStore implements SessionStore {
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.serialize(key.sessionId, async () => {
      if (await this.isReleased(key.sessionId)) {
        throw Object.assign(
          new Error("The Claude session has been released."),
          { code: "RUNTIME_SESSION_RELEASED" },
        );
      }
      const filePath = this.filePath(key);
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
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    let result: SessionStoreEntry[] | null = null;
    await this.serialize(key.sessionId, async () => {
      if (await this.isReleased(key.sessionId)) return;
      const value = await readJson(this.filePath(key));
      result = value === undefined ? null : asSessionEntries(value);
    });
    return result;
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      const directory = path.join(this.rootPath, "claude", digest(sessionId));
      await rm(directory, { recursive: true, force: true });
      await writeJson(this.releasePath(sessionId), {
        version: "claude_session_released_v1",
      });
    });
  }

  private filePath(key: SessionKey): string {
    const scope = `${key.projectKey}\0${key.subpath ?? ""}`;
    return path.join(
      this.rootPath,
      "claude",
      digest(key.sessionId),
      `${digest(scope)}.json`,
    );
  }

  private releasePath(sessionId: string): string {
    return path.join(
      this.rootPath,
      "claude-released",
      `${digest(sessionId)}.json`,
    );
  }

  private async isReleased(sessionId: string): Promise<boolean> {
    return (await readJson(this.releasePath(sessionId))) !== undefined;
  }

  private async serialize(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = digest(sessionId);
    const previous = this.operations.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.operations.set(key, current);
    try {
      await current;
    } finally {
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
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

function parseNativeSession(value: unknown): RuntimeNativeSessionV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const valid = (
    record.version === "runtime_native_session_v1" &&
    typeof record.bindingId === "string" &&
    (record.runtimeId === "codex" || record.runtimeId === "claude") &&
    typeof record.nativeVersion === "string" &&
    (record.status === "ready" ||
      record.status === "degraded" ||
      record.status === "released") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.threadId === undefined || typeof record.threadId === "string") &&
    (record.participantId === undefined ||
      typeof record.participantId === "string") &&
    (record.environmentId === undefined ||
      typeof record.environmentId === "string") &&
    (record.status === "released"
      ? record.nativeSessionId === undefined ||
        typeof record.nativeSessionId === "string"
      : typeof record.nativeSessionId === "string")
  );
  if (!valid) return;
  const common = {
    version: "runtime_native_session_v1" as const,
    bindingId: record.bindingId as string,
    runtimeId: record.runtimeId as "codex" | "claude",
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
    ...(typeof record.participantId === "string"
      ? { participantId: record.participantId }
      : {}),
    ...(typeof record.environmentId === "string"
      ? { environmentId: record.environmentId }
      : {}),
    nativeVersion: record.nativeVersion as string,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
  };
  return record.status === "released"
    ? { ...common, status: "released" }
    : {
        ...common,
        status: record.status as "ready" | "degraded",
        nativeSessionId: record.nativeSessionId as string,
      };
}

function parseBindingCorrelation(
  value: unknown,
): RuntimeBindingCorrelationV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.version !== "runtime_binding_correlation_v1" ||
    typeof record.bindingId !== "string" ||
    (record.runtimeId !== "codex" && record.runtimeId !== "claude") ||
    typeof record.threadId !== "string" ||
    typeof record.participantId !== "string" ||
    typeof record.environmentId !== "string" ||
    (record.status !== "active" && record.status !== "released") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return;
  }
  return record as unknown as RuntimeBindingCorrelationV1;
}

function asCodexCheckpointMetadata(
  value: unknown,
): CodexCheckpointMetadataV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.version !== "codex_rollout_checkpoint_v1" ||
    typeof record.relativePath !== "string"
  ) {
    return;
  }
  return {
    version: "codex_rollout_checkpoint_v1",
    relativePath: record.relativePath,
  };
}

function assertSafeRelativePath(value: string): void {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    value === ".." ||
    value.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Codex rollout checkpoint path is invalid.");
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} is outside the active Codex home.`);
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
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
