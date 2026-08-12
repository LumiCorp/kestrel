import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import type { RuntimeTurnInput } from "../runtime/RuntimeTurn.js";

const MAX_RUNTIME_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/yaml",
]);
const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export async function prepareCodexInput(turn: RuntimeTurnInput): Promise<{
  input: CodexUserInput[];
  cleanup(): Promise<void>;
}> {
  const attachments = validateAttachments(turn);
  const temporaryRoot = attachments.some((attachment) => attachment.kind === "image")
    ? path.join(os.tmpdir(), `kestrel-codex-${randomUUID()}`)
    : undefined;
  if (temporaryRoot !== undefined) await mkdir(temporaryRoot, { recursive: true });
  const input: CodexUserInput[] = [
    {
      type: "text",
      text: initialPrompt(turn),
      text_elements: [],
    },
  ];
  for (const attachment of attachments) {
    if (attachment.kind === "text") {
      input.push({
        type: "text",
        text: `\n\n[Attachment: ${attachment.filename}]\n${attachment.text ?? ""}`,
        text_elements: [],
      });
      continue;
    }
    const extension = safeExtension(attachment.filename);
    const filePath = path.join(
      temporaryRoot!,
      `${createHash("sha256").update(attachment.attachmentId).digest("hex")}${extension}`,
    );
    await writeFile(filePath, attachmentBytes(attachment), { mode: 0o600 });
    input.push({ type: "localImage", path: filePath });
  }
  return {
    input,
    cleanup: async () => {
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}

export function claudePrompt(turn: RuntimeTurnInput): string | AsyncIterable<SDKUserMessage> {
  const attachments = validateAttachments(turn);
  if (attachments.length === 0) return initialPrompt(turn);
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: initialPrompt(turn) },
  ];
  for (const attachment of attachments) {
    if (attachment.kind === "text") {
      content.push({
        type: "text",
        text: `\n\n[Attachment: ${attachment.filename}]\n${attachment.text ?? ""}`,
      });
    } else {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: normalizedBase64(attachment.data ?? "", attachment.mimeType),
        },
      });
    }
  }
  const message = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
  return (async function* () {
    yield message;
  })();
}

export function initialPrompt(turn: RuntimeTurnInput): string {
  if (!turn.history?.length) return turn.message;
  const history = turn.history
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
    .join("\n\n");
  return [
    "Continue this Kestrel Thread from its canonical history.",
    history,
    `USER: ${turn.message}`,
  ].join("\n\n");
}

export function validateAttachments(turn: RuntimeTurnInput): RunTurnAttachment[] {
  const attachments = turn.attachments ?? [];
  for (const attachment of attachments) {
    if (
      attachment.filename.trim().length === 0 ||
      path.basename(attachment.filename) !== attachment.filename ||
      attachment.sizeBytes <= 0 ||
      attachment.sizeBytes > MAX_RUNTIME_ATTACHMENT_BYTES ||
      !/^[a-f0-9]{64}$/u.test(attachment.sha256)
    ) {
      throw runtimeAttachmentError("Attachment declaration is invalid.");
    }
    if (attachment.threadId !== undefined && attachment.threadId !== turn.sessionId) {
      throw runtimeAttachmentError("Attachment does not belong to this Thread.");
    }
    if (
      attachment.kind === "image" &&
      !IMAGE_MEDIA_TYPES.has(attachment.mimeType)
    ) {
      throw runtimeAttachmentError("Image attachment has an unsupported MIME type.");
    }
    if (
      attachment.kind === "text" &&
      !TEXT_MEDIA_TYPES.has(attachment.mimeType)
    ) {
      throw runtimeAttachmentError("Text attachment has an unsupported MIME type.");
    }
    if (attachment.kind === "text" && typeof attachment.text !== "string") {
      throw runtimeAttachmentError("Text attachment payload is missing.");
    }
    if (attachment.kind === "image" && typeof attachment.data !== "string") {
      throw runtimeAttachmentError("Image attachment payload is missing.");
    }
    const bytes = attachmentBytes(attachment);
    if (bytes.byteLength !== attachment.sizeBytes) {
      throw runtimeAttachmentError("Attachment size does not match its declaration.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== attachment.sha256.toLowerCase()) {
      throw runtimeAttachmentError("Attachment digest does not match its declaration.");
    }
    if (attachment.kind === "text") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw runtimeAttachmentError("Text attachment is not valid UTF-8.");
      }
    } else if (detectImageMime(bytes) !== attachment.mimeType) {
      throw runtimeAttachmentError(
        "Image attachment MIME type does not match its payload.",
      );
    }
  }
  return attachments;
}

function attachmentBytes(attachment: RunTurnAttachment): Buffer {
  if (attachment.kind === "text") {
    return Buffer.from(attachment.text ?? "", "utf8");
  }
  const encoded = normalizedBase64(attachment.data ?? "", attachment.mimeType);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw runtimeAttachmentError("Image attachment is not canonical base64.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw runtimeAttachmentError("Image attachment is not canonical base64.");
  }
  return bytes;
}

function normalizedBase64(value: string, mimeType?: string): string {
  const marker = value.indexOf(",");
  if (!value.startsWith("data:")) return value;
  const expectedPrefix = `data:${mimeType};base64,`;
  if (mimeType === undefined || !value.startsWith(expectedPrefix) || marker < 0) {
    throw runtimeAttachmentError("Image data URI does not match its MIME type.");
  }
  return value.slice(marker + 1);
}

function detectImageMime(data: Buffer): string | undefined {
  if (
    data.byteLength >= 24 &&
    data.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ) &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(20) > 0
  ) {
    return "image/png";
  }
  if (
    data.byteLength >= 10 &&
    ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")) &&
    data.readUInt16LE(6) > 0 &&
    data.readUInt16LE(8) > 0
  ) {
    return "image/gif";
  }
  if (jpegHasDimensions(data)) return "image/jpeg";
  if (webpHasDimensions(data)) return "image/webp";
  return;
}

function jpegHasDimensions(data: Buffer): boolean {
  if (data.byteLength < 11 || data[0] !== 0xff || data[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 8 < data.byteLength) {
    if (data[offset] !== 0xff) return false;
    const marker = data[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.byteLength) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.byteLength) return false;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
    ) {
      return length >= 7 && data.readUInt16BE(offset + 3) > 0 && data.readUInt16BE(offset + 5) > 0;
    }
    offset += length;
  }
  return false;
}

function webpHasDimensions(data: Buffer): boolean {
  if (
    data.byteLength < 30 ||
    data.subarray(0, 4).toString("ascii") !== "RIFF" ||
    data.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return false;
  }
  const kind = data.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") {
    const width = 1 + data.readUIntLE(24, 3);
    const height = 1 + data.readUIntLE(27, 3);
    return width > 0 && height > 0;
  }
  if (kind === "VP8 " && data.byteLength >= 30) {
    return data.readUInt16LE(26) > 0 && data.readUInt16LE(28) > 0;
  }
  if (kind === "VP8L" && data.byteLength >= 25 && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return (bits & 0x3fff) + 1 > 0 && ((bits >>> 14) & 0x3fff) + 1 > 0;
  }
  return false;
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : "";
}

function runtimeAttachmentError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "RUNTIME_ATTACHMENT_UNSUPPORTED" });
}
