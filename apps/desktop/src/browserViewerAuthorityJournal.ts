import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  DesktopBrowserViewerAuthorityLossReason,
  DesktopBrowserViewerPrincipal,
} from "./browserViewerAuthority.js";

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const LOSS_REASONS = new Set<DesktopBrowserViewerAuthorityLossReason>([
  "app_disabled",
  "desktop_stopped",
  "principal_replaced",
  "renderer_crashed",
  "renderer_restarted",
  "thread_unavailable",
  "window_closed",
]);

export interface DesktopBrowserViewerAuthorityJournalState {
  current: DesktopBrowserViewerPrincipal;
  pendingReason: DesktopBrowserViewerAuthorityLossReason | undefined;
}

export interface DesktopBrowserViewerAuthorityJournalDependencies {
  syncDirectory?(directoryPath: string): Promise<void>;
}

/**
 * Private, single-record persistence for Desktop's one authoritative viewer.
 * This intentionally is not a general recovery queue.
 */
export class DesktopBrowserViewerAuthorityJournal {
  readonly #journalPath: string;
  readonly #directoryPath: string;
  readonly #syncDirectory: (directoryPath: string) => Promise<void>;

  constructor(
    journalPath: string,
    dependencies: DesktopBrowserViewerAuthorityJournalDependencies = {},
  ) {
    this.#journalPath = path.resolve(journalPath);
    this.#directoryPath = path.dirname(this.#journalPath);
    this.#syncDirectory = dependencies.syncDirectory ?? syncDirectory;
  }

