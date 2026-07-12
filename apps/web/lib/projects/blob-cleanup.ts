export async function cleanupProjectBlobKeys(
  storageKeys: string[],
  deleteObject: (storageKey: string) => Promise<void>
) {
  const uniqueKeys = [...new Set(storageKeys)];
  const results = await Promise.allSettled(
    uniqueKeys.map((storageKey) => deleteObject(storageKey))
  );
  return {
    attemptedCount: uniqueKeys.length,
    failedCount: results.filter((result) => result.status === "rejected")
      .length,
  };
}
