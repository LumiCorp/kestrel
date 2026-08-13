import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, statfs } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { materializePortableBackupPayload } from "./portable-worktree-backup.js";

export const WORKSPACE_BACKUP_PREPARATION_VERSION = 2;
export const WORKSPACE_BACKUP_PREPARATION_TTL_MS = 5 * 60 * 1000;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".local",
  ".npm",
  ".pnpm-store",
  ".yarn",
  "logs",
  "node_modules",
  "temp",
  "tmp",
]);

type PreparedEntry = {
  relativePath: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  contentDigest: string;
  linkTarget?: string | undefined;
};

export type WorkspaceBackupPreparation = {
  version: typeof WORKSPACE_BACKUP_PREPARATION_VERSION;
  preparationId: string;
  sourceRevision: string;
  logicalBytes: number;
  entryCount: number;
  expiresAt: string;
};

type StoredPreparation = WorkspaceBackupPreparation & {
  entries: PreparedEntry[];
};

export class WorkspaceBackupPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkspaceBackupPreparationError";
  }
}

export class WorkspaceBackupPreparationRegistry {
  private readonly preparations = new Map<string, StoredPreparation>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: {
      maxLogicalBytes?: number | undefined;
      now?: (() => Date) | undefined;
    } = {},
  ) {}

  async prepare(): Promise<WorkspaceBackupPreparation> {
    await materializePortableBackupPayload(this.workspaceRoot);
    const maxLogicalBytes =
      this.options.maxLogicalBytes ??
      (await resolveWorkspaceBackupLogicalLimit(this.workspaceRoot));
    const entries = await inspectWorkspace(
      this.workspaceRoot,
      maxLogicalBytes,
    );
    const now = this.options.now?.() ?? new Date();
    const preparation: StoredPreparation = {
      version: WORKSPACE_BACKUP_PREPARATION_VERSION,
      preparationId: randomUUID(),
      sourceRevision: revisionForEntries(entries),
      logicalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      entryCount: entries.length,
      expiresAt: new Date(
        now.getTime() + WORKSPACE_BACKUP_PREPARATION_TTL_MS,
      ).toISOString(),
      entries,
    };
    this.prune(now);
    this.preparations.set(preparation.preparationId, preparation);
    return publicPreparation(preparation);
  }

  createArchive(preparationId: string): Readable {
    const preparation = this.requirePreparation(preparationId);
    const pack = tar.pack();
    const gzip = createGzip({ level: 6 });
    const output = new PassThrough();
    void pipeline(pack, gzip, output).catch((error: unknown) => {
      output.destroy(asError(error));
    });
    void writePreparedArchive(pack, this.workspaceRoot, preparation.entries)
      .then(() => pack.finalize())
      .catch((error: unknown) => pack.destroy(asError(error)));
    return output;
  }

  private requirePreparation(preparationId: string) {
    const now = this.options.now?.() ?? new Date();
    this.prune(now);
    const preparation = this.preparations.get(preparationId);
    if (!preparation) {
      throw new WorkspaceBackupPreparationError(
        "WORKSPACE_BACKUP_PREPARATION_UNAVAILABLE",
        "Workspace backup preparation is missing or expired.",
        404,
      );
    }
    return preparation;
  }

  private prune(now: Date) {
    for (const [id, preparation] of this.preparations) {
      if (Date.parse(preparation.expiresAt) <= now.getTime()) {
        this.preparations.delete(id);
      }
    }
  }
}

async function inspectWorkspace(root: string, maxLogicalBytes: number) {
  const entries: PreparedEntry[] = [];
  let logicalBytes = 0;

  async function visit(relativeDirectory: string) {
    const directory = path.join(root, relativeDirectory);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const absolutePath = path.join(root, relativePath);
      const metadata = await lstat(absolutePath);
      const mode = metadata.mode & 0o777;
      if (metadata.isDirectory()) {
        if (isExcludedWorkspaceBackupPath(relativePath, true)) continue;
        entries.push({
          relativePath,
          type: "directory",
          mode,
          size: 0,
          contentDigest: "",
        });
        await visit(relativePath);
        continue;
      }
      if (isExcludedWorkspaceBackupPath(relativePath, false)) continue;
      if (metadata.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath);
        entries.push({
          relativePath,
          type: "symlink",
          mode,
          size: 0,
          contentDigest: digestText(linkTarget),
          linkTarget,
        });
        continue;
      }
      if (!metadata.isFile()) continue;
      logicalBytes += metadata.size;
      if (logicalBytes > maxLogicalBytes) {
        throw new WorkspaceBackupPreparationError(
          "WORKSPACE_BACKUP_TOO_LARGE",
          `Workspace backup contains ${logicalBytes} logical bytes; the limit is ${maxLogicalBytes}.`,
          413,
        );
      }
      entries.push({
        relativePath,
        type: "file",
        mode,
        size: metadata.size,
        contentDigest: await digestFile(absolutePath),
      });
    }
  }

  await visit("");
  return entries;
}

