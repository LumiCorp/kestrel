import type { AgentToolPresentation } from "../kestrel/contracts/model-io.js";
import type {
  PreparedToolCallV1,
  ToolExecutionOutcomeV1,
} from "../kestrel/contracts/tool-invocation.js";
import {
  RuntimeFailure,
  createRuntimeFailure,
} from "../runtime/RuntimeFailure.js";

export const BROWSER_APP_ID = "built_in.browser" as const;
export const BROWSER_SERVICE_PORT_VERSION = "browser_service_port_v1" as const;
export const BROWSER_TOOL_RESULT_VERSION = "browser_tool_result_v1" as const;
export const BROWSER_CONTRACT_VERSION = "browser_app_contract_v1" as const;
export const BROWSER_POLICY_RESOLUTION_VERSION =
  "browser_policy_resolution_v1" as const;
export const BROWSER_ARTIFACT_AUTHORIZATION_VERSION =
  "browser_artifact_authorization_v1" as const;
export const BROWSER_AUTHORIZED_ARTIFACT_VERSION =
  "browser_authorized_artifact_v1" as const;
export const BROWSER_ALLOWLIST_ADOPTION_VERSION =
  "browser_allowlist_adoption_v1" as const;
export const BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION =
  "browser_allowlist_adoption_receipt_v1" as const;
export const BROWSER_UPLOAD_PREPARATION_VERSION =
  "browser_upload_preparation_v1" as const;

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
  "BROWSER_DOWNLOAD_UNAVAILABLE",
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
  resolvePolicy(input: {
    version: typeof BROWSER_POLICY_RESOLUTION_VERSION;
    runId: string;
    threadId: string;
    operation: BrowserToolName;
    effectiveInput: Record<string, unknown>;
    authority: BrowserHostExecutionAuthorityV1;
  }): Promise<BrowserPolicyResolutionV1>;
  prepareUpload?(
    input: BrowserUploadPreparationRequestV1,
  ): Promise<BrowserUploadPreparedEffectV1>;
  execute(
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown>;
  authorizeArtifact(
    input: BrowserArtifactAuthorizationRequestV1,
  ): Promise<BrowserAuthorizedArtifactV1 | undefined>;
  adoptAllowlistRevision(
    input: BrowserAllowlistAdoptionRequestV1,
  ): Promise<BrowserAllowlistAdoptionReceiptV1>;
}

export interface BrowserUploadAttachmentMetadataV1 {
  attachmentId: string;
  filename: string;
  /** User-declared media type. This value is untrusted display metadata. */
  declaredMediaType: string;
  /** Host-validated media type used for execution binding. */
  detectedMediaType: string;
  sizeBytes: number;
  sha256: string;
}

export interface BrowserUploadPreparationRequestV1 {
  version: typeof BROWSER_UPLOAD_PREPARATION_VERSION;
  runId: string;
  threadId: string;
  turnId: string;
  effectiveInput: Record<string, unknown>;
  attachment: BrowserUploadAttachmentMetadataV1;
  authority: BrowserHostExecutionAuthorityV1;
}

export interface BrowserUploadPreparedEffectV1 {
  version: typeof BROWSER_UPLOAD_PREPARATION_VERSION;
  turnId: string;
  threadId: string;
  attachmentId: string;
  filename: string;
  declaredMediaType: string;
  detectedMediaType: string;
  sizeBytes: number;
  sha256: string;
  sessionId: string;
  generation: number;
  snapshotId: string;
  documentRevision: string;
  targetRef: string;
  targetLabel: string;
}

