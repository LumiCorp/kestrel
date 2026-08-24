import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { createRuntimeFailure, RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { DevProcessStartResult } from "../../src/devshell/contracts.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import {
  resolveExistingFileSystemPath,
  resolveFileSystemPolicy,
} from "../filesystem/shared.js";
import {
  closeRetainedWorkspacePreview,
  publishRetainedWorkspacePreview,
  withCleanupEvidence,
} from "./workspacePreviews.js";
import { buildWorkspaceFileShareServerSource } from "./workspaceFileShareServerSource.js";

const TOOL_NAME = "workspace.files.share";
const STAGING_PREFIX = "kestrel-file-share-";
const MAX_FILE_COUNT = 20;
const MAX_PAYLOAD_BYTES = 500 * 1024 * 1024;
const SERVER_READY_PREFIX = "KESTREL_FILE_SHARE_READY ";
const FILE_SHARE_WARNING =
  "Anyone with this link can download the file until the preview closes or expires.";

type ShareMode = "file" | "zip";

interface ShareInput {
  mode: ShareMode;
  paths: string[];
  downloadName: string | undefined;
  ttlMinutes: number | undefined;
}

interface OpenSource {
  handle: FileHandle;
  entryName: string;
  stat: Stats;
}

interface ShareOutput {
  share: {
    previewId: string;
    url: string;
    downloadName: string;
    mediaType: string;
    sizeBytes: number;
    fileCount: number;
    expiresAt: string;
  };
  warning: string;
}

export const workspaceFilesShareTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description:
      "Share selected regular files from the active Workspace through one temporary Kestrel Edge download link. Use mode 'file' for exactly one file or mode 'zip' for one to 20 files. The tool snapshots the selected bytes, serves only that payload, and returns a Download card. Anyone with the link can download it until the existing preview is closed or expires; use workspace.preview.list, workspace.preview.renew, or workspace.preview.close for lifecycle management.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["file", "zip"],
          description: "Explicitly share one file or package the selected files as one ZIP.",
        },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FILE_COUNT,
          items: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative path to one existing regular file.",
          },
          description: "Exact Workspace-relative files to publish. Directories and links are rejected.",
        },
        downloadName: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Optional safe filename shown to the downloader. It must not contain a path.",
        },
        ttlMinutes: {
          type: "integer",
          minimum: 1,
          maximum: 240,
          description: "Preview lifetime in minutes. Defaults to the existing 60-minute preview lifetime.",
        },
      },
      required: ["mode", "paths"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "live",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      allowedInteractionModes: ["build"],
      capabilityClasses: ["workspace.preview", "workspace.read", "network.call"],
      approvalCapabilities: ["network.call"],
    },
    presentation: {
      displayName: "Share Workspace Files",
      aliases: ["share file", "download file", "share zip", "download link"],
      keywords: ["workspace", "file", "zip", "download", "preview"],
      provider: "kestrel-one",
      toolFamily: "workspace-preview",
    },
  },
  createHandler: (context) => async (input) => shareWorkspaceFiles(context, input),
  normalizeResult(value) {
    const output = requireShareOutput(value);
    return {
      output,
      presentation: {
        artifacts: [
          {
            id: `file-share:${output.share.previewId}`,
            title: output.share.downloadName,
            kind: "file-share",
            url: output.share.url,
            mediaType: output.share.mediaType,
            metadata: {
              previewId: output.share.previewId,
              sizeBytes: output.share.sizeBytes,
              fileCount: output.share.fileCount,
              expiresAt: output.share.expiresAt,
              warning: output.warning,
            },
          },
        ],
      },
    };
  },
};

