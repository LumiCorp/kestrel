import type { AgentToolPresentation } from "../kestrel/contracts/model-io.js";
import type { PreparedToolCallV1 } from "../kestrel/contracts/tool-invocation.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export const BROWSER_APP_ID = "built_in.browser" as const;
export const BROWSER_SERVICE_PORT_VERSION = "browser_service_port_v1" as const;
export const BROWSER_TOOL_RESULT_VERSION = "browser_tool_result_v1" as const;
export const BROWSER_CONTRACT_VERSION = "browser_app_contract_v1" as const;

export const BROWSER_TOOL_NAMES = [
  "browser.open",
  "browser.request_grant",
  "browser.snapshot",
  "browser.inspect",
  "browser.navigate",
  "browser.interact",
  "browser.tabs",
  "browser.capture",
  "browser.upload",
  "browser.download",
  "browser.request_takeover",
  "browser.close",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
export type BrowserMode = "qa" | "operator";
export type BrowserSessionState =
  | "opening"
  | "ready"
  | "human_control"
  | "closing"
  | "closed"
  | "expired"
  | "lost"
  | "failed";

export const BROWSER_SESSION_STATES: readonly BrowserSessionState[] = [
  "opening",
  "ready",
  "human_control",
  "closing",
  "closed",
  "expired",
  "lost",
  "failed",
];

export const BROWSER_FAILURE_CODES = [
  "BROWSER_SESSION_CONFLICT",
  "BROWSER_SESSION_EXPIRED",
  "BROWSER_SESSION_LOST",
  "BROWSER_DESTINATION_BLOCKED",
  "BROWSER_GRANT_DENIED",
  "BROWSER_HUMAN_CONTROL_ACTIVE",
  "BROWSER_TARGET_STALE",
  "BROWSER_ACTION_OUTCOME_UNKNOWN",
  "BROWSER_ARTIFACT_TOO_LARGE",
  "BROWSER_SERVICE_UNAVAILABLE",
  "BROWSER_ENGINE_FAILURE",
] as const;

export type BrowserFailureCode = (typeof BROWSER_FAILURE_CODES)[number];

export interface BrowserSessionV1 {
  version: "browser_session_v1";
  sessionId: string;
  threadId: string;
  mode: BrowserMode;
  state: BrowserSessionState;
  engineRevision: string;
  generation: number;
  effectiveAllowlistRevision: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  idleExpiresAt: string;
  hardExpiresAt: string;
  terminalReason?: BrowserFailureCode | "closed_by_user" | undefined;
}

export interface BrowserServicePort {
  readonly version: typeof BROWSER_SERVICE_PORT_VERSION;
  execute(prepared: PreparedToolCallV1): Promise<unknown>;
}

export function isBrowserToolName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isConformingBrowserServicePort(
  value: BrowserServicePort | undefined,
): value is BrowserServicePort {
  return (
    value?.version === BROWSER_SERVICE_PORT_VERSION &&
    typeof value.execute === "function"
  );
}

export function requireBrowserServicePort(
  value: BrowserServicePort | undefined,
): BrowserServicePort {
  if (!isConformingBrowserServicePort(value)) {
    throw browserFailure(
      "BROWSER_SERVICE_UNAVAILABLE",
      "The active host does not provide the Browser App contract.",
      { recoverable: true },
    );
  }
  return value;
}

export function parseBrowserSessionV1(value: unknown): BrowserSessionV1 {
  const record = requireRecord(value, "BrowserSessionV1");
  rejectUnknown(
    record,
    new Set([
      "version",
      "sessionId",
      "threadId",
      "mode",
      "state",
      "engineRevision",
      "generation",
      "effectiveAllowlistRevision",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
      "idleExpiresAt",
      "hardExpiresAt",
      "terminalReason",
    ]),
    "BrowserSessionV1",
  );
  if (record.version !== "browser_session_v1") {
    throw new Error("BrowserSessionV1.version must be 'browser_session_v1'.");
  }
  const mode = record.mode;
  if (mode !== "qa" && mode !== "operator") {
    throw new Error("BrowserSessionV1.mode must be 'qa' or 'operator'.");
  }
  const state = record.state;
  if (!(BROWSER_SESSION_STATES as readonly unknown[]).includes(state)) {
    throw new Error("BrowserSessionV1.state is invalid.");
  }
  const generation = record.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new Error("BrowserSessionV1.generation must be a positive integer.");
  }
  const terminalReason = record.terminalReason;
  if (
    terminalReason !== undefined &&
    terminalReason !== "closed_by_user" &&
    !(BROWSER_FAILURE_CODES as readonly unknown[]).includes(terminalReason)
  ) {
    throw new Error("BrowserSessionV1.terminalReason is invalid.");
  }
  const session: BrowserSessionV1 = {
    version: "browser_session_v1",
    sessionId: requireString(record.sessionId, "BrowserSessionV1.sessionId"),
    threadId: requireString(record.threadId, "BrowserSessionV1.threadId"),
    mode,
    state: state as BrowserSessionState,
    engineRevision: requireString(
      record.engineRevision,
      "BrowserSessionV1.engineRevision",
    ),
    generation: generation as number,
    effectiveAllowlistRevision: requireString(
      record.effectiveAllowlistRevision,
      "BrowserSessionV1.effectiveAllowlistRevision",
    ),
    createdAt: requireTimestamp(record.createdAt, "BrowserSessionV1.createdAt"),
    updatedAt: requireTimestamp(record.updatedAt, "BrowserSessionV1.updatedAt"),
    lastActivityAt: requireTimestamp(
      record.lastActivityAt,
      "BrowserSessionV1.lastActivityAt",
    ),
    idleExpiresAt: requireTimestamp(
      record.idleExpiresAt,
      "BrowserSessionV1.idleExpiresAt",
    ),
    hardExpiresAt: requireTimestamp(
      record.hardExpiresAt,
      "BrowserSessionV1.hardExpiresAt",
    ),
    ...(terminalReason === undefined
      ? {}
      : {
          terminalReason: terminalReason as BrowserSessionV1["terminalReason"],
        }),
  };
  if (Date.parse(session.hardExpiresAt) <= Date.parse(session.createdAt)) {
    throw new Error("BrowserSessionV1.hardExpiresAt must follow createdAt.");
  }
  if (Date.parse(session.idleExpiresAt) > Date.parse(session.hardExpiresAt)) {
    throw new Error(
      "BrowserSessionV1.idleExpiresAt cannot follow hardExpiresAt.",
    );
  }
  return session;
}

