import type WebSocket from "ws";
import {
  HOSTED_BROWSER_VIEWER_AUTHENTICATE_TIMEOUT_MS,
  HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  serializeHostedBrowserViewerServerMessage,
  type HostedBrowserViewerClientMessageV1,
  type HostedBrowserViewerServerMessageV1,
} from "../../../../src/browser/hostedViewerProtocol.js";
import {
  HostedBrowserViewerOutcomeUnknownError,
  type HostedBrowserViewerConnection,
} from "./viewer-service";

const DEFAULT_FRAME_INTERVAL_MS = 750;
const DEFAULT_AUTHORITY_REVALIDATION_INTERVAL_MS = 2000;

type ViewerSocket = Pick<WebSocket, "bufferedAmount" | "close" | "on" | "readyState" | "send">;
type TimerHandle = ReturnType<typeof setTimeout>;
type ConnectOutcome =
  | { kind: "connected"; connection: HostedBrowserViewerConnection }
  | { kind: "outcome_unknown"; error: HostedBrowserViewerOutcomeUnknownError }
  | { kind: "failed"; error: unknown };
type AuthenticatedViewerMessage = Exclude<
  HostedBrowserViewerClientMessageV1,
  { type: "authenticate" }
>;

const MAX_PENDING_VIEWER_QUEUE = 64;

export interface HostedBrowserViewerSocketController {
  close(code: number, reason: string): Promise<void>;
  whenClosed(): Promise<void>;
}