async function shareWorkspaceFiles(
  context: SharedToolContext,
  rawInput: unknown,
): Promise<ShareOutput> {
  const input = parseShareInput(rawInput);
  const policy = resolveFileSystemPolicy(context.fileSystem);
  const configuredWorkspaceRoot = path.resolve(policy.workspaceRoot);
  const workspaceRoot = await realpath(configuredWorkspaceRoot).catch(() => {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_PATH_INVALID",
      "The active Workspace root is unavailable.",
      { stage: "path_validation" },
    );
  });
  const tempRoot = policy.tempRoots[0];
  if (tempRoot === undefined) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "Workspace file sharing has no allowed runtime temporary root.",
      { stage: "staging" },
    );
  }
  await mkdir(tempRoot, { recursive: true });
  await cleanExpiredStaging(tempRoot).catch((error) => {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_CLEANUP_PENDING",
      "Expired Workspace file-share staging could not be removed.",
      { stage: "cleanup", reason: errorMessage(error) },
    );
  });

  const sources = await openShareSources(
    input.paths,
    configuredWorkspaceRoot,
    workspaceRoot,
    context,
  );
  const fileCount = sources.length;
  let stagePath: string | undefined;
  let processId: string | undefined;
  let createdPreviewId: string | undefined;
  try {
    const downloadName = resolveDownloadName(input, sources);
    const mediaType = input.mode === "zip"
      ? "application/zip"
      : "application/octet-stream";
    stagePath = await mkdtemp(path.join(tempRoot, STAGING_PREFIX));
    const payloadPath = path.join(stagePath, "payload");
    const serverPath = path.join(stagePath, "server.mjs");
    const sizeBytes = input.mode === "file"
      ? await copySinglePayload(sources[0]!, payloadPath, context.signal)
      : await writeZipPayload(sources, payloadPath, context.signal);
    await Promise.all(sources.map((source) => source.handle.close()));
    sources.length = 0;
    await writeFile(serverPath, buildWorkspaceFileShareServerSource(), {
      encoding: "utf8",
      mode: 0o500,
      flag: "wx",
    });
    await writeStageMetadata(stagePath, { expiresAt: null });

    const started = await startDownloadProcess(context, {
      stagePath,
      payloadPath,
      serverPath,
      downloadName,
      mediaType,
    });
    processId = started.processId;
    const published = await publishRetainedWorkspacePreview(context, {
      port: started.port,
      sessionId: started.processId,
      ...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes }),
      name: previewName(downloadName),
      approvalToolName: TOOL_NAME,
    });
    const preview = requirePublishedPreview(published);
    createdPreviewId = preview.id;
    const baseUrl = requirePreviewBaseUrl(preview);
    const url = `${baseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(downloadName)}`;
    await writeStageMetadata(stagePath, { expiresAt: preview.expiresAt });
    return {
      share: {
        previewId: preview.id,
        url,
        downloadName,
        mediaType,
        sizeBytes,
        fileCount,
        expiresAt: preview.expiresAt,
      },
      warning: FILE_SHARE_WARNING,
    };
  } catch (error) {
    const cleanupFailures: Array<{ operation: string; message: string }> = [];
    await Promise.all(sources.map((source) => source.handle.close().catch((closeError) => {
      cleanupFailures.push({ operation: "close_source", message: errorMessage(closeError) });
    })));
    let previewCloseCompleted = false;
    if (createdPreviewId !== undefined) {
      try {
        await closeRetainedWorkspacePreview(context, createdPreviewId);
        previewCloseCompleted = true;
      } catch (closeError) {
        cleanupFailures.push({ operation: "close_preview", message: errorMessage(closeError) });
      }
    }
    if (processId !== undefined && !previewCloseCompleted) {
      await context.devShellService?.stopProcess({
        processId,
        signal: "SIGTERM",
        waitMs: 2_000,
      }).catch((stopError) => {
        cleanupFailures.push({ operation: "stop_download_process", message: errorMessage(stopError) });
      });
    }
    if (stagePath !== undefined) {
      await rm(stagePath, { recursive: true, force: true }).catch((removeError) => {
        cleanupFailures.push({ operation: "remove_file_share_staging", message: errorMessage(removeError) });
      });
    }
    throw withCleanupEvidence(error, cleanupFailures);
  }
}

