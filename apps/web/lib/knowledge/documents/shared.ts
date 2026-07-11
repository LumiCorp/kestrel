import path from "node:path";

const STRUCTURED_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/yaml",
  "text/yaml",
  "application/x-yaml",
  "text/html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const IMAGE_MEDIA_PREFIX = "image/";

export function normalizeMediaType(
  mediaType: string | null | undefined,
  filename: string
) {
  const extension = path.extname(filename).toLowerCase();
  const normalized = mediaType?.trim().toLowerCase();

  if (normalized === "application/x-yaml" || normalized === "text/yaml") {
    return "application/yaml";
  }

  if (normalized) {
    return normalized;
  }

  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function isKnowledgeDocumentMediaTypeSupported(
  mediaType: string,
  filename: string
) {
  const normalized = normalizeMediaType(mediaType, filename);
  return (
    normalized.startsWith(IMAGE_MEDIA_PREFIX) ||
    STRUCTURED_MEDIA_TYPES.has(normalized)
  );
}

export function isInlineRenderableMediaType(mediaType: string) {
  const normalized = mediaType.trim().toLowerCase();
  return (
    normalized.startsWith("image/") ||
    normalized === "application/pdf" ||
    normalized === "text/plain" ||
    normalized === "text/markdown" ||
    normalized === "text/csv" ||
    normalized === "application/json" ||
    normalized === "application/yaml" ||
    normalized === "text/yaml" ||
    normalized === "application/x-yaml" ||
    normalized === "text/html"
  );
}

export function buildKnowledgeDocumentObjectKey(input: {
  organizationId: string;
  documentId: string;
  filename: string;
}) {
  const extension = path.extname(input.filename);
  const basename = path.basename(input.filename, extension) || "document";
  const safeName = basename.replace(/[^A-Za-z0-9._-]/g, "-");
  const safeExtension = extension.replace(/[^A-Za-z0-9.]/g, "");

  return [
    input.organizationId,
    input.documentId,
    `${safeName}${safeExtension}`,
  ];
}

export function stripMarkup(text: string) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function estimateTokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}