export function parseBrowserUploadPreparedEffectV1(
  value: unknown,
): BrowserUploadPreparedEffectV1 {
  const record = requireRecord(value, "BrowserUploadPreparedEffectV1");
  rejectUnknown(
    record,
    new Set([
      "version",
      "turnId",
      "threadId",
      "attachmentId",
      "filename",
      "declaredMediaType",
      "detectedMediaType",
      "sizeBytes",
      "sha256",
      "sessionId",
      "generation",
      "snapshotId",
      "documentRevision",
      "targetRef",
      "targetLabel",
    ]),
    "BrowserUploadPreparedEffectV1",
  );
  if (record.version !== BROWSER_UPLOAD_PREPARATION_VERSION) {
    throw new Error("BrowserUploadPreparedEffectV1.version is invalid.");
  }
  const sha256 = requireString(
    record.sha256,
    "BrowserUploadPreparedEffectV1.sha256",
  );
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error("BrowserUploadPreparedEffectV1.sha256 is invalid.");
  }
  return {
    version: BROWSER_UPLOAD_PREPARATION_VERSION,
    turnId: requireString(record.turnId, "BrowserUploadPreparedEffectV1.turnId"),
    threadId: requireString(record.threadId, "BrowserUploadPreparedEffectV1.threadId"),
    attachmentId: requireString(record.attachmentId, "BrowserUploadPreparedEffectV1.attachmentId"),
    filename: requireString(record.filename, "BrowserUploadPreparedEffectV1.filename"),
    declaredMediaType: requireString(record.declaredMediaType, "BrowserUploadPreparedEffectV1.declaredMediaType"),
    detectedMediaType: requireString(record.detectedMediaType, "BrowserUploadPreparedEffectV1.detectedMediaType"),
    sizeBytes: requireNonNegativeSafeInteger(record.sizeBytes, "BrowserUploadPreparedEffectV1.sizeBytes"),
    sha256,
    sessionId: requireString(record.sessionId, "BrowserUploadPreparedEffectV1.sessionId"),
    generation: requirePositiveSafeInteger(record.generation, "BrowserUploadPreparedEffectV1.generation"),
    snapshotId: requireString(record.snapshotId, "BrowserUploadPreparedEffectV1.snapshotId"),
    documentRevision: requireString(record.documentRevision, "BrowserUploadPreparedEffectV1.documentRevision"),
    targetRef: requireString(record.targetRef, "BrowserUploadPreparedEffectV1.targetRef"),
    targetLabel: requireString(record.targetLabel, "BrowserUploadPreparedEffectV1.targetLabel"),
  };
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeSafeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

export interface BrowserAllowlistAdoptionRequestV1 {
  version: typeof BROWSER_ALLOWLIST_ADOPTION_VERSION;
  runId: string;
  threadId: string;
  sessionId: string;
  effectiveAllowlistRevision: string;
  cause: "personal_grant" | "personal_revocation";
}

export interface BrowserAllowlistAdoptionReceiptV1 {
  version: typeof BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION;
  sessionId: string;
  effectiveAllowlistRevision: string;
  closedUnauthorizedConnections: number;
}

export interface BrowserResultExecutionAuthorityV1 {
  runId: string;
  sessionId: string;
  threadId: string;
  callId: string;
  toolName: BrowserToolName;
}

export interface BrowserArtifactAuthorizationRequestV1 {
  version: typeof BROWSER_ARTIFACT_AUTHORIZATION_VERSION;
  runId: string;
  threadId: string;
  callId: string;
  toolName: "browser.capture" | "browser.download";
  sessionId: string;
  artifactId: string;
  artifactKind: "browser-screenshot" | "browser-download";
  artifactUrl?: string | undefined;
}

