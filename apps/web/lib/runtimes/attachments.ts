import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";

import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";
import type { UIMessage } from "ai";
import { readUpload } from "@/lib/files/storage";
import { assertUploadPathOwnedByUserAndThread } from "@/lib/files/upload-path";
import { normalizeMediaType } from "@/lib/knowledge/documents/shared";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/yaml",
]);

export async function hydrateRuntimeAttachments(input: {
  message: UIMessage | undefined;
  threadId: string;
  userId: string;
}): Promise<RunnerTurnAttachment[]> {
  const fileParts = (input.message?.parts ?? []).filter(
    (part) => part.type === "file",
  );
  return await Promise.all(
    fileParts.map(async (part) => {
      if (!part.url.startsWith("/api/files/")) {
        throw attachmentError("Runtime attachments must reference an internal upload.");
      }
      let pathname: string[];
      try {
        pathname = part.url
          .slice("/api/files/".length)
          .split("/")
          .filter(Boolean)
          .map((segment) => decodeURIComponent(segment));
        assertUploadPathOwnedByUserAndThread(
          pathname,
          input.userId,
          input.threadId,
        );
      } catch {
        throw attachmentError("Runtime attachment ownership is invalid.");
      }
      const stored = await readUpload(pathname).catch(() => {
        throw attachmentError("Runtime attachment payload is missing.");
      });
      if (stored.size === 0 || stored.size > MAX_FILE_BYTES) {
        throw attachmentError("Runtime attachment payload size is invalid.");
      }
      const partName = "name" in part && typeof part.name === "string" ? part.name : undefined;
      const filename = partName?.trim() || pathname.at(-1) || "attachment";
      const mimeType = normalizeMediaType(part.mediaType, filename);
      const sha256 = createHash("sha256").update(stored.buffer).digest("hex");
      const common = {
        attachmentId: createHash("sha256").update(pathname.join("/")).digest("hex"),
        threadId: input.threadId,
        filename,
        mimeType,
        sizeBytes: stored.size,
        sha256,
      };
      if (mimeType.startsWith("image/")) {
        const metadata = await sharp(stored.buffer).metadata().catch(() => null);
        if (!(metadata?.width && metadata.height)) {
          throw attachmentError("Runtime image attachment is invalid.");
        }
        const detectedMime = imageMimeType(metadata.format);
        if (detectedMime !== mimeType) {
          throw attachmentError("Runtime image MIME type does not match its payload.");
        }
        return {
          ...common,
          kind: "image" as const,
          data: stored.buffer.toString("base64"),
        };
      }
      if (!TEXT_MEDIA_TYPES.has(mimeType)) {
        throw attachmentError(`Runtime attachment type '${mimeType}' is unsupported.`);
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(stored.buffer);
      } catch {
        throw attachmentError("Runtime text attachment is not valid UTF-8.");
      }
      return { ...common, kind: "text" as const, text };
    }),
  );
}

function imageMimeType(format: string | undefined): string | undefined {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "gif") return "image/gif";
  if (format === "webp") return "image/webp";
  return;
}

function attachmentError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: "RUNTIME_ATTACHMENT_UNSUPPORTED",
  });
}
