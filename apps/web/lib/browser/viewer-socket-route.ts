import type WebSocket from "ws";
import {
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  type HostedBrowserViewerClientMessageV1,
  type HostedBrowserViewerServerMessageV1,
} from "../../../../src/browser/hostedViewerProtocol.js";
import {
  HostedBrowserViewerOutcomeUnknownError,
  type HostedBrowserViewerConnection,
} from "./viewer-service";

const DEFAULT_FRAME_INTERVAL_MS = 750;

type ViewerSocket = Pick<WebSocket, "close" | "on" | "readyState" | "send">;
type TimerHandle = ReturnType<typeof setTimeout>;
type ConnectOutcome =
  | { kind: "connected"; connection: HostedBrowserViewerConnection }
  | { kind: "outcome_unknown"; error: HostedBrowserViewerOutcomeUnknownError }
  | { kind: "failed"; error: unknown };

export interface HostedBrowserViewerSocketController {
  close(code: number, reason: string): Promise<void>;
  whenClosed(): Promise<void>;
}

export function attachHostedBrowserViewerSocket(input: {
  socket: ViewerSocket;
  parseMessage(data: WebSocket.RawData): HostedBrowserViewerClientMessageV1;
  connect(ticket: string): Promise<HostedBrowserViewerConnection>;
  frameIntervalMs?: number | undefined;
  timers?: {
    setInterval(handler: () => void, delay: number): TimerHandle;
    clearInterval(handle: TimerHandle): void;
    setTimeout(handler: () => void, delay: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
  } | undefined;
}): HostedBrowserViewerSocketController {
  const timers = input.timers ?? {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  let connection: HostedBrowserViewerConnection | undefined;
  let pendingConnect: Promise<ConnectOutcome> | undefined;
  let cleanupRetry: (() => Promise<boolean>) | undefined;
  let frameTimer: TimerHandle | undefined;
  let authorityTimer: TimerHandle | undefined;
  let closeIntent: { code: number; reason: string } | undefined;
  let closeSettlement: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const clearTimers = () => {
    if (frameTimer) timers.clearInterval(frameTimer);
    if (authorityTimer) timers.clearTimeout(authorityTimer);
    frameTimer = undefined;
    authorityTimer = undefined;
  };

  const settleClose = async (waitForQueuedWork: Promise<void> | undefined) => {
    if (waitForQueuedWork) await waitForQueuedWork;

    const connectAttempt = pendingConnect;
    pendingConnect = undefined;
    const active = connection;
    connection = undefined;
    const retry = cleanupRetry;
    cleanupRetry = undefined;

    const connectOutcome = connectAttempt ? await connectAttempt : undefined;
    const lateConnection = connectOutcome?.kind === "connected"
      ? connectOutcome.connection
      : undefined;
    const lateRetry = connectOutcome?.kind === "outcome_unknown"
      ? connectOutcome.error.retryCleanup
      : undefined;

    if (active) await active.disconnect().catch(() => {});
    if (lateConnection && lateConnection !== active) {
      await lateConnection.disconnect().catch(() => {});
    }
    if (retry) await retry().catch(() => false);
    if (lateRetry && lateRetry !== retry) await lateRetry().catch(() => false);

    const intent = closeIntent;
    if (intent && (input.socket.readyState === 1 || input.socket.readyState === 0)) {
      try {
        input.socket.close(intent.code, intent.reason);
      } catch {
        // The exact viewer cleanup above is authoritative. Socket close is best effort.
      }
    }
  };

  const close = (code: number, reason: string, waitForQueuedWork = true) => {
    if (!closeIntent) {
      closeIntent = { code, reason };
      clearTimers();
    }
    if (!closeSettlement) {
      const queuedWork = waitForQueuedWork ? tail : undefined;
      closeSettlement = Promise.resolve().then(() => settleClose(queuedWork));
    }
    return closeSettlement;
  };

  const sendBestEffort = (message: HostedBrowserViewerServerMessageV1) => {
    if (input.socket.readyState !== 1) return false;
    try {
      input.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const sendOrClose = async (message: HostedBrowserViewerServerMessageV1) => {
    let sent = false;
    try {
      sent = sendBestEffort(message);
      return sent;
    } finally {
      if (!sent) await close(1011, "viewer transport failed", false);
    }
  };

  const fail = async (error: unknown, reason: string) => {
    if (error instanceof HostedBrowserViewerOutcomeUnknownError) {
      cleanupRetry = error.retryCleanup;
    }
    try {
      sendBestEffort({
        version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
        type: "error",
        code: error instanceof HostedBrowserViewerOutcomeUnknownError
          ? error.code
          : "BROWSER_SESSION_LOST",
      });
    } finally {
      // An external close already owns settlement and waits for this queued task.
      if (!closeIntent) await close(1008, reason, false);
    }
  };

  const scheduleConnectionExpiry = () => {
    if (closeIntent || !connection) return;
    if (authorityTimer) timers.clearTimeout(authorityTimer);
    const ticketExpiry = Date.parse(connection.claims.expiresAt);
    const leaseExpiry = connection.state.inputLeaseExpiresAt
      ? Date.parse(connection.state.inputLeaseExpiresAt)
      : Number.POSITIVE_INFINITY;
    const delay = Math.max(1, Math.min(ticketExpiry, leaseExpiry) - Date.now());
    authorityTimer = timers.setTimeout(
      () => void close(1008, "viewer authority expired"),
      delay,
    );
  };

  const enqueue = (work: () => Promise<void>) => {
    tail = tail.then(work).catch(() => {});
  };

  const startFrames = () => {
    if (closeIntent || frameTimer) return;
    frameTimer = timers.setInterval(() => {
      enqueue(async () => {
        if (!connection || closeIntent) return;
        try {
          const sent = await sendOrClose(await connection.frame());
          if (!sent) return;
        } catch (error) {
          await fail(error, "viewer authority unavailable");
        }
      });
    }, input.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS);
  };

  input.socket.on("message", (data) => {
    enqueue(async () => {
      if (closeIntent) return;
      try {
        const message = input.parseMessage(data);
        if (!connection) {
          if (message.type !== "authenticate") throw new Error("BROWSER_SESSION_LOST");
          const attempt = Promise.resolve()
            .then(() => input.connect(message.ticket))
            .then<ConnectOutcome, ConnectOutcome>(
              (connected) => ({ kind: "connected", connection: connected }),
              (error: unknown) => error instanceof HostedBrowserViewerOutcomeUnknownError
                ? { kind: "outcome_unknown", error }
                : { kind: "failed", error },
            );
          // Publish the attempt before awaiting or dispatching its first async effect.
          pendingConnect = attempt;
          const outcome = await attempt;
          if (closeIntent) return;
          pendingConnect = undefined;
          if (outcome.kind === "outcome_unknown") {
            await fail(outcome.error, "viewer authorization failed");
            return;
          }
          if (outcome.kind === "failed") throw outcome.error;
          connection = outcome.connection;
          const sent = await sendOrClose({
            version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
            type: "state",
            state: connection.state,
          });
          if (!(sent && !closeIntent)) return;
          scheduleConnectionExpiry();
          startFrames();
          return;
        }

        const response = await connection.dispatch(message);
        if (closeIntent) return;
        const sent = await sendOrClose(response);
        if (!(sent && !closeIntent)) return;
        if (response.type === "closed") {
          await close(1000, "browser session closed", false);
          return;
        }
        scheduleConnectionExpiry();
      } catch (error) {
        await fail(error, "viewer authorization failed");
      }
    });
  });
  input.socket.on("close", () => void close(1000, "viewer disconnected"));
  input.socket.on("error", () => void close(1011, "viewer transport failed"));

  return {
    close: (code, reason) => close(code, reason),
    whenClosed: () => closeSettlement ?? Promise.resolve(),
  };
}