export interface BrowserAuthorizedArtifactV1 {
  version: typeof BROWSER_AUTHORIZED_ARTIFACT_VERSION;
  id: string;
  title: string;
  kind: "browser-screenshot" | "browser-download";
  url?: string | undefined;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface BrowserPolicyResolutionV1 {
  version: typeof BROWSER_POLICY_RESOLUTION_VERSION;
  decision: "allow" | "deny" | "approval_required";
  policyRevision: string;
  sessionMode: BrowserMode;
}

export interface BrowserOperationLifecycleV1 {
  readonly authority: BrowserHostExecutionAuthorityV1;
  readonly signal?: AbortSignal | undefined;
  acknowledgeDispatch(): Promise<void>;
  persistCompletedResult(rawOutput: unknown): Promise<void>;
}

/** Trusted Browser-host identity from SharedToolContext, never model input. */
export interface BrowserHostExecutionAuthorityV1 {
  threadId: string;
  projectId?: string | undefined;
  projectRoot?: string | undefined;
}

export function isBrowserToolName(value: string): value is BrowserToolName {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isConformingBrowserServicePort(
  value: BrowserServicePort | undefined,
): value is BrowserServicePort {
  return (
    value?.version === BROWSER_SERVICE_PORT_VERSION &&
    typeof value.resolvePolicy === "function" &&
    typeof value.execute === "function" &&
    typeof value.authorizeArtifact === "function" &&
    typeof value.adoptAllowlistRevision === "function"
  );
}

export function parseBrowserPolicyResolutionV1(
  value: unknown,
): BrowserPolicyResolutionV1 {
  const record = requireRecord(value, "BrowserPolicyResolutionV1");
  rejectUnknown(
    record,
    new Set(["version", "decision", "policyRevision", "sessionMode"]),
    "BrowserPolicyResolutionV1",
  );
  if (record.version !== BROWSER_POLICY_RESOLUTION_VERSION) {
    throw new Error(
      `BrowserPolicyResolutionV1.version must be '${BROWSER_POLICY_RESOLUTION_VERSION}'.`,
    );
  }
  if (
    record.decision !== "allow" &&
    record.decision !== "deny" &&
    record.decision !== "approval_required"
  ) {
    throw new Error("BrowserPolicyResolutionV1.decision is invalid.");
  }
  if (record.sessionMode !== "qa" && record.sessionMode !== "operator") {
    throw new Error("BrowserPolicyResolutionV1.sessionMode is invalid.");
  }
  return {
    version: BROWSER_POLICY_RESOLUTION_VERSION,
    decision: record.decision,
    policyRevision: requireString(
      record.policyRevision,
      "BrowserPolicyResolutionV1.policyRevision",
    ),
    sessionMode: record.sessionMode,
  };
}

export function parseBrowserAllowlistAdoptionReceiptV1(
  value: unknown,
): BrowserAllowlistAdoptionReceiptV1 {
  const record = requireRecord(value, "BrowserAllowlistAdoptionReceiptV1");
  rejectUnknown(
    record,
    new Set([
      "version",
      "sessionId",
      "effectiveAllowlistRevision",
      "closedUnauthorizedConnections",
    ]),
    "BrowserAllowlistAdoptionReceiptV1",
  );
  if (record.version !== BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION) {
    throw new Error(
      `BrowserAllowlistAdoptionReceiptV1.version must be '${BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION}'.`,
    );
  }
  return {
    version: BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
    sessionId: requireString(
      record.sessionId,
      "BrowserAllowlistAdoptionReceiptV1.sessionId",
    ),
    effectiveAllowlistRevision: requireString(
      record.effectiveAllowlistRevision,
      "BrowserAllowlistAdoptionReceiptV1.effectiveAllowlistRevision",
    ),
    closedUnauthorizedConnections: requireNonNegativeSafeInteger(
      record.closedUnauthorizedConnections,
      "BrowserAllowlistAdoptionReceiptV1.closedUnauthorizedConnections",
    ),
  };
}

export function parseBrowserAllowlistAdoptionRequestV1(
  value: unknown,
): BrowserAllowlistAdoptionRequestV1 {
  const record = requireRecord(value, "BrowserAllowlistAdoptionRequestV1");
  rejectUnknown(
    record,
    new Set([
      "version",
      "runId",
      "threadId",
      "sessionId",
      "effectiveAllowlistRevision",
      "cause",
    ]),
    "BrowserAllowlistAdoptionRequestV1",
  );
  if (record.version !== BROWSER_ALLOWLIST_ADOPTION_VERSION) {
    throw new Error(
      `BrowserAllowlistAdoptionRequestV1.version must be '${BROWSER_ALLOWLIST_ADOPTION_VERSION}'.`,
    );
  }
  if (
    record.cause !== "personal_grant" &&
    record.cause !== "personal_revocation"
  ) {
    throw new Error("BrowserAllowlistAdoptionRequestV1.cause is invalid.");
  }
  return {
    version: BROWSER_ALLOWLIST_ADOPTION_VERSION,
    runId: requireString(
      record.runId,
      "BrowserAllowlistAdoptionRequestV1.runId",
    ),
    threadId: requireString(
      record.threadId,
      "BrowserAllowlistAdoptionRequestV1.threadId",
    ),
    sessionId: requireString(
      record.sessionId,
      "BrowserAllowlistAdoptionRequestV1.sessionId",
    ),
    effectiveAllowlistRevision: requireString(
      record.effectiveAllowlistRevision,
      "BrowserAllowlistAdoptionRequestV1.effectiveAllowlistRevision",
    ),
    cause: record.cause,
  };
}

export async function adoptBrowserAllowlistRevision(
  port: BrowserServicePort,
  input: BrowserAllowlistAdoptionRequestV1,
): Promise<BrowserAllowlistAdoptionReceiptV1> {
  const request = parseBrowserAllowlistAdoptionRequestV1(input);
  const receipt = parseBrowserAllowlistAdoptionReceiptV1(
    await port.adoptAllowlistRevision(request),
  );
  if (
    receipt.sessionId !== request.sessionId ||
    receipt.effectiveAllowlistRevision !== request.effectiveAllowlistRevision
  ) {
    throw browserFailure(
      "BROWSER_SERVICE_UNAVAILABLE",
      "The Browser host did not confirm the requested allowlist revision.",
      { recoverable: true },
    );
  }
  return receipt;
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
  const sessionId = requireString(
    record.sessionId,
    "BrowserSessionV1.sessionId",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) {
    throw new Error(
      "BrowserSessionV1.sessionId must be a path-safe opaque identifier.",
    );
  }
  const session: BrowserSessionV1 = {
    version: "browser_session_v1",
    sessionId,
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
  if (Date.parse(session.updatedAt) < Date.parse(session.createdAt)) {
    throw new Error("BrowserSessionV1.updatedAt cannot precede createdAt.");
  }
  if (Date.parse(session.lastActivityAt) < Date.parse(session.createdAt)) {
    throw new Error(
      "BrowserSessionV1.lastActivityAt cannot precede createdAt.",
    );
  }
  if (Date.parse(session.updatedAt) < Date.parse(session.lastActivityAt)) {
    throw new Error(
      "BrowserSessionV1.updatedAt cannot precede lastActivityAt.",
    );
  }
  if (Date.parse(session.idleExpiresAt) <= Date.parse(session.lastActivityAt)) {
    throw new Error(
      "BrowserSessionV1.idleExpiresAt must follow lastActivityAt.",
    );
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
  const output = requireRecord(
    normalizeBrowserResultOrigins(value),
    `${toolName} output`,
  );
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
    "boundary",
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

export function projectBrowserRunOutcome(
  toolName: string,
  outcome: ToolExecutionOutcomeV1 | undefined,
): ToolExecutionOutcomeV1 | undefined {
  if (!isBrowserToolName(toolName) || outcome === undefined) return outcome;
  if (outcome.kind === "success" || outcome.kind === "partial") {
    return {
      ...outcome,
      rawOutput: projectBrowserAuditOutput(toolName, outcome.rawOutput) ?? {},
    };
  }
  if (outcome.kind === "failure") {
    const failure = projectBrowserRunError(toolName, {
      code: outcome.normalizedFailureCode,
    });
    return {
      ...outcome,
      normalizedFailureCode: failure.code,
      error: { message: failure.message },
    };
  }
  return outcome;
}

export function projectBrowserRunError(
  toolName: string,
  error: { code?: string | undefined } | undefined,
): {
  code: BrowserFailureCode;
  message: string;
  details?: Record<string, unknown>;
} {
  const code =
    isBrowserToolName(toolName) &&
    typeof error?.code === "string" &&
    (BROWSER_FAILURE_CODES as readonly string[]).includes(error.code)
      ? (error.code as BrowserFailureCode)
      : "BROWSER_ENGINE_FAILURE";
  return { code, message: browserFailureMessage(code) };
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

export function withoutBrowserArtifactPresentationUrl(value: unknown): unknown {
  const output = requireRecord(value, "Browser output");
  const artifact = asRecord(output.artifact);
  if (artifact === undefined || artifact.url === undefined) return value;
  const { url: _url, ...artifactWithoutUrl } = artifact;
  return {
    ...output,
    artifact: artifactWithoutUrl,
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

export function normalizeBrowserHostFailure(
  error: unknown,
  input: {
    toolName: BrowserToolName;
    dispatchAcknowledged: boolean;
    effectful: boolean;
  },
) {
  const exactOutcomeKnown =
    error instanceof RuntimeFailure &&
    error.details?.browserOutcomeKnown === true;
  if (input.dispatchAcknowledged && input.effectful && !exactOutcomeKnown) {
    return browserFailure(
      "BROWSER_ACTION_OUTCOME_UNKNOWN",
      "The Browser operation was dispatched, but its exact outcome could not be confirmed.",
      {
        recoverable: false,
        operation: input.toolName,
        dispatchAcknowledged: true,
      },
    );
  }
  const code =
    error instanceof RuntimeFailure &&
    (BROWSER_FAILURE_CODES as readonly string[]).includes(error.code)
      ? (error.code as BrowserFailureCode)
      : "BROWSER_ENGINE_FAILURE";
  return browserFailure(code, browserFailureMessage(code), {
    recoverable:
      code === "BROWSER_SERVICE_UNAVAILABLE" || code === "BROWSER_TARGET_STALE",
    operation: input.toolName,
    dispatchAcknowledged: input.dispatchAcknowledged,
  });
}

export function normalizeBrowserResultOrigins(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBrowserResultOrigins(item));
  }
  const record = asRecord(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      (key === "normalizedOrigin" || key === "normalizedSourceOrigin") &&
      typeof child === "string"
        ? requireNormalizedOrigin(child, key)
        : normalizeBrowserResultOrigins(child),
    ]),
  );
}

export function validateBrowserResultSemantics(
  toolName: BrowserToolName,
  value: unknown,
): unknown {
  const normalized = normalizeBrowserResultOrigins(value);
  const output = requireRecord(normalized, `${toolName} output`);
  if (
    output.version !== BROWSER_TOOL_RESULT_VERSION ||
    output.operation !== toolName
  ) {
    throw new Error(`${toolName} output identity is invalid.`);
  }
  if (output.session !== undefined) parseBrowserSessionV1(output.session);
  validateTimestampOrder(output.pendingDownload, {
    earlier: "createdAt",
    later: "expiresAt",
    label: `${toolName} pendingDownload`,
  });
  return normalized;
}

export function validateBrowserResultAuthority(
  prepared: PreparedToolCallV1,
  value: unknown,
  execution: BrowserResultExecutionAuthorityV1,
): unknown {
  const toolName = prepared.activation.descriptor.toolId;
  if (!isBrowserToolName(toolName)) {
    throw new Error(
      "Prepared Browser result authority has an invalid operation.",
    );
  }
  if (
    execution.runId !== prepared.runId ||
    execution.sessionId !== prepared.sessionId ||
    execution.callId !== prepared.callId ||
    execution.toolName !== toolName ||
    execution.threadId.length === 0
  ) {
    throw new Error(
      "Browser execution authority does not match the prepared call.",
    );
  }
  const output = requireRecord(value, `${toolName} output`);
  const nestedSession =
    output.session === undefined
      ? undefined
      : parseBrowserSessionV1(output.session);
  const topLevelSessionId =
    typeof output.sessionId === "string" ? output.sessionId : undefined;
  const inputSessionId =
    typeof prepared.effectiveInput.sessionId === "string"
      ? prepared.effectiveInput.sessionId
      : undefined;
  if (
    topLevelSessionId !== undefined &&
    nestedSession !== undefined &&
    topLevelSessionId !== nestedSession.sessionId
  ) {
    throw new Error("Browser result contains conflicting session identities.");
  }
  if (
    toolName !== "browser.open" &&
    inputSessionId !== undefined &&
    ((topLevelSessionId !== undefined &&
      topLevelSessionId !== inputSessionId) ||
      (nestedSession !== undefined &&
        nestedSession.sessionId !== inputSessionId))
  ) {
    throw new Error(
      "Browser result session does not match prepared authority.",
    );
  }
  if (
    nestedSession !== undefined &&
    nestedSession.threadId !== execution.threadId
  ) {
    throw new Error(
      "Browser result Thread does not match execution authority.",
    );
  }
  if (toolName === "browser.open" && nestedSession === undefined) {
    const outcome = output.outcome;
    if (outcome !== "blocked") {
      throw new Error(
        "Browser open result is missing its prepared session authority.",
      );
    }
  }
  if (
    toolName === "browser.open" &&
    nestedSession !== undefined &&
    nestedSession.mode !== prepared.effectiveInput.mode
  ) {
    throw new Error(
      "Browser open result mode does not match the prepared call.",
    );
  }
  if (
    toolName === "browser.upload" &&
    (output.attachmentId !== prepared.effectiveInput.attachmentId ||
      output.targetRef !== prepared.effectiveInput.targetRef)
  ) {
    throw new Error(
      "Browser upload result attachment does not match the prepared call.",
    );
  }
  if (
    toolName === "browser.inspect" &&
    output.kind !== prepared.effectiveInput.kind
  ) {
    throw new Error(
      "Browser inspect result target does not match the prepared call.",
    );
  }
  if (
    toolName === "browser.tabs" &&
    prepared.effectiveInput.operation === "switch" &&
    output.activeTabId !== prepared.effectiveInput.tabId
  ) {
    throw new Error(
      "Browser tab result target does not match the prepared call.",
    );
  }
  return value;
}

export function browserArtifactAuthorizationRequest(
  execution: BrowserResultExecutionAuthorityV1,
  value: unknown,
): BrowserArtifactAuthorizationRequestV1 | undefined {
  if (
    execution.toolName !== "browser.capture" &&
    execution.toolName !== "browser.download"
  ) {
    return;
  }
  const output = requireRecord(value, `${execution.toolName} output`);
  const artifact = requireRecord(
    output.artifact,
    `${execution.toolName} artifact`,
  );
  const sessionId = requireString(
    output.sessionId,
    `${execution.toolName} sessionId`,
  );
  const artifactKind = requireString(
    artifact.kind,
    `${execution.toolName} artifact.kind`,
  );
  const expectedKind =
    execution.toolName === "browser.capture"
      ? "browser-screenshot"
      : "browser-download";
  if (artifactKind !== expectedKind) {
    throw new Error(
      "Browser artifact kind does not match the prepared operation.",
    );
  }
  return {
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: execution.runId,
    threadId: execution.threadId,
    callId: execution.callId,
    toolName: execution.toolName,
    sessionId,
    artifactId: requireString(artifact.id, `${execution.toolName} artifact.id`),
    artifactKind: expectedKind,
    ...(typeof artifact.url === "string" ? { artifactUrl: artifact.url } : {}),
  };
}

export function parseBrowserAuthorizedArtifactV1(
  value: unknown,
  request: BrowserArtifactAuthorizationRequestV1,
): BrowserAuthorizedArtifactV1 {
  const record = requireRecord(value, "BrowserAuthorizedArtifactV1");
  rejectUnknown(
    record,
    new Set([
      "version",
      "id",
      "title",
      "kind",
      "url",
      "mediaType",
      "bytes",
      "sha256",
    ]),
    "BrowserAuthorizedArtifactV1",
  );
  if (record.version !== BROWSER_AUTHORIZED_ARTIFACT_VERSION) {
    throw new Error(
      `BrowserAuthorizedArtifactV1.version must be '${BROWSER_AUTHORIZED_ARTIFACT_VERSION}'.`,
    );
  }
  const id = requireString(record.id, "BrowserAuthorizedArtifactV1.id");
  const kind = requireString(record.kind, "BrowserAuthorizedArtifactV1.kind");
  if (id !== request.artifactId || kind !== request.artifactKind) {
    throw new Error(
      "Authorized Browser artifact does not match the requested artifact authority.",
    );
  }
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) {
    throw new Error(
      "BrowserAuthorizedArtifactV1.bytes must be a non-negative safe integer.",
    );
  }
  const sha256 = requireString(
    record.sha256,
    "BrowserAuthorizedArtifactV1.sha256",
  );
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(
      "BrowserAuthorizedArtifactV1.sha256 must be a lowercase SHA-256 digest.",
    );
  }
  return {
    version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
    id,
    title: requireString(record.title, "BrowserAuthorizedArtifactV1.title"),
    kind: kind as BrowserAuthorizedArtifactV1["kind"],
    ...(record.url === undefined
      ? {}
      : {
          url: requireAuthorizedArtifactUrl(
            record.url,
            "BrowserAuthorizedArtifactV1.url",
          ),
        }),
    mediaType: requireString(
      record.mediaType,
      "BrowserAuthorizedArtifactV1.mediaType",
    ),
    bytes: record.bytes as number,
    sha256,
  };
}

export function canonicalizeBrowserArtifact(
  value: unknown,
  authorization: BrowserAuthorizedArtifactV1,
): unknown {
  const output = requireRecord(value, "Browser artifact output");
  return {
    ...output,
    artifact: {
      id: authorization.id,
      title: authorization.title,
      kind: authorization.kind,
      ...(authorization.url === undefined ? {} : { url: authorization.url }),
      mediaType: authorization.mediaType,
      bytes: authorization.bytes,
      sha256: authorization.sha256,
    },
  };
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

function requireNormalizedOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) origin.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.length === 0
  ) {
    throw new Error(`${label} must be an absolute HTTP(S) origin.`);
  }
  return parsed.origin;
}

