import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import { resolveLocalCorePaths } from "./home.js";

export const DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const DESKTOP_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DESKTOP_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DesktopAttachmentMetadata {
  attachmentId: string;
  threadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: "image" | "text";
  createdAt: string;
  submittedAt?: string | undefined;
}

interface AttachmentIndexV1 {
  version: "desktop-attachments-v1";
  attachments: DesktopAttachmentMetadata[];
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".ts", ".tsx", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc",
  ".cpp", ".cxx", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".html", ".css",
  ".scss", ".less", ".xml", ".toml", ".ini", ".cfg", ".conf", ".env", ".graphql", ".gql", ".vue", ".svelte",
]);

export class DesktopAttachmentStore {
  private readonly rootPath: string;
  private readonly blobPath: string;
  private readonly indexPath: string;
  private mutation = Promise.resolve();

  constructor(homePath: string) {
    this.rootPath = path.join(resolveLocalCorePaths(homePath).stateRootPath, "attachments");
    this.blobPath = path.join(this.rootPath, "blobs");
    this.indexPath = path.join(this.rootPath, "index.json");
  }

  async import(input: {
    threadId: string;
    filename: string;
    data: Buffer;
    mimeType?: string | undefined;
    sha256?: string | undefined;
    now?: Date | undefined;
  }): Promise<DesktopAttachmentMetadata> {
    return this.withMutation(async () => {
      const threadId = requireNonEmpty(input.threadId, "threadId");
      const filename = sanitizeFilename(input.filename);
      const validation = validateAttachment(filename, input.data, input.mimeType);
      const sha256 = createHash("sha256").update(input.data).digest("hex");
      if (input.sha256 !== undefined && input.sha256.toLowerCase() !== sha256) {
        throw new Error("Attachment hash does not match its contents.");
      }
      const index = await this.readIndex();
      const createdAt = (input.now ?? new Date()).toISOString();
      const metadata: DesktopAttachmentMetadata = {
        attachmentId: `attachment-${randomUUID()}`,
        threadId,
        filename,
        mimeType: validation.mimeType,
        sizeBytes: input.data.byteLength,
        sha256,
        kind: validation.kind,
        createdAt,
      };
      await mkdir(this.blobPath, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.blobPath, sha256), input.data, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await this.writeIndex({ ...index, attachments: [...index.attachments, metadata] });
      return metadata;
    });
  }