function parseShareInput(input: unknown): ShareInput {
  const body = parseObjectInput(TOOL_NAME, input);
  const mode = body.mode;
  if (mode !== "file" && mode !== "zip") {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "workspace.files.share requires explicit mode 'file' or 'zip'.",
      { subsystem: "tooling", classification: "schema", recoverable: true },
    );
  }
  if (!Array.isArray(body.paths) || body.paths.some((value) => typeof value !== "string")) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "workspace.files.share requires an array of Workspace-relative paths.",
      { subsystem: "tooling", classification: "schema", recoverable: true },
    );
  }
  const paths = body.paths.map((value) => String(value));
  if (paths.length === 0 || paths.length > MAX_FILE_COUNT) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
      `Workspace file sharing accepts between one and ${MAX_FILE_COUNT} files.`,
      { stage: "path_validation", fileCount: paths.length },
    );
  }
  if (mode === "file" && paths.length !== 1) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "workspace.files.share file mode requires exactly one path.",
      { subsystem: "tooling", classification: "schema", recoverable: true },
    );
  }
  const downloadName = body.downloadName;
  if (downloadName !== undefined && typeof downloadName !== "string") {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "workspace.files.share downloadName must be a string.",
      { subsystem: "tooling", classification: "schema", recoverable: true },
    );
  }
  const ttlMinutes = body.ttlMinutes;
  if (
    ttlMinutes !== undefined &&
    (!Number.isInteger(ttlMinutes) || Number(ttlMinutes) < 1 || Number(ttlMinutes) > 240)
  ) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "workspace.files.share ttlMinutes must be an integer from 1 through 240.",
      { subsystem: "tooling", classification: "schema", recoverable: true },
    );
  }
  return {
    mode,
    paths,
    downloadName: downloadName as string | undefined,
    ttlMinutes: ttlMinutes as number | undefined,
  };
}

async function openShareSources(
  inputPaths: string[],
  configuredWorkspaceRoot: string,
  workspaceRoot: string,
  context: SharedToolContext,
): Promise<OpenSource[]> {
  const sources: OpenSource[] = [];
  const canonicalPaths = new Set<string>();
  const openedFileIds = new Set<string>();
  const entryNames = new Set<string>();
  try {
    for (const inputPath of inputPaths) {
      if (!isWorkspaceRelativePath(inputPath)) {
        throw pathFailure(inputPath, "Selected paths must be non-empty Workspace-relative paths without traversal.");
      }
      const resolved = await resolveExistingFileSystemPath(inputPath, context.fileSystem)
        .catch((error) => {
          throw pathFailure(inputPath, errorMessage(error));
        });
      if (!isWithinWorkspace(resolved.realPath, workspaceRoot)) {
        throw pathFailure(inputPath, "The selected file resolves outside the active Workspace.");
      }
      await rejectSymlinkComponents(
        configuredWorkspaceRoot,
        resolved.absolutePath,
        inputPath,
      );
      if (resolved.lstat.isSymbolicLink() || !resolved.stat.isFile()) {
        throw pathFailure(inputPath, "The selected path must be a regular file and cannot be a link.");
      }
      if (canonicalPaths.has(resolved.realPath)) {
        throw pathFailure(inputPath, "The same source file was selected more than once.");
      }
      const entryName = normalizedEntryName(workspaceRoot, resolved.realPath);
      if (entryNames.has(entryName)) {
        throw pathFailure(inputPath, "Two selected files would create the same ZIP entry name.");
      }
      const handle = await open(
        resolved.absolutePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      ).catch((error) => {
        throw pathFailure(inputPath, errorMessage(error));
      });
      const descriptorStat = await handle.stat().catch(async (error) => {
        await handle.close().catch(() => undefined);
        throw pathFailure(inputPath, errorMessage(error));
      });
      if (
        !descriptorStat.isFile() ||
        descriptorStat.dev !== resolved.stat.dev ||
        descriptorStat.ino !== resolved.stat.ino
      ) {
        await handle.close();
        throw pathFailure(inputPath, "The selected file changed while Kestrel was opening it.");
      }
      const openedFileId = `${descriptorStat.dev}:${descriptorStat.ino}`;
      if (openedFileIds.has(openedFileId)) {
        await handle.close();
        throw pathFailure(inputPath, "The same source file was selected more than once.");
      }
      canonicalPaths.add(resolved.realPath);
      openedFileIds.add(openedFileId);
      entryNames.add(entryName);
      sources.push({
        handle,
        entryName,
        stat: descriptorStat,
      });
    }
    return sources;
  } catch (error) {
    await Promise.all(sources.map((source) => source.handle.close().catch(() => undefined)));
    throw error;
  }
}

function resolveDownloadName(input: ShareInput, sources: OpenSource[]): string {
  const candidate = input.downloadName?.trim() || (
    input.mode === "zip" ? "kestrel-files.zip" : path.basename(sources[0]!.entryName)
  );
  if (
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(candidate) ||
    Buffer.byteLength(candidate, "utf8") > 255
  ) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_PATH_INVALID",
      "downloadName must be one safe filename without path separators or control characters.",
      { stage: "path_validation" },
    );
  }
  return candidate;
}

