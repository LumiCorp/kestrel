export function isAllowedEmbeddedPreviewUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1");
  } catch {
    return false;
  }
}
