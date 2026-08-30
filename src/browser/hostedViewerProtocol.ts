import type {
  DesktopBrowserViewerFrameV1,
  DesktopBrowserViewerInputV1,
  DesktopBrowserViewerStateV1,
} from "../desktopShell/contracts.js";

export const HOSTED_BROWSER_VIEWER_ROUTE_VERSION =
  "hosted_browser_viewer_route_v1" as const;
export const HOSTED_BROWSER_VIEWER_AUTHENTICATE_TIMEOUT_MS = 10_000;
export const HOSTED_BROWSER_VIEWER_MAX_SERVER_MESSAGE_BYTES = 28 * 1024 * 1024;
export const HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE =
  "BROWSER_VIEWER_FRAME_UNAVAILABLE" as const;

export type HostedBrowserViewerClientMessageV1 =
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "authenticate"; ticket: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "accept_takeover" }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "renew_lease"; leaseId: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "input"; leaseId: string; input: DesktopBrowserViewerInputV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "return_control"; leaseId: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "close_session" };

export type HostedBrowserViewerServerMessageV1 =
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "state"; state: DesktopBrowserViewerStateV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "frame"; frame: DesktopBrowserViewerFrameV1 }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "closed"; reason: string }
  | { version: typeof HOSTED_BROWSER_VIEWER_ROUTE_VERSION; type: "error"; code: string };

export function parseHostedBrowserViewerServerMessage(
  value: unknown,
  expected: {
    threadId?: string | undefined;
    projectId?: string | undefined;
    sessionId?: string | undefined;
    generation?: number | undefined;
    connectionId?: string | undefined;
  } = {},
): HostedBrowserViewerServerMessageV1 {
  const record = viewerRecord(value);
  if (
    record.version !== HOSTED_BROWSER_VIEWER_ROUTE_VERSION ||
    typeof record.type !== "string"
  ) throw invalidViewerMessage();
  if (record.type === "closed") {
    if (!(viewerExactKeys(record, ["version", "type", "reason"]) && viewerText(record.reason))) {
      throw invalidViewerMessage();
    }
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "closed", reason: record.reason as string };
  }
  if (record.type === "error") {
    if (!(viewerExactKeys(record, ["version", "type", "code"]) && viewerText(record.code))) {
      throw invalidViewerMessage();
    }
    return { version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION, type: "error", code: record.code as string };
  }
  if (record.type === "frame") {
    if (!viewerExactKeys(record, ["version", "type", "frame"])) throw invalidViewerMessage();
    const frame = viewerRecord(record.frame);
    if (
      !viewerExactKeys(frame, ["version", "sessionId", "generation", "sequence", "capturedAt", "mediaType", "dataBase64"]) ||
      frame.version !== "desktop_browser_viewer_frame_v1" ||
      !viewerText(frame.sessionId) ||
      !viewerPositiveInteger(frame.generation) ||
      !viewerPositiveInteger(frame.sequence) ||
      !viewerTimestamp(frame.capturedAt) ||
      frame.mediaType !== "image/png" ||
      typeof frame.dataBase64 !== "string" ||
      frame.dataBase64.length < 1 ||
      frame.dataBase64.length > HOSTED_BROWSER_VIEWER_MAX_SERVER_MESSAGE_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(frame.dataBase64) ||
      (expected.sessionId !== undefined && frame.sessionId !== expected.sessionId) ||
      (expected.generation !== undefined && frame.generation !== expected.generation)
    ) throw invalidViewerMessage();
    return {
      version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
      type: "frame",
      frame: frame as unknown as DesktopBrowserViewerFrameV1,
    };
  }
  if (record.type === "state") {
    if (!viewerExactKeys(record, ["version", "type", "state"])) throw invalidViewerMessage();
    const state = viewerRecord(record.state);
    const allowed = new Set([
      "version", "available", "threadId", "projectId", "sessionId", "generation",
      "connectionId", "sessionState", "takeoverRequested", "inputLeaseId",
      "inputLeaseExpiresAt", "nativeHandoffActive",
    ]);
    if (
      Object.keys(state).some((key) => !allowed.has(key)) ||
      state.version !== "desktop_browser_viewer_state_v1" ||
      state.available !== true ||
      !viewerText(state.threadId) ||
      !viewerText(state.projectId) ||
      !viewerText(state.sessionId) ||
      !viewerPositiveInteger(state.generation) ||
      !viewerText(state.connectionId) ||
      (state.sessionState !== "ready" && state.sessionState !== "human_control") ||
      typeof state.takeoverRequested !== "boolean" ||
      (state.inputLeaseId !== undefined && !viewerText(state.inputLeaseId)) ||
      (state.inputLeaseExpiresAt !== undefined && !viewerTimestamp(state.inputLeaseExpiresAt)) ||
      (state.nativeHandoffActive !== undefined && typeof state.nativeHandoffActive !== "boolean") ||
      (expected.threadId !== undefined && state.threadId !== expected.threadId) ||
      (expected.projectId !== undefined && state.projectId !== expected.projectId) ||
      (expected.sessionId !== undefined && state.sessionId !== expected.sessionId) ||
      (expected.generation !== undefined && state.generation !== expected.generation) ||
      (expected.connectionId !== undefined && state.connectionId !== expected.connectionId)
    ) throw invalidViewerMessage();
    return {
      version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
      type: "state",
      state: state as unknown as DesktopBrowserViewerStateV1,
    };
  }
  throw invalidViewerMessage();
}

function viewerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidViewerMessage();
  return value as Record<string, unknown>;
}

function viewerExactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(record).length === keys.length && keys.every((key) => key in record);
}

function viewerText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function viewerPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function viewerTimestamp(value: unknown): value is string {
  if (!viewerText(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidViewerMessage() {
  return new Error("BROWSER_SESSION_LOST");
}