async function copySinglePayload(
  source: OpenSource,
  payloadPath: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (source.stat.size > MAX_PAYLOAD_BYTES) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
      "The staged payload exceeds the 500 MiB file-share limit.",
      { stage: "staging", sizeBytes: source.stat.size },
    );
  }
  let output: FileHandle | undefined;
  let total = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    output = await open(payloadPath, "wx", 0o600);
    for (;;) {
      throwIfCancelled(signal);
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      if (total + bytesRead > MAX_PAYLOAD_BYTES) {
        throw fileShareFailure(
          "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
          "The staged payload exceeds the 500 MiB file-share limit.",
          { stage: "staging", sizeBytes: total + bytesRead },
        );
      }
      await output.write(buffer, 0, bytesRead, total);
      total += bytesRead;
    }
    await output.sync();
    await output.chmod(0o400);
    return total;
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_ARCHIVE_FAILED",
      "Kestrel could not create the immutable file payload.",
      { stage: "staging", reason: errorMessage(error) },
    );
  } finally {
    await output?.close();
  }
}

async function writeZipPayload(
  sources: OpenSource[],
  payloadPath: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const selectedBytes = sources.reduce((total, source) => total + source.stat.size, 0);
  if (selectedBytes > MAX_PAYLOAD_BYTES) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
      "The selected files exceed the 500 MiB file-share limit before ZIP overhead.",
      { stage: "archive", sizeBytes: selectedBytes },
    );
  }
  let output: FileHandle | undefined;
  try {
    output = await open(payloadPath, "wx", 0o600);
    const writer = new StreamingZipWriter(output, MAX_PAYLOAD_BYTES, signal);
    for (const source of sources) {
      await writer.add(source);
    }
    const size = await writer.finish();
    await output.sync();
    await output.chmod(0o400);
    return size;
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_ARCHIVE_FAILED",
      "Kestrel could not create the requested ZIP payload.",
      { stage: "archive", reason: errorMessage(error) },
    );
  } finally {
    await output?.close();
  }
}

class StreamingZipWriter {
  private offset = 0;
  private readonly entries: Array<{
    name: Buffer;
    crc32: number;
    size: number;
    localOffset: number;
    dosTime: number;
    dosDate: number;
  }> = [];

  constructor(
    private readonly output: FileHandle,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async add(source: OpenSource): Promise<void> {
    throwIfCancelled(this.signal);
    const name = Buffer.from(source.entryName, "utf8");
    if (name.length === 0 || name.length > 65_535) {
      throw fileShareFailure(
        "WORKSPACE_FILE_SHARE_PATH_INVALID",
        "A selected Workspace path is too long for a ZIP entry.",
        { stage: "archive" },
      );
    }
    const { dosTime, dosDate } = dosTimestamp(source.stat.mtime);
    const localOffset = this.offset;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0808, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt16LE(name.length, 26);
    await this.write(localHeader);
    await this.write(name);

    let crc32 = 0xffffffff;
    let size = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      throwIfCancelled(this.signal);
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      crc32 = updateCrc32(crc32, chunk);
      size += bytesRead;
      await this.write(chunk);
    }
    crc32 = (crc32 ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc32, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ name, crc32, size, localOffset, dosTime, dosDate });
  }

  async finish(): Promise<number> {
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.dosTime, 12);
      header.writeUInt16LE(entry.dosDate, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.localOffset, 42);
      await this.write(header);
      await this.write(entry.name);
    }
    const centralSize = this.offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await this.write(end);
    return this.offset;
  }

  private async write(buffer: Buffer): Promise<void> {
    if (this.offset + buffer.length > this.maxBytes) {
      throw fileShareFailure(
        "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED",
        "The staged payload exceeds the 500 MiB file-share limit.",
        { stage: "archive", sizeBytes: this.offset + buffer.length },
      );
    }
    let written = 0;
    while (written < buffer.length) {
      throwIfCancelled(this.signal);
      const result = await this.output.write(
        buffer,
        written,
        buffer.length - written,
        this.offset + written,
      );
      written += result.bytesWritten;
    }
    this.offset += buffer.length;
  }
}

