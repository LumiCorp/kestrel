export async function mapWithConcurrencyLimit<T, TResult>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<TResult>
) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, items.length) }, () =>
      runWorker()
    )
  );

  return results;
}