export function projectBrowserAuditInput(
  toolName: string,
  value: unknown,
): unknown | undefined {
  if (!isBrowserToolName(toolName)) return;
  const input = requireRecord(value, `${toolName} input`);
  const projected: Record<string, unknown> = {};
  copyStrings(input, projected, [
    "sessionId",
    "snapshotId",
    "documentRevision",
    "tabId",
    "attachmentId",
    "pendingDownloadId",
    "targetRef",
    "kind",
    "operation",
    "mode",
  ]);
  for (const field of ["destination", "url"] as const) {
    if (typeof input[field] === "string") {
      projected[`${field}Origin`] = safeNormalizedOrigin(input[field]);
    }
  }
  const target = asRecord(input.target);
  if (target !== undefined) {
    projected.target = projectTrustedTarget(target);
  }
  const action = asRecord(input.action);
  if (action !== undefined) {
    projected.action = projectBrowserAction(action);
  }
  if (typeof input.reason === "string") {
    projected.reasonBytes = Buffer.byteLength(input.reason, "utf8");
  }
  return projected;
}

export function projectBrowserAuditOutput(
  toolName: string,
  value: unknown,
): unknown | undefined {
  if (!isBrowserToolName(toolName)) return;
  const output = requireRecord(value, `${toolName} output`);
  const projected: Record<string, unknown> = {};
  copyStrings(output, projected, [
    "version",
    "operation",
    "outcome",
    "sessionId",
    "snapshotId",
    "documentRevision",
    "normalizedOrigin",
    "capturedAt",
    "activeTabId",
    "state",
  ]);
  if (typeof output.generation === "number") {
    projected.generation = output.generation;
  }
  if (typeof output.complete === "boolean") {
    projected.complete = output.complete;
  }
  projected.hasContinuation = typeof output.nextCursor === "string";
  const session = asRecord(output.session);
  if (session !== undefined) {
    const parsed = parseBrowserSessionV1(session);
    projected.session = {
      sessionId: parsed.sessionId,
      threadId: parsed.threadId,
      mode: parsed.mode,
      state: parsed.state,
      engineRevision: parsed.engineRevision,
      generation: parsed.generation,
      effectiveAllowlistRevision: parsed.effectiveAllowlistRevision,
      idleExpiresAt: parsed.idleExpiresAt,
      hardExpiresAt: parsed.hardExpiresAt,
      ...(parsed.terminalReason === undefined
        ? {}
        : { terminalReason: parsed.terminalReason }),
    };
  }
  const artifact = asRecord(output.artifact);
  if (artifact !== undefined) {
    projected.artifact = projectArtifactMetadata(artifact);
  }
  const pendingDownload = asRecord(output.pendingDownload);
  if (pendingDownload !== undefined) {
    projected.pendingDownload = {
      downloadId: pendingDownload.downloadId,
      filename: pendingDownload.filename,
      measuredBytes: pendingDownload.measuredBytes,
      declaredMediaType: pendingDownload.declaredMediaType,
      normalizedSourceOrigin: pendingDownload.normalizedSourceOrigin,
      sha256: pendingDownload.sha256,
      createdAt: pendingDownload.createdAt,
      expiresAt: pendingDownload.expiresAt,
    };
  }
  return projected;
}

