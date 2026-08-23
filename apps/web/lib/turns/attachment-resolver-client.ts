import {
  signTurnAttachmentResolutionTicket,
  type TurnAttachmentResolutionTicket,
} from "@lumi/kestrel-environment-auth";
import type { RunnerTurnAttachment } from "@kestrel-agents/protocol";

export type HostedAttachmentFailureCode =
  | "ATTACHMENT_ACCESS_UNAUTHORIZED"
  | "ATTACHMENT_SET_INVALID"
  | "ATTACHMENT_UNAVAILABLE"
  | "ATTACHMENT_BLOB_MISSING"
  | "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE";

export class HostedAttachmentResolutionError extends Error {
  readonly code: HostedAttachmentFailureCode;
  readonly retryable: boolean;
  readonly fileIds: string[];

  constructor(
    code: HostedAttachmentFailureCode,
    message = "Attachment resolution failed.",
    fileIds: string[] = [],
  ) {
    super(message);
    this.name = "HostedAttachmentResolutionError";
    this.code = code;
    this.retryable = code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE";
    this.fileIds = [...new Set(fileIds.filter((fileId) => fileId.length > 0))];
  }
}

export function attachmentParts(parts: unknown) {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
    const partRecord = part as Record<string, unknown>;
    if (
      partRecord.type !== "data-kestrel-attachment" &&
      partRecord.type !== "data-kestrel-file"
    ) {
      return [];
    }
    const data = partRecord.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
    const record = data as Record<string, unknown>;
    const fileId = typeof record.fileId === "string"
      ? record.fileId.trim()
      : typeof record.attachmentId === "string" ? record.attachmentId.trim() : "";
    if (!fileId) {
      throw new HostedAttachmentResolutionError("ATTACHMENT_SET_INVALID");
    }
    return [{
      fileId,
      filename: typeof record.filename === "string" ? record.filename : undefined,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : undefined,
      mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
    }];
  });
}

export async function resolveHostedTurnAttachments(input: {
  turnId: string;
  parts: unknown;
  appUrl?: string | undefined;
  privateKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<RunnerTurnAttachment[]> {
  const expected = attachmentParts(input.parts);
  if (expected.length === 0) return [];
  const now = Math.floor(Date.now() / 1000);
  const ticket: TurnAttachmentResolutionTicket = {
    version: 1,
    audience: "kestrel-turn-attachment-resolver",
    turnId: input.turnId,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: crypto.randomUUID(),
  };
  const token = signTurnAttachmentResolutionTicket({
    ticket,
    privateKey:
      input.privateKey ??
      process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ??
      "",
  });
  const baseUrl = input.appUrl ?? process.env.KESTREL_ONE_APP_URL?.trim();
  if (!baseUrl) {
    throw new HostedAttachmentResolutionError(
      "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
    );
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      new URL(
        `/internal/turn-worker/${encodeURIComponent(input.turnId)}/attachments/resolve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "cache-control": "no-store",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new HostedAttachmentResolutionError(
      "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
    );
  }
  const body = await response.json().catch(() => null) as {
    attachments?: RunnerTurnAttachment[];
    error?: { code?: unknown; fileId?: unknown };
  } | null;
  if (!response.ok) {
    const code = body?.error?.code;
    const fileIds = typeof body?.error?.fileId === "string"
      ? [body.error.fileId]
      : [];
    if (
      code === "ATTACHMENT_ACCESS_UNAUTHORIZED" ||
      code === "ATTACHMENT_SET_INVALID" ||
      code === "ATTACHMENT_UNAVAILABLE" ||
      code === "ATTACHMENT_BLOB_MISSING" ||
      code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE"
    ) {
      throw new HostedAttachmentResolutionError(code, undefined, fileIds);
    }
    throw new HostedAttachmentResolutionError(
      "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE",
    );
  }
  const attachments = body?.attachments;
  if (!Array.isArray(attachments) || attachments.length !== expected.length) {
    throw new HostedAttachmentResolutionError(
      "ATTACHMENT_SET_INVALID",
      undefined,
      expected.map((attachment) => attachment.fileId),
    );
  }
  const seen = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    const source = expected[index];
    if (
      !attachment ||
      typeof attachment.fileId !== "string" ||
      attachment.fileId !== source.fileId ||
      seen.has(attachment.fileId) ||
      typeof attachment.sourceUrl !== "string" ||
      typeof attachment.sourceUrlExpiresAt !== "string" ||
      typeof attachment.sha256 !== "string" ||
      typeof attachment.sizeBytes !== "number" ||
      typeof attachment.mimeType !== "string" ||
      (source.filename !== undefined && attachment.filename !== source.filename) ||
      (source.sizeBytes !== undefined && attachment.sizeBytes !== source.sizeBytes) ||
      (source.mediaType !== undefined && attachment.mimeType !== source.mediaType)
    ) {
      throw new HostedAttachmentResolutionError(
        "ATTACHMENT_SET_INVALID",
        undefined,
        [source.fileId],
      );
    }
    seen.add(attachment.fileId);
  }
  return attachments;
}