async function startDownloadProcess(
  context: SharedToolContext,
  input: {
    stagePath: string;
    payloadPath: string;
    serverPath: string;
    downloadName: string;
    mediaType: string;
  },
): Promise<{ processId: string; port: number }> {
  const service = context.devShellService;
  const workspaceRoot = context.fileSystem?.workspaceRoot;
  if (service === undefined || !workspaceRoot) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "The managed Workspace process service is unavailable.",
      { stage: "server_start" },
    );
  }
  const config = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  let result: DevProcessStartResult;
  try {
    result = await service.startProcess({
      workspaceRoot,
      cwd: workspaceRoot,
      command: `node ${shellQuote(input.serverPath)} ${shellQuote(config)}`,
      requiredTools: ["node"],
      envMode: "allowlist",
      sourceWriteAuthority: "source_readonly",
      yieldTimeMs: 1_500,
      maxOutputBytes: 16_384,
    });
  } catch (error) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "Kestrel could not start the managed download process.",
      { stage: "server_start", reason: errorMessage(error) },
    );
  }
  if (!result.processId) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "The managed download process did not return a process ID.",
      {
        stage: "server_start",
        processStatus: result.status,
        ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      },
    );
  }
  let ready = parseServerReady(result.text);
  if (ready === undefined && result.status === "RUNNING") {
    try {
      const read = await service.readProcess({
        processId: result.processId,
        cursor: result.nextCursor,
        waitMs: 5_000,
        maxBytes: 16_384,
      });
      ready = parseServerReady(read.text);
    } catch (error) {
      const primary = fileShareFailure(
        "WORKSPACE_FILE_SHARE_SERVER_FAILED",
        "Kestrel could not confirm that the managed download process was listening.",
        {
          stage: "server_readiness",
          processId: result.processId,
          reason: errorMessage(error),
        },
      );
      const cleanupFailures: Array<{ operation: string; message: string }> = [];
      await service.stopProcess({
        processId: result.processId,
        signal: "SIGTERM",
        waitMs: 2_000,
      }).catch((stopError) => {
        cleanupFailures.push({
          operation: "stop_download_process",
          message: errorMessage(stopError),
        });
      });
      throw withCleanupEvidence(primary, cleanupFailures);
    }
  }
  if (ready === undefined) {
    const primary = fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "The managed download process did not report a listening port.",
      { stage: "server_readiness", processId: result.processId, processStatus: result.status },
    );
    const cleanupFailures: Array<{ operation: string; message: string }> = [];
    await service.stopProcess({
      processId: result.processId,
      signal: "SIGTERM",
      waitMs: 2_000,
    }).catch((error) => {
      cleanupFailures.push({ operation: "stop_download_process", message: errorMessage(error) });
    });
    throw withCleanupEvidence(primary, cleanupFailures);
  }
  return { processId: result.processId, port: ready };
}

function parseServerReady(text: string): number | undefined {
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith(SERVER_READY_PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(SERVER_READY_PREFIX.length)) as { port?: unknown };
      if (
        Number.isInteger(value.port) &&
        Number(value.port) >= 1024 &&
        Number(value.port) <= 65_535
      ) {
        return Number(value.port);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function writeStageMetadata(
  stagePath: string,
  metadata: { expiresAt: string | null },
): Promise<void> {
  const nextPath = path.join(stagePath, "metadata.next.json");
  const targetPath = path.join(stagePath, "metadata.json");
  await writeFile(nextPath, JSON.stringify({ version: 1, ...metadata }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(nextPath, targetPath);
}

async function cleanExpiredStaging(tempRoot: string): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) return [];
    const stagePath = path.join(tempRoot, entry.name);
    return [readExpiredStage(stagePath).then(async (expired) => {
      if (expired) await rm(stagePath, { recursive: true, force: true });
    })];
  }));
}

async function readExpiredStage(stagePath: string): Promise<boolean> {
  const stageStat = await lstat(stagePath).catch(() => undefined);
  if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) return false;
  const metadata = await readFile(path.join(stagePath, "metadata.json"), "utf8")
    .catch(() => undefined);
  if (!metadata) return false;
  try {
    const value = JSON.parse(metadata) as { version?: unknown; expiresAt?: unknown };
    return value.version === 1 &&
      typeof value.expiresAt === "string" &&
      Number.isFinite(new Date(value.expiresAt).getTime()) &&
      new Date(value.expiresAt).getTime() <= Date.now();
  } catch {
    return false;
  }
}