  async load(): Promise<DesktopBrowserViewerAuthorityJournalState | undefined> {
    await this.#ensurePrivateDirectory();
    let journalStats: Stats;
    try {
      journalStats = await lstat(this.#journalPath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return undefined;
      throw journalError("read journal metadata", error);
    }
    assertPrivateRegularFile(journalStats);

    let handle;
    try {
      handle = await open(
        this.#journalPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedStats = await handle.stat();
      assertPrivateRegularFile(openedStats);
      if (
        openedStats.dev !== journalStats.dev ||
        openedStats.ino !== journalStats.ino
      ) {
        throw new Error("journal identity changed while it was opened");
      }
      if (openedStats.size <= 0 || openedStats.size > MAX_JOURNAL_BYTES) {
        throw new Error("journal size is invalid");
      }
      const source = await handle.readFile({ encoding: "utf8" });
      return parseJournal(source);
    } catch (error) {
      throw journalError("load journal", error);
    } finally {
      await handle?.close();
    }
  }

  async recordCurrent(principal: DesktopBrowserViewerPrincipal): Promise<void> {
    const existing = await this.load();
    if (existing !== undefined && !samePrincipal(existing.current, principal)) {
      throw new Error(
        "Desktop Browser viewer authority journal cannot replace another principal.",
      );
    }
    if (existing?.pendingReason !== undefined) {
      throw new Error(
        "Desktop Browser viewer authority journal cannot overwrite pending loss.",
      );
    }
    await this.#write({ current: principal, pendingReason: undefined });
  }

  async recordPending(
    principal: DesktopBrowserViewerPrincipal,
    reason: DesktopBrowserViewerAuthorityLossReason,
  ): Promise<void> {
    const existing = await this.load();
    if (existing === undefined || !samePrincipal(existing.current, principal)) {
      throw new Error(
        "Desktop Browser viewer authority journal drifted before loss was retained.",
      );
    }
    if (
      existing.pendingReason !== undefined &&
      existing.pendingReason !== reason
    ) {
      throw new Error(
        "Desktop Browser viewer authority journal changed its pending loss reason.",
      );
    }
    await this.#write({ current: principal, pendingReason: reason });
  }

  async clear(principal: DesktopBrowserViewerPrincipal): Promise<void> {
    const existing = await this.load();
    if (existing === undefined || !samePrincipal(existing.current, principal)) {
      throw new Error(
        "Desktop Browser viewer authority journal drifted before exact cleanup.",
      );
    }
    try {
      await unlink(this.#journalPath);
    } catch (error) {
      throw journalError("clear journal", error);
    }
    try {
      await this.#syncDirectory(this.#directoryPath);
    } catch {
      // The exact authority has already been lost and the journal name is gone
      // in this process. If a crash exposes the old directory entry again,
      // startup treats that exact stale record as idempotent pending loss.
    }
  }

  async #write(
    state: DesktopBrowserViewerAuthorityJournalState,
  ): Promise<void> {
    await this.#ensurePrivateDirectory();
    const temporaryPath = path.join(
      this.#directoryPath,
      `.${path.basename(this.#journalPath)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serializeJournal(state), { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#journalPath);
      assertPrivateRegularFile(await lstat(this.#journalPath));
      await this.#syncDirectory(this.#directoryPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw journalError("persist journal", error);
    }
  }

  async #ensurePrivateDirectory(): Promise<void> {
    try {
      await mkdir(this.#directoryPath, { recursive: true, mode: 0o700 });
      const directoryStats = await lstat(this.#directoryPath);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        throw new Error("journal directory is not a real directory");
      }
      assertOwnedAndPrivate(directoryStats, "journal directory");
    } catch (error) {
      throw journalError("verify journal directory", error);
    }
  }
}

function serializeJournal(
  state: DesktopBrowserViewerAuthorityJournalState,
): string {
  return `${JSON.stringify({
    version: JOURNAL_VERSION,
    current: state.current,
    pendingLoss:
      state.pendingReason === undefined
        ? null
        : { principal: state.current, reason: state.pendingReason },
  })}\n`;
}

function parseJournal(
  source: string,
): DesktopBrowserViewerAuthorityJournalState {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw journalError("parse journal JSON", error);
  }
  const record = requireRecord(value, "journal");
  requireExactKeys(record, ["version", "current", "pendingLoss"], "journal");
  if (record.version !== JOURNAL_VERSION) {
    throw new Error(
      "Desktop Browser viewer authority journal version is invalid.",
    );
  }
  const current = parsePrincipal(record.current, "journal.current");
  if (record.pendingLoss === null) {
    return { current, pendingReason: undefined };
  }
  const pending = requireRecord(record.pendingLoss, "journal.pendingLoss");
  requireExactKeys(pending, ["principal", "reason"], "journal.pendingLoss");
  const pendingPrincipal = parsePrincipal(
    pending.principal,
    "journal.pendingLoss.principal",
  );
  if (!samePrincipal(current, pendingPrincipal)) {
    throw new Error(
      "Desktop Browser viewer authority journal pending identity drifted.",
    );
  }
  if (
    typeof pending.reason !== "string" ||
    !LOSS_REASONS.has(pending.reason as DesktopBrowserViewerAuthorityLossReason)
  ) {
    throw new Error(
      "Desktop Browser viewer authority journal loss reason is invalid.",
    );
  }
  return {
    current,
    pendingReason: pending.reason as DesktopBrowserViewerAuthorityLossReason,
  };
}

function parsePrincipal(
  value: unknown,
  label: string,
): DesktopBrowserViewerPrincipal {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      "senderId",
      "principalId",
      "threadId",
      "projectId",
      "sessionId",
      "generation",
      "connectionId",
    ],
    label,
  );
  return {
    senderId: requireNonNegativeInteger(record.senderId, `${label}.senderId`),
    principalId: requireCanonicalText(
      record.principalId,
      `${label}.principalId`,
    ),
    threadId: requireCanonicalText(record.threadId, `${label}.threadId`),
    projectId: requireCanonicalText(record.projectId, `${label}.projectId`),
    sessionId: requireCanonicalText(record.sessionId, `${label}.sessionId`),
    generation: requirePositiveInteger(
      record.generation,
      `${label}.generation`,
    ),
    connectionId: requireCanonicalText(
      record.connectionId,
      `${label}.connectionId`,
    ),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Desktop Browser viewer authority ${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new Error(
      `Desktop Browser viewer authority ${label} has invalid fields.`,
    );
  }
}

function requireCanonicalText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim()
  ) {
    throw new Error(`Desktop Browser viewer authority ${label} is invalid.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Desktop Browser viewer authority ${label} is invalid.`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Desktop Browser viewer authority ${label} is invalid.`);
  }
  return value as number;
}

function assertPrivateRegularFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("journal is not a private regular file");
  }
  assertOwnedAndPrivate(stats, "journal");
}

function assertOwnedAndPrivate(stats: Stats, label: string): void {
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad`);
  }
  const getuid = process.getuid;
  if (getuid !== undefined && stats.uid !== getuid()) {
    throw new Error(`${label} is owned by another user`);
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function samePrincipal(
  left: DesktopBrowserViewerPrincipal,
  right: DesktopBrowserViewerPrincipal,
): boolean {
  return (
    left.senderId === right.senderId &&
    left.principalId === right.principalId &&
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.connectionId === right.connectionId
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function journalError(action: string, cause: unknown): Error {
  return new Error(`Desktop Browser viewer authority could not ${action}.`, {
    cause,
  });
}
