import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";
import type { RuntimeTurnInput } from "../runtime/RuntimeTurn.js";

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
          data: normalizedBase64(attachment.data ?? ""),
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
    if (attachment.threadId !== undefined && attachment.threadId !== turn.sessionId) {
      throw runtimeAttachmentError("Attachment does not belong to this Thread.");
    }
    if (attachment.kind === "image" && !attachment.mimeType.startsWith("image/")) {
      throw runtimeAttachmentError("Image attachment has an invalid MIME type.");
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
  }
  return attachments;
}

function attachmentBytes(attachment: RunTurnAttachment): Buffer {
  return attachment.kind === "text"
    ? Buffer.from(attachment.text ?? "", "utf8")
    : Buffer.from(normalizedBase64(attachment.data ?? ""), "base64");
}

function normalizedBase64(value: string): string {
  const marker = value.indexOf(",");
  return value.startsWith("data:") && marker >= 0 ? value.slice(marker + 1) : value;
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : "";
}

function runtimeAttachmentError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "RUNTIME_ATTACHMENT_UNSUPPORTED" });
}