  async list(threadId: string): Promise<DesktopAttachmentMetadata[]> {
    const normalized = requireNonEmpty(threadId, "threadId");
    return (await this.readIndex()).attachments
      .filter((entry) => entry.threadId === normalized)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async remove(threadId: string, attachmentId: string): Promise<boolean> {
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const found = index.attachments.find((entry) => entry.attachmentId === attachmentId && entry.threadId === threadId);
      if (found === undefined) return false;
      if (found.submittedAt !== undefined) throw new Error("Submitted attachments cannot be removed.");
      const attachments = index.attachments.filter((entry) => entry !== found);
      await this.writeIndex({ ...index, attachments });
      if (attachments.every((entry) => entry.sha256 !== found.sha256)) {
        await rm(path.join(this.blobPath, found.sha256), { force: true });
      }
      return true;
    });
  }

  async resolve(threadId: string, attachmentIds: string[]): Promise<RunTurnAttachment[]> {
    if (attachmentIds.length > DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`A message can include at most ${DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("Attachment IDs must be unique.");
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const entries = attachmentIds.map((attachmentId) => {
        const entry = index.attachments.find((candidate) => candidate.attachmentId === attachmentId);
        if (entry === undefined || entry.threadId !== threadId) {
          throw new Error(`Attachment '${attachmentId}' is unavailable for this thread.`);
        }
        return entry;
      });
      const total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      if (total > DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the per-message total size limit.");
      const resolved = await Promise.all(entries.map(async (entry) => {
        const bytes = await readFile(path.join(this.blobPath, entry.sha256));
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (actualHash !== entry.sha256 || bytes.byteLength !== entry.sizeBytes) {
          throw new Error(`Attachment '${entry.attachmentId}' failed integrity validation.`);
        }
        return {
          attachmentId: entry.attachmentId,
          threadId: entry.threadId,
          filename: entry.filename,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256,
          kind: entry.kind,
          createdAt: entry.createdAt,
          ...(entry.kind === "image"
            ? { data: bytes.toString("base64") }
            : { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }),
        } satisfies RunTurnAttachment;
      }));
      const submittedAt = new Date().toISOString();
      const selected = new Set(attachmentIds);
      await this.writeIndex({
        ...index,
        attachments: index.attachments.map((entry) => selected.has(entry.attachmentId) && entry.threadId === threadId
          ? { ...entry, submittedAt: entry.submittedAt ?? submittedAt }
          : entry),
      });
      return resolved;
    });
  }

  async cleanup(now = new Date()): Promise<number> {
    return this.withMutation(async () => {
      const index = await this.readIndex();
      const cutoff = now.getTime() - DESKTOP_DRAFT_ATTACHMENT_RETENTION_MS;
      const removed = index.attachments.filter((entry) => entry.submittedAt === undefined && Date.parse(entry.createdAt) < cutoff);
      if (removed.length === 0) return 0;
      const attachments = index.attachments.filter((entry) => removed.includes(entry) === false);
      await this.writeIndex({ ...index, attachments });
      const retainedHashes = new Set(attachments.map((entry) => entry.sha256));
      await Promise.all([...new Set(removed.map((entry) => entry.sha256))]
        .filter((sha256) => retainedHashes.has(sha256) === false)
        .map(async (sha256) => await rm(path.join(this.blobPath, sha256), { force: true })));
      return removed.length;
    });
  }

  private async readIndex(): Promise<AttachmentIndexV1> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Desktop attachment index is invalid.");
      const record = parsed as Record<string, unknown>;
      if (record.version !== "desktop-attachments-v1" || Array.isArray(record.attachments) === false) {
        throw new Error("Desktop attachment index version is invalid.");
      }
      return {
        version: "desktop-attachments-v1",
        attachments: record.attachments.map(parseAttachmentMetadata),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: "desktop-attachments-v1", attachments: [] };
      throw error;
    }
  }

  private async writeIndex(index: AttachmentIndexV1): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.indexPath);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function parseAttachmentMetadata(value: unknown): DesktopAttachmentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Desktop attachment metadata is invalid.");
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "image" && kind !== "text") throw new Error("Desktop attachment kind is invalid.");
  const sizeBytes = record.sizeBytes;
  if (typeof sizeBytes !== "number" || Number.isSafeInteger(sizeBytes) === false || sizeBytes < 0) throw new Error("Desktop attachment size is invalid.");
  const sha256 = requireNonEmpty(String(record.sha256 ?? ""), "sha256").toLowerCase();
  if (/^[a-f0-9]{64}$/u.test(sha256) === false) throw new Error("Desktop attachment hash is invalid.");
  const createdAt = requireNonEmpty(String(record.createdAt ?? ""), "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Desktop attachment creation time is invalid.");
  const submittedAt = typeof record.submittedAt === "string" ? record.submittedAt : undefined;
  if (submittedAt !== undefined && Number.isNaN(Date.parse(submittedAt))) throw new Error("Desktop attachment submission time is invalid.");
  return {
    attachmentId: requireNonEmpty(String(record.attachmentId ?? ""), "attachmentId"),
    threadId: requireNonEmpty(String(record.threadId ?? ""), "threadId"),
    filename: sanitizeFilename(String(record.filename ?? "")),
    mimeType: requireNonEmpty(String(record.mimeType ?? ""), "mimeType"),
    sizeBytes,
    sha256,
    kind,
    createdAt,
    ...(submittedAt !== undefined ? { submittedAt } : {}),
  };
}

function validateAttachment(filename: string, data: Buffer, claimedMime?: string): { kind: "image" | "text"; mimeType: string } {
  const imageMime = detectImageMime(data);
  if (imageMime !== undefined) {
    if (data.byteLength > DESKTOP_MAX_IMAGE_BYTES) throw new Error("Image attachment exceeds the 10 MiB limit.");
    if (claimedMime !== undefined && claimedMime !== "application/octet-stream" && claimedMime !== imageMime) {
      throw new Error("Attachment MIME type does not match its contents.");
    }
    return { kind: "image", mimeType: imageMime };
  }
  const extension = path.extname(filename).toLowerCase();
  const normalizedMime = claimedMime?.split(";", 1)[0]?.trim().toLowerCase();
  const textMime = normalizedMime?.startsWith("text/") === true
    || normalizedMime === "application/json" || normalizedMime === "application/yaml" || normalizedMime === "application/x-yaml";
  if (TEXT_EXTENSIONS.has(extension) === false && textMime === false) throw new Error("Attachment type is unsupported.");
  if (data.byteLength > DESKTOP_MAX_TEXT_BYTES) throw new Error("Text attachment exceeds the 2 MiB limit.");
  if (data.includes(0)) throw new Error("Text attachments cannot contain NUL bytes.");
  try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error("Text attachment must be valid UTF-8."); }
  return { kind: "text", mimeType: normalizedMime && normalizedMime !== "application/octet-stream" ? normalizedMime : "text/plain" };
}

function detectImageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const header = data.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return;
}

function sanitizeFilename(value: string): string {
  const filename = path.basename(requireNonEmpty(value, "filename"));
  if (filename === "." || filename === "..") throw new Error("Attachment filename is invalid.");
  return filename.slice(0, 240);
}
function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Attachment ${field} must be a non-empty string.`);
  return value.trim();
}
