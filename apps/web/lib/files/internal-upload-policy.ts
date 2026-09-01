export type InternalExpectedUploadMediaType = "image/png";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isReservedHostedBrowserFileId(fileId: string): boolean {
  return /^file-browser-[0-9a-f]{64}$/u.test(fileId);
}

export function matchesExpectedUploadMediaType(
  header: Uint8Array,
  expectedMediaType: InternalExpectedUploadMediaType,
): boolean {
  if (expectedMediaType !== "image/png" || header.byteLength < PNG_SIGNATURE.length) {
    return false;
  }
  return PNG_SIGNATURE.every((byte, index) => header[index] === byte);
}