async function rejectSymlinkComponents(
  workspaceRoot: string,
  absolutePath: string,
  inputPath: string,
): Promise<void> {
  const relative = path.relative(workspaceRoot, absolutePath);
  let candidate = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    candidate = path.join(candidate, segment);
    const stat = await lstat(candidate).catch((error) => {
      throw pathFailure(inputPath, errorMessage(error));
    });
    if (stat.isSymbolicLink()) {
      throw pathFailure(inputPath, "Selected files cannot pass through symbolic links.");
    }
  }
}

function normalizedEntryName(workspaceRoot: string, realPathValue: string): string {
  return path.relative(workspaceRoot, realPathValue).split(path.sep).join("/");
}

function isWorkspaceRelativePath(value: string): boolean {
  if (value.trim().length === 0 || path.isAbsolute(value) || value.includes("\0")) return false;
  return !value.split(/[\\/]/u).some((segment) => segment === "..");
}

function isWithinWorkspace(candidate: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requirePublishedPreview(value: unknown): {
  id: string;
  url: string;
  expiresAt: string;
} {
  const preview = asRecord(asRecord(value)?.preview);
  if (
    typeof preview?.id !== "string" ||
    typeof preview.url !== "string" ||
    typeof preview.expiresAt !== "string"
  ) {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "The preview publication result did not include the file-share lease.",
      { stage: "publication_result" },
    );
  }
  return { id: preview.id, url: preview.url, expiresAt: preview.expiresAt };
}

function requirePreviewBaseUrl(preview: { url: string }): string {
  try {
    const parsed = new URL(preview.url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid preview URL");
    }
    return preview.url;
  } catch {
    throw fileShareFailure(
      "WORKSPACE_FILE_SHARE_SERVER_FAILED",
      "The preview publication result did not include a valid public URL.",
      { stage: "publication_result" },
    );
  }
}

function requireShareOutput(value: unknown): ShareOutput {
  const root = asRecord(value);
  const share = asRecord(root?.share);
  if (
    typeof share?.previewId !== "string" ||
    typeof share.url !== "string" ||
    typeof share.downloadName !== "string" ||
    typeof share.mediaType !== "string" ||
    typeof share.sizeBytes !== "number" ||
    typeof share.fileCount !== "number" ||
    typeof share.expiresAt !== "string" ||
    typeof root?.warning !== "string"
  ) {
    throw createRuntimeFailure(
      "TOOL_RESULT_NORMALIZATION_FAILED",
      "workspace.files.share returned an invalid result.",
      { subsystem: "tooling", toolName: TOOL_NAME, recoverable: false },
    );
  }
  return value as ShareOutput;
}

function previewName(downloadName: string): string {
  return `Download: ${[...downloadName].slice(0, 68).join("")}`;
}

function pathFailure(inputPath: string, reason: string): RuntimeFailure {
  return fileShareFailure(
    "WORKSPACE_FILE_SHARE_PATH_INVALID",
    `Workspace file '${inputPath}' cannot be shared: ${reason}`,
    { stage: "path_validation", path: inputPath },
  );
}

function fileShareFailure(
  code:
    | "WORKSPACE_FILE_SHARE_PATH_INVALID"
    | "WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED"
    | "WORKSPACE_FILE_SHARE_ARCHIVE_FAILED"
    | "WORKSPACE_FILE_SHARE_SERVER_FAILED"
    | "WORKSPACE_FILE_SHARE_CLEANUP_PENDING",
  message: string,
  details: Record<string, unknown>,
): RuntimeFailure {
  return createRuntimeFailure(code, message, {
    subsystem: "tooling",
    classification: code === "WORKSPACE_FILE_SHARE_PATH_INVALID" ? "schema" : "runtime",
    recoverable: true,
    toolName: TOOL_NAME,
    ...details,
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : createRuntimeFailure(
        "RUN_CANCELLED",
        "Workspace file sharing was cancelled.",
        { subsystem: "tooling", recoverable: true },
      );
}

function dosTimestamp(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    dosTime:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    dosDate:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

const CRC32_TABLE = createCrc32Table();

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(current: number, buffer: Buffer): number {
  let value = current >>> 0;
  for (const byte of buffer) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
