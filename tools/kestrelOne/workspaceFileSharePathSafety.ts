export interface PortableZipEntryName {
  entryName: string;
  collisionKey: string;
}

/**
 * Validates the archive name against the path rules shared by common POSIX,
 * Windows, and macOS extractors. The returned key is comparison-only: the ZIP
 * keeps the original safe Unicode spelling.
 */
export function inspectPortableZipEntryName(
  entryName: string,
): PortableZipEntryName | { reason: string } {
  if (entryName.length === 0 || entryName.startsWith("/")) {
    return { reason: "ZIP entries must be non-empty relative paths." };
  }
  if (entryName.includes("\\")) {
    return { reason: "ZIP entry names cannot contain Windows path separators." };
  }
  if (/^[A-Za-z]:/u.test(entryName)) {
    return { reason: "ZIP entry names cannot be Windows drive-qualified paths." };
  }

  const segments = entryName.split("/");
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
  )) {
    return { reason: "ZIP entry names cannot contain empty or traversal path segments." };
  }

  const collisionSegments: string[] = [];
  for (const segment of segments) {
    const compatibilityName = segment.normalize("NFKC");
    const unsafeReason =
      portableWindowsSegmentFailure(segment) ??
      portableWindowsSegmentFailure(compatibilityName);
    if (unsafeReason !== undefined) return { reason: unsafeReason };
    collisionSegments.push(
      compatibilityName.toUpperCase().toLowerCase().normalize("NFC"),
    );
  }

  return { entryName, collisionKey: collisionSegments.join("/") };
}

function portableWindowsSegmentFailure(segment: string): string | undefined {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    return "A ZIP entry path segment has an ambiguous portable form.";
  }
  if (/[\u0000-\u001f\u007f<>:"|?*]/u.test(segment)) {
    return "A ZIP entry path segment contains characters unsafe on Windows.";
  }
  if (/[ .]$/u.test(segment)) {
    return "ZIP entry path segments cannot end in a space or period.";
  }
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment)) {
    return "A ZIP entry path segment is a reserved Windows device name.";
  }
  return undefined;
}
