export interface WaitForAsyncValueOptions {
  description: string;
  timeoutMs: number;
  intervalMs?: number | undefined;
}

export async function waitForAsyncValue<T>(
  sample: () => Promise<T>,
  accepts: (value: T) => boolean,
  options: WaitForAsyncValueOptions,
): Promise<T> {
  const intervalMs = options.intervalMs ?? 50;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Async value timeout must be a positive finite number.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error("Async value polling interval must be a non-negative finite number.");
  }

  const deadline = Date.now() + options.timeoutMs;
  while (true) {
    const remainingBeforeSampleMs = deadline - Date.now();
    if (remainingBeforeSampleMs <= 0) {
      throw new Error(`Timed out waiting for ${options.description}.`);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      sample(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${options.description}.`));
        }, remainingBeforeSampleMs);
      }),
    ]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
    if (accepts(value)) {
      return value;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for ${options.description}.`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, remainingMs));
    });
  }
}
