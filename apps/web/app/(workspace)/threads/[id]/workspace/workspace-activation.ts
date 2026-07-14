export type EnvironmentActivation = {
  stage: string;
  detail: string;
  status: "pending" | "ready" | "failed";
};

export async function waitForWorkspaceActivation(input: {
  initial: EnvironmentActivation;
  read: () => Promise<EnvironmentActivation>;
  onProgress: (activation: EnvironmentActivation) => void;
  sleep: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<EnvironmentActivation | null> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? 90_000);
  let current = input.initial;
  input.onProgress(current);

  while (current.status === "pending") {
    if (input.signal?.aborted) return null;
    if (now() >= deadline) {
      throw new Error("Environment activation timed out.");
    }
    await input.sleep(input.pollIntervalMs ?? 500);
    if (input.signal?.aborted) return null;
    current = await input.read();
    input.onProgress(current);
  }

  if (current.status === "failed") throw new Error(current.detail);
  return current;
}
