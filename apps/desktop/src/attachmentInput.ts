import { createDesktopError } from "./errors.js";
import type { DesktopAttachmentImportInput } from "./contracts.js";

const DESKTOP_MAIN_THREAD_PREFIX = "thread-main:";

export function parseDesktopAttachmentThreadId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.startsWith(DESKTOP_MAIN_THREAD_PREFIX) === false
    || normalized.slice(DESKTOP_MAIN_THREAD_PREFIX.length).trim().length === 0
  ) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_thread",
      message: "Attachment thread ID must identify a Desktop session.",
    });
  }
  return normalized;
}

export function parseDesktopAttachmentImportInput(value: unknown): DesktopAttachmentImportInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: "Attachment import requires an object payload.",
    });
  }
  const input = value as Record<string, unknown>;
  const supported = new Set(["threadId", "filename", "mimeType", "data", "sha256"]);
  const unsupported = Object.keys(input).find((key) => supported.has(key) === false);
  if (unsupported !== undefined) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: `Attachment import includes unsupported field '${unsupported}'.`,
    });
  }
  const filename = requiredString(input.filename, "filename");
  const data = parseCanonicalBase64(input.data);
  const mimeType = optionalString(input.mimeType, "mimeType");
  const sha256 = parseSha256(input.sha256);
  return {
    threadId: parseDesktopAttachmentThreadId(input.threadId),
    filename,
    data,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
  };
}

function parseCanonicalBase64(value: unknown): string {
  const normalized = requiredString(value, "data").replace(/\s/gu, "");
  if (
    normalized.length % 4 !== 0
    || /^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) === false
    || Buffer.from(normalized, "base64").toString("base64") !== normalized
  ) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: "Attachment import data must be canonical base64.",
    });
  }
  return normalized;
}

function parseSha256(value: unknown): string | undefined {
  const normalized = optionalString(value, "sha256")?.toLowerCase();
  if (normalized !== undefined && /^[a-f0-9]{64}$/u.test(normalized) === false) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: "Attachment import sha256 must be a 64-character hexadecimal digest.",
    });
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value, field);
  if (normalized === undefined) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: `Attachment import ${field} must be a non-empty string.`,
    });
  }
  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createDesktopError({
      code: "desktop.invalid_attachment_input",
      message: `Attachment import ${field} must be a non-empty string when provided.`,
    });
  }
  return value.trim();
}