export function browserArtifactPresentation(
  value: unknown,
): AgentToolPresentation | undefined {
  const output = asRecord(value);
  const artifact = asRecord(output?.artifact);
  if (artifact === undefined) return;
  const id = requireString(artifact.id, "browser artifact.id");
  const title = requireString(artifact.title, "browser artifact.title");
  const kind = requireString(artifact.kind, "browser artifact.kind");
  return {
    artifacts: [
      {
        id,
        title,
        kind,
        ...(typeof artifact.url === "string" ? { url: artifact.url } : {}),
        ...(typeof artifact.mediaType === "string"
          ? { mediaType: artifact.mediaType }
          : {}),
        metadata: projectArtifactMetadata(artifact),
      },
    ],
  };
}

export function browserFailure(
  code: BrowserFailureCode,
  message: string,
  details: Record<string, unknown> = {},
) {
  return createRuntimeFailure(code, message, {
    subsystem: "browser",
    classification: "runtime",
    recoverable: false,
    ...details,
  });
}

function projectBrowserAction(action: Record<string, unknown>) {
  const projected: Record<string, unknown> = {};
  copyStrings(action, projected, ["kind", "ref", "key", "direction"]);
  if (Array.isArray(action.values)) {
    projected.valueCount = action.values.length;
  }
  if (typeof action.amount === "number") projected.amount = action.amount;
  if (typeof action.text === "string") {
    projected.characterCount = [...action.text].length;
  }
  return projected;
}

function projectTrustedTarget(target: Record<string, unknown>) {
  const projected: Record<string, unknown> = {};
  copyStrings(target, projected, [
    "kind",
    "projectId",
    "runId",
    "urlId",
    "previewId",
  ]);
  if (typeof target.url === "string") {
    projected.normalizedOrigin = safeNormalizedOrigin(target.url);
  }
  return projected;
}

function projectArtifactMetadata(artifact: Record<string, unknown>) {
  const projected: Record<string, unknown> = {};
  copyStrings(artifact, projected, [
    "id",
    "title",
    "kind",
    "mediaType",
    "sha256",
  ]);
  if (typeof artifact.bytes === "number") projected.bytes = artifact.bytes;
  return projected;
}

function safeNormalizedOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function copyStrings(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fields: readonly string[],
) {
  for (const field of fields) {
    if (typeof source[field] === "string") target[field] = source[field];
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object.`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rejectUnknown(
  record: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
) {
  const unknown = Object.keys(record).find((key) => !keys.has(key));
  if (unknown !== undefined)
    throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error(`${label} must be a timestamp.`);
  return timestamp;
}