function requireAuthorizedArtifactUrl(value: unknown, label: string): string {
  const url = requireString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.length === 0
  ) {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  return url;
}

function validateTimestampOrder(
  value: unknown,
  input: { earlier: string; later: string; label: string },
): void {
  const record = asRecord(value);
  if (record === undefined) return;
  const earlier = requireTimestamp(
    record[input.earlier],
    `${input.label}.${input.earlier}`,
  );
  const later = requireTimestamp(
    record[input.later],
    `${input.label}.${input.later}`,
  );
  if (Date.parse(later) <= Date.parse(earlier)) {
    throw new Error(
      `${input.label}.${input.later} must follow ${input.earlier}.`,
    );
  }
}

function browserFailureMessage(code: BrowserFailureCode): string {
  switch (code) {
    case "BROWSER_SESSION_CONFLICT":
      return "The Thread already has a conflicting Browser Session.";
    case "BROWSER_SESSION_EXPIRED":
      return "The Browser Session expired.";
    case "BROWSER_SESSION_LOST":
      return "The Browser Session was lost.";
    case "BROWSER_DESTINATION_BLOCKED":
      return "Browser policy blocked the destination.";
    case "BROWSER_GRANT_DENIED":
      return "The Browser domain grant was denied.";
    case "BROWSER_HUMAN_CONTROL_ACTIVE":
      return "Agent Browser actions are disabled while human control is active.";
    case "BROWSER_TARGET_STALE":
      return "The Browser target reference is stale.";
    case "BROWSER_ACTION_OUTCOME_UNKNOWN":
      return "The Browser operation outcome is unknown.";
    case "BROWSER_ARTIFACT_TOO_LARGE":
      return "The Browser artifact exceeds the permitted size.";
    case "BROWSER_DOWNLOAD_UNAVAILABLE":
      return "The Browser download was cancelled before storage.";
    case "BROWSER_SERVICE_UNAVAILABLE":
      return "The Browser service is unavailable.";
    case "BROWSER_ENGINE_FAILURE":
      return "The Browser engine could not complete the operation.";
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

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error(`${label} must be a timestamp.`);
  return timestamp;
}
