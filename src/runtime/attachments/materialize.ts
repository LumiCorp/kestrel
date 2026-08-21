import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertPublicResolvedAddresses,
  normalizeMcpResolutionHostname,
} from "../../../packages/mcp-security/src/index.js";
import sharp from "sharp";
import type { RunTurnAttachment } from "../../kestrel/contracts/orchestration.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_TURN_BYTES = 500 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 1024 * 1024;

export async function materializeRunTurnAttachments(
  attachments: RunTurnAttachment[] | undefined,
): Promise<RunTurnAttachment[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length === 0) return [];
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error("A turn can include at most 20 attachments.");
  }
  if (new Set(attachments.map((attachment) => attachment.fileId ?? attachment.attachmentId)).size !== attachments.length) {
    throw new Error("File IDs must be unique.");
  }
  if (attachments.some((attachment) => attachment.sizeBytes > MAX_FILE_BYTES)) {
    throw new Error("Each attachment must be at most 100 MiB.");
  }
  if (attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) > MAX_TURN_BYTES) {
    throw new Error("Attachments must total at most 500 MiB per turn.");
  }
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-turn-attachments-"));
  const resolved: RunTurnAttachment[] = [];
  try {
    for (const attachment of attachments) {
      const fileId = attachment.fileId ?? attachment.attachmentId;
      const filename = sanitizeFilename(attachment.filename);
      const target = path.join(root, `${sanitizeFilename(fileId)}-${filename}`);
      if (attachment.path !== undefined) {
        await copyFile(attachment.path, target);
      } else if (attachment.sourceUrl !== undefined) {
        if (
          attachment.sourceUrlExpiresAt !== undefined
          && Date.parse(attachment.sourceUrlExpiresAt) <= Date.now()
        ) {
          throw new Error(`Attachment '${attachment.attachmentId}' source URL expired before materialization.`);
        }
        await downloadTrustedAttachmentSource(attachment.sourceUrl, target, fileId);
      } else if (attachment.data !== undefined) {
        const bytes = Buffer.from(attachment.data, "base64");
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Attachment exceeds the 100 MiB limit.");
        await pipeline(Readable.from(bytes), createWriteStream(target, { mode: 0o600, flags: "wx" }));
      } else if (attachment.kind === "text" && attachment.text !== undefined) {
        await pipeline(
          Readable.from(Buffer.from(attachment.text, "utf8")),
          createWriteStream(target, { mode: 0o600, flags: "wx" }),
        );
      } else {
        throw new Error(`Attachment '${attachment.attachmentId}' has no materializable source.`);
      }
      await verifyFile(target, attachment.sha256, attachment.sizeBytes);
      await chmod(target, 0o400);
      const hydrated = await hydrateModelRepresentation(attachment, target);
      resolved.push({
        ...hydrated,
        fileId,
        path: target,
        ...(attachment.kind === "file" ? { data: undefined } : {}),
        sourceUrl: undefined,
        sourceUrlExpiresAt: undefined,
      });
    }
    await chmod(root, 0o500);
    return resolved;
  } catch (error) {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupMaterializedRunTurnAttachments(
  attachments: RunTurnAttachment[] | undefined,
): Promise<void> {
  const roots = new Set((attachments ?? []).flatMap((attachment) => {
    if (!attachment.path) return [];
    const root = path.dirname(attachment.path);
    return path.basename(root).startsWith("kestrel-turn-attachments-") ? [root] : [];
  }));
  await Promise.all([...roots].map(async (root) => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }));
}

async function hydrateModelRepresentation(
  attachment: RunTurnAttachment,
  target: string,
): Promise<RunTurnAttachment> {
  if (attachment.kind === "image") {
    try {
      const derivative = await sharp(target, { animated: false })
        .rotate()
        .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
        .toBuffer();
      if (derivative.byteLength <= MAX_INLINE_IMAGE_BYTES) {
        return { ...attachment, data: derivative.toString("base64") };
      }
    } catch {
      return {
        ...attachment,
        kind: "file",
        representationStatus: "metadata_only",
        metadataOnlyReason: "The image could not be decoded safely; the original is staged read-only for tools.",
      };
    }
  }
  if (attachment.kind === "text" && attachment.text === undefined) {
    const bytes = await readFile(target);
    const visible = bytes.subarray(0, MAX_EXTRACTED_TEXT_BYTES);
    try {
      return {
        ...attachment,
        text: new TextDecoder("utf-8", { fatal: true }).decode(visible),
        ...(bytes.byteLength > visible.byteLength ? { textTruncated: true } : {}),
      };
    } catch {
      return {
        ...attachment,
        kind: "file",
        representationStatus: "metadata_only",
        metadataOnlyReason: "The file was not valid UTF-8; the original is staged read-only for tools.",
      };
    }
  }
  return attachment;
}

async function verifyFile(filePath: string, expectedSha256: string, expectedSizeBytes: number) {
  const info = await stat(filePath);
  if (info.size !== expectedSizeBytes) throw new Error("Attachment size failed integrity validation.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== expectedSha256) throw new Error("Attachment hash failed integrity validation.");
  return { sizeBytes: info.size };
}

function sanitizeFilename(value: string): string {
  const filename = value.trim().split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (!filename || filename === "." || filename === "..") return `attachment-${randomUUID()}`;
  return filename.slice(0, 180);
}

async function downloadTrustedAttachmentSource(
  value: string,
  target: string,
  attachmentId: string,
): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Attachment source URL must use credential-free HTTPS.");
  }
  const hostname = normalizeMcpResolutionHostname(url.hostname);
  const addresses: Array<{ address: string; family: 4 | 6 }> = [];
  for (const entry of await lookup(hostname, { all: true, verbatim: true })) {
    if (entry.family === 4 || entry.family === 6) {
      addresses.push({ address: entry.address, family: entry.family });
    }
  }
  assertPublicResolvedAddresses(addresses);
  const pinned = addresses[0];
  if (pinned === undefined) throw new Error("Attachment source hostname did not resolve.");
  await new Promise<void>((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      timeout: 30_000,
    }, (response) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.resume();
        reject(new Error(`Attachment '${attachmentId}' could not be downloaded for execution.`));
        return;
      }
      pipeline(
        response,
        new ByteLimitTransform(MAX_FILE_BYTES),
        createWriteStream(target, { mode: 0o600, flags: "wx" }),
      ).then(resolve, reject);
    });
    outgoing.once("timeout", () => outgoing.destroy(new Error("Attachment download timed out.")));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

class ByteLimitTransform extends Transform {
  private seen = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.seen += bytes.byteLength;
    callback(this.seen > this.limit ? new Error("Attachment download exceeds the 100 MiB limit.") : null, bytes);
  }
}
