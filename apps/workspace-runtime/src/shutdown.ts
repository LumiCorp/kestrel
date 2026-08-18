export const WORKSPACE_FATAL_SHUTDOWN_TIMEOUT_MS = 10_000;
export const WORKSPACE_NORMAL_SHUTDOWN_TIMEOUT_MS = 115_000;

export type WorkspaceShutdownMode = "normal" | "fatal";

interface ShutdownServer {
  close(callback: () => void): void;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

interface ShutdownSocket {
  destroy(): void;
}

export function createWorkspaceShutdownCoordinator(input: {
  server: ShutdownServer;
  sockets: ReadonlySet<ShutdownSocket>;
  enterDraining: () => void;
  clearIdleTimer: () => void;
  closeTerminals: () => void;
  stopServices: ReadonlyArray<() => Promise<unknown>>;
  exit: (code: number) => void;
  normalTimeoutMs?: number | undefined;
  fatalTimeoutMs?: number | undefined;
}) {
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (
    code: number,
    mode: WorkspaceShutdownMode,
  ): Promise<void> => {
    shutdownPromise ??= (async () => {
      input.enterDraining();
      input.clearIdleTimer();
      input.closeTerminals();

      const serverClosed = new Promise<void>((resolve) => {
        try {
          input.server.close(resolve);
        } catch {
          resolve();
        }
        input.server.closeIdleConnections();
      });
      const servicesStopped = Promise.allSettled(
        input.stopServices.map((stop) => Promise.resolve().then(stop)),
      );
      const settled = Promise.all([serverClosed, servicesStopped]);
      const timeoutMs = mode === "fatal"
        ? (input.fatalTimeoutMs ?? WORKSPACE_FATAL_SHUTDOWN_TIMEOUT_MS)
        : (input.normalTimeoutMs ?? WORKSPACE_NORMAL_SHUTDOWN_TIMEOUT_MS);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        settled.then(() => "settled" as const),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);

      if (outcome === "deadline") {
        for (const socket of input.sockets) socket.destroy();
        input.server.closeAllConnections();
      }
      input.exit(code);
    })();
    return shutdownPromise;
  };

  return { shutdown };
}