export function attachHostedBrowserViewerSocket(input: {
  socket: ViewerSocket;
  parseMessage(data: WebSocket.RawData): HostedBrowserViewerClientMessageV1;
  connect(ticket: string): Promise<HostedBrowserViewerConnection>;
  frameIntervalMs?: number | undefined;
  authorityRevalidationIntervalMs?: number | undefined;
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
  let authenticateTimer: TimerHandle | undefined;
  let authorityTimer: TimerHandle | undefined;
  let authorityPollTimer: TimerHandle | undefined;
  let closeIntent: { code: number; reason: string } | undefined;
  let closeSettlement: Promise<void> | undefined;
  let frameInFlight = false;
  let authorityRevalidationInFlight = false;
  let pendingState: Extract<HostedBrowserViewerServerMessageV1, { type: "state" }> | undefined;
  let pendingFrame: HostedBrowserViewerServerMessageV1 | undefined;
  let drainingMessages = false;
  let drainPromise: Promise<void> | undefined;
  const controlQueue: AuthenticatedViewerMessage[] = [];
  const inputQueue: Array<Extract<AuthenticatedViewerMessage, { type: "input" }>> = [];

  const clearTimers = () => {
    if (frameTimer) timers.clearInterval(frameTimer);
    if (authenticateTimer) timers.clearTimeout(authenticateTimer);
    if (authorityTimer) timers.clearTimeout(authorityTimer);
    if (authorityPollTimer) timers.clearInterval(authorityPollTimer);
    frameTimer = undefined;
    authenticateTimer = undefined;
    authorityTimer = undefined;
    authorityPollTimer = undefined;
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
  };

  const close = (code: number, reason: string, waitForQueuedWork = true) => {
    if (!closeIntent) {
      closeIntent = { code, reason };
      clearTimers();
      if (input.socket.readyState === 1 || input.socket.readyState === 0) {
        try {
          input.socket.close(code, reason);
        } catch {
          // Exact viewer cleanup remains owned by the independent settlement.
        }
      }
    }
    if (!closeSettlement) {
      const queuedWork = waitForQueuedWork ? drainPromise : undefined;
      closeSettlement = Promise.resolve().then(() => settleClose(queuedWork));
    }
    return closeSettlement;
  };

  const sendBestEffort = (message: HostedBrowserViewerServerMessageV1) => {
    if (input.socket.readyState !== 1) return false;
    try {
      input.socket.send(serializeHostedBrowserViewerServerMessage(message));
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

  const frameUnavailable = (error: unknown) =>
    error instanceof Error &&
    error.message === HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE;

  const flushPendingState = () => {
    if (
      !pendingState ||
      closeIntent ||
      input.socket.readyState !== 1 ||
      input.socket.bufferedAmount !== 0
    ) return;
    const state = pendingState;
    pendingState = undefined;
    if (!sendBestEffort(state)) {
      void close(1011, "viewer transport failed", false);
    }
  };

  const flushPendingFrame = () => {
    const hadPendingState = pendingState !== undefined;
    flushPendingState();
    if (hadPendingState) return;
    if (
      !pendingFrame ||
      closeIntent ||
      drainingMessages ||
      controlQueue.length > 0 ||
      inputQueue.length > 0 ||
      input.socket.readyState !== 1 ||
      input.socket.bufferedAmount !== 0
    ) return;
    const frame = pendingFrame;
    pendingFrame = undefined;
    if (!sendBestEffort(frame)) {
      void close(1011, "viewer transport failed", false);
    }
  };

  const captureFrame = () => {
    const hadPendingState = pendingState !== undefined;
    flushPendingState();
    if (hadPendingState) return;
    const hadPendingFrame = pendingFrame !== undefined;
    flushPendingFrame();
    if (hadPendingFrame) return;
    if (
      closeIntent ||
      !connection ||
      frameInFlight ||
      pendingFrame ||
      drainingMessages ||
      controlQueue.length > 0 ||
      inputQueue.length > 0 ||
      input.socket.bufferedAmount !== 0
    ) return;
    frameInFlight = true;
    const active = connection;
    void active.frame().then(
      (frame) => {
        frameInFlight = false;
        if (closeIntent || connection !== active) return;
        pendingFrame = frame;
        flushPendingFrame();
      },
      async (error: unknown) => {
        frameInFlight = false;
        if (closeIntent || frameUnavailable(error)) return;
        await fail(error, "viewer authority unavailable");
      },
    );
  };

  const startFrames = () => {
    if (closeIntent || frameTimer) return;
    frameTimer = timers.setInterval(
      captureFrame,
      input.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS,
    );
  };

  const startAuthorityRevalidation = () => {
    if (closeIntent || authorityPollTimer) return;
    authorityPollTimer = timers.setInterval(() => {
      void (async () => {
        if (!connection || closeIntent || authorityRevalidationInFlight) return;
        authorityRevalidationInFlight = true;
        try {
          await connection.revalidate();
        } catch (error) {
          await fail(error, "viewer authorization failed");
        } finally {
          authorityRevalidationInFlight = false;
        }
      })();
    }, input.authorityRevalidationIntervalMs ?? DEFAULT_AUTHORITY_REVALIDATION_INTERVAL_MS);
  };

  const processAuthenticatedMessage = async (message: AuthenticatedViewerMessage) => {
    if (!connection || closeIntent) return;
    try {
      const response = await connection.dispatch(message);
      if (closeIntent) return;
      let sent: boolean;
      if (
        response.type === "state" &&
        (pendingState !== undefined || input.socket.bufferedAmount !== 0)
      ) {
        pendingState = response;
        sent = true;
      } else {
        sent = await sendOrClose(response);
      }
      if (!(sent && !closeIntent)) return;
      if (response.type === "closed") {
        await close(1000, "browser session closed", false);
        return;
      }
      scheduleConnectionExpiry();
    } catch (error) {
      await fail(error, "viewer authorization failed");
    }
  };

  const drainMessages = () => {
    if (drainingMessages || closeIntent) return;
    drainingMessages = true;
    const running = (async () => {
      while (!closeIntent) {
        const message = controlQueue.shift() ?? inputQueue.shift();
        if (!message) return;
        await processAuthenticatedMessage(message);
      }
    })();
    drainPromise = running.finally(() => {
      drainingMessages = false;
      if (!closeIntent && (controlQueue.length > 0 || inputQueue.length > 0)) {
        drainMessages();
      } else {
        flushPendingFrame();
      }
    });
  };

  const enqueueAuthenticatedMessage = (message: AuthenticatedViewerMessage) => {
    if (message.type !== "input") {
      if (controlQueue.length >= MAX_PENDING_VIEWER_QUEUE) {
        void close(1008, "viewer control limit exceeded", false);
        return;
      }
      controlQueue.push(message);
      drainMessages();
      return;
    }
    const trailing = inputQueue.at(-1);
    if (
      message.input.kind === "pointer" &&
      message.input.phase === "move" &&
      trailing?.input.kind === "pointer" &&
      trailing.input.phase === "move"
    ) {
      inputQueue[inputQueue.length - 1] = message;
      return;
    }
    if (inputQueue.length >= MAX_PENDING_VIEWER_QUEUE) {
      void close(1008, "viewer input limit exceeded", false);
      return;
    }
    inputQueue.push(message);
    drainMessages();
  };

  const finishConnect = async (attempt: Promise<ConnectOutcome>) => {
    const outcome = await attempt;
    if (closeIntent) return;
    pendingConnect = undefined;
    if (outcome.kind === "outcome_unknown") {
      await fail(outcome.error, "viewer authorization failed");
      return;
    }
    if (outcome.kind === "failed") {
      await fail(outcome.error, "viewer authorization failed");
      return;
    }
    if (authenticateTimer) timers.clearTimeout(authenticateTimer);
    authenticateTimer = undefined;
    connection = outcome.connection;
    const sent = await sendOrClose({
      version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
      type: "state",
      state: connection.state,
    });
    if (!(sent && !closeIntent)) return;
    scheduleConnectionExpiry();
    startAuthorityRevalidation();
    startFrames();
  };

  input.socket.on("message", (data) => {
    if (closeIntent) return;
    let message: HostedBrowserViewerClientMessageV1;
    try {
      message = input.parseMessage(data);
    } catch {
      void close(1008, "viewer authorization failed", false);
      return;
    }
    if (!connection) {
      if (message.type !== "authenticate" || pendingConnect) {
        void close(1008, "viewer authorization failed", false);
        return;
      }
      const attempt = Promise.resolve()
        .then(() => input.connect(message.ticket))
        .then<ConnectOutcome, ConnectOutcome>(
          (connected) => ({ kind: "connected", connection: connected }),
          (error: unknown) => error instanceof HostedBrowserViewerOutcomeUnknownError
            ? { kind: "outcome_unknown", error }
            : { kind: "failed", error },
        );
      pendingConnect = attempt;
      void finishConnect(attempt);
      return;
    }
    if (message.type === "authenticate") {
      void close(1008, "viewer authorization failed", false);
      return;
    }
    enqueueAuthenticatedMessage(message);
  });
  authenticateTimer = timers.setTimeout(
    () => void close(1008, "viewer authentication timed out", false),
    HOSTED_BROWSER_VIEWER_AUTHENTICATE_TIMEOUT_MS,
  );
  input.socket.on("close", () => void close(1000, "viewer disconnected"));
  input.socket.on("error", () => void close(1011, "viewer transport failed"));

  return {
    close: (code, reason) => close(code, reason),
    whenClosed: () => closeSettlement ?? Promise.resolve(),
  };
}
