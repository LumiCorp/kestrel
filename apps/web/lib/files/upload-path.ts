import path from "node:path";

function sanitizeSegment(segment: string) {
  return segment.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function getUploadOwnerSegment(userId: string) {
  return sanitizeSegment(userId);
}

export function assertUploadPathOwnedByUser(
  pathname: string[],
  userId: string
) {
  const ownerSegment = pathname[0];

  if (!ownerSegment || ownerSegment !== getUploadOwnerSegment(userId)) {
    throw new Error("Forbidden");
  }
}

export function buildUploadPath(parts: {
  userId: string;
  threadId: string;
  filename: string;
}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const extension = path.extname(parts.filename);
  const basename = path.basename(parts.filename, extension) || "file";

  return [
    getUploadOwnerSegment(parts.userId),
    sanitizeSegment(parts.threadId),
    `${sanitizeSegment(basename)}-${suffix}${extension}`,
  ];
}
