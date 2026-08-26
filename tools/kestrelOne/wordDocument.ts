import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { parseObjectInput } from "../helpers.js";
import {
  closeRetainedWorkspacePreview,
  publishRetainedWorkspacePreview,
} from "./workspacePreviews.js";
import {
  buildWorkspaceFileShareServerSource,
} from "./workspaceFileShareServerSource.js";
import {
  parseServerReady,
  requirePreviewBaseUrl,
  shellQuote,
} from "./workspaceFileShare.js";

const TOOL_NAME = "kestrel_one.word_document_create";
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export const kestrelOneWordDocumentCreateTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description:
      "Create a real downloadable Microsoft Word .docx file from the supplied title and plain-text content. Use this when the user explicitly requests a Word document or download link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 255 },
        content: { type: "string", minLength: 1, maxLength: MAX_CONTENT_BYTES },
        fileName: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "runtime",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      allowedInteractionModes: ["build"],
      capabilityClasses: ["workspace.preview", "network.call"],
      approvalCapabilities: ["network.call"],
    },
    presentation: {
      displayName: "Create Word Document",
      aliases: ["create Word document", "export DOCX", "download Word file"],
      keywords: ["word", "docx", "document", "download", "export"],
      provider: "kestrel-one",
      toolFamily: "document-export",
    },
  },
  createHandler: (context) => async (input) => createWordDocument(context, input),
  normalizeResult(output) {
    const value = output as Record<string, unknown>;
    return {
      output,
      presentation: {
        artifacts: [
          {
            id: `word-document:${String(value.previewId)}`,
            title: String(value.downloadName),
            kind: "file-share",
            url: String(value.url),
            mediaType: DOCX_MEDIA_TYPE,
            metadata: {
              expiresAt: value.expiresAt,
              sizeBytes: value.sizeBytes,
            },
          },
        ],
      },
    };
  },
};

async function createWordDocument(
  context: SharedToolContext,
  rawInput: unknown,
) {
  const input = parseObjectInput(TOOL_NAME, rawInput);
  const title = requireText(input.title, "title", 255);
  const content = requireText(input.content, "content", MAX_CONTENT_BYTES);
  const downloadName = safeFileName(
    typeof input.fileName === "string" ? input.fileName : `${title}.docx`,
  );
  const tempRoot = context.fileSystem?.tempRoots[0];
  const service = context.devShellService;
  const workspaceRoot = context.fileSystem?.workspaceRoot;
  if (!tempRoot || !service || !workspaceRoot) {
    throw createRuntimeFailure(
      "WORD_DOCUMENT_EXPORT_UNAVAILABLE",
      "Word document export is unavailable in this runtime.",
      { subsystem: "tooling", classification: "policy", recoverable: true },
    );
  }

  const stagePath = await mkdtemp(path.join(tempRoot, "kestrel-word-document-"));
  const payloadPath = path.join(stagePath, "payload");
  const docx = await buildWordDocumentBytes(title, content);
  let started;
  try {
    await writeFile(payloadPath, docx, { flag: "wx" });
    const stat = await lstat(payloadPath);
    started = await service.startProcess({
    workspaceRoot,
    cwd: workspaceRoot,
    command: `node --input-type=module --eval ${shellQuote(buildWorkspaceFileShareServerSource())} ${shellQuote(Buffer.from(JSON.stringify({
      stagePath,
      payloadPath,
      downloadName,
      mediaType: DOCX_MEDIA_TYPE,
      expectedSizeBytes: docx.byteLength,
      expectedSha256: createHash("sha256").update(docx).digest("hex"),
      stageDevice: String(stat.dev),
      stageInode: String(stat.ino),
    }), "utf8").toString("base64url"))}`,
    requiredTools: ["node"],
    envMode: "allowlist",
    sourceWriteAuthority: "source_readonly",
    yieldTimeMs: 1_500,
    maxOutputBytes: 16_384,
    });
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  let port = parseServerReady(started.text);
  if (port === undefined && started.status === "RUNNING" && started.processId) {
    try {
      const read = await service.readProcess({
        processId: started.processId,
        cursor: started.nextCursor,
        waitMs: 5_000,
        maxBytes: 16_384,
      });
      port = parseServerReady(read.text);
    } catch {
      await service.stopProcess({ processId: started.processId, signal: "SIGTERM", waitMs: 2_000 }).catch(() => undefined);
    }
  }
  if (!started.processId || port === undefined) {
    if (started.processId) await service.stopProcess({ processId: started.processId, signal: "SIGTERM", waitMs: 2_000 }).catch(() => undefined);
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    throw createRuntimeFailure(
      "WORD_DOCUMENT_EXPORT_SERVER_FAILED",
      "The Word document download server did not start.",
      { subsystem: "tooling", classification: "dependency", recoverable: true },
    );
  }
  let previewId: string | undefined;
  try {
    const published = await publishRetainedWorkspacePreview(context, {
      port,
      sessionId: started.processId,
      name: `Download: ${downloadName}`,
      approvalToolName: "workspace.preview.publish",
    });
    const preview = (published as { preview?: { id?: string; url?: string; expiresAt?: string } }).preview;
    if (!preview?.id || !preview.url || !preview.expiresAt) throw new Error("Invalid preview publication result.");
    previewId = preview.id;
    const baseUrl = requirePreviewBaseUrl(preview as { url: string }, context.kestrelOne?.appUrl);
    return {
      previewId,
      url: `${baseUrl.replace(/\/+$/u, "")}/${encodeURIComponent(downloadName)}`,
      downloadName,
      mediaType: DOCX_MEDIA_TYPE,
      sizeBytes: docx.byteLength,
      expiresAt: preview.expiresAt,
    };
  } catch (error) {
    if (previewId) await closeRetainedWorkspacePreview({ ...context, signal: undefined }, previewId).catch(() => undefined);
    await service.stopProcess({ processId: started.processId, signal: "SIGTERM", waitMs: 2_000 }).catch(() => undefined);
    throw error;
  }
}

export async function buildWordDocumentBytes(title: string, content: string): Promise<Buffer> {
  const files: Array<[string, string]> = [];
  files.push(["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`]);
  files.push(["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`]);
  const paragraphs = [title, ...content.split(/\r?\n/u).filter((line) => line.length > 0)];
  const body = paragraphs.map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("");
  files.push(["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`]);
  return createStoredZip(files);
}

function createStoredZip(files: Array<[string, string]>): Buffer {
  const entries: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    entries.push(local, data);
    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    nameBytes.copy(record, 46);
    central.push(record);
    offset += local.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralBytes, end]);
}

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function requireText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw createRuntimeFailure("TOOL_INPUT_SCHEMA_FAILED", `Word document ${name} is invalid.`, { subsystem: "tooling", classification: "schema", recoverable: true });
  }
  return value.trim();
}

function safeFileName(value: string): string {
  const name = value.trim().replace(/[\\/\u0000-\u001f\u007f]/gu, "_");
  if (!name.toLowerCase().endsWith(".docx")) return `${name}.docx`;
  return name;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;");
}