function revisionForEntries(entries: PreparedEntry[]) {
  const hash = createHash("sha256");
  hash.update(
    `workspace-backup-revision-v${WORKSPACE_BACKUP_PREPARATION_VERSION}\0`,
  );
  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(entry.contentDigest);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function writePreparedArchive(
  pack: ReturnType<typeof tar.pack>,
  root: string,
  entries: PreparedEntry[],
) {
  await assertPreparedWorkspaceStructure(root, entries);
  for (const entry of entries) {
    const name = entry.relativePath.replaceAll("\\", "/");
    if (entry.type === "directory") {
      await writeEntry(pack, { name, type: "directory", mode: entry.mode });
      continue;
    }
    if (entry.type === "symlink") {
      await writeEntry(pack, {
        name,
        type: "symlink",
        mode: entry.mode,
        linkname: entry.linkTarget,
      });
      continue;
    }
    await writeFileEntry(pack, root, entry);
  }
  await assertPreparedWorkspaceStructure(root, entries);
}

async function assertPreparedWorkspaceStructure(
  root: string,
  preparedEntries: PreparedEntry[],
) {
  const currentEntries = await inspectWorkspaceStructure(root);
  const changed =
    currentEntries.length !== preparedEntries.length ||
    currentEntries.some((entry, index) => {
      const prepared = preparedEntries[index];
      return (
        !prepared ||
        entry.relativePath !== prepared.relativePath ||
        entry.type !== prepared.type ||
        entry.mode !== prepared.mode ||
        entry.size !== prepared.size ||
        entry.linkTarget !== prepared.linkTarget
      );
    });
  if (changed) {
    throw new WorkspaceBackupPreparationError(
      "WORKSPACE_CHANGED_DURING_BACKUP",
      "Workspace changed while its prepared backup was exported.",
      409,
    );
  }
}

async function inspectWorkspaceStructure(root: string) {
  const entries: Array<
    Pick<
      PreparedEntry,
      "relativePath" | "type" | "mode" | "size" | "linkTarget"
    >
  > = [];

  async function visit(relativeDirectory: string) {
    const children = await readdir(path.join(root, relativeDirectory), {
      withFileTypes: true,
    });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const absolutePath = path.join(root, relativePath);
      const metadata = await lstat(absolutePath);
      const mode = metadata.mode & 0o777;
      if (metadata.isDirectory()) {
        if (isExcludedWorkspaceBackupPath(relativePath, true)) continue;
        entries.push({ relativePath, type: "directory", mode, size: 0 });
        await visit(relativePath);
      } else if (metadata.isSymbolicLink()) {
        if (isExcludedWorkspaceBackupPath(relativePath, false)) continue;
        entries.push({
          relativePath,
          type: "symlink",
          mode,
          size: 0,
          linkTarget: await readlink(absolutePath),
        });
      } else if (metadata.isFile()) {
        if (isExcludedWorkspaceBackupPath(relativePath, false)) continue;
        entries.push({
          relativePath,
          type: "file",
          mode,
          size: metadata.size,
        });
      }
    }
  }

  await visit("");
  return entries;
}

export async function resolveWorkspaceBackupLogicalLimit(root: string) {
  const filesystem = await statfs(root, { bigint: true });
  const capacity = filesystem.blocks * filesystem.bsize;
  if (capacity <= 0n || capacity > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkspaceBackupPreparationError(
      "WORKSPACE_BACKUP_CAPACITY_INVALID",
      "Workspace volume capacity is unavailable.",
      500,
    );
  }
  return Number(capacity);
}

export function isExcludedWorkspaceBackupPath(
  relativePath: string,
  directory: boolean,
) {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized === ".kestrel/runner" ||
    normalized.startsWith(".kestrel/runner/") ||
    normalized === ".kestrel/backup-imports" ||
    normalized.startsWith(".kestrel/backup-imports/") ||
    normalized === ".git/worktrees" ||
    normalized.startsWith(".git/worktrees/")
  ) {
    return true;
  }
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return true;
  }
  return !directory && (normalized.endsWith(".log") || normalized.endsWith(".tmp"));
}

function writeEntry(
  pack: ReturnType<typeof tar.pack>,
  header: Parameters<typeof pack.entry>[0],
) {
  return new Promise<void>((resolve, reject) => {
    pack.entry(header, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeFileEntry(
  pack: ReturnType<typeof tar.pack>,
  root: string,
  entry: PreparedEntry,
) {
  const output = pack.entry({
    name: entry.relativePath.replaceAll("\\", "/"),
    type: "file",
    mode: entry.mode,
    size: entry.size,
  });
  const hash = createHash("sha256");
  const verifier = new PassThrough();
  verifier.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(
    createReadStream(path.join(root, entry.relativePath)),
    verifier,
    output,
  );
  if (`sha256:${hash.digest("hex")}` !== entry.contentDigest) {
    throw new WorkspaceBackupPreparationError(
      "WORKSPACE_CHANGED_DURING_BACKUP",
      "Workspace changed while its prepared backup was exported.",
      409,
    );
  }
}

function publicPreparation(
  preparation: StoredPreparation,
): WorkspaceBackupPreparation {
  return {
    version: preparation.version,
    preparationId: preparation.preparationId,
    sourceRevision: preparation.sourceRevision,
    logicalBytes: preparation.logicalBytes,
    entryCount: preparation.entryCount,
    expiresAt: preparation.expiresAt,
  };
}

function digestText(value: string) {
  return digestBuffer(Buffer.from(value, "utf8"));
}

function digestBuffer(value: Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function digestFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Workspace backup failed.");
}
