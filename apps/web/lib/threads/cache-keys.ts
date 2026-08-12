export function isThreadListCacheKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith("/api/threads?");
}
