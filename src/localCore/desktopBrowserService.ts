import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import {
  BROWSER_AUTHORIZED_ARTIFACT_VERSION,
  BROWSER_DOWNLOAD_PREPARATION_VERSION,
  BROWSER_POLICY_RESOLUTION_VERSION,
  BROWSER_SERVICE_PORT_VERSION,
  BROWSER_TOOL_RESULT_VERSION,
  BROWSER_UPLOAD_PREPARATION_VERSION,
  browserFailure,
  isBrowserToolName,
  normalizeBrowserHostFailure,
  parseBrowserDownloadPreparedEffectV1,
  parseBrowserSessionV1,
  parseBrowserUploadPreparedEffectV1,
  type BrowserAllowlistAdoptionReceiptV1,
  type BrowserArtifactAuthorizationRequestV1,
  type BrowserAuthorizedArtifactV1,
  type BrowserDownloadPreparationRequestV1,
  type BrowserDownloadPreparedEffectV1,
  type BrowserHostExecutionAuthorityV1,
  type BrowserOperationLifecycleV1,
  type BrowserPolicyResolutionV1,
  type BrowserServicePort,
  type BrowserSessionV1,
  type BrowserUploadPreparationRequestV1,
  type BrowserUploadPreparedEffectV1,
} from "../browser/contracts.js";
import { resolveBrowserToolExecutionClass } from "../browser/browserAppContract.fixture.js";
import { HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED } from "../browser/hostedViewer.js";
import {
  HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES,
  hostedBrowserViewerPngBase64ByteLength,
} from "../browser/hostedViewerProtocol.js";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  BROWSER_QA_TARGET_VERSION,
  canonicalizePublicBrowserDestination,
  canonicalizeTrustedBrowserQaTarget,
  effectiveBrowserAuthorityAllowsPublicDestination,
  type BrowserEffectiveDomainAuthorityV1,
} from "../browser/domainAuthority.js";
import type { PreparedToolCallV1 } from "../kestrel/contracts/tool-invocation.js";
import {
  DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE,
  DESKTOP_MAX_ATTACHMENT_BYTES,
  DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES,
  DesktopAttachmentStore,
  type DesktopAttachmentMetadata,
} from "./desktopAttachments.js";
import {
  createLocalCoreBrowserEgressProxy,
  type CreateLocalCoreBrowserEgressProxyInput,
  type LocalCoreBrowserEgressLaunchBindingV1,
  type LocalCoreBrowserEgressProxy,
} from "./browserEgressProxy.js";
import type { DesktopProjectRunRegistry } from "./desktopProjectRuns.js";
import {
  DESKTOP_BROWSER_VIEWER_FRAME_VERSION,
  DESKTOP_BROWSER_VIEWER_STATE_VERSION,
  type DesktopBrowserViewerFrameV1,
  type DesktopBrowserViewerInputV1,
  type DesktopBrowserViewerStateV1,
} from "../desktopShell/contracts.js";

const LEDGER_VERSION = "desktop_browser_sessions_v1" as const;
const IDLE_TTL_MS = 30 * 60 * 1000;
const HARD_TTL_MS = 8 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_ENGINE_OUTPUT_BYTES = 512 * 1024;
const MAX_PAGE_OUTPUT_CHARS = 32_768;
const MAX_ENGINE_PAGE_OUTPUT_CHARS = 128 * 1024;
const ENGINE_REVISION = "agent-browser:v0.35.0-kestrel.1+chrome:152.0.7977.54";
const TERMINAL_STATES = new Set(["closed", "expired", "lost", "failed"]);
const AGENT_BROWSER_INTERNAL_SHUTDOWN_ACTION =
  "__agent_browser_internal_shutdown";
const AGENT_BROWSER_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_BROWSER_TABS = 100;
const BROWSER_DOWNLOAD_RETENTION_MS = 30 * 60 * 1000;
const BROWSER_DOWNLOAD_GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DESKTOP_BROWSER_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DESKTOP_BROWSER_INPUT_LEASE_MS = 30_000;
const DESKTOP_BROWSER_VIEWER_CAPTURE_TIMEOUT_MS = 5000;

export interface DesktopBrowserAuthorityResolutionInput {
  runId: string;
  threadId: string;
  projectId?: string | undefined;
  mode: "qa" | "operator";
  destination?: string | undefined;
}

export interface DesktopBrowserAuthorityResolver {
  resolve(
    input: DesktopBrowserAuthorityResolutionInput,
  ): Promise<BrowserEffectiveDomainAuthorityV1>;
  resolveForPersonalRevision?(
    input: DesktopBrowserAuthorityResolutionInput & {
      accountId: string;
      environmentId: string;
    },
  ): Promise<{
    authority: BrowserEffectiveDomainAuthorityV1;
    personalRevision: number;
  }>;
  rememberPersonalDomain?(
    input: DesktopBrowserAuthorityResolutionInput & {
      destination: string;
      approvalId: string;
    },
  ): Promise<BrowserEffectiveDomainAuthorityV1>;
}

export interface DesktopBrowserEngineCommandResult {
  stdout: string;
  stderr: string;
}

export interface DesktopBrowserAcceptedOperation {
  readonly sessionId: string;
  readonly operationId: string;
  readonly grantGeneration: number;
  readonly acceptanceToken: string;
}

export interface DesktopBrowserInterceptedDownload {
  readonly downloadId: string;
  readonly browserGuid: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly normalizedSourceOrigin: string;
  readonly measuredBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ownedPath: string;
}

export interface DesktopBrowserUploadStreamHook {
  open(input: {
    operationId: string;
    threadId: string;
    sessionId: string;
    generation: number;
    attachmentId: string;
    maximumBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<AsyncIterable<Uint8Array>>;
}

export interface DesktopBrowserEngineAdapter {
  acceptOperation(
    input: DesktopBrowserEngineInvocation & {
      operationId: string;
      grantGeneration: number;
    },
  ): Promise<DesktopBrowserAcceptedOperation>;
  releaseOperation(operation: DesktopBrowserAcceptedOperation): void;
  open(
    input: DesktopBrowserEngineInvocation & {
      destination: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<void>;
  command(
    input: DesktopBrowserEngineInvocation & {
      command: readonly string[];
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<DesktopBrowserEngineCommandResult>;
  describeFileInput?(
    input: DesktopBrowserEngineInvocation & {
      targetRef: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<{ targetRef: string; targetLabel: string }>;
  uploadFile?(
    input: DesktopBrowserEngineInvocation & {
      targetRef: string;
      ownedPath: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
      signal?: AbortSignal | undefined;
    },
  ): Promise<void>;
  close(
    input: DesktopBrowserEngineInvocation & {
      acceptedOperation?: DesktopBrowserAcceptedOperation | undefined;
    },
  ): Promise<void>;
  watchForLoss?(
    input: DesktopBrowserEngineInvocation,
    onLost: () => void,
  ): () => void;
  captureViewerFrame?(
    input: DesktopBrowserEngineInvocation,
  ): Promise<{ mediaType: "image/png"; dataBase64: string }>;
  captureScreenshot?(
    input: DesktopBrowserEngineInvocation & {
      fullPage: boolean;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<{ mediaType: "image/png"; dataBase64: string }>;
  dispatchViewerInput?(
    input: DesktopBrowserEngineInvocation & {
      viewerInput: DesktopBrowserViewerInputV1;
    },
  ): Promise<void>;
  presentNativeHandoff?(
    input: DesktopBrowserEngineInvocation & {
      authority: DesktopBrowserNativeHandoffAuthority;
    },
  ): Promise<DesktopBrowserNativeHandoffPresentation>;
  revokeNativeHandoff?(
    input: DesktopBrowserEngineInvocation & {
      authority: DesktopBrowserNativeHandoffAuthority;
      presentation: DesktopBrowserNativeHandoffPresentation;
    },
  ): Promise<void>;
}

export interface DesktopBrowserNativeHandoffAuthority {
  sessionId: string;
  generation: number;
  threadId: string;
  projectId: string;
  principalId: string;
  connectionId: string;
  leaseId: string;
  expiresAt: string;
}

export interface DesktopBrowserNativeHandoffPresentation {
  windowId: number;
  targetId: string;
}

export type DesktopBrowserMetricName =
  | "browser_startup"
  | "browser_revision_adoption"
  | "browser_destination_blocked"
  | "browser_target_stale"
  | "browser_session_expired"
  | "browser_engine_crash"
  | "browser_unknown_outcome"
  | "browser_screenshot"
  | "browser_cleanup";

export interface DesktopBrowserMetric {
  version: "desktop_browser_metric_v1";
  name: DesktopBrowserMetricName;
  at: string;
  mode?: "qa" | "operator" | undefined;
  operation?: string | undefined;
  outcome?: "success" | "failure" | undefined;
  reason?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
}

export interface DesktopBrowserMetricSink {
  record(metric: DesktopBrowserMetric): void;
}

export type DesktopBrowserViewerEventName =
  | "request"
  | "acceptance"
  | "lease_issue"
  | "lease_renewal"
  | "disconnect"
  | "return"
  | "rejection"
  | "expiry"
  | "authorization_loss"
  | "cleanup";

export type DesktopBrowserViewerEventReason =
  | "principal_conflict"
  | "lease_conflict"
  | "request_missing"
  | "connection_identity"
  | "project_identity"
  | "qa_authority_changed"
  | "authority_changed"
  | "session_expired"
  | "input_lease"
  | "principal_changed"
  | Exclude<BrowserSessionV1["terminalReason"], undefined>;

export interface DesktopBrowserViewerEventV1 {
  version: "desktop_browser_viewer_event_v1";
  name: DesktopBrowserViewerEventName;
  at: string;
  sessionId: string;
  generation: number;
  threadId: string;
  projectId: string;
  reason?: DesktopBrowserViewerEventReason | undefined;
}

export interface DesktopBrowserViewerEventSink {
  record(event: DesktopBrowserViewerEventV1): void;
  flush?(): Promise<void>;
}

export interface DesktopBrowserEngineInvocation {
  sessionId: string;
  runtimePath: string;
  socketPath: string;
  profilePath: string;
  configPath: string;
  screenshotPath: string;
  blockedDownloadPath: string;
  proxy: LocalCoreBrowserEgressLaunchBindingV1;
  nativeAuthenticationHandoff?: boolean | undefined;
  launchProcessGroupId?: number | undefined;
  daemonPid?: number | undefined;
  onDownloadIntercepted?:
    | ((download: DesktopBrowserInterceptedDownload) => void | Promise<void>)
    | undefined;
  getDownloadQuarantineUsage?:
    | (() => { count: number; measuredBytes: number })
    | undefined;
  stopDownloadInterception?: (() => void) | undefined;
  synchronizeDownloads?: (() => Promise<void>) | undefined;
}

export interface DesktopBrowserServiceOptions {
  homePath: string;
  engineExecutablePath: string;
  chromeExecutablePath: string;
  projectRunRegistry: Pick<DesktopProjectRunRegistry, "resolvePreviewUrl">;
  authorityResolver?: DesktopBrowserAuthorityResolver | undefined;
  engine?: DesktopBrowserEngineAdapter | undefined;
  createProxy?: typeof createLocalCoreBrowserEgressProxy | undefined;
  attachmentStore?:
    | (Pick<DesktopAttachmentStore, "importPath" | "list"> &
        Partial<Pick<DesktopAttachmentStore, "resolve">>)
    | undefined;
  uploadStream?: DesktopBrowserUploadStreamHook | undefined;
  metrics?: DesktopBrowserMetricSink | undefined;
  viewerEvents?: DesktopBrowserViewerEventSink | undefined;
  nativeAuthenticationHandoff?: boolean | undefined;
  now?: (() => Date) | undefined;
  randomId?: (() => string) | undefined;
  scheduleExpiry?: boolean | undefined;
  withAuthorityAdmission?:
    | (<T>(action: () => Promise<T>) => Promise<T>)
    | undefined;
  writeLedger?:
    | ((ledgerPath: string, ledger: DesktopBrowserLedgerV1) => Promise<void>)
    | undefined;
  /**
   * Hosted Browser supplies its control-plane-owned Session and exact QA target.
   * The local ledger remains ephemeral execution state, never session authority.
   */
  hostedSession?:
    | {
        session: BrowserSessionV1;
        resolveQaDestination(input: {
          target: Record<string, unknown>;
          authority: BrowserHostExecutionAuthorityV1;
        }): {
          destination: string;
          targetIdentity: string;
          authority: QaRunAuthority;
        };
      }
    | undefined;
}

interface DesktopBrowserLedgerV1 {
  version: typeof LEDGER_VERSION;
  sessions: BrowserSessionV1[];
  artifacts: PendingArtifact[];
}

interface SnapshotAuthority {
  snapshotId: string;
  documentRevision: string;
  tabId: string;
}

interface ActiveDesktopBrowserRuntime {
  session: BrowserSessionV1;
  targetIdentity: string;
  destination: string;
  authority: BrowserEffectiveDomainAuthorityV1;
  qaRunAuthority?: QaRunAuthority | undefined;
  proxy: LocalCoreBrowserEgressProxy;
  engine: DesktopBrowserEngineInvocation;
  snapshots: Map<string, SnapshotAuthority>;
  operations: Map<string, Promise<unknown>>;
  operationTail: Promise<void>;
  continuations: Map<string, BrowserContinuation>;
  interceptedDownloads: DesktopBrowserInterceptedDownload[];
  interceptedDownloadCount: number;
  downloadExpiryTimers: Map<string, ReturnType<typeof setTimeout>>;
  authorityResolutionDepth: number;
  takeoverRequested: boolean;
  viewerConnections: Map<string, DesktopBrowserViewerConnection>;
  activeInputLease?: DesktopBrowserInputLease | undefined;
  nativeHandoff?: DesktopBrowserActiveNativeHandoff | undefined;
  viewerFrameSequence: number;
  terminationRequested?: BrowserSessionV1["terminalReason"] | undefined;
  stopWatchingEngine?: (() => void) | undefined;
  expiryTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface DesktopBrowserViewerConnection {
  connectionId: string;
  principalId: string;
  projectId: string;
  connectedAt: string;
}

interface DesktopBrowserInputLease {
  leaseId: string;
  connectionId: string;
  expiresAt: string;
}

interface DesktopBrowserActiveNativeHandoff {
  authority: DesktopBrowserNativeHandoffAuthority;
  presentation: DesktopBrowserNativeHandoffPresentation;
  expiryTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface BrowserContinuation {
  operation: "browser.snapshot" | "browser.inspect";
  chunks: string[];
  index: number;
  base: Record<string, unknown>;
}

interface PendingArtifact {
  runId: string;
  threadId: string;
  callId: string;
  toolName: "browser.capture" | "browser.download";
  sessionId: string;
  authorization: BrowserAuthorizedArtifactV1;
}

interface QaRunAuthority {
  runId: string;
  urlId: string;
  projectRoot: string;
}

interface PendingOpenOperation {
  identity: string;
  promise: Promise<unknown>;
}

export class DesktopBrowserService implements BrowserServicePort {
  readonly version = BROWSER_SERVICE_PORT_VERSION;
  readonly #options: DesktopBrowserServiceOptions;
  readonly #ledgerPath: string;
  readonly #runtimeRoot: string;
  readonly #engine: DesktopBrowserEngineAdapter;
  readonly #active = new Map<string, ActiveDesktopBrowserRuntime>();
  readonly #artifacts = new Map<string, PendingArtifact>();
  readonly #openOperations = new Map<string, PendingOpenOperation>();
  #sessions: BrowserSessionV1[] = [];
  #generation = 1;
  #mutation = Promise.resolve();
  #ledgerWrites = Promise.resolve();
  #initialized = false;

  constructor(options: DesktopBrowserServiceOptions) {
    this.#options = options;
    this.#ledgerPath = path.join(options.homePath, "browser", "sessions.json");
    this.#runtimeRoot = path.join(options.homePath, "browser", "runtime");
    this.#engine =
      options.engine ??
      new AgentBrowserCliAdapter({
        engineExecutablePath: requireAbsolutePath(
          options.engineExecutablePath,
          "agent-browser executable",
        ),
        chromeExecutablePath: requireAbsolutePath(
          options.chromeExecutablePath,
          "Chrome executable",
        ),
      });
  }

  async initialize(): Promise<void> {
    await this.#serialize(async () => {
      if (this.#initialized) return;
      const ledger = await readLedger(this.#ledgerPath);
      this.#sessions = ledger.sessions;
      for (const artifact of ledger.artifacts) {
        this.#artifacts.set(artifact.authorization.id, artifact);
      }
      this.#generation =
        Math.max(0, ...this.#sessions.map((session) => session.generation)) + 1;
      const now = this.#now().toISOString();
      let changed = false;
      for (const session of this.#sessions) {
        const terminal = TERMINAL_STATES.has(session.state);
        await this.#cleanupOrphan(session);
        if (terminal) continue;
        changed = true;
        session.state = "lost";
        session.terminalReason = "BROWSER_SESSION_LOST";
        session.updatedAt = now;
      }
      if (changed) await this.#persist();
      this.#initialized = true;
    });
  }

  async close(): Promise<void> {
    const candidates = [...this.#active.values()];
    await this.#closeAuthorityCandidates(candidates);
    try {
      await this.#options.viewerEvents?.flush?.();
    } catch {
      // Viewer evidence flushing cannot change Browser shutdown behavior.
    }
  }

  async closeAuthority(input: {
    accountId?: string | undefined;
    environmentId?: string | undefined;
    projectIds?: readonly string[] | undefined;
  }): Promise<number> {
    await this.#requireInitialized();
    const projectIds =
      input.projectIds === undefined ? undefined : new Set(input.projectIds);
    const candidates = [...this.#active.values()].filter(
      (runtime) =>
        (input.accountId === undefined ||
          runtime.authority.userId === input.accountId) &&
        (input.environmentId === undefined ||
          runtime.authority.environmentId === input.environmentId) &&
        (projectIds === undefined ||
          (runtime.authority.projectId !== undefined &&
            projectIds.has(runtime.authority.projectId))),
    );
    await this.#closeAuthorityCandidates(candidates);
    return candidates.length;
  }

  async connectViewer(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId?: string | undefined;
    generation?: number | undefined;
    connectionId?: string | undefined;
  }): Promise<DesktopBrowserViewerStateV1> {
    await this.#requireInitialized();
    return await this.#serialize(async () => {
      const principalId = requireText(input.principalId, "viewer principalId");
      const threadId = requireText(input.threadId, "viewer threadId");
      const projectId = requireText(input.projectId, "viewer projectId");
      const matches = [...this.#active.values()].filter(
        (runtime) => runtime.session.threadId === threadId,
      );
      if (matches.length === 0) {
        return {
          version: DESKTOP_BROWSER_VIEWER_STATE_VERSION,
          available: false,
          threadId,
          projectId,
        };
      }
      if (matches.length !== 1) {
        throw browserFailure(
          "BROWSER_SESSION_CONFLICT",
          "The Thread has conflicting Browser Sessions.",
        );
      }
      const runtime = matches[0]!;
      await this.#assertViewerAuthority(runtime, projectId);
      const expectedIdentityPresent =
        input.sessionId !== undefined ||
        input.generation !== undefined ||
        input.connectionId !== undefined;
      if (expectedIdentityPresent) {
        const exactIdentityPresent =
          input.sessionId !== undefined &&
          input.generation !== undefined &&
          input.connectionId !== undefined;
        const expectedConnectionId =
          input.connectionId === undefined
            ? undefined
            : requireText(input.connectionId, "viewer connectionId");
        const expectedConnection =
          expectedConnectionId === undefined
            ? undefined
            : runtime.viewerConnections.get(expectedConnectionId);
        const expectedSessionTerminal =
          input.sessionId !== undefined &&
          input.generation !== undefined &&
          runtime.session.sessionId !== input.sessionId &&
          this.#sessions.some(
            (session) =>
              session.sessionId === input.sessionId &&
              session.threadId === threadId &&
              session.generation === input.generation &&
              TERMINAL_STATES.has(session.state),
          );
        if (expectedSessionTerminal) {
          return {
            version: DESKTOP_BROWSER_VIEWER_STATE_VERSION,
            available: false,
            threadId,
            projectId,
          };
        }
        if (
          !exactIdentityPresent ||
          runtime.session.sessionId !== input.sessionId ||
          runtime.session.generation !== input.generation
        ) {
          this.#viewerEvent(runtime, "rejection", "connection_identity");
          throw browserFailure(
            "BROWSER_SESSION_LOST",
            "The Browser viewer expected identity is no longer current.",
          );
        }
        if (
          expectedConnection === undefined &&
          runtime.viewerConnections.size === 0
        ) {
          const proposed = {
            connectionId: expectedConnectionId!,
            principalId,
            projectId,
            connectedAt: this.#now().toISOString(),
          };
          runtime.viewerConnections.set(proposed.connectionId, proposed);
          await this.#expireViewerLease(runtime);
          return this.#viewerState(runtime, proposed);
        }
        if (
          expectedConnection === undefined &&
          runtime.viewerConnections.size > 0
        ) {
          this.#viewerEvent(runtime, "rejection", "connection_identity");
          await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
          throw browserFailure(
            "BROWSER_SESSION_LOST",
            "A different Browser viewer connection retained authority.",
          );
        }
        if (
          expectedConnection?.principalId !== principalId ||
          expectedConnection.projectId !== projectId
        ) {
          this.#viewerEvent(runtime, "rejection", "connection_identity");
          throw browserFailure(
            "BROWSER_SESSION_LOST",
            "The Browser viewer expected identity is no longer current.",
          );
        }
      }
      if (!expectedIdentityPresent && runtime.viewerConnections.size > 0) {
        this.#viewerEvent(runtime, "rejection", "connection_identity");
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
        return {
          version: DESKTOP_BROWSER_VIEWER_STATE_VERSION,
          available: false,
          threadId,
          projectId,
        };
      }
      const conflicting = [...runtime.viewerConnections.values()].find(
        (connection) => connection.principalId !== principalId,
      );
      if (conflicting !== undefined) {
        this.#viewerEvent(runtime, "rejection", "principal_conflict");
        throw browserFailure(
          "BROWSER_SESSION_CONFLICT",
          "The Browser viewer is already bound to another principal.",
        );
      }
      let connection = [...runtime.viewerConnections.values()].find(
        (candidate) => candidate.principalId === principalId,
      );
      if (connection === undefined) {
        connection = {
          connectionId: `browser-viewer-${this.#id()}`,
          principalId,
          projectId,
          connectedAt: this.#now().toISOString(),
        };
        runtime.viewerConnections.set(connection.connectionId, connection);
      }
      await this.#expireViewerLease(runtime);
      return this.#viewerState(runtime, connection);
    });
  }

  async readViewerFrame(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<DesktopBrowserViewerFrameV1> {
    const queuedRuntime = this.#requireRuntime(input.sessionId, input.threadId);
    const frame = queuedRuntime.operationTail.then(async () => {
      const { runtime } = await this.#requireViewerConnection(input);
      if (runtime !== queuedRuntime) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer runtime changed before frame capture.",
        );
      }
      const capture = this.#engine.captureViewerFrame;
      if (capture === undefined) {
        throw browserFailure(
          "BROWSER_SERVICE_UNAVAILABLE",
          "The Browser engine does not support transient viewer frames.",
        );
      }
      let captured: { mediaType: "image/png"; dataBase64: string };
      try {
        captured = await capture.call(this.#engine, runtime.engine);
      } catch (error) {
        if (isEngineLost(error)) {
          await this.#loseRuntime(runtime);
        }
        throw normalizeBrowserHostFailure(error, {
          toolName: "browser.snapshot",
          dispatchAcknowledged: true,
          effectful: false,
        });
      }
      this.#assertViewerRuntimeCurrent(runtime, input.generation);
      runtime.viewerFrameSequence += 1;
      return {
        version: DESKTOP_BROWSER_VIEWER_FRAME_VERSION,
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        sequence: runtime.viewerFrameSequence,
        capturedAt: this.#now().toISOString(),
        mediaType: captured.mediaType,
        dataBase64: captured.dataBase64,
      };
    });
    queuedRuntime.operationTail = frame.then(
      () => undefined,
      () => undefined,
    );
    return await frame;
  }

  async acceptViewerTakeover(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<DesktopBrowserViewerStateV1> {
    return await this.#serialize(async () => {
      const { runtime, connection } =
        await this.#requireViewerConnection(input);
      await this.#expireViewerLease(runtime);
      const activeLease = runtime.activeInputLease;
      if (
        activeLease !== undefined &&
        activeLease.connectionId !== connection.connectionId
      ) {
        this.#viewerEvent(runtime, "rejection", "lease_conflict");
        throw browserFailure(
          "BROWSER_SESSION_CONFLICT",
          "Another viewer connection holds Browser input control.",
        );
      }
      if (
        activeLease !== undefined &&
        runtime.engine.nativeAuthenticationHandoff === true &&
        (runtime.nativeHandoff === undefined ||
          runtime.nativeHandoff.authority.sessionId !==
            runtime.session.sessionId ||
          runtime.nativeHandoff.authority.generation !==
            runtime.session.generation ||
          runtime.nativeHandoff.authority.connectionId !==
            connection.connectionId ||
          runtime.nativeHandoff.authority.leaseId !== activeLease.leaseId)
      ) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
          () => undefined,
        );
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser native handoff authority is unavailable.",
        );
      }
      if (runtime.session.state === "ready" && !runtime.takeoverRequested) {
        this.#viewerEvent(runtime, "rejection", "request_missing");
        throw browserFailure(
          "BROWSER_SERVICE_UNAVAILABLE",
          "The agent has not requested Browser takeover.",
        );
      }
      if (
        runtime.session.state !== "ready" &&
        runtime.session.state !== "human_control"
      ) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser Session cannot enter human control.",
        );
      }
      if (activeLease === undefined) {
        const lease = {
          leaseId: `browser-lease-${this.#id()}`,
          connectionId: connection.connectionId,
          expiresAt: new Date(
            this.#now().getTime() + DESKTOP_BROWSER_INPUT_LEASE_MS,
          ).toISOString(),
        };
        const wasReady = runtime.session.state === "ready";
        try {
          await this.#presentNativeHandoff(runtime, connection, lease);
        } catch (error) {
          await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
            () => undefined,
          );
          throw normalizeBrowserHostFailure(error, {
            toolName: "browser.request_takeover",
            dispatchAcknowledged: true,
            effectful: true,
          });
        }
        runtime.activeInputLease = lease;
        if (wasReady) {
          runtime.session.state = "human_control";
          runtime.takeoverRequested = false;
          this.#viewerEvent(runtime, "acceptance");
        }
        this.#viewerEvent(runtime, "lease_issue");
      }
      this.#touch(runtime);
      try {
        await this.#persist();
      } catch (error) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
          () => undefined,
        );
        throw normalizeBrowserHostFailure(error, {
          toolName: "browser.request_takeover",
          dispatchAcknowledged: true,
          effectful: true,
        });
      }
      return this.#viewerState(runtime, connection);
    });
  }

  async renewViewerInputLease(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
    leaseId: string;
  }): Promise<DesktopBrowserViewerStateV1> {
    return await this.#serialize(async () => {
      const { runtime, connection } =
        await this.#requireViewerConnection(input);
      const lease = await this.#requireViewerLease(
        runtime,
        connection,
        input.leaseId,
      );
      lease.expiresAt = new Date(
        this.#now().getTime() + DESKTOP_BROWSER_INPUT_LEASE_MS,
      ).toISOString();
      if (runtime.nativeHandoff !== undefined) {
        runtime.nativeHandoff.authority = {
          ...runtime.nativeHandoff.authority,
          expiresAt: lease.expiresAt,
        };
        this.#scheduleNativeHandoffExpiry(runtime);
      }
      this.#viewerEvent(runtime, "lease_renewal");
      return this.#viewerState(runtime, connection);
    });
  }

  async sendViewerInput(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
    leaseId: string;
    viewerInput: DesktopBrowserViewerInputV1;
  }): Promise<DesktopBrowserViewerStateV1> {
    return await this.#serialize(async () => {
      const { runtime, connection } =
        await this.#requireViewerConnection(input);
      await this.#requireViewerLease(runtime, connection, input.leaseId);
      const dispatch = this.#engine.dispatchViewerInput;
      if (dispatch === undefined) {
        throw browserFailure(
          "BROWSER_SERVICE_UNAVAILABLE",
          "The Browser engine does not support typed viewer input.",
        );
      }
      try {
        await dispatch.call(this.#engine, {
          ...runtime.engine,
          viewerInput: input.viewerInput,
        });
      } catch (error) {
        if (isEngineLost(error)) {
          await this.#loseRuntime(runtime, true);
        }
        throw normalizeBrowserHostFailure(error, {
          toolName: "browser.request_takeover",
          dispatchAcknowledged: true,
          effectful: true,
        });
      }
      this.#assertViewerRuntimeCurrent(runtime, input.generation);
      this.#touch(runtime);
      await this.#persist();
      return this.#viewerState(runtime, connection);
    });
  }

  async returnViewerControl(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
    leaseId: string;
  }): Promise<DesktopBrowserViewerStateV1> {
    return await this.#serialize(async () => {
      const { runtime, connection } =
        await this.#requireViewerConnection(input);
      await this.#requireViewerLease(runtime, connection, input.leaseId);
      try {
        await this.#revokeNativeHandoff(runtime);
      } catch (error) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
          () => undefined,
        );
        throw normalizeBrowserHostFailure(error, {
          toolName: "browser.request_takeover",
          dispatchAcknowledged: true,
          effectful: true,
        });
      }
      runtime.activeInputLease = undefined;
      runtime.takeoverRequested = false;
      runtime.session.state = "ready";
      this.#touch(runtime);
      const returned = this.#viewerState(runtime, connection);
      runtime.viewerConnections.delete(connection.connectionId);
      await this.#persist();
      this.#viewerEvent(runtime, "return");
      return returned;
    });
  }

  async disconnectViewer(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<void> {
    await this.#serialize(async () => {
      const { runtime, connection } =
        await this.#requireViewerConnection(input);
      if (runtime.activeInputLease?.connectionId === connection.connectionId) {
        try {
          await this.#revokeNativeHandoff(runtime);
        } catch {
          await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
            () => undefined,
          );
          return;
        }
      }
      runtime.viewerConnections.delete(connection.connectionId);
      if (runtime.activeInputLease?.connectionId === connection.connectionId) {
        runtime.activeInputLease = undefined;
      }
      this.#viewerEvent(runtime, "disconnect");
    });
  }

  async cleanupViewerConnection(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<void> {
    await this.#requireInitialized();
    await this.#serialize(async () => {
      const sessionId = requireText(input.sessionId, "viewer sessionId");
      const threadId = requireText(input.threadId, "viewer threadId");
      const projectId = requireText(input.projectId, "viewer projectId");
      const principalId = requireText(input.principalId, "viewer principalId");
      const connectionId = requireText(
        input.connectionId,
        "viewer connectionId",
      );
      const runtime = this.#active.get(sessionId);
      if (
        runtime === undefined ||
        runtime.session.threadId !== threadId ||
        runtime.session.generation !== input.generation ||
        runtime.authority.projectId !== projectId
      ) {
        const terminal = this.#sessions.find(
          (session) =>
            session.sessionId === sessionId &&
            session.threadId === threadId &&
            session.generation === input.generation &&
            TERMINAL_STATES.has(session.state),
        );
        if (terminal !== undefined || runtime === undefined) return;
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer cleanup identity is no longer current.",
        );
      }
      const connection = runtime.viewerConnections.get(connectionId);
      if (connection === undefined) return;
      if (
        connection.principalId !== principalId ||
        connection.projectId !== projectId
      ) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer cleanup identity does not match the connection.",
        );
      }
      if (runtime.activeInputLease?.connectionId === connectionId) {
        try {
          await this.#revokeNativeHandoff(runtime);
        } catch (error) {
          await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
            () => undefined,
          );
          throw normalizeBrowserHostFailure(error, {
            toolName: "browser.request_takeover",
            dispatchAcknowledged: true,
            effectful: true,
          });
        }
        runtime.activeInputLease = undefined;
      }
      runtime.viewerConnections.delete(connectionId);
      this.#viewerEvent(runtime, "cleanup");
    });
  }

  async loseViewerAuthority(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<void> {
    await this.#requireInitialized();
    const sessionId = requireText(input.sessionId, "viewer sessionId");
    const threadId = requireText(input.threadId, "viewer threadId");
    const projectId = requireText(input.projectId, "viewer projectId");
    const principalId = requireText(input.principalId, "viewer principalId");
    const connectionId = requireText(input.connectionId, "viewer connectionId");
    const active = this.#active.get(sessionId);
    if (active === undefined) {
      const terminal = this.#sessions.find(
        (session) =>
          session.sessionId === sessionId &&
          session.threadId === threadId &&
          session.generation === input.generation &&
          TERMINAL_STATES.has(session.state),
      );
      if (terminal !== undefined) return;
    }
    if (
      active !== undefined &&
      active.session.threadId === threadId &&
      active.session.generation === input.generation &&
      active.authority.projectId === projectId
    ) {
      this.#assertViewerSessionState(active);
      const selected = active.viewerConnections.get(connectionId);
      const principalMatches = selected
        ? selected.principalId === principalId &&
          selected.projectId === projectId
        : [...active.viewerConnections.values()].some(
            (connection) =>
              connection.principalId === principalId &&
              connection.projectId === projectId,
          ) ||
          (active.viewerConnections.size === 0 &&
            active.authority.userId === principalId);
      if (!principalMatches) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer authority identity is no longer current.",
        );
      }
      this.#viewerEvent(active, "authorization_loss", "principal_changed");
      await this.#requestTermination(active, "lost", "BROWSER_SESSION_LOST");
      return;
    }
    const { runtime } = await this.#requireViewerConnection(input);
    this.#viewerEvent(runtime, "authorization_loss", "principal_changed");
    await this.#requestTermination(runtime, "lost", "BROWSER_SESSION_LOST");
  }

  async closeViewerSession(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<void> {
    const { runtime } = await this.#requireViewerConnection(input);
    await this.#requestTermination(runtime, "closed", "closed_by_user");
  }

  async resolvePolicy(input: {
    version: typeof BROWSER_POLICY_RESOLUTION_VERSION;
    runId: string;
    threadId: string;
    operation: "browser.request_grant";
    effectiveInput: Record<string, unknown>;
    authority: BrowserOperationLifecycleV1["authority"];
  }): Promise<BrowserPolicyResolutionV1> {
    await this.#requireInitialized();
    const sessionId = requireText(input.effectiveInput.sessionId, "sessionId");
    const destination = requireText(
      input.effectiveInput.destination,
      "destination",
    );
    const runtime = this.#requireRuntime(sessionId, input.threadId);
    const generation = requireGeneration(input.effectiveInput.generation);
    if (generation !== runtime.session.generation) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser policy generation does not match the active Session.",
      );
    }
    if (runtime.session.mode !== "operator") {
      return {
        version: BROWSER_POLICY_RESOLUTION_VERSION,
        decision: "deny",
        policyRevision: runtime.session.effectiveAllowlistRevision,
        sessionMode: runtime.session.mode,
      };
    }
    const authority = await this.#resolveCurrentAuthority(runtime, {
      runId: input.runId,
      threadId: input.threadId,
      projectId: input.authority.projectId,
      mode: runtime.session.mode,
      destination,
    });
    const allowed = effectiveBrowserAuthorityAllowsPublicDestination(
      authority,
      destination,
    );
    return {
      version: BROWSER_POLICY_RESOLUTION_VERSION,
      decision: allowed
        ? "allow"
        : authority.personalGrantsEnabled
          ? "approval_required"
          : "deny",
      policyRevision: authority.effectiveAllowlistRevision,
      sessionMode: runtime.session.mode,
    };
  }

  async prepareUpload(
    input: BrowserUploadPreparationRequestV1,
  ): Promise<BrowserUploadPreparedEffectV1> {
    await this.#requireInitialized();
    if (input.version !== BROWSER_UPLOAD_PREPARATION_VERSION) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Browser upload preparation is invalid.",
      );
    }
    const sessionId = requireText(input.effectiveInput.sessionId, "sessionId");
    const generation = requireGeneration(input.effectiveInput.generation);
    const snapshotId = requireText(
      input.effectiveInput.snapshotId,
      "snapshotId",
    );
    const targetRef = requireEngineRef(
      requireText(input.effectiveInput.targetRef, "targetRef"),
    );
    const attachmentId = requireText(
      input.effectiveInput.attachmentId,
      "attachmentId",
    );
    const runtime = this.#requireRuntime(sessionId, input.threadId);
    if (
      generation !== runtime.session.generation ||
      attachmentId !== input.attachment.attachmentId
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "Browser upload preparation authority is stale.",
      );
    }
    const resolved = await this.#resolveUploadAttachment(
      input.threadId,
      input.attachment,
    );
    const operation = runtime.operationTail.then(async () => {
      await this.#assertUsable(runtime, false);
      const accepted = await this.#engine.acceptOperation({
        ...runtime.engine,
        operationId: `prepare-upload:${input.runId}:${this.#id()}`,
        grantGeneration: runtime.session.generation,
      });
      try {
        const snapshot = await this.#revalidateUploadTarget(
          runtime,
          snapshotId,
          targetRef,
          accepted,
        );
        return {
          version: BROWSER_UPLOAD_PREPARATION_VERSION,
          turnId: input.turnId,
          threadId: input.threadId,
          attachmentId,
          filename: resolved.filename,
          declaredMediaType:
            resolved.declaredMediaType ?? "application/octet-stream",
          detectedMediaType: resolved.detectedMediaType ?? resolved.mimeType,
          sizeBytes: resolved.sizeBytes,
          sha256: resolved.sha256,
          sessionId,
          generation,
          snapshotId,
          documentRevision: snapshot.documentRevision,
          targetRef,
          targetLabel: snapshot.targetLabel,
        } satisfies BrowserUploadPreparedEffectV1;
      } finally {
        this.#engine.releaseOperation(accepted);
      }
    });
    runtime.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async prepareDownload(
    input: BrowserDownloadPreparationRequestV1,
  ): Promise<BrowserDownloadPreparedEffectV1> {
    await this.#requireInitialized();
    if (input.version !== BROWSER_DOWNLOAD_PREPARATION_VERSION) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Browser download preparation is invalid.",
      );
    }
    const sessionId = requireText(input.effectiveInput.sessionId, "sessionId");
    const generation = requireGeneration(input.effectiveInput.generation);
    const pendingDownloadId = requireText(
      input.effectiveInput.pendingDownloadId,
      "pendingDownloadId",
    );
    const runtime = this.#requireRuntime(sessionId, input.threadId);
    if (generation !== runtime.session.generation) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "Browser download preparation authority is stale.",
      );
    }
    await this.#assertUsable(runtime, false);
    const download = await this.#requirePendingDownload(
      runtime,
      pendingDownloadId,
    );
    return this.#downloadPreparedEffect(runtime, download);
  }

  async openPreparedDownload(
    effectValue: BrowserDownloadPreparedEffectV1,
  ): Promise<NodeJS.ReadableStream> {
    await this.#requireInitialized();
    const effect = parseBrowserDownloadPreparedEffectV1(effectValue);
    const runtime = this.#requireRuntime(effect.sessionId, effect.threadId);
    if (runtime.session.generation !== effect.generation) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "Browser download authority is stale.",
      );
    }
    const download = await this.#requirePendingDownload(
      runtime,
      effect.pendingDownloadId,
    );
    if (hashCanonicalDownload(download) !== hashCanonicalDownload(effect)) {
      throw this.#downloadUnavailable();
    }
    const handle = await openExactOwnedBrowserDownload(
      download.ownedPath,
      effect.measuredBytes,
    );
    if ((await handle.stat()).size !== effect.measuredBytes) {
      await handle.close();
      throw this.#downloadUnavailable();
    }
    return handle.createReadStream({ autoClose: true });
  }

  async removePreparedDownload(
    effectValue: BrowserDownloadPreparedEffectV1,
  ): Promise<void> {
    await this.#requireInitialized();
    const effect = parseBrowserDownloadPreparedEffectV1(effectValue);
    const runtime = this.#requireRuntime(effect.sessionId, effect.threadId);
    if (runtime.session.generation !== effect.generation) return;
    const download = await this.#requirePendingDownload(
      runtime,
      effect.pendingDownloadId,
    );
    if (hashCanonicalDownload(download) !== hashCanonicalDownload(effect)) {
      throw this.#downloadUnavailable();
    }
    await this.#removePendingDownload(runtime, effect.pendingDownloadId);
  }

  async releasePreparedDownload(
    prepared: PreparedToolCallV1,
    authority?: BrowserHostExecutionAuthorityV1,
  ): Promise<void> {
    if (prepared.activation.descriptor.toolId !== "browser.download") {
      throw this.#downloadUnavailable();
    }
    const adapters = prepared.inputAdapters.filter(
      (adapter) => adapter.adapterId === "kestrel.browser-download-effect:v1",
    );
    if (adapters.length !== 1) throw this.#downloadUnavailable();
    const effect = parseBrowserDownloadPreparedEffectV1(adapters[0]!.metadata);
    if (authority && effect.threadId !== authority.threadId) {
      throw this.#downloadUnavailable();
    }
    const runtime = this.#active.get(effect.sessionId);
    if (!runtime || runtime.session.generation !== effect.generation) return;
    if (runtime.session.threadId !== effect.threadId) {
      throw this.#downloadUnavailable();
    }
    if (authority && runtime.authority.projectId !== authority.projectId) {
      throw this.#downloadUnavailable();
    }
    const download = runtime.interceptedDownloads.find(
      (candidate) => candidate.downloadId === effect.pendingDownloadId,
    );
    if (!download) return;
    if (hashCanonicalDownload(download) !== hashCanonicalDownload(effect)) {
      throw this.#downloadUnavailable();
    }
    await this.#removePendingDownload(runtime, effect.pendingDownloadId);
  }

  async execute(
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    await this.#requireInitialized();
    const operation = prepared.activation.descriptor.toolId;
    if (!operation.startsWith("browser.")) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Invalid Browser operation.",
      );
    }
    if (operation === "browser.open") {
      const threadId = requireText(lifecycle.authority.threadId, "threadId");
      const operationKey = `${threadId}:${prepared.callId}`;
      const identity = digest({
        runId: prepared.runId,
        sessionId: prepared.sessionId,
        callId: prepared.callId,
        effectiveInput: prepared.effectiveInput,
        authority: lifecycle.authority,
      });
      const existing = this.#openOperations.get(operationKey);
      if (existing !== undefined) {
        if (existing.identity !== identity) {
          throw browserFailure(
            "BROWSER_SESSION_CONFLICT",
            "The Browser open call identity conflicts with an operation already in progress.",
          );
        }
        return await existing.promise;
      }
      const promise = (this.#options.withAuthorityAdmission ?? runDirectly)(
        () => this.#serialize(() => this.#open(prepared, lifecycle)),
      );
      const pending = { identity, promise };
      this.#openOperations.set(operationKey, pending);
      try {
        return await promise;
      } finally {
        if (this.#openOperations.get(operationKey) === pending) {
          this.#openOperations.delete(operationKey);
        }
      }
    }
    const sessionId = requireText(
      prepared.effectiveInput.sessionId,
      "sessionId",
    );
    const runtime = this.#requireRuntime(
      sessionId,
      lifecycle.authority.threadId,
    );
    const generation = requireGeneration(prepared.effectiveInput.generation);
    if (generation !== runtime.session.generation) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser operation generation does not match the active Session.",
      );
    }
    const existing = runtime.operations.get(prepared.callId);
    if (existing !== undefined) return await existing;
    const promise = runtime.operationTail.then(() =>
      this.#executeInRuntime(runtime, prepared, lifecycle),
    );
    runtime.operationTail = promise.then(
      () => undefined,
      () => undefined,
    );
    runtime.operations.set(prepared.callId, promise);
    try {
      return await promise;
    } finally {
      runtime.operations.delete(prepared.callId);
    }
  }

  async authorizeArtifact(
    input: BrowserArtifactAuthorizationRequestV1,
  ): Promise<BrowserAuthorizedArtifactV1 | undefined> {
    const pending = this.#artifacts.get(input.artifactId);
    if (
      pending === undefined ||
      pending.runId !== input.runId ||
      pending.threadId !== input.threadId ||
      pending.callId !== input.callId ||
      pending.toolName !== input.toolName ||
      pending.sessionId !== input.sessionId ||
      pending.authorization.kind !== input.artifactKind
    )
      return;
    const stored = (
      await (
        this.#options.attachmentStore ??
        new DesktopAttachmentStore(this.#options.homePath)
      ).list(input.threadId)
    ).find((attachment) => attachment.fileId === input.artifactId);
    if (
      stored === undefined ||
      stored.lifecycleState !== "ready" ||
      !attachmentMatchesAuthorization(stored, pending.authorization)
    ) {
      return;
    }
    return pending.authorization;
  }

  async adoptAllowlistRevision(input: {
    version: "browser_allowlist_adoption_v1";
    runId: string;
    threadId: string;
    sessionId: string;
    effectiveAllowlistRevision: string;
    cause: "personal_grant" | "personal_revocation";
  }): Promise<BrowserAllowlistAdoptionReceiptV1> {
    return await this.#serialize(async () => {
      const runtime = this.#requireRuntime(input.sessionId, input.threadId);
      let authority: BrowserEffectiveDomainAuthorityV1;
      try {
        authority = await this.#withRuntimeAuthorityResolution(
          runtime,
          async () =>
            await this.#resolveAuthority({
              runId: input.runId,
              threadId: input.threadId,
              projectId: runtime.authority.projectId,
              mode: runtime.session.mode,
              destination: runtime.destination,
            }),
        );
      } catch (error) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
          () => undefined,
        );
        throw error;
      }
      this.#assertCommitAllowed(runtime);
      if (
        authority.effectiveAllowlistRevision !==
        input.effectiveAllowlistRevision
      ) {
        throw browserFailure(
          "BROWSER_DESTINATION_BLOCKED",
          "The Browser authority revision changed before adoption.",
        );
      }
      const adopted = await runtime.proxy.adoptAuthority({
        threadId: runtime.session.threadId,
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        mode: runtime.session.mode,
        authority,
      });
      if (
        adopted.launchBinding.username !== runtime.engine.proxy.username ||
        adopted.launchBinding.password !== runtime.engine.proxy.password
      ) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser engine cannot adopt rotated proxy credentials.",
        );
      }
      runtime.engine.proxy = adopted.launchBinding;
      runtime.authority = authority;
      runtime.session.effectiveAllowlistRevision =
        authority.effectiveAllowlistRevision;
      this.#touch(runtime);
      await this.#persist();
      this.#metric("browser_revision_adoption", {
        mode: runtime.session.mode,
        operation: "browser.request_grant",
        outcome: "success",
        reason: input.cause,
        count: adopted.receipt.closedUnauthorizedConnections,
      });
      return adopted.receipt;
    });
  }

  async adoptPersonalRevision(input: {
    accountId: string;
    environmentId: string;
    personalRevision: number;
    threadId?: string | undefined;
    sessionId?: string | undefined;
  }): Promise<{
    personalRevision: number;
    closedUnauthorizedConnections: number;
  }> {
    if (
      !Number.isSafeInteger(input.personalRevision) ||
      input.personalRevision < 0
    ) {
      throw new Error("Desktop Browser personal revision is invalid.");
    }
    const transition = await this.#serialize(async () => {
      const candidates = [...this.#active.values()].filter(
        (runtime) =>
          runtime.authority.userId === input.accountId &&
          runtime.authority.environmentId === input.environmentId &&
          (input.threadId === undefined ||
            runtime.session.threadId === input.threadId) &&
          (input.sessionId === undefined ||
            runtime.session.sessionId === input.sessionId),
      );
      if (
        (input.threadId !== undefined || input.sessionId !== undefined) &&
        candidates.length !== 1
      ) {
        throw new Error(
          "The exact Desktop Browser Session is unavailable for revision adoption.",
        );
      }
      return {
        candidates,
        ...this.#holdOperationQueues(candidates),
      };
    });
    await Promise.all(transition.priorOperations);
    try {
      return await this.#serialize(async () => {
        const candidates = transition.candidates;
        if (
          candidates.some(
            (runtime) =>
              this.#active.get(runtime.session.sessionId) !== runtime,
          )
        ) {
          throw new Error(
            "Desktop Browser authority changed while revision adoption was waiting.",
          );
        }
        const resolveForPersonalRevision =
          this.#options.authorityResolver?.resolveForPersonalRevision;
        if (candidates.length > 0 && resolveForPersonalRevision === undefined) {
          await this.#terminateAuthorityCandidates(candidates);
          throw new Error(
            "Desktop Browser authority cannot prove the persisted personal revision.",
          );
        }
        let closedUnauthorizedConnections = 0;
        try {
          const resolutions = await Promise.all(
            candidates.map(async (runtime) => {
              const resolved = await this.#withRuntimeAuthorityResolution(
                runtime,
                async () =>
                  await resolveForPersonalRevision!({
                    runId: "desktop-personal-revision-adoption",
                    threadId: runtime.session.threadId,
                    projectId: runtime.authority.projectId,
                    mode: runtime.session.mode,
                    destination: runtime.destination,
                    accountId: input.accountId,
                    environmentId: input.environmentId,
                  }),
              );
              if (
                resolved.personalRevision !== input.personalRevision ||
                resolved.authority.userId !== input.accountId ||
                resolved.authority.environmentId !== input.environmentId ||
                resolved.authority.projectId !== runtime.authority.projectId
              ) {
                throw new Error(
                  "Desktop Browser revision adoption did not resolve the exact persisted authority.",
                );
              }
              return { runtime, authority: resolved.authority };
            }),
          );
          for (const { runtime, authority } of resolutions) {
            this.#assertCommitAllowed(runtime);
            if (
              runtime.session.effectiveAllowlistRevision ===
              authority.effectiveAllowlistRevision
            ) {
              runtime.authority = authority;
              this.#touch(runtime);
              continue;
            }
            const adopted = await runtime.proxy.adoptAuthority({
              threadId: runtime.session.threadId,
              sessionId: runtime.session.sessionId,
              generation: runtime.session.generation,
              mode: runtime.session.mode,
              authority,
            });
            if (
              adopted.launchBinding.username !==
                runtime.engine.proxy.username ||
              adopted.launchBinding.password !== runtime.engine.proxy.password
            )
              throw new Error(
                "Desktop Browser proxy credentials changed during adoption.",
              );
            runtime.engine.proxy = adopted.launchBinding;
            runtime.authority = authority;
            runtime.session.effectiveAllowlistRevision =
              authority.effectiveAllowlistRevision;
            closedUnauthorizedConnections +=
              adopted.receipt.closedUnauthorizedConnections;
            this.#touch(runtime);
          }
          for (const runtime of candidates) this.#assertCommitAllowed(runtime);
        } catch (error) {
          await this.#terminateAuthorityCandidates(candidates);
          throw error;
        }
        if (candidates.length > 0) await this.#persist();
        this.#metric("browser_revision_adoption", {
          operation: "browser.personal_revision",
          outcome: "success",
          reason:
            input.threadId === undefined
              ? "revocation_scope"
              : "approved_session",
          count: candidates.length,
        });
        return {
          personalRevision: input.personalRevision,
          closedUnauthorizedConnections,
        };
      });
    } finally {
      transition.release();
    }
  }

  #holdOperationQueues(candidates: readonly ActiveDesktopBrowserRuntime[]): {
    priorOperations: Promise<void>[];
    release: () => void;
  } {
    const priorOperations = candidates.map((runtime) => runtime.operationTail);
    const releases: Array<() => void> = [];
    for (const runtime of candidates) {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      runtime.operationTail = runtime.operationTail.then(() => hold);
      releases.push(release);
    }
    return {
      priorOperations,
      release: () => {
        for (const release of releases) release();
      },
    };
  }

  async #terminateAuthorityCandidates(
    candidates: readonly ActiveDesktopBrowserRuntime[],
  ): Promise<void> {
    for (const runtime of candidates) {
      if (this.#active.get(runtime.session.sessionId) !== runtime) continue;
      await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
        () => undefined,
      );
    }
  }

  async #closeAuthorityCandidates(
    candidates: readonly ActiveDesktopBrowserRuntime[],
  ): Promise<void> {
    for (const runtime of candidates) {
      if (this.#active.get(runtime.session.sessionId) === runtime) {
        if (runtime.terminationRequested !== "BROWSER_DOWNLOAD_UNAVAILABLE") {
          runtime.terminationRequested = "BROWSER_SESSION_LOST";
        }
      }
    }
    const resolving = candidates.filter(
      (runtime) => runtime.authorityResolutionDepth > 0,
    );
    for (const runtime of resolving) {
      if (this.#active.get(runtime.session.sessionId) !== runtime) continue;
      await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
    }
    const queued = candidates.filter(
      (runtime) => runtime.authorityResolutionDepth === 0,
    );
    if (queued.length === 0) return;
    await Promise.all(queued.map((runtime) => runtime.operationTail));
    await this.#serialize(async () => {
      for (const runtime of queued) {
        if (this.#active.get(runtime.session.sessionId) !== runtime) continue;
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
      }
    });
  }

  async #open(
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    const startupStartedAt = Date.now();
    let dispatched = false;
    const input = prepared.effectiveInput;
    const mode = input.mode;
    if (mode !== "qa" && mode !== "operator") {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "Browser mode is invalid.",
      );
    }
    const threadId = requireText(lifecycle.authority.threadId, "threadId");
    const target = requireRecord(input.target, "target");
    const hostedQaResolution =
      mode === "qa"
        ? this.#options.hostedSession?.resolveQaDestination({
            target,
            authority: lifecycle.authority,
          })
        : undefined;
    const qaResolution =
      mode === "qa"
        ? (hostedQaResolution ??
          (await this.#resolveQaDestination(target, lifecycle)))
        : undefined;
    const destination =
      mode === "qa"
        ? qaResolution!.destination
        : requirePublicDestination(target);
    const targetIdentity =
      mode === "qa"
        ? (hostedQaResolution?.targetIdentity ??
          `qa:${requireText(target.projectId, "target.projectId")}:${requireText(target.runId, "target.runId")}:${requireText(target.urlId, "target.urlId")}`)
        : "operator";
    const activeForThread = [...this.#active.values()].filter(
      (runtime) => runtime.session.threadId === threadId,
    );
    if (
      activeForThread.some(
        (runtime) =>
          runtime.terminationRequested !== undefined ||
          TERMINAL_STATES.has(runtime.session.state),
      )
    ) {
      throw browserFailure(
        "BROWSER_SESSION_CONFLICT",
        "The Thread Browser Session is still completing cleanup.",
      );
    }
    if (activeForThread.length > 1) {
      throw browserFailure(
        "BROWSER_SESSION_CONFLICT",
        "The Thread has conflicting active Browser Sessions.",
      );
    }
    const active = activeForThread[0];
    if (active !== undefined) {
      if (
        active.session.mode === mode &&
        active.targetIdentity === targetIdentity
      ) {
        await this.#assertUsable(active, false, true);
        if (mode === "operator") {
          await this.#refreshAuthorityBeforeDispatch(
            active,
            prepared,
            lifecycle.authority.projectId,
            true,
            destination,
          );
        }
        const output = browserOutput("browser.open", {
          outcome: "existing",
          session: { ...active.session },
        });
        await lifecycle.persistCompletedResult(output);
        return output;
      }
      throw browserFailure(
        "BROWSER_SESSION_CONFLICT",
        "The Thread already has a conflicting Browser Session.",
      );
    }
    const prior = this.#sessions.find(
      (session) =>
        session.threadId === threadId && !TERMINAL_STATES.has(session.state),
    );
    if (prior !== undefined) {
      throw browserFailure(
        "BROWSER_SESSION_CONFLICT",
        "The Thread already has a conflicting Browser Session.",
      );
    }
    const authority =
      mode === "qa"
        ? createQaAuthority({
            threadId,
            projectId: requireText(lifecycle.authority.projectId, "projectId"),
            destination,
            revision: prepared.policy.policyRevision,
          })
        : await this.#resolveAuthority({
            runId: prepared.runId,
            threadId,
            projectId: lifecycle.authority.projectId,
            mode,
            destination,
          });
    if (
      mode === "operator" &&
      !effectiveBrowserAuthorityAllowsPublicDestination(authority, destination)
    ) {
      throw this.#destinationBlocked(
        "The public destination is outside current Browser authority.",
        mode,
        "browser.open",
      );
    }
    const now = this.#now();
    const hostedSession = this.#options.hostedSession?.session;
    const sessionId = requireDesktopBrowserSessionId(
      hostedSession?.sessionId ?? `browser-${this.#id()}`,
      hostedSession
        ? "hosted Browser session ID"
        : "generated Browser session ID",
    );
    if (
      hostedSession &&
      (hostedSession.threadId !== threadId ||
        hostedSession.mode !== mode ||
        hostedSession.state !== "opening" ||
        hostedSession.effectiveAllowlistRevision !==
          authority.effectiveAllowlistRevision)
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The hosted Browser Session no longer matches its execution authority.",
        { browserOutcomeKnown: true },
      );
    }
    const session: BrowserSessionV1 = hostedSession
      ? { ...hostedSession }
      : {
          version: "browser_session_v1",
          sessionId,
          threadId,
          mode,
          state: "opening",
          engineRevision: ENGINE_REVISION,
          generation: this.#generation,
          effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
          idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS).toISOString(),
          hardExpiresAt: new Date(now.getTime() + HARD_TTL_MS).toISOString(),
        };
    this.#sessions.push(session);
    let proxy: LocalCoreBrowserEgressProxy | undefined;
    let engine: DesktopBrowserEngineInvocation | undefined;
    let runtime: ActiveDesktopBrowserRuntime | undefined;
    try {
      await this.#persist();
      const proxyInput: CreateLocalCoreBrowserEgressProxyInput = {
        threadId,
        sessionId,
        generation: session.generation,
        mode,
        authority,
      };
      proxy =
        this.#options.createProxy === undefined
          ? await createLocalCoreBrowserEgressProxy({
              ...proxyInput,
              dependencies: {
                metrics: {
                  record: (metric) => {
                    this.#metric("browser_destination_blocked", {
                      mode: metric.mode,
                      operation: `browser.egress.${metric.transport}`,
                      outcome: metric.outcome,
                      reason: metric.reason,
                    });
                  },
                },
              },
            })
          : await this.#options.createProxy(proxyInput);
      engine = await this.#prepareRuntime(sessionId, proxy.launchBinding);
      runtime = {
        session,
        targetIdentity,
        destination,
        authority,
        ...(qaResolution === undefined
          ? {}
          : { qaRunAuthority: qaResolution.authority }),
        proxy,
        engine,
        snapshots: new Map(),
        operations: new Map(),
        operationTail: Promise.resolve(),
        continuations: new Map(),
        interceptedDownloads: [],
        interceptedDownloadCount: 0,
        downloadExpiryTimers: new Map(),
        authorityResolutionDepth: 0,
        takeoverRequested: false,
        viewerConnections: new Map(),
        viewerFrameSequence: 0,
      };
      this.#active.set(sessionId, runtime);
      const activeRuntime = runtime;
      const launchedEngine = {
        ...engine,
        destination,
        onDownloadIntercepted: async (
          download: DesktopBrowserInterceptedDownload,
        ) => {
          await this.#admitDownload(runtime!, download);
        },
        getDownloadQuarantineUsage: () => ({
          count: runtime!.interceptedDownloads.length,
          measuredBytes: runtime!.interceptedDownloads.reduce(
            (total, download) => total + download.measuredBytes,
            0,
          ),
        }),
      };
      activeRuntime.engine = launchedEngine;
      const acceptedOperation = await this.#engine.acceptOperation({
        ...launchedEngine,
        operationId: prepared.callId,
        grantGeneration: session.generation,
      });
      try {
        await lifecycle.acknowledgeDispatch();
        dispatched = true;
        const priorDownloads = activeRuntime.interceptedDownloadCount;
        const openInvocation = {
          ...launchedEngine,
          acceptedOperation,
        };
        try {
          await this.#engine.open(openInvocation);
        } finally {
          activeRuntime.engine.daemonPid = openInvocation.daemonPid;
          activeRuntime.engine.launchProcessGroupId =
            openInvocation.launchProcessGroupId;
          activeRuntime.engine.stopDownloadInterception =
            openInvocation.stopDownloadInterception;
          activeRuntime.engine.synchronizeDownloads =
            openInvocation.synchronizeDownloads;
        }
        await activeRuntime.engine.synchronizeDownloads?.();
        this.#throwIfDownloadIntercepted(activeRuntime, priorDownloads);
      } finally {
        this.#engine.releaseOperation(acceptedOperation);
      }
      session.state = "ready";
      this.#assertCommitAllowed(activeRuntime);
      this.#startWatchingEngine(activeRuntime);
      this.#touch(activeRuntime);
      await this.#persist();
      this.#assertCommitAllowed(activeRuntime);
      this.#scheduleExpiry(activeRuntime);
      this.#metric("browser_startup", {
        mode,
        operation: "browser.open",
        outcome: "success",
        durationMs: Math.max(0, Date.now() - startupStartedAt),
      });
      const output = browserOutput("browser.open", {
        outcome: "opened",
        session: { ...session },
      });
      await lifecycle.persistCompletedResult(output);
      return output;
    } catch (error) {
      if (dispatched) {
        this.#recordUnknownOutcomeIfClassified(
          error,
          prepared,
          mode,
          "startup_after_dispatch",
        );
      }
      this.#metric("browser_startup", {
        mode,
        operation: "browser.open",
        outcome: "failure",
        durationMs: Math.max(0, Date.now() - startupStartedAt),
      });
      const terminalReason = isBrowserDownloadUnavailable(error)
        ? "BROWSER_DOWNLOAD_UNAVAILABLE"
        : "BROWSER_ENGINE_FAILURE";
      if (runtime !== undefined) {
        await this.#terminate(runtime, "failed", terminalReason);
      } else {
        session.state = "failed";
        session.terminalReason = terminalReason;
        session.updatedAt = this.#now().toISOString();
        await this.#persist();
        const ownedPaths = desktopBrowserOwnedPaths(
          this.#runtimeRoot,
          sessionId,
        );
        const cleanup = await Promise.allSettled([
          ...(engine === undefined
            ? []
            : [
                (async () => {
                  assertDesktopBrowserInvocationPaths(ownedPaths, engine!);
                  await this.#engine.close(engine!);
                  await removeDesktopBrowserRuntimePaths(ownedPaths);
                })(),
              ]),
          ...(proxy === undefined ? [] : [proxy.close()]),
          ...(engine === undefined
            ? [removeDesktopBrowserRuntimePaths(ownedPaths)]
            : []),
        ]);
        const cleanupFailure = cleanup.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (cleanupFailure !== undefined) throw cleanupFailure.reason;
      }
      throw error;
    }
  }

  async #executeInRuntime(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    const operation = prepared.activation.descriptor.toolId;
    if (runtime.session.state === "human_control") {
      throw browserFailure(
        "BROWSER_HUMAN_CONTROL_ACTIVE",
        "The Browser Session is under human control.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    await this.#assertUsable(runtime, operation === "browser.close");
    if (operation === "browser.close") {
      const acceptedOperation = await this.#engine.acceptOperation({
        ...runtime.engine,
        operationId: prepared.callId,
        grantGeneration: runtime.session.generation,
      });
      try {
        await lifecycle.acknowledgeDispatch();
        await this.#terminate(
          runtime,
          "closed",
          "closed_by_user",
          acceptedOperation,
        );
      } finally {
        this.#engine.releaseOperation(acceptedOperation);
      }
      const output = browserOutput("browser.close", {
        sessionId: runtime.session.sessionId,
        state: "closed",
      });
      await lifecycle.persistCompletedResult(output);
      return output;
    }
    if (operation === "browser.download") {
      return await this.#promoteDownload(runtime, prepared, lifecycle);
    }
    if (operation === "browser.request_takeover") {
      await this.#refreshAuthorityBeforeDispatch(
        runtime,
        prepared,
        lifecycle.authority.projectId,
      );
      await lifecycle.acknowledgeDispatch();
      runtime.takeoverRequested = true;
      this.#touch(runtime);
      await this.#persist();
      this.#viewerEvent(runtime, "request");
      const output = browserOutput(operation, {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        outcome: "takeover_requested",
        state: "ready",
      });
      await lifecycle.persistCompletedResult(output);
      return output;
    }
    if (operation === "browser.request_grant") {
      return await this.#requestGrant(runtime, prepared, lifecycle);
    }
    if (operation === "browser.upload") {
      return await this.#upload(runtime, prepared, lifecycle);
    }
    await this.#refreshAuthorityBeforeDispatch(
      runtime,
      prepared,
      lifecycle.authority.projectId,
    );
    await this.#preflightOperation(runtime, prepared);
    const acceptedOperation = await this.#engine.acceptOperation({
      ...runtime.engine,
      operationId: prepared.callId,
      grantGeneration: runtime.session.generation,
    });
    let output: unknown;
    try {
      await lifecycle.acknowledgeDispatch();
      await this.#refreshActivePageAuthority(
        runtime,
        prepared,
        lifecycle.authority.projectId,
        acceptedOperation,
      );
      output = await this.#runOperation(
        runtime,
        prepared,
        acceptedOperation,
        lifecycle.authority.projectId,
      );
      this.#assertCommitAllowed(runtime);
    } catch (error) {
      if (isEngineTabGone(error)) {
        if (
          isBrowserToolName(operation) &&
          resolveBrowserToolExecutionClass(
            operation,
            prepared.effectiveInput,
          ) === "external_side_effect"
        ) {
          this.#recordUnknownOutcomeIfClassified(
            error,
            prepared,
            runtime.session.mode,
            "tab_gone",
          );
          throw normalizeBrowserHostFailure(error, {
            toolName: operation,
            dispatchAcknowledged: true,
            effectful: true,
          });
        }
        this.#metric("browser_target_stale", {
          mode: runtime.session.mode,
          operation,
          outcome: "failure",
          reason: "tab_gone",
        });
        throw this.#targetStale(
          runtime,
          operation,
          "The Browser tab bound to this operation is no longer available.",
          "tab_gone",
        );
      }
      this.#recordUnknownOutcomeIfClassified(
        error,
        prepared,
        runtime.session.mode,
        isEngineLost(error) ? "engine_lost" : "engine_failure",
      );
      if (isEngineLost(error)) {
        this.#metric("browser_engine_crash", {
          mode: runtime.session.mode,
          operation,
          outcome: "failure",
          reason: "command_lost_control",
        });
        await this.#serialize(() =>
          this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST"),
        );
      }
      throw error;
    } finally {
      this.#engine.releaseOperation(acceptedOperation);
    }
    this.#touch(runtime);
    await this.#persist();
    this.#assertCommitAllowed(runtime);
    await lifecycle.persistCompletedResult(output);
    return output;
  }

  async #upload(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    const effect = requirePreparedBrowserUploadEffect(prepared);
    if (
      effect.threadId !== runtime.session.threadId ||
      effect.sessionId !== runtime.session.sessionId ||
      effect.generation !== runtime.session.generation ||
      effect.snapshotId !== prepared.effectiveInput.snapshotId ||
      effect.targetRef !== prepared.effectiveInput.targetRef ||
      effect.attachmentId !== prepared.effectiveInput.attachmentId
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The approved Browser upload authority is stale.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    await this.#resolveUploadAttachment(effect.threadId, {
      attachmentId: effect.attachmentId,
      filename: effect.filename,
      declaredMediaType: effect.declaredMediaType,
      detectedMediaType: effect.detectedMediaType,
      sizeBytes: effect.sizeBytes,
      sha256: effect.sha256,
    });
    const uploadStream = this.#options.uploadStream;
    if (uploadStream === undefined) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "The Browser attachment stream is unavailable.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    const accepted = await this.#engine.acceptOperation({
      ...runtime.engine,
      operationId: prepared.callId,
      grantGeneration: runtime.session.generation,
    });
    const ownedPath = path.join(
      runtime.engine.runtimePath,
      `upload-${this.#id()}.bin`,
    );
    let primaryFailure: unknown;
    try {
      const target = await this.#revalidateUploadTarget(
        runtime,
        effect.snapshotId,
        effect.targetRef,
        accepted,
      );
      if (
        target.documentRevision !== effect.documentRevision ||
        target.targetLabel !== effect.targetLabel
      ) {
        throw this.#targetStale(
          runtime,
          "browser.upload",
          "The Browser upload target changed after approval.",
          "approved_target",
        );
      }
      lifecycle.signal?.throwIfAborted();
      const stream = await uploadStream.open({
        operationId: prepared.callId,
        threadId: effect.threadId,
        sessionId: effect.sessionId,
        generation: effect.generation,
        attachmentId: effect.attachmentId,
        maximumBytes: DESKTOP_MAX_ATTACHMENT_BYTES,
        ...(lifecycle.signal ? { signal: lifecycle.signal } : {}),
      });
      const handle = await open(ownedPath, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const value of stream) {
          lifecycle.signal?.throwIfAborted();
          const chunk = Buffer.from(value);
          bytes += chunk.byteLength;
          if (
            bytes > DESKTOP_MAX_ATTACHMENT_BYTES ||
            bytes > effect.sizeBytes
          ) {
            throw browserFailure(
              "BROWSER_ARTIFACT_TOO_LARGE",
              "The approved Browser upload stream exceeded its exact bound.",
              { browserOutcomeKnown: true, effectDispatched: false },
            );
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
        lifecycle.signal?.throwIfAborted();
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (bytes !== effect.sizeBytes || hash.digest("hex") !== effect.sha256) {
        throw browserFailure(
          "BROWSER_SERVICE_UNAVAILABLE",
          "The approved Browser upload stream failed integrity validation.",
          { browserOutcomeKnown: true, effectDispatched: false },
        );
      }
      await this.#resolveUploadAttachment(effect.threadId, {
        attachmentId: effect.attachmentId,
        filename: effect.filename,
        declaredMediaType: effect.declaredMediaType,
        detectedMediaType: effect.detectedMediaType,
        sizeBytes: effect.sizeBytes,
        sha256: effect.sha256,
      });
      const currentTarget = await this.#revalidateUploadTarget(
        runtime,
        effect.snapshotId,
        effect.targetRef,
        accepted,
      );
      if (
        currentTarget.documentRevision !== effect.documentRevision ||
        currentTarget.targetLabel !== effect.targetLabel
      ) {
        throw this.#targetStale(
          runtime,
          "browser.upload",
          "The Browser upload target changed before dispatch.",
          "dispatch_target",
        );
      }
      if (typeof this.#engine.uploadFile !== "function") {
        throw browserFailure(
          "BROWSER_SERVICE_UNAVAILABLE",
          "The Browser engine upload operation is unavailable.",
        );
      }
      lifecycle.signal?.throwIfAborted();
      await lifecycle.acknowledgeDispatch();
      await this.#engine.uploadFile({
        ...runtime.engine,
        targetRef: effect.targetRef,
        ownedPath,
        acceptedOperation: accepted,
        ...(lifecycle.signal ? { signal: lifecycle.signal } : {}),
      });
      runtime.snapshots.clear();
      runtime.continuations.clear();
      this.#touch(runtime);
      await this.#persist();
      const output = browserOutput("browser.upload", {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        outcome: "uploaded",
        attachmentId: effect.attachmentId,
        filename: sanitizeBrowserUploadResultFilename(effect.filename),
        bytes: effect.sizeBytes,
        sha256: effect.sha256,
        targetRef: effect.targetRef,
      });
      await lifecycle.persistCompletedResult(output);
      return output;
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      this.#engine.releaseOperation(accepted);
      try {
        await rm(ownedPath, { force: true });
      } catch (cleanupError) {
        if (primaryFailure === undefined) throw cleanupError;
      }
    }
  }

  async #promoteDownload(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    const effect = requirePreparedBrowserDownloadEffect(prepared);
    if (
      effect.threadId !== runtime.session.threadId ||
      effect.sessionId !== runtime.session.sessionId ||
      effect.generation !== runtime.session.generation ||
      effect.pendingDownloadId !== prepared.effectiveInput.pendingDownloadId
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The approved Browser download authority is stale.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    const download = await this.#requirePendingDownload(
      runtime,
      effect.pendingDownloadId,
    );
    if (hashCanonicalDownload(download) !== hashCanonicalDownload(effect)) {
      throw browserFailure(
        "BROWSER_DOWNLOAD_UNAVAILABLE",
        "The quarantined Browser download changed after approval.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    const measured = await measureOwnedBrowserDownload(
      download.ownedPath,
      DESKTOP_MAX_ATTACHMENT_BYTES,
    );
    if (
      measured.measuredBytes !== effect.measuredBytes ||
      measured.sha256 !== effect.sha256
    ) {
      throw browserFailure(
        "BROWSER_DOWNLOAD_UNAVAILABLE",
        "The quarantined Browser download failed integrity validation.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    lifecycle.signal?.throwIfAborted();
    await lifecycle.acknowledgeDispatch();
    const fileId = `file-browser-${digest({
      threadId: effect.threadId,
      sessionId: effect.sessionId,
      generation: effect.generation,
      pendingDownloadId: effect.pendingDownloadId,
      operationId: prepared.callId,
    })}`;
    const imported = await (
      this.#options.attachmentStore ??
      new DesktopAttachmentStore(this.#options.homePath)
    ).importPath({
      threadId: effect.threadId,
      filename: effect.filename,
      sourcePath: download.ownedPath,
      mimeType: effect.declaredMediaType,
      sha256: effect.sha256,
      trustedFileId: fileId,
    });
    const authorization: BrowserAuthorizedArtifactV1 = {
      version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
      id: imported.fileId,
      title: effect.filename,
      kind: "browser-download",
      mediaType: imported.mimeType,
      bytes: imported.sizeBytes,
      sha256: imported.sha256,
    };
    this.#artifacts.set(imported.fileId, {
      runId: prepared.runId,
      threadId: effect.threadId,
      callId: prepared.callId,
      toolName: "browser.download",
      sessionId: effect.sessionId,
      authorization,
    });
    await this.#persist();
    const output = browserOutput("browser.download", {
      sessionId: effect.sessionId,
      generation: effect.generation,
      artifact: browserArtifactOutput(authorization),
    });
    await lifecycle.persistCompletedResult(output);
    // The durable completed result is the promotion commit boundary. A failed
    // quarantine cleanup must not turn the already committed file into an
    // unknown outcome; the retained exact item remains bounded by its timer and
    // Session teardown, and a same-call replay imports the same trusted file ID.
    await this.#removePendingDownload(runtime, effect.pendingDownloadId).catch(
      () => undefined,
    );
    return output;
  }

  async #runOperation(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    acceptedOperation: DesktopBrowserAcceptedOperation,
    projectId: string | undefined,
  ): Promise<unknown> {
    const operation = prepared.activation.descriptor.toolId;
    const input = prepared.effectiveInput;
    if (operation === "browser.snapshot") {
      const cursor =
        typeof input.cursor === "string" ? input.cursor : undefined;
      if (cursor !== undefined) {
        return this.#continueContent(runtime, operation, cursor);
      }
      const requestedTabId =
        typeof input.tabId === "string" ? requireTabId(input.tabId) : undefined;
      if (requestedTabId !== undefined) {
        await this.#selectExactTab(
          runtime,
          requestedTabId,
          operation,
          acceptedOperation,
        );
        await this.#refreshActivePageAuthority(
          runtime,
          prepared,
          projectId,
          acceptedOperation,
        );
      }
      const result = await this.#command(runtime, acceptedOperation, [
        "snapshot",
      ]);
      const page = await this.#readPageIdentity(runtime, acceptedOperation);
      await this.#applyActivePageAuthority(
        runtime,
        prepared,
        projectId,
        page.exactUrl,
        false,
      );
      const content = extractEngineContent(result);
      const snapshotId = `snapshot-${this.#id()}`;
      const documentRevision = digest({
        documentIdentity: page.documentIdentity,
        content,
      });
      if (requestedTabId !== undefined && page.tabId !== requestedTabId) {
        throw this.#targetStale(
          runtime,
          operation,
          "The requested Browser tab is no longer active.",
          "snapshot_tab",
        );
      }
      const tabId = page.tabId;
      runtime.snapshots.clear();
      runtime.continuations.clear();
      runtime.snapshots.set(snapshotId, {
        snapshotId,
        documentRevision,
        tabId,
      });
      return this.#createPagedContent(
        runtime,
        operation,
        {
          sessionId: runtime.session.sessionId,
          generation: runtime.session.generation,
          snapshotId,
          documentRevision,
          normalizedOrigin: page.origin,
          capturedAt: this.#now().toISOString(),
          boundary: "untrusted_browser_content",
          title: page.title,
        },
        content,
      );
    }
    if (operation === "browser.inspect") {
      const cursor =
        typeof input.cursor === "string" ? input.cursor : undefined;
      if (cursor !== undefined) {
        return this.#continueContent(runtime, operation, cursor);
      }
      const kind = requireText(input.kind, "kind");
      const command =
        kind === "console_errors"
          ? ["console", "--json"]
          : kind === "page_errors"
            ? ["errors", "--json"]
            : kind === "accessibility"
              ? ["a11y", "--json"]
              : ["network", "requests", "--json"];
      const result = await this.#command(runtime, acceptedOperation, command);
      const page = await this.#readPageIdentity(runtime, acceptedOperation);
      await this.#applyActivePageAuthority(
        runtime,
        prepared,
        projectId,
        page.exactUrl,
        false,
      );
      const content =
        kind === "network_summary"
          ? metadataOnlyNetworkSummary(result.stdout)
          : extractEngineContent(result);
      return this.#createPagedContent(
        runtime,
        operation,
        {
          sessionId: runtime.session.sessionId,
          generation: runtime.session.generation,
          snapshotId: `inspect-${this.#id()}`,
          documentRevision: digest({
            documentIdentity: page.documentIdentity,
            kind,
            content,
          }),
          normalizedOrigin: page.origin,
          capturedAt: this.#now().toISOString(),
          boundary: "untrusted_browser_content",
          kind,
        },
        content,
      );
    }
    if (operation === "browser.navigate") {
      const kind = requireText(input.kind, "kind");
      const command =
        kind === "url" ? ["open", requireText(input.url, "url")] : [kind];
      const priorDownloads = runtime.interceptedDownloadCount;
      await this.#command(runtime, acceptedOperation, command);
      const pendingDownload = this.#pendingDownloadSince(
        runtime,
        priorDownloads,
      );
      runtime.snapshots.clear();
      runtime.continuations.clear();
      const page = await this.#readPageIdentity(runtime, acceptedOperation);
      await this.#applyActivePageAuthority(
        runtime,
        prepared,
        projectId,
        page.exactUrl,
        true,
      );
      return browserOutput(operation, {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        outcome: "completed",
        normalizedOrigin: page.origin,
        ...(pendingDownload
          ? { pendingDownload: publicPendingBrowserDownload(pendingDownload) }
          : {}),
      });
    }
    if (operation === "browser.interact") {
      const snapshot = this.#assertSnapshotAuthority(runtime, input);
      await this.#assertCurrentSnapshotAuthority(
        runtime,
        snapshot,
        acceptedOperation,
        prepared,
        projectId,
      );
      const action = requireRecord(input.action, "action");
      const kind = requireText(action.kind, "action.kind");
      const ref =
        typeof action.ref === "string"
          ? requireEngineRef(action.ref)
          : undefined;
      const command = mapInteraction(kind, ref, action);
      const priorDownloads = runtime.interceptedDownloadCount;
      await this.#command(runtime, acceptedOperation, command);
      const pendingDownload = this.#pendingDownloadSince(
        runtime,
        priorDownloads,
      );
      await this.#refreshActivePageAuthority(
        runtime,
        prepared,
        projectId,
        acceptedOperation,
        true,
      );
      runtime.snapshots.clear();
      runtime.continuations.clear();
      return browserOutput(operation, {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        outcome: "completed",
        documentRevision: `changed-${this.#id()}`,
        ...(pendingDownload
          ? { pendingDownload: publicPendingBrowserDownload(pendingDownload) }
          : {}),
      });
    }
    if (operation === "browser.tabs") {
      const tabOperation = requireText(input.operation, "operation");
      if (tabOperation === "switch") {
        await this.#command(runtime, acceptedOperation, [
          "tab",
          requireTabId(input.tabId),
        ]);
        runtime.snapshots.clear();
        runtime.continuations.clear();
      } else if (tabOperation === "close") {
        await this.#command(runtime, acceptedOperation, [
          "tab",
          "close",
          requireTabId(input.tabId),
        ]);
        runtime.snapshots.clear();
        runtime.continuations.clear();
      }
      const result = await this.#command(runtime, acceptedOperation, [
        "tab",
        "--json",
      ]);
      await this.#refreshActivePageAuthority(
        runtime,
        prepared,
        projectId,
        acceptedOperation,
        tabOperation === "switch" || tabOperation === "close",
      );
      const parsedTabs = parseTabs(result.stdout);
      const requestedTabId =
        typeof input.tabId === "string" ? requireTabId(input.tabId) : undefined;
      return browserOutput(operation, {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        capturedAt: this.#now().toISOString(),
        boundary: "untrusted_browser_content",
        ...boundTabsForOutput(parsedTabs, requestedTabId),
      });
    }
    if (operation === "browser.capture") {
      await rm(runtime.engine.screenshotPath, { force: true });
      const captureScreenshot = this.#engine.captureScreenshot;
      if (captureScreenshot === undefined) {
        await this.#command(runtime, acceptedOperation, [
          "screenshot",
          runtime.engine.screenshotPath,
          ...(input.fullPage === true ? ["--full"] : []),
        ]);
      } else {
        const capture = await captureScreenshot.call(this.#engine, {
          ...runtime.engine,
          acceptedOperation,
          fullPage: input.fullPage === true,
        });
        await writeFile(
          runtime.engine.screenshotPath,
          Buffer.from(capture.dataBase64, "base64"),
          { mode: 0o600 },
        );
      }
      const page = await this.#readPageIdentity(runtime, acceptedOperation);
      await this.#applyActivePageAuthority(
        runtime,
        prepared,
        projectId,
        page.exactUrl,
        false,
      );
      const file = await stat(runtime.engine.screenshotPath);
      if (file.size > DESKTOP_MAX_ATTACHMENT_BYTES) {
        throw browserFailure(
          "BROWSER_ARTIFACT_TOO_LARGE",
          "The Browser screenshot exceeds the Desktop artifact limit.",
          { browserOutcomeKnown: true },
        );
      }
      const imported = await (
        this.#options.attachmentStore ??
        new DesktopAttachmentStore(this.#options.homePath)
      ).importPath({
        threadId: runtime.session.threadId,
        filename: `browser-screenshot-${this.#id()}.png`,
        sourcePath: runtime.engine.screenshotPath,
        mimeType: "image/png",
      });
      const authorization: BrowserAuthorizedArtifactV1 = {
        version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
        id: imported.fileId,
        title: "Browser screenshot",
        kind: "browser-screenshot",
        mediaType: imported.mimeType,
        bytes: imported.sizeBytes,
        sha256: imported.sha256,
      };
      this.#artifacts.set(imported.fileId, {
        runId: prepared.runId,
        threadId: runtime.session.threadId,
        callId: prepared.callId,
        toolName: "browser.capture",
        sessionId: runtime.session.sessionId,
        authorization,
      });
      await this.#persist();
      this.#metric("browser_screenshot", {
        mode: runtime.session.mode,
        operation,
        outcome: "success",
        count: 1,
      });
      return browserOutput(operation, {
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        artifact: browserArtifactOutput(authorization),
        normalizedOrigin: page.origin,
        capturedAt: this.#now().toISOString(),
        boundary: "untrusted_browser_content",
      });
    }
    throw browserFailure(
      "BROWSER_SERVICE_UNAVAILABLE",
      "Browser operation is unavailable.",
    );
  }

  async #requestGrant(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    const destination = requireText(
      prepared.effectiveInput.destination,
      "destination",
    );
    const canonical = canonicalizePublicBrowserDestination(destination);
    let authority = await this.#resolveCurrentAuthority(runtime, {
      runId: prepared.runId,
      threadId: runtime.session.threadId,
      projectId: lifecycle.authority.projectId,
      mode: runtime.session.mode,
      destination,
    });
    if (
      authority.effectiveAllowlistRevision ===
        runtime.session.effectiveAllowlistRevision &&
      effectiveBrowserAuthorityAllowsPublicDestination(authority, destination)
    ) {
      runtime.authority = authority;
      const output = browserOutput("browser.request_grant", {
        outcome: "already_allowed",
        sessionId: runtime.session.sessionId,
        canonicalWildcard: `*.${canonical.canonicalDomain}`,
        effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
      });
      await lifecycle.persistCompletedResult(output);
      return output;
    }
    await lifecycle.acknowledgeDispatch();
    await this.#installRequestGrantAuthority(runtime, authority);
    this.#assertCommitAllowed(runtime);
    let outcome: "already_allowed" | "granted";
    if (
      effectiveBrowserAuthorityAllowsPublicDestination(authority, destination)
    ) {
      outcome = "already_allowed";
    } else {
      if (
        authority.personalGrantsEnabled !== true ||
        this.#options.authorityResolver?.rememberPersonalDomain === undefined ||
        prepared.approval?.approvalId === undefined
      ) {
        throw browserFailure(
          "BROWSER_GRANT_DENIED",
          "Browser domain grant is unavailable.",
        );
      }
      authority = await this.#withRuntimeAuthorityResolution(
        runtime,
        async () =>
          await this.#options.authorityResolver!.rememberPersonalDomain!({
            runId: prepared.runId,
            threadId: runtime.session.threadId,
            projectId: runtime.authority.projectId,
            mode: runtime.session.mode,
            destination,
            approvalId: prepared.approval!.approvalId!,
          }),
      );
      this.#assertCommitAllowed(runtime);
      await this.#installRequestGrantAuthority(runtime, authority);
      outcome = "granted";
    }
    const output = browserOutput("browser.request_grant", {
      outcome,
      sessionId: runtime.session.sessionId,
      canonicalWildcard: `*.${canonical.canonicalDomain}`,
      effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
    });
    await lifecycle.persistCompletedResult(output);
    return output;
  }

  async #installRequestGrantAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    authority: BrowserEffectiveDomainAuthorityV1,
  ): Promise<void> {
    if (
      authority.userId !== runtime.authority.userId ||
      authority.environmentId !== runtime.authority.environmentId ||
      authority.projectId !== runtime.authority.projectId
    ) {
      await this.#loseRuntime(runtime);
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser grant authority belongs to another person, Environment, or Project.",
      );
    }
    if (
      authority.effectiveAllowlistRevision ===
      runtime.session.effectiveAllowlistRevision
    ) {
      runtime.authority = authority;
      return;
    }
    try {
      const adopted = await runtime.proxy.adoptAuthority({
        threadId: runtime.session.threadId,
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        mode: runtime.session.mode,
        authority,
      });
      if (
        adopted.receipt.sessionId !== runtime.session.sessionId ||
        adopted.receipt.effectiveAllowlistRevision !==
          authority.effectiveAllowlistRevision ||
        adopted.launchBinding.username !== runtime.engine.proxy.username ||
        adopted.launchBinding.password !== runtime.engine.proxy.password
      ) {
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser Session could not install the remembered domain authority.",
        );
      }
      runtime.engine.proxy = adopted.launchBinding;
      runtime.authority = authority;
      runtime.session.effectiveAllowlistRevision =
        authority.effectiveAllowlistRevision;
      this.#touch(runtime);
      await this.#persist();
      this.#metric("browser_revision_adoption", {
        mode: runtime.session.mode,
        operation: "browser.request_grant",
        outcome: "success",
        reason: "personal_grant",
        count: adopted.receipt.closedUnauthorizedConnections,
      });
    } catch (error) {
      await this.#loseRuntime(runtime);
      throw error;
    }
  }

  async #refreshActivePageAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    projectId: string | undefined,
    acceptedOperation: DesktopBrowserAcceptedOperation,
    effectDispatched = false,
  ): Promise<void> {
    const destination = await this.#readActivePageUrl(
      runtime,
      acceptedOperation,
    );
    await this.#applyActivePageAuthority(
      runtime,
      prepared,
      projectId,
      destination,
      effectDispatched,
    );
  }

  async #readActivePageUrl(
    runtime: ActiveDesktopBrowserRuntime,
    acceptedOperation: DesktopBrowserAcceptedOperation,
  ): Promise<string> {
    const result = await this.#command(runtime, acceptedOperation, [
      "get",
      "url",
      "--json",
    ]);
    const rawUrl = extractScalar(result.stdout, "url");
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported page URL scheme");
      }
      return parsed.href;
    } catch {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "Browser engine returned an invalid active page URL.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
  }

  async #applyActivePageAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    projectId: string | undefined,
    destination: string,
    effectDispatched: boolean,
  ): Promise<void> {
    this.#assertCommitAllowed(runtime);
    const operation = prepared.activation.descriptor.toolId;
    if (runtime.session.mode === "qa") {
      await this.#assertCurrentQaRunAuthority(runtime);
      let target: ReturnType<typeof canonicalizeTrustedBrowserQaTarget>;
      try {
        target = canonicalizeTrustedBrowserQaTarget(destination);
      } catch {
        throw this.#destinationBlocked(
          "The active QA page is not the exact managed target.",
          runtime.session.mode,
          operation,
          effectDispatched,
        );
      }
      const allowed = runtime.authority.qaTarget;
      if (
        allowed === null ||
        target.scheme !== allowed.scheme ||
        target.hostname !== allowed.hostname ||
        target.port !== allowed.port
      ) {
        throw this.#destinationBlocked(
          "The active QA page is not the exact managed target.",
          runtime.session.mode,
          operation,
          effectDispatched,
        );
      }
      runtime.destination = destination;
      this.#assertCommitAllowed(runtime);
      return;
    }

    const current = await this.#resolveCurrentAuthority(runtime, {
      runId: prepared.runId,
      threadId: runtime.session.threadId,
      projectId,
      mode: runtime.session.mode,
      destination,
    });
    if (
      current.userId !== runtime.authority.userId ||
      current.environmentId !== runtime.authority.environmentId ||
      current.projectId !== runtime.authority.projectId
    ) {
      await this.#loseRuntime(runtime);
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser account, Environment, or Project identity changed.",
        { browserOutcomeKnown: true, effectDispatched },
      );
    }
    if (
      current.effectiveAllowlistRevision !==
      runtime.session.effectiveAllowlistRevision
    ) {
      try {
        const adopted = await runtime.proxy.adoptAuthority({
          threadId: runtime.session.threadId,
          sessionId: runtime.session.sessionId,
          generation: runtime.session.generation,
          mode: runtime.session.mode,
          authority: current,
        });
        if (
          adopted.receipt.sessionId !== runtime.session.sessionId ||
          adopted.receipt.effectiveAllowlistRevision !==
            current.effectiveAllowlistRevision ||
          adopted.launchBinding.username !== runtime.engine.proxy.username ||
          adopted.launchBinding.password !== runtime.engine.proxy.password
        ) {
          throw browserFailure(
            "BROWSER_SESSION_LOST",
            "The Browser engine cannot adopt current page authority.",
          );
        }
        runtime.engine.proxy = adopted.launchBinding;
        runtime.authority = current;
        runtime.session.effectiveAllowlistRevision =
          current.effectiveAllowlistRevision;
        this.#touch(runtime);
        await this.#persist();
        this.#metric("browser_revision_adoption", {
          mode: runtime.session.mode,
          operation,
          outcome: "success",
          reason: "active_page_refresh",
          count: adopted.receipt.closedUnauthorizedConnections,
        });
      } catch (error) {
        await this.#loseRuntime(runtime);
        throw error;
      }
    } else {
      runtime.authority = current;
    }
    let destinationAllowed = false;
    try {
      destinationAllowed = effectiveBrowserAuthorityAllowsPublicDestination(
        current,
        destination,
      );
    } catch {
      destinationAllowed = false;
    }
    if (!destinationAllowed) {
      throw this.#destinationBlocked(
        "The active Browser page is outside current authority.",
        runtime.session.mode,
        operation,
        effectDispatched,
      );
    }
    runtime.destination = destination;
    this.#assertCommitAllowed(runtime);
  }

  async #refreshAuthorityBeforeDispatch(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
    projectId: string | undefined,
    directAuthorityLoss = false,
    destinationOverride?: string | undefined,
  ): Promise<void> {
    this.#assertCommitAllowed(runtime);
    let current = runtime.authority;
    const explicitDestination =
      destinationOverride ??
      (prepared.activation.descriptor.toolId === "browser.navigate" &&
      prepared.effectiveInput.kind === "url"
        ? requireText(prepared.effectiveInput.url, "url")
        : undefined);
    if (runtime.session.mode === "operator") {
      current = await this.#resolveCurrentAuthority(
        runtime,
        {
          runId: prepared.runId,
          threadId: runtime.session.threadId,
          projectId,
          mode: runtime.session.mode,
          destination: explicitDestination,
        },
        directAuthorityLoss,
      );
      if (
        current.userId !== runtime.authority.userId ||
        current.environmentId !== runtime.authority.environmentId ||
        current.projectId !== runtime.authority.projectId
      ) {
        await this.#loseRuntime(runtime, directAuthorityLoss);
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser account, Environment, or Project identity changed.",
        );
      }
    } else {
      await this.#assertCurrentQaRunAuthority(runtime);
      if (
        prepared.activation.descriptor.toolId !== "browser.navigate" ||
        prepared.effectiveInput.kind !== "url"
      ) {
        this.#assertCommitAllowed(runtime);
        return;
      }
      const target = canonicalizeTrustedBrowserQaTarget(
        requireText(prepared.effectiveInput.url, "url"),
      );
      const allowed = current.qaTarget;
      if (
        allowed === null ||
        target.scheme !== allowed.scheme ||
        target.hostname !== allowed.hostname ||
        target.port !== allowed.port
      ) {
        throw this.#destinationBlocked(
          "The QA navigation destination is not the exact managed target.",
          runtime.session.mode,
          prepared.activation.descriptor.toolId,
        );
      }
    }
    if (
      current.effectiveAllowlistRevision !==
      runtime.session.effectiveAllowlistRevision
    ) {
      try {
        const adopted = await runtime.proxy.adoptAuthority({
          threadId: runtime.session.threadId,
          sessionId: runtime.session.sessionId,
          generation: runtime.session.generation,
          mode: runtime.session.mode,
          authority: current,
        });
        if (
          adopted.launchBinding.username !== runtime.engine.proxy.username ||
          adopted.launchBinding.password !== runtime.engine.proxy.password
        ) {
          throw browserFailure(
            "BROWSER_SESSION_LOST",
            "The Browser engine cannot adopt rotated proxy credentials.",
          );
        }
        runtime.engine.proxy = adopted.launchBinding;
        runtime.authority = current;
        runtime.session.effectiveAllowlistRevision =
          current.effectiveAllowlistRevision;
        this.#touch(runtime);
        await this.#persist();
        this.#metric("browser_revision_adoption", {
          mode: runtime.session.mode,
          operation: prepared.activation.descriptor.toolId,
          outcome: "success",
          reason: "dispatch_refresh",
          count: adopted.receipt.closedUnauthorizedConnections,
        });
      } catch (error) {
        await this.#loseRuntime(runtime, directAuthorityLoss);
        throw error;
      }
    }
    if (
      runtime.session.mode === "operator" &&
      explicitDestination !== undefined &&
      !effectiveBrowserAuthorityAllowsPublicDestination(
        current,
        explicitDestination,
      )
    ) {
      throw this.#destinationBlocked(
        "The Browser destination is outside current authority.",
        runtime.session.mode,
        prepared.activation.descriptor.toolId,
      );
    }
    this.#assertCommitAllowed(runtime);
  }

  async #assertCurrentQaRunAuthority(
    runtime: ActiveDesktopBrowserRuntime,
  ): Promise<void> {
    const authority = runtime.qaRunAuthority;
    if (authority === undefined) {
      await this.#loseRuntime(runtime);
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The managed Project run authority is unavailable.",
        { browserOutcomeKnown: true },
      );
    }
    try {
      const resolved = this.#options.projectRunRegistry.resolvePreviewUrl({
        runId: authority.runId,
        urlId: authority.urlId,
      });
      if (
        path.resolve(resolved.run.projectPath) !==
        path.resolve(authority.projectRoot)
      ) {
        throw new Error("Project run ownership changed.");
      }
      const target = canonicalizeTrustedBrowserQaTarget(resolved.url);
      const active = runtime.authority.qaTarget;
      if (
        active === null ||
        target.scheme !== active.scheme ||
        target.hostname !== active.hostname ||
        target.port !== active.port
      ) {
        throw new Error("Project run preview authority changed.");
      }
    } catch {
      await this.#loseRuntime(runtime);
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The managed Project run is no longer live and owned by this Session.",
        { browserOutcomeKnown: true },
      );
    }
  }

  #createPagedContent(
    runtime: ActiveDesktopBrowserRuntime,
    operation: "browser.snapshot" | "browser.inspect",
    base: Record<string, unknown>,
    content: string,
  ): unknown {
    const chunks = splitContent(content);
    const first = chunks[0] ?? "";
    if (chunks.length <= 1) {
      return browserOutput(operation, {
        ...base,
        content: first,
        complete: true,
      });
    }
    const cursor = `browser-cursor-${this.#id()}`;
    runtime.continuations.set(cursor, {
      operation,
      chunks,
      index: 1,
      base,
    });
    return browserOutput(operation, {
      ...base,
      content: first,
      complete: false,
      nextCursor: cursor,
    });
  }

  #continueContent(
    runtime: ActiveDesktopBrowserRuntime,
    operation: "browser.snapshot" | "browser.inspect",
    cursor: string,
  ): unknown {
    const continuation = runtime.continuations.get(cursor);
    if (continuation === undefined || continuation.operation !== operation) {
      this.#metric("browser_target_stale", {
        mode: runtime.session.mode,
        operation,
        outcome: "failure",
        reason: "continuation",
      });
      throw browserFailure(
        "BROWSER_TARGET_STALE",
        "The Browser continuation cursor is stale.",
      );
    }
    const content = continuation.chunks[continuation.index] ?? "";
    continuation.index += 1;
    const complete = continuation.index >= continuation.chunks.length;
    if (complete) runtime.continuations.delete(cursor);
    return browserOutput(operation, {
      ...continuation.base,
      content,
      complete,
      ...(complete ? {} : { nextCursor: cursor }),
    });
  }

  async #readPageIdentity(
    runtime: ActiveDesktopBrowserRuntime,
    acceptedOperation: DesktopBrowserAcceptedOperation,
  ): Promise<{
    origin: string;
    exactUrl: string;
    title: string;
    tabId: string;
    documentIdentity: string;
  }> {
    const url = await this.#command(runtime, acceptedOperation, [
      "get",
      "url",
      "--json",
    ]);
    const title = await this.#command(runtime, acceptedOperation, [
      "get",
      "title",
      "--json",
    ]);
    const tabs = await this.#command(runtime, acceptedOperation, [
      "tab",
      "--json",
    ]);
    const document = await this.#command(runtime, acceptedOperation, [
      "eval",
      "String(globalThis.performance.timeOrigin)",
      "--json",
    ]);
    const rawUrl = extractScalar(url.stdout, "url");
    let origin: string;
    let exactUrl: string;
    try {
      const parsed = new URL(rawUrl);
      origin = parsed.origin;
      exactUrl = parsed.href;
    } catch {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "Browser engine returned an invalid page URL.",
      );
    }
    const parsedTabs = parseTabs(tabs.stdout);
    return {
      origin,
      exactUrl,
      title: extractScalar(title.stdout, "title").slice(0, 2048),
      tabId: parsedTabs.activeTabId,
      documentIdentity: digest({
        tabId: parsedTabs.activeTabId,
        exactUrl,
        navigationEpoch: extractScalar(document.stdout, "value"),
      }),
    };
  }

  async #command(
    runtime: ActiveDesktopBrowserRuntime,
    acceptedOperation: DesktopBrowserAcceptedOperation,
    command: readonly string[],
  ): Promise<DesktopBrowserEngineCommandResult> {
    const priorDownloads = runtime.interceptedDownloadCount;
    let result: DesktopBrowserEngineCommandResult | undefined;
    let commandError: unknown;
    let synchronizationError: unknown;
    try {
      result = await this.#engine.command({
        ...runtime.engine,
        acceptedOperation,
        command,
      });
    } catch (error) {
      commandError = error;
    }
    try {
      await runtime.engine.synchronizeDownloads?.();
    } catch (error) {
      synchronizationError = error;
    }
    if (runtime.interceptedDownloadCount > priorDownloads) {
      return result ?? { stdout: "", stderr: "" };
    }
    if (synchronizationError !== undefined) {
      void this.#requestTermination(
        runtime,
        "failed",
        "BROWSER_ENGINE_FAILURE",
      ).catch(() => undefined);
      throw synchronizationError;
    }
    if (commandError !== undefined) throw commandError;
    return result!;
  }

  async #assertCurrentSnapshotAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    snapshot: SnapshotAuthority,
    acceptedOperation: DesktopBrowserAcceptedOperation,
    prepared: PreparedToolCallV1,
    projectId: string | undefined,
  ): Promise<void> {
    await this.#selectExactTab(
      runtime,
      snapshot.tabId,
      "browser.interact",
      acceptedOperation,
      true,
    );
    await this.#refreshActivePageAuthority(
      runtime,
      prepared,
      projectId,
      acceptedOperation,
    );
    const current = await this.#command(runtime, acceptedOperation, [
      "snapshot",
    ]);
    const page = await this.#readPageIdentity(runtime, acceptedOperation);
    await this.#applyActivePageAuthority(
      runtime,
      prepared,
      projectId,
      page.exactUrl,
      false,
    );
    const documentRevision = digest({
      documentIdentity: page.documentIdentity,
      content: extractEngineContent(current),
    });
    if (
      page.tabId !== snapshot.tabId ||
      documentRevision !== snapshot.documentRevision
    ) {
      runtime.snapshots.clear();
      runtime.continuations.clear();
      throw this.#targetStale(
        runtime,
        "browser.interact",
        "The Browser document changed after the target snapshot was captured.",
        "document_revision",
      );
    }
  }

  async #resolveUploadAttachment(
    threadId: string,
    expected: BrowserUploadPreparationRequestV1["attachment"],
  ) {
    let resolved;
    try {
      const store = this.#options.attachmentStore;
      if (store !== undefined && typeof store.resolve !== "function") {
        if (this.#options.hostedSession !== undefined) {
          return {
            attachmentId: expected.attachmentId,
            threadId,
            filename: expected.filename,
            mimeType: expected.declaredMediaType,
            declaredMediaType: expected.declaredMediaType,
            detectedMediaType: expected.detectedMediaType,
            sizeBytes: expected.sizeBytes,
            sha256: expected.sha256,
          };
        }
        throw new Error("Attachment resolution is unavailable.");
      }
      [resolved] = await (
        store ?? new DesktopAttachmentStore(this.#options.homePath)
      ).resolve!(threadId, [expected.attachmentId]);
    } catch {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "The approved Thread attachment is no longer available.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    if (
      resolved === undefined ||
      resolved.attachmentId !== expected.attachmentId ||
      resolved.threadId !== threadId ||
      resolved.filename !== expected.filename ||
      (resolved.declaredMediaType ?? "application/octet-stream") !==
        expected.declaredMediaType ||
      (resolved.detectedMediaType ?? resolved.mimeType) !==
        expected.detectedMediaType ||
      resolved.sizeBytes !== expected.sizeBytes ||
      resolved.sha256 !== expected.sha256
    ) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "The approved Thread attachment metadata changed.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    return resolved;
  }

  async #revalidateUploadTarget(
    runtime: ActiveDesktopBrowserRuntime,
    snapshotId: string,
    targetRef: string,
    acceptedOperation: DesktopBrowserAcceptedOperation,
  ): Promise<SnapshotAuthority & { targetLabel: string }> {
    const snapshot = runtime.snapshots.get(snapshotId);
    if (snapshot === undefined) {
      throw this.#targetStale(
        runtime,
        "browser.upload",
        "The Browser upload target snapshot is stale.",
        "snapshot_authority",
      );
    }
    await this.#selectExactTab(
      runtime,
      snapshot.tabId,
      "browser.upload",
      acceptedOperation,
      true,
    );
    const current = await this.#command(runtime, acceptedOperation, [
      "snapshot",
    ]);
    const page = await this.#readPageIdentity(runtime, acceptedOperation);
    if (
      page.tabId !== snapshot.tabId ||
      digest({
        documentIdentity: page.documentIdentity,
        content: extractEngineContent(current),
      }) !== snapshot.documentRevision
    ) {
      runtime.snapshots.clear();
      runtime.continuations.clear();
      throw this.#targetStale(
        runtime,
        "browser.upload",
        "The Browser document changed after the upload target snapshot was captured.",
        "document_revision",
      );
    }
    let target;
    try {
      if (typeof this.#engine.describeFileInput !== "function") {
        throw new Error(
          "Browser engine file-input description is unavailable.",
        );
      }
      target = await this.#engine.describeFileInput({
        ...runtime.engine,
        targetRef,
        acceptedOperation,
      });
    } catch {
      throw this.#targetStale(
        runtime,
        "browser.upload",
        "The Browser upload target is no longer an exact file input.",
        "file_input",
      );
    }
    if (target.targetRef !== targetRef || target.targetLabel.length === 0) {
      throw this.#targetStale(
        runtime,
        "browser.upload",
        "The Browser upload target identity changed.",
        "file_input_identity",
      );
    }
    return { ...snapshot, targetLabel: target.targetLabel };
  }

  #throwIfDownloadIntercepted(
    runtime: ActiveDesktopBrowserRuntime,
    priorCount: number,
  ): void {
    if (runtime.interceptedDownloadCount <= priorCount) return;
    throw this.#downloadUnavailable();
  }

  #pendingDownloadSince(
    runtime: ActiveDesktopBrowserRuntime,
    priorCount: number,
  ): DesktopBrowserInterceptedDownload | undefined {
    if (runtime.interceptedDownloadCount <= priorCount) return;
    return runtime.interceptedDownloads.at(-1);
  }

  async #admitDownload(
    runtime: ActiveDesktopBrowserRuntime,
    download: DesktopBrowserInterceptedDownload,
  ): Promise<void> {
    if (
      this.#active.get(runtime.session.sessionId) !== runtime ||
      runtime.terminationRequested !== undefined ||
      TERMINAL_STATES.has(runtime.session.state)
    ) {
      throw this.#downloadUnavailable();
    }
    await this.#pruneExpiredDownloads(runtime);
    if (
      runtime.interceptedDownloads.some(
        (candidate) => candidate.downloadId === download.downloadId,
      ) ||
      runtime.interceptedDownloads.length >=
        DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE ||
      runtime.interceptedDownloads.reduce(
        (total, candidate) => total + candidate.measuredBytes,
        0,
      ) +
        download.measuredBytes >
        DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      throw browserFailure(
        "BROWSER_ARTIFACT_TOO_LARGE",
        "The Browser download quarantine limit was reached.",
        { browserOutcomeKnown: true, downloadIntercepted: true },
      );
    }
    runtime.interceptedDownloadCount += 1;
    runtime.interceptedDownloads.push(download);
    const delay = Math.max(
      1,
      Date.parse(download.expiresAt) - this.#now().getTime(),
    );
    const timer = setTimeout(() => {
      void this.#serialize(async () => {
        await this.#removePendingDownload(runtime, download.downloadId);
      }).catch(() => undefined);
    }, delay);
    timer.unref?.();
    runtime.downloadExpiryTimers.set(download.downloadId, timer);
  }

  async #pruneExpiredDownloads(
    runtime: ActiveDesktopBrowserRuntime,
  ): Promise<void> {
    const now = this.#now().getTime();
    for (const download of [...runtime.interceptedDownloads]) {
      if (Date.parse(download.expiresAt) <= now) {
        await this.#removePendingDownload(runtime, download.downloadId);
      }
    }
  }

  async #requirePendingDownload(
    runtime: ActiveDesktopBrowserRuntime,
    pendingDownloadId: string,
  ): Promise<DesktopBrowserInterceptedDownload> {
    await this.#pruneExpiredDownloads(runtime);
    const matches = runtime.interceptedDownloads.filter(
      (download) => download.downloadId === pendingDownloadId,
    );
    if (matches.length !== 1) throw this.#downloadUnavailable();
    return matches[0]!;
  }

  #downloadPreparedEffect(
    runtime: ActiveDesktopBrowserRuntime,
    download: DesktopBrowserInterceptedDownload,
  ): BrowserDownloadPreparedEffectV1 {
    return {
      version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
      threadId: runtime.session.threadId,
      sessionId: runtime.session.sessionId,
      generation: runtime.session.generation,
      pendingDownloadId: download.downloadId,
      filename: download.filename,
      measuredBytes: download.measuredBytes,
      sha256: download.sha256,
      declaredMediaType: download.declaredMediaType,
      normalizedSourceOrigin: download.normalizedSourceOrigin,
      createdAt: download.createdAt,
      expiresAt: download.expiresAt,
    };
  }

  async #removePendingDownload(
    runtime: ActiveDesktopBrowserRuntime,
    pendingDownloadId: string,
  ): Promise<void> {
    const download = runtime.interceptedDownloads.find(
      (candidate) => candidate.downloadId === pendingDownloadId,
    );
    if (!download) return;
    const timer = runtime.downloadExpiryTimers.get(pendingDownloadId);
    if (timer) clearTimeout(timer);
    runtime.downloadExpiryTimers.delete(pendingDownloadId);
    const quarantineRoot = path.resolve(runtime.engine.blockedDownloadPath);
    const ownedPath = path.resolve(download.ownedPath);
    if (
      path.dirname(ownedPath) !== quarantineRoot ||
      path.basename(ownedPath) !== download.browserGuid
    ) {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "Browser download quarantine ownership changed.",
      );
    }
    await rm(ownedPath, { force: true });
    runtime.interceptedDownloads = runtime.interceptedDownloads.filter(
      (candidate) => candidate !== download,
    );
  }

  #downloadUnavailable(): ReturnType<typeof browserFailure> {
    return browserFailure(
      "BROWSER_DOWNLOAD_UNAVAILABLE",
      "The exact quarantined Browser download is unavailable.",
      { browserOutcomeKnown: true, downloadIntercepted: true },
    );
  }

  #assertCommitAllowed(runtime: ActiveDesktopBrowserRuntime): void {
    if (
      this.#active.get(runtime.session.sessionId) !== runtime ||
      runtime.terminationRequested !== undefined ||
      runtime.session.state !== "ready"
    ) {
      if (
        runtime.terminationRequested === "BROWSER_DOWNLOAD_UNAVAILABLE" ||
        runtime.session.terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE"
      ) {
        throw this.#downloadUnavailable();
      }
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser Session ended before the operation could commit.",
        { browserOutcomeKnown: true },
      );
    }
  }

  async #resolveQaDestination(
    target: Record<string, unknown>,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<{ destination: string; authority: QaRunAuthority }> {
    if (target.kind !== "desktop_project_run") {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "Desktop QA requires a managed Project run.",
      );
    }
    const projectId = requireText(
      lifecycle.authority.projectId,
      "active projectId",
    );
    if (requireText(target.projectId, "target.projectId") !== projectId) {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "The QA target belongs to another Project.",
      );
    }
    const projectRoot = requireText(
      lifecycle.authority.projectRoot,
      "active Project root",
    );
    const resolved = this.#options.projectRunRegistry.resolvePreviewUrl({
      runId: requireText(target.runId, "target.runId"),
      urlId: requireText(target.urlId, "target.urlId"),
    });
    if (path.resolve(resolved.run.projectPath) !== path.resolve(projectRoot)) {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "The managed run is not owned by the active Project.",
      );
    }
    return {
      destination: resolved.url,
      authority: {
        runId: requireText(target.runId, "target.runId"),
        urlId: requireText(target.urlId, "target.urlId"),
        projectRoot,
      },
    };
  }

  async #resolveAuthority(
    input: DesktopBrowserAuthorityResolutionInput,
  ): Promise<BrowserEffectiveDomainAuthorityV1> {
    const resolver = this.#options.authorityResolver;
    if (resolver === undefined) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Desktop Browser authority is unavailable.",
      );
    }
    const authority = await resolver.resolve(input);
    if (authority.version !== BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Desktop Browser authority is invalid.",
      );
    }
    if (
      input.projectId !== undefined &&
      authority.projectId !== input.projectId
    ) {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "Browser authority belongs to another Project.",
      );
    }
    if (!authority.enabledModes.includes(input.mode)) {
      throw browserFailure(
        "BROWSER_DESTINATION_BLOCKED",
        "Browser mode is disabled by current authority.",
      );
    }
    return authority;
  }

  async #requireViewerConnection(input: {
    principalId: string;
    threadId: string;
    projectId: string;
    sessionId: string;
    generation: number;
    connectionId: string;
  }): Promise<{
    runtime: ActiveDesktopBrowserRuntime;
    connection: DesktopBrowserViewerConnection;
  }> {
    const runtime = this.#requireRuntime(
      requireText(input.sessionId, "viewer sessionId"),
      requireText(input.threadId, "viewer threadId"),
    );
    this.#assertViewerRuntimeCurrent(runtime, input.generation);
    await this.#assertViewerAuthority(runtime, input.projectId);
    const connection = runtime.viewerConnections.get(
      requireText(input.connectionId, "viewer connectionId"),
    );
    if (
      connection === undefined ||
      connection.principalId !== input.principalId ||
      connection.projectId !== input.projectId
    ) {
      this.#viewerEvent(runtime, "rejection", "connection_identity");
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser viewer connection is unavailable.",
      );
    }
    return { runtime, connection };
  }

  async #assertViewerAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    projectId: string,
  ): Promise<void> {
    if (runtime.authority.projectId !== projectId) {
      this.#viewerEvent(runtime, "rejection", "project_identity");
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser viewer belongs to another Project.",
      );
    }
    this.#assertViewerSessionState(runtime);
    if (runtime.session.mode === "qa") {
      const qa = runtime.qaRunAuthority;
      if (qa === undefined) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer QA authority is unavailable.",
        );
      }
      try {
        const resolved = this.#options.projectRunRegistry.resolvePreviewUrl({
          runId: qa.runId,
          urlId: qa.urlId,
        });
        if (
          resolved.url !== runtime.destination ||
          resolved.run.projectPath !== qa.projectRoot
        ) {
          throw new Error("QA authority changed");
        }
        return;
      } catch {
        this.#viewerEvent(
          runtime,
          "authorization_loss",
          "qa_authority_changed",
        );
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
        throw browserFailure(
          "BROWSER_SESSION_LOST",
          "The Browser viewer QA authority changed.",
        );
      }
    }
    const current = await this.#resolveCurrentAuthority(
      runtime,
      {
        runId: "desktop-browser-viewer",
        threadId: runtime.session.threadId,
        projectId,
        mode: runtime.session.mode,
        destination: runtime.destination,
      },
      true,
    );
    if (
      current.userId !== runtime.authority.userId ||
      current.environmentId !== runtime.authority.environmentId ||
      current.projectId !== runtime.authority.projectId ||
      current.effectiveAllowlistRevision !==
        runtime.session.effectiveAllowlistRevision
    ) {
      this.#viewerEvent(runtime, "authorization_loss", "authority_changed");
      await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST");
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser viewer authority changed.",
      );
    }
  }

  #assertViewerSessionState(runtime: ActiveDesktopBrowserRuntime): void {
    if (
      runtime.terminationRequested !== undefined ||
      (runtime.session.state !== "ready" &&
        runtime.session.state !== "human_control")
    ) {
      throw browserFailure(
        runtime.session.state === "expired"
          ? "BROWSER_SESSION_EXPIRED"
          : "BROWSER_SESSION_LOST",
        "The Browser Session is unavailable to the viewer.",
      );
    }
    const now = this.#now().getTime();
    if (
      now >= Date.parse(runtime.session.idleExpiresAt) ||
      now >= Date.parse(runtime.session.hardExpiresAt)
    ) {
      this.#viewerEvent(runtime, "expiry", "session_expired");
      void this.#requestTermination(
        runtime,
        "expired",
        "BROWSER_SESSION_EXPIRED",
      ).catch(() => undefined);
      throw browserFailure(
        "BROWSER_SESSION_EXPIRED",
        "The Browser Session expired.",
      );
    }
  }

  #assertViewerRuntimeCurrent(
    runtime: ActiveDesktopBrowserRuntime,
    generation: number,
  ): void {
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      runtime.session.generation !== generation ||
      this.#active.get(runtime.session.sessionId) !== runtime
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser viewer generation is no longer active.",
      );
    }
    this.#assertViewerSessionState(runtime);
  }

  async #expireViewerLease(
    runtime: ActiveDesktopBrowserRuntime,
  ): Promise<void> {
    const lease = runtime.activeInputLease;
    if (
      lease !== undefined &&
      this.#now().getTime() >= Date.parse(lease.expiresAt)
    ) {
      try {
        await this.#revokeNativeHandoff(runtime);
      } catch (error) {
        await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
          () => undefined,
        );
        throw normalizeBrowserHostFailure(error, {
          toolName: "browser.request_takeover",
          dispatchAcknowledged: true,
          effectful: true,
        });
      }
      runtime.activeInputLease = undefined;
      this.#viewerEvent(runtime, "expiry", "input_lease");
    }
  }

  async #requireViewerLease(
    runtime: ActiveDesktopBrowserRuntime,
    connection: DesktopBrowserViewerConnection,
    leaseId: string,
  ): Promise<DesktopBrowserInputLease> {
    const exactLease = runtime.activeInputLease;
    if (
      runtime.session.state === "human_control" &&
      exactLease?.connectionId === connection.connectionId &&
      exactLease.leaseId === leaseId &&
      this.#now().getTime() >= Date.parse(exactLease.expiresAt)
    ) {
      await this.#expireViewerLease(runtime);
      throw Object.assign(new Error(HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED), {
        code: HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED,
      });
    }
    await this.#expireViewerLease(runtime);
    const lease = runtime.activeInputLease;
    if (
      runtime.session.state !== "human_control" ||
      lease === undefined ||
      lease.connectionId !== connection.connectionId ||
      lease.leaseId !== leaseId
    ) {
      this.#viewerEvent(runtime, "rejection", "input_lease");
      throw browserFailure(
        "BROWSER_HUMAN_CONTROL_ACTIVE",
        "The Browser input lease is unavailable.",
      );
    }
    const handoff = runtime.nativeHandoff;
    if (
      runtime.engine.nativeAuthenticationHandoff === true &&
      (handoff === undefined ||
        handoff.authority.sessionId !== runtime.session.sessionId ||
        handoff.authority.generation !== runtime.session.generation ||
        handoff.authority.connectionId !== connection.connectionId ||
        handoff.authority.leaseId !== lease.leaseId)
    ) {
      await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
        () => undefined,
      );
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser native handoff authority is unavailable.",
      );
    }
    return lease;
  }

  #viewerState(
    runtime: ActiveDesktopBrowserRuntime,
    connection: DesktopBrowserViewerConnection,
  ): DesktopBrowserViewerStateV1 {
    const lease =
      runtime.activeInputLease?.connectionId === connection.connectionId
        ? runtime.activeInputLease
        : undefined;
    return {
      version: DESKTOP_BROWSER_VIEWER_STATE_VERSION,
      available: true,
      threadId: runtime.session.threadId,
      projectId: connection.projectId,
      sessionId: runtime.session.sessionId,
      generation: runtime.session.generation,
      connectionId: connection.connectionId,
      sessionState:
        runtime.session.state === "human_control" ? "human_control" : "ready",
      takeoverRequested: runtime.takeoverRequested,
      ...(lease === undefined
        ? {}
        : {
            inputLeaseId: lease.leaseId,
            inputLeaseExpiresAt: lease.expiresAt,
            nativeHandoffActive:
              runtime.nativeHandoff?.authority.leaseId === lease.leaseId,
          }),
    };
  }

  async #presentNativeHandoff(
    runtime: ActiveDesktopBrowserRuntime,
    connection: DesktopBrowserViewerConnection,
    lease: DesktopBrowserInputLease,
  ): Promise<void> {
    // Hosted viewers deliver typed input inside the authenticated web surface.
    // Only packaged Desktop uses a separately presented native Chrome window.
    if (runtime.engine.nativeAuthenticationHandoff !== true) return;
    const present = this.#engine.presentNativeHandoff;
    const revoke = this.#engine.revokeNativeHandoff;
    if (present === undefined || revoke === undefined) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "The Browser engine cannot prove native authentication presentation.",
      );
    }
    const authority: DesktopBrowserNativeHandoffAuthority = Object.freeze({
      sessionId: runtime.session.sessionId,
      generation: runtime.session.generation,
      threadId: runtime.session.threadId,
      projectId: connection.projectId,
      principalId: connection.principalId,
      connectionId: connection.connectionId,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
    });
    const presentation = await present.call(this.#engine, {
      ...runtime.engine,
      authority,
    });
    if (
      !Number.isSafeInteger(presentation.windowId) ||
      presentation.windowId < 1 ||
      typeof presentation.targetId !== "string" ||
      presentation.targetId.length < 1 ||
      presentation.targetId.length > 512
    ) {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "The Browser engine returned an invalid native handoff receipt.",
      );
    }
    try {
      this.#assertNativeHandoffPresentationCurrent(
        runtime,
        connection,
        lease,
        authority,
      );
    } catch (error) {
      try {
        await revoke.call(this.#engine, {
          ...runtime.engine,
          authority,
          presentation,
        });
      } catch (revocationError) {
        throw new AggregateError(
          [error, revocationError],
          "Browser native handoff presentation expired or drifted and revocation could not be proven.",
        );
      }
      throw error;
    }
    runtime.nativeHandoff = {
      authority,
      presentation: Object.freeze({ ...presentation }),
    };
    this.#scheduleNativeHandoffExpiry(runtime);
  }

  #assertNativeHandoffPresentationCurrent(
    runtime: ActiveDesktopBrowserRuntime,
    connection: DesktopBrowserViewerConnection,
    lease: DesktopBrowserInputLease,
    authority: DesktopBrowserNativeHandoffAuthority,
  ): void {
    if (
      this.#active.get(authority.sessionId) !== runtime ||
      runtime.session.sessionId !== authority.sessionId ||
      runtime.session.generation !== authority.generation ||
      runtime.session.threadId !== authority.threadId ||
      runtime.terminationRequested !== undefined ||
      (runtime.session.state !== "ready" &&
        runtime.session.state !== "human_control") ||
      runtime.viewerConnections.get(authority.connectionId) !== connection ||
      connection.connectionId !== lease.connectionId ||
      connection.principalId !== authority.principalId ||
      connection.projectId !== authority.projectId ||
      lease.leaseId !== authority.leaseId ||
      lease.expiresAt !== authority.expiresAt ||
      runtime.activeInputLease !== undefined ||
      this.#now().getTime() >= Date.parse(authority.expiresAt)
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser native handoff authority expired or changed during presentation.",
      );
    }
  }

  async #revokeNativeHandoff(
    runtime: ActiveDesktopBrowserRuntime,
  ): Promise<void> {
    const handoff = runtime.nativeHandoff;
    if (handoff === undefined) return;
    if (handoff.expiryTimer !== undefined) clearTimeout(handoff.expiryTimer);
    const revoke = this.#engine.revokeNativeHandoff;
    if (revoke === undefined) {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "The Browser engine cannot prove native authentication revocation.",
      );
    }
    await revoke.call(this.#engine, {
      ...runtime.engine,
      authority: handoff.authority,
      presentation: handoff.presentation,
    });
    if (runtime.nativeHandoff === handoff) runtime.nativeHandoff = undefined;
  }

  #scheduleNativeHandoffExpiry(runtime: ActiveDesktopBrowserRuntime): void {
    const handoff = runtime.nativeHandoff;
    if (handoff === undefined || this.#options.scheduleExpiry === false) return;
    if (handoff.expiryTimer !== undefined) clearTimeout(handoff.expiryTimer);
    const delay = Math.max(
      1,
      Date.parse(handoff.authority.expiresAt) - this.#now().getTime(),
    );
    handoff.expiryTimer = setTimeout(() => {
      void this.#serialize(async () => {
        if (
          this.#active.get(runtime.session.sessionId) !== runtime ||
          runtime.nativeHandoff !== handoff
        )
          return;
        await this.#expireViewerLease(runtime);
      }).catch(() => undefined);
    }, delay);
    handoff.expiryTimer.unref?.();
  }

  #viewerEvent(
    runtime: ActiveDesktopBrowserRuntime,
    name: DesktopBrowserViewerEventName,
    reason?: DesktopBrowserViewerEventReason,
  ): void {
    try {
      this.#options.viewerEvents?.record({
        version: "desktop_browser_viewer_event_v1",
        name,
        at: this.#now().toISOString(),
        sessionId: runtime.session.sessionId,
        generation: runtime.session.generation,
        threadId: runtime.session.threadId,
        projectId: runtime.authority.projectId ?? "desktop-local",
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // Metadata-only viewer evidence must never change Browser behavior.
    }
  }

  async #resolveCurrentAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    input: DesktopBrowserAuthorityResolutionInput,
    directAuthorityLoss = false,
  ): Promise<BrowserEffectiveDomainAuthorityV1> {
    try {
      return await this.#withRuntimeAuthorityResolution(
        runtime,
        async () => await this.#resolveAuthority(input),
      );
    } catch (error) {
      await this.#loseRuntime(runtime, directAuthorityLoss);
      throw error;
    }
  }

  async #loseRuntime(
    runtime: ActiveDesktopBrowserRuntime,
    direct = false,
  ): Promise<void> {
    if (this.#active.get(runtime.session.sessionId) !== runtime) return;
    try {
      await this.#revokeNativeHandoff(runtime);
    } catch {
      // Closing the exact owned engine below is the fail-closed revocation
      // proof when window minimization itself cannot be acknowledged.
    }
    if (direct || runtime.authorityResolutionDepth > 0) {
      await this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST").catch(
        () => undefined,
      );
      return;
    }
    await this.#serialize(() =>
      this.#terminate(runtime, "lost", "BROWSER_SESSION_LOST"),
    ).catch(() => undefined);
  }

  async #withRuntimeAuthorityResolution<T>(
    runtime: ActiveDesktopBrowserRuntime,
    action: () => Promise<T>,
  ): Promise<T> {
    runtime.authorityResolutionDepth += 1;
    try {
      return await action();
    } finally {
      runtime.authorityResolutionDepth -= 1;
    }
  }

  async #assertUsable(
    runtime: ActiveDesktopBrowserRuntime,
    allowCleanupRetry = false,
    directExpiration = false,
  ): Promise<void> {
    if (allowCleanupRetry && runtime.terminationRequested !== undefined) return;
    if (runtime.terminationRequested !== undefined && !allowCleanupRetry) {
      if (runtime.terminationRequested === "BROWSER_DOWNLOAD_UNAVAILABLE") {
        throw this.#downloadUnavailable();
      }
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser Session is terminating.",
      );
    }
    const now = this.#now().getTime();
    if (
      now >= Date.parse(runtime.session.idleExpiresAt) ||
      now >= Date.parse(runtime.session.hardExpiresAt)
    ) {
      this.#metric("browser_session_expired", {
        mode: runtime.session.mode,
        operation: "browser.session",
        outcome: "failure",
        reason:
          now >= Date.parse(runtime.session.hardExpiresAt)
            ? "hard_ttl"
            : "idle_ttl",
      });
      if (directExpiration) {
        await this.#terminate(runtime, "expired", "BROWSER_SESSION_EXPIRED");
      } else {
        await this.#serialize(() =>
          this.#terminate(runtime, "expired", "BROWSER_SESSION_EXPIRED"),
        );
      }
      throw browserFailure(
        "BROWSER_SESSION_EXPIRED",
        "The Browser Session expired.",
      );
    }
    if (runtime.session.state !== "ready") {
      throw browserFailure(
        runtime.session.state === "lost"
          ? "BROWSER_SESSION_LOST"
          : "BROWSER_ENGINE_FAILURE",
        "The Browser Session is not ready.",
      );
    }
  }

  #assertSnapshotAuthority(
    runtime: ActiveDesktopBrowserRuntime,
    input: Record<string, unknown>,
  ): SnapshotAuthority {
    const snapshotId = requireText(input.snapshotId, "snapshotId");
    const authority = runtime.snapshots.get(snapshotId);
    if (
      authority === undefined ||
      authority.documentRevision !== input.documentRevision ||
      authority.tabId !== input.tabId
    ) {
      this.#metric("browser_target_stale", {
        mode: runtime.session.mode,
        operation: "browser.interact",
        outcome: "failure",
        reason: "snapshot_authority",
      });
      throw browserFailure(
        "BROWSER_TARGET_STALE",
        "The Browser target reference is stale.",
      );
    }
    return authority;
  }

  async #preflightOperation(
    runtime: ActiveDesktopBrowserRuntime,
    prepared: PreparedToolCallV1,
  ): Promise<void> {
    const operation = prepared.activation.descriptor.toolId;
    if (operation === "browser.interact") {
      const snapshot = this.#assertSnapshotAuthority(
        runtime,
        prepared.effectiveInput,
      );
      const action = requireRecord(prepared.effectiveInput.action, "action");
      if (typeof action.ref === "string") requireEngineRef(action.ref);
    }
    if (
      operation === "browser.tabs" &&
      (prepared.effectiveInput.operation === "switch" ||
        prepared.effectiveInput.operation === "close")
    ) {
      requireTabId(prepared.effectiveInput.tabId);
    }
  }

  async #selectExactTab(
    runtime: ActiveDesktopBrowserRuntime,
    tabId: string,
    operation: string,
    acceptedOperation: DesktopBrowserAcceptedOperation,
    preserveTabGone = false,
  ): Promise<void> {
    try {
      const listed = parseTabs(
        (await this.#command(runtime, acceptedOperation, ["tab", "--json"]))
          .stdout,
      );
      const target = listed.tabs.find((tab) => tab.tabId === tabId);
      if (target === undefined) {
        throw this.#targetStale(
          runtime,
          operation,
          "The requested Browser tab no longer exists.",
          "tab_missing",
        );
      }
      if (listed.activeTabId === tabId) return;
      await this.#command(runtime, acceptedOperation, ["tab", tabId]);
      const selected = parseTabs(
        (await this.#command(runtime, acceptedOperation, ["tab", "--json"]))
          .stdout,
      );
      if (selected.activeTabId !== tabId) {
        throw this.#targetStale(
          runtime,
          operation,
          "The requested Browser tab could not be selected exactly.",
          "tab_selection",
        );
      }
    } catch (error) {
      if (isEngineTabGone(error)) {
        if (preserveTabGone) throw error;
        throw this.#targetStale(
          runtime,
          operation,
          "The requested Browser tab no longer exists.",
          "tab_gone",
        );
      }
      throw error;
    }
  }

  #targetStale(
    runtime: ActiveDesktopBrowserRuntime,
    operation: string,
    message: string,
    reason: string,
  ): ReturnType<typeof browserFailure> {
    this.#metric("browser_target_stale", {
      mode: runtime.session.mode,
      operation,
      outcome: "failure",
      reason,
    });
    return browserFailure("BROWSER_TARGET_STALE", message, {
      browserOutcomeKnown: true,
      effectDispatched: false,
    });
  }

  #requireRuntime(
    sessionId: string,
    threadId: string,
  ): ActiveDesktopBrowserRuntime {
    const runtime = this.#active.get(sessionId);
    if (runtime !== undefined && runtime.session.threadId === threadId)
      return runtime;
    const persisted = this.#sessions.find(
      (session) => session.sessionId === sessionId,
    );
    if (persisted?.terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE") {
      throw this.#downloadUnavailable();
    }
    throw browserFailure(
      persisted?.state === "expired"
        ? "BROWSER_SESSION_EXPIRED"
        : "BROWSER_SESSION_LOST",
      "The Browser Session is unavailable.",
    );
  }

  async #prepareRuntime(
    sessionId: string,
    proxy: LocalCoreBrowserEgressLaunchBindingV1,
  ): Promise<DesktopBrowserEngineInvocation> {
    const ownedPaths = desktopBrowserOwnedPaths(this.#runtimeRoot, sessionId);
    const {
      runtimePath,
      socketPath,
      profilePath,
      configPath,
      screenshotPath,
      blockedDownloadPath,
    } = ownedPaths;
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await mkdir(configPath, { recursive: true, mode: 0o700 });
    await prepareOwnedSocketDirectory(socketPath);
    await mkdir(blockedDownloadPath, { recursive: true, mode: 0o700 });
    await chmod(blockedDownloadPath, 0o700);
    return {
      sessionId,
      runtimePath,
      socketPath,
      profilePath,
      configPath,
      screenshotPath,
      blockedDownloadPath,
      proxy,
      ...(this.#options.nativeAuthenticationHandoff === true
        ? { nativeAuthenticationHandoff: true }
        : {}),
    };
  }

  #touch(runtime: ActiveDesktopBrowserRuntime): void {
    const now = this.#now();
    runtime.session.lastActivityAt = now.toISOString();
    runtime.session.updatedAt = now.toISOString();
    runtime.session.idleExpiresAt = new Date(
      Math.min(
        now.getTime() + IDLE_TTL_MS,
        Date.parse(runtime.session.hardExpiresAt),
      ),
    ).toISOString();
    this.#scheduleExpiry(runtime);
  }

  #scheduleExpiry(runtime: ActiveDesktopBrowserRuntime): void {
    if (this.#options.scheduleExpiry === false) return;
    if (runtime.expiryTimer !== undefined) clearTimeout(runtime.expiryTimer);
    const delay = Math.max(
      1,
      Math.min(
        Date.parse(runtime.session.idleExpiresAt),
        Date.parse(runtime.session.hardExpiresAt),
      ) - Date.now(),
    );
    runtime.expiryTimer = setTimeout(() => {
      void (async () => {
        if (this.#active.get(runtime.session.sessionId) !== runtime) return;
        this.#metric("browser_session_expired", {
          mode: runtime.session.mode,
          operation: "browser.session",
          outcome: "failure",
          reason:
            Date.now() >= Date.parse(runtime.session.hardExpiresAt)
              ? "hard_ttl"
              : "idle_ttl",
        });
        await this.#requestTermination(
          runtime,
          "expired",
          "BROWSER_SESSION_EXPIRED",
        );
      })().catch(() => undefined);
    }, delay);
    runtime.expiryTimer.unref?.();
  }

  async #terminate(
    runtime: ActiveDesktopBrowserRuntime,
    requestedState: "closed" | "expired" | "lost" | "failed",
    requestedTerminalReason: BrowserSessionV1["terminalReason"],
    acceptedOperation?: DesktopBrowserAcceptedOperation | undefined,
  ): Promise<void> {
    if (this.#active.get(runtime.session.sessionId) !== runtime) return;
    const alreadyTerminal = TERMINAL_STATES.has(runtime.session.state);
    const terminalReason =
      runtime.session.terminalReason ??
      runtime.terminationRequested ??
      requestedTerminalReason;
    const state = alreadyTerminal
      ? runtime.session.state
      : terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE"
        ? "failed"
        : requestedState;
    runtime.terminationRequested = terminalReason;
    runtime.session.state = state;
    runtime.session.terminalReason = terminalReason;
    runtime.activeInputLease = undefined;
    runtime.takeoverRequested = false;
    runtime.viewerConnections.clear();
    this.#viewerEvent(runtime, "cleanup", terminalReason);
    if (!alreadyTerminal) {
      runtime.session.updatedAt = this.#now().toISOString();
    }
    let persistenceFailure: unknown;
    try {
      await this.#persist();
    } catch (error) {
      persistenceFailure = error;
    }
    if (runtime.expiryTimer !== undefined) clearTimeout(runtime.expiryTimer);
    runtime.expiryTimer = undefined;
    runtime.stopWatchingEngine?.();
    runtime.stopWatchingEngine = undefined;
    runtime.engine.stopDownloadInterception?.();
    runtime.engine.stopDownloadInterception = undefined;
    runtime.engine.synchronizeDownloads = undefined;
    for (const timer of runtime.downloadExpiryTimers.values())
      clearTimeout(timer);
    runtime.downloadExpiryTimers.clear();
    runtime.interceptedDownloads = [];
    const ownedPaths = desktopBrowserOwnedPaths(
      this.#runtimeRoot,
      runtime.session.sessionId,
    );
    assertDesktopBrowserInvocationPaths(ownedPaths, runtime.engine);
    const cleanup = await Promise.allSettled([
      runtime.proxy.close(),
      this.#engine.close({ ...runtime.engine, acceptedOperation }),
    ]);
    if (cleanup[1]?.status === "fulfilled") runtime.nativeHandoff = undefined;
    let cleanupFailure: unknown = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    if (cleanupFailure === undefined) {
      try {
        await removeDesktopBrowserRuntimePaths(ownedPaths);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (persistenceFailure !== undefined) {
      try {
        await this.#persist();
        persistenceFailure = undefined;
      } catch (error) {
        persistenceFailure = error;
      }
    }
    if (cleanupFailure !== undefined) {
      this.#metric("browser_cleanup", {
        mode: runtime.session.mode,
        operation: "browser.session",
        outcome: "failure",
        reason: "termination_unproven",
        count: 1,
      });
      if (persistenceFailure !== undefined) {
        throw new AggregateError(
          [persistenceFailure, cleanupFailure],
          "Browser terminal intent could not be persisted and cleanup could not be proven.",
        );
      }
      throw cleanupFailure;
    }
    if (persistenceFailure !== undefined) {
      this.#active.delete(runtime.session.sessionId);
      this.#metric("browser_cleanup", {
        mode: runtime.session.mode,
        operation: "browser.session",
        outcome: "failure",
        reason: "terminal_persistence_pending",
        count: 1,
      });
      throw persistenceFailure;
    }
    this.#active.delete(runtime.session.sessionId);
    this.#metric("browser_cleanup", {
      mode: runtime.session.mode,
      operation: "browser.session",
      outcome: "success",
      reason: state,
      count: 1,
    });
  }

  #startWatchingEngine(runtime: ActiveDesktopBrowserRuntime): void {
    runtime.stopWatchingEngine?.();
    runtime.stopWatchingEngine = this.#engine.watchForLoss?.(
      runtime.engine,
      () => {
        void (async () => {
          if (
            this.#active.get(runtime.session.sessionId) !== runtime ||
            (runtime.session.state !== "ready" &&
              runtime.session.state !== "human_control")
          )
            return;
          this.#metric("browser_engine_crash", {
            mode: runtime.session.mode,
            operation: "browser.session",
            outcome: "failure",
            reason: "lost_control",
          });
          await this.#requestTermination(
            runtime,
            "lost",
            "BROWSER_SESSION_LOST",
          );
        })().catch(() => undefined);
      },
    );
  }

  async #requestTermination(
    runtime: ActiveDesktopBrowserRuntime,
    state: "closed" | "expired" | "lost" | "failed",
    terminalReason: BrowserSessionV1["terminalReason"],
  ): Promise<void> {
    if (this.#active.get(runtime.session.sessionId) !== runtime) return;
    const retainedTerminalReason =
      runtime.terminationRequested ?? terminalReason;
    runtime.terminationRequested = retainedTerminalReason;
    await runtime.operationTail;
    await this.#serialize(() =>
      this.#terminate(runtime, state, retainedTerminalReason),
    );
  }

  async #cleanupOrphan(session: BrowserSessionV1): Promise<void> {
    const sessionId = requireDesktopBrowserSessionId(
      session.sessionId,
      "persisted Browser session ID",
    );
    const ownedPaths = desktopBrowserOwnedPaths(this.#runtimeRoot, sessionId);
    const {
      runtimePath,
      socketPath,
      profilePath,
      configPath,
      screenshotPath,
      blockedDownloadPath,
    } = ownedPaths;
    const invocation: DesktopBrowserEngineInvocation = {
      sessionId,
      runtimePath,
      socketPath,
      profilePath,
      configPath,
      screenshotPath,
      blockedDownloadPath,
      proxy: {
        version: "local_core_browser_egress_launch_binding_v1",
        proxyServer: "http://127.0.0.1:9",
        username: "closed",
        password: "closed",
        threadId: "lost",
        sessionId,
        generation: 1,
        effectiveAllowlistRevision: "lost",
        chromiumFlags: [],
      },
    };
    try {
      const [runtimePathState, socketPathState] = await Promise.allSettled([
        lstat(runtimePath),
        lstat(socketPath),
      ]);
      for (const state of [runtimePathState, socketPathState]) {
        if (state.status === "rejected" && !isMissingPathError(state.reason)) {
          throw state.reason;
        }
      }
      const pathsAlreadyRemoved =
        runtimePathState.status === "rejected" &&
        socketPathState.status === "rejected";
      const terminal = TERMINAL_STATES.has(session.state);
      if (pathsAlreadyRemoved && !terminal) {
        throw new Error(
          "BROWSER_ENGINE_FAILURE: prior nonterminal Browser launch has no PID or session socket termination proof.",
        );
      }
      if (!pathsAlreadyRemoved && socketPathState.status === "fulfilled") {
        assertDesktopBrowserInvocationPaths(ownedPaths, invocation);
        await this.#engine.close(invocation);
      } else if (!pathsAlreadyRemoved && !terminal) {
        // A nonterminal ledger entry still represents potentially live
        // authority. Without its owned control socket, termination is not
        // proven and cleanup must fail closed.
        throw new Error(
          "BROWSER_ENGINE_FAILURE: prior Browser launch has no PID or session socket termination proof.",
        );
      }
      if (!pathsAlreadyRemoved) {
        await removeDesktopBrowserRuntimePaths(ownedPaths);
      }
    } catch (error) {
      this.#metric("browser_cleanup", {
        operation: "browser.initialize",
        outcome: "failure",
        reason: "orphan_termination_unproven",
        count: 1,
      });
      throw error;
    }
    this.#metric("browser_cleanup", {
      operation: "browser.initialize",
      outcome: "success",
      reason: "orphan",
      count: 1,
    });
  }

  async #persist(): Promise<void> {
    const snapshot: DesktopBrowserLedgerV1 = {
      version: LEDGER_VERSION,
      sessions: this.#sessions.map((session) => parseBrowserSessionV1(session)),
      artifacts: [...this.#artifacts.values()],
    };
    const write = this.#ledgerWrites.then(
      async () =>
        await (this.#options.writeLedger ?? writeLedger)(
          this.#ledgerPath,
          snapshot,
        ),
      async () =>
        await (this.#options.writeLedger ?? writeLedger)(
          this.#ledgerPath,
          snapshot,
        ),
    );
    this.#ledgerWrites = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  async #requireInitialized(): Promise<void> {
    if (!this.#initialized) await this.initialize();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #id(): string {
    return this.#options.randomId?.() ?? randomUUID();
  }

  #destinationBlocked(
    message: string,
    mode: "qa" | "operator",
    operation: string,
    effectDispatched = false,
  ): ReturnType<typeof browserFailure> {
    this.#metric("browser_destination_blocked", {
      mode,
      operation,
      outcome: "failure",
      reason: "authority",
    });
    return browserFailure("BROWSER_DESTINATION_BLOCKED", message, {
      browserOutcomeKnown: true,
      effectDispatched,
    });
  }

  #recordUnknownOutcomeIfClassified(
    error: unknown,
    prepared: PreparedToolCallV1,
    mode: "qa" | "operator",
    reason: string,
  ): void {
    try {
      const toolName = prepared.activation.descriptor.toolId;
      if (!isBrowserToolName(toolName)) return;
      const classified = normalizeBrowserHostFailure(error, {
        toolName,
        dispatchAcknowledged: true,
        effectful:
          resolveBrowserToolExecutionClass(
            toolName,
            prepared.effectiveInput,
          ) === "external_side_effect",
      });
      if (classified.code !== "BROWSER_ACTION_OUTCOME_UNKNOWN") return;
      this.#metric("browser_unknown_outcome", {
        mode,
        operation: toolName,
        outcome: "failure",
        reason,
      });
    } catch {
      // Outcome classification is observability and cannot alter execution.
    }
  }

  #metric(
    name: DesktopBrowserMetricName,
    fields: Omit<DesktopBrowserMetric, "version" | "name" | "at"> = {},
  ): void {
    try {
      this.#options.metrics?.record({
        version: "desktop_browser_metric_v1",
        name,
        at: this.#now().toISOString(),
        ...fields,
      });
    } catch {
      // Observability must never change Browser execution behavior.
    }
  }
}

export class AgentBrowserCliAdapter implements DesktopBrowserEngineAdapter {
  readonly #engineExecutablePath: string;
  readonly #chromeExecutablePath: string;
  readonly #nativeCapturePrimed = new Set<string>();
  readonly #nativeConcealments = new Map<
    string,
    Promise<unknown | undefined>
  >();
  readonly #acceptedOperations = new Map<
    string,
    DesktopBrowserAcceptedOperation
  >();

  constructor(input: {
    engineExecutablePath: string;
    chromeExecutablePath: string;
  }) {
    this.#engineExecutablePath = realpathSync(
      requireAbsolutePath(
        input.engineExecutablePath,
        "agent-browser executable",
      ),
    );
    this.#chromeExecutablePath = realpathSync(
      requireAbsolutePath(input.chromeExecutablePath, "Chrome executable"),
    );
  }

  async acceptOperation(
    input: DesktopBrowserEngineInvocation & {
      operationId: string;
      grantGeneration: number;
    },
  ): Promise<DesktopBrowserAcceptedOperation> {
    const operationId = requireText(input.operationId, "Browser operationId");
    if (
      input.grantGeneration !== input.proxy.generation ||
      input.proxy.sessionId !== input.sessionId
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser adapter rejected a stale operation generation.",
      );
    }
    const acceptedOperation: DesktopBrowserAcceptedOperation = Object.freeze({
      sessionId: input.sessionId,
      operationId,
      grantGeneration: input.grantGeneration,
      acceptanceToken: randomUUID(),
    });
    this.#acceptedOperations.set(
      acceptedOperation.acceptanceToken,
      acceptedOperation,
    );
    return acceptedOperation;
  }

  releaseOperation(operation: DesktopBrowserAcceptedOperation): void {
    if (this.#acceptedOperations.get(operation.acceptanceToken) === operation) {
      this.#acceptedOperations.delete(operation.acceptanceToken);
    }
  }

  async open(
    input: DesktopBrowserEngineInvocation & {
      destination: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<void> {
    this.#assertAccepted(input, input.acceptedOperation);
    // v0.35.0-kestrel.1 exposes the Browser CDP URL but has no deny-download CLI flag.
    // Launch without remote content, install Browser-level denial, then navigate.
    await this.#openStep("launch", () =>
      this.#run(input, ["open", "about:blank"], {
        captureLaunchProcessGroup: true,
      }),
    );
    input.daemonPid = await this.#openStep("pid_binding", () =>
      this.#readOwnedDaemonPid(input),
    );
    const cdp = await this.#openStep("cdp_discovery", () =>
      this.#run(input, ["get", "cdp-url"]),
    );
    const interception = await this.#openStep("download_quarantine", () =>
      installAgentBrowserDownloadInterception(
        extractScalar(cdp.stdout, "cdpUrl"),
        input.blockedDownloadPath,
        input.onDownloadIntercepted ?? (() => undefined),
        input.getDownloadQuarantineUsage,
      ),
    );
    input.stopDownloadInterception = interception.stop;
    input.synchronizeDownloads = interception.synchronize;
    await this.#openStep("destination_navigation", () =>
      this.#run(input, ["open", input.destination]),
    );
    await this.#openStep("download_synchronization", () =>
      interception.synchronize(),
    );
    if (input.nativeAuthenticationHandoff === true) {
      await this.#openStep("native_window_concealment", async () => {
        const activeTargetId = requirePinnedViewerActiveTarget(
          (await this.#run(input, ["tab", "list"])).stdout,
        );
        const cdpUrl = requirePinnedViewerCdpUrl(
          (await this.#run(input, ["get", "cdp-url"])).stdout,
        );
        await minimizeAgentBrowserNativeWindow(cdpUrl, activeTargetId);
      });
    }
  }

  async command(
    input: DesktopBrowserEngineInvocation & {
      command: readonly string[];
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<DesktopBrowserEngineCommandResult> {
    this.#assertAccepted(input, input.acceptedOperation);
    return await this.#run(input, input.command);
  }

  async describeFileInput(
    input: DesktopBrowserEngineInvocation & {
      targetRef: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<{ targetRef: string; targetLabel: string }> {
    this.#assertAccepted(input, input.acceptedOperation);
    const targetRef = requireEngineRef(input.targetRef);
    const description = (
      await this.#run(input, ["get", "local-name", targetRef])
    ).stdout;
    const localName = extractSuccessfulAgentString(
      description,
      "localName",
    ).toLowerCase();
    const type = extractSuccessfulAgentString(
      description,
      "type",
    ).toLowerCase();
    if (localName !== "input" || type !== "file") {
      throw new Error("BROWSER_TARGET_STALE: target is not input[type=file].");
    }
    let accessibleLabel: string | undefined;
    try {
      accessibleLabel = extractSuccessfulAgentString(
        (await this.#run(input, ["get", "attr", targetRef, "aria-label"]))
          .stdout,
        "value",
        true,
      )?.trim();
    } catch {
      accessibleLabel = undefined;
    }
    return {
      targetRef,
      targetLabel: (accessibleLabel || "File input").slice(0, 512),
    };
  }

  async uploadFile(
    input: DesktopBrowserEngineInvocation & {
      targetRef: string;
      ownedPath: string;
      acceptedOperation: DesktopBrowserAcceptedOperation;
      signal?: AbortSignal | undefined;
    },
  ): Promise<void> {
    this.#assertAccepted(input, input.acceptedOperation);
    const targetRef = requireEngineRef(input.targetRef);
    const runtimeRoot = path.resolve(input.runtimePath);
    const ownedPath = path.resolve(input.ownedPath);
    if (path.dirname(ownedPath) !== runtimeRoot) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: upload staging path is not owned.",
      );
    }
    await this.#run(input, ["upload", targetRef, ownedPath], {
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async captureViewerFrame(
    input: DesktopBrowserEngineInvocation,
  ): Promise<{ mediaType: "image/png"; dataBase64: string }> {
    return await this.#captureFrame(input, false);
  }

  async captureScreenshot(
    input: DesktopBrowserEngineInvocation & {
      fullPage: boolean;
      acceptedOperation: DesktopBrowserAcceptedOperation;
    },
  ): Promise<{ mediaType: "image/png"; dataBase64: string }> {
    this.#assertAccepted(input, input.acceptedOperation);
    return await this.#captureFrame(input, input.fullPage);
  }

  async #captureFrame(
    input: DesktopBrowserEngineInvocation,
    fullPage: boolean,
  ): Promise<{ mediaType: "image/png"; dataBase64: string }> {
    if (process.platform === "darwin") {
      const priorConcealmentFailure = await this.#nativeConcealments.get(
        input.sessionId,
      );
      if (priorConcealmentFailure !== undefined) {
        throw priorConcealmentFailure;
      }
    }
    const activeTargetId = requirePinnedViewerActiveTarget(
      (await this.#run(input, ["tab", "list"])).stdout,
    );
    const cdpUrl = requirePinnedViewerCdpUrl(
      (await this.#run(input, ["get", "cdp-url"])).stdout,
    );
    const presentation =
      input.nativeAuthenticationHandoff === true
        ? await prepareAgentBrowserNativeCaptureWindow(cdpUrl, activeTargetId)
        : undefined;
    let frame: { mediaType: "image/png"; dataBase64: string } | undefined;
    let captureFailure: unknown;
    try {
      frame = await captureViewerPngThroughCdp(
        cdpUrl,
        activeTargetId,
        fullPage,
      );
    } catch (error) {
      captureFailure = error;
    }
    let concealmentFailure: unknown;
    if (presentation !== undefined) {
      try {
        if (process.platform === "darwin") {
          if (this.#nativeCapturePrimed.has(input.sessionId)) {
            await this.#setNativeApplicationHidden(input, true);
          } else {
            this.#nativeCapturePrimed.add(input.sessionId);
            this.#scheduleNativeApplicationConcealment(
              input,
              cdpUrl,
              presentation,
            );
          }
        } else {
          await revokeAgentBrowserNativeWindow(cdpUrl, presentation);
        }
      } catch (error) {
        concealmentFailure = error;
        if (process.platform === "darwin") {
          await revokeAgentBrowserNativeWindow(cdpUrl, presentation).catch(
            () => undefined,
          );
        }
      }
    }
    if (captureFailure !== undefined && concealmentFailure === undefined) {
      throw captureFailure;
    }
    if (captureFailure === undefined && concealmentFailure !== undefined) {
      throw concealmentFailure;
    }
    if (captureFailure !== undefined && concealmentFailure !== undefined) {
      throw new AggregateError(
        [captureFailure, concealmentFailure],
        "BROWSER_ENGINE_FAILURE: Browser frame capture or native-window concealment failed.",
      );
    }
    if (frame === undefined) throw viewerCdpFailure();
    const currentTargetId = requirePinnedViewerActiveTarget(
      (await this.#run(input, ["tab", "list"])).stdout,
    );
    if (currentTargetId !== activeTargetId) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: Browser viewer target changed during capture.",
      );
    }
    return frame;
  }

  async dispatchViewerInput(
    input: DesktopBrowserEngineInvocation & {
      viewerInput: DesktopBrowserViewerInputV1;
    },
  ): Promise<void> {
    const cdp = await this.#run(input, ["get", "cdp-url"]);
    const activeTargetId = requirePinnedViewerActiveTarget(
      (await this.#run(input, ["tab", "--json"])).stdout,
    );
    await sendBrowserPageCdpCommand(
      extractScalar(cdp.stdout, "cdpUrl"),
      activeTargetId,
      input.viewerInput.kind === "pointer"
        ? "Input.dispatchMouseEvent"
        : "Input.dispatchKeyEvent",
      input.viewerInput.kind === "pointer"
        ? viewerPointerCdpParameters(input.viewerInput)
        : viewerKeyboardCdpParameters(input.viewerInput),
    );
  }

  async presentNativeHandoff(
    input: DesktopBrowserEngineInvocation & {
      authority: DesktopBrowserNativeHandoffAuthority;
    },
  ): Promise<DesktopBrowserNativeHandoffPresentation> {
    if (input.nativeAuthenticationHandoff !== true) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Native authentication handoff is unavailable on this Browser host.",
      );
    }
    assertNativeHandoffAuthority(input, input.authority);
    const priorConcealmentFailure = await this.#nativeConcealments.get(
      input.sessionId,
    );
    if (priorConcealmentFailure !== undefined) {
      throw priorConcealmentFailure;
    }
    const cdp = await this.#run(input, ["get", "cdp-url"]);
    const activeTargetId = requirePinnedViewerActiveTarget(
      (await this.#run(input, ["tab", "--json"])).stdout,
    );
    if (process.platform === "darwin") {
      await this.#setNativeApplicationHidden(input, false);
    }
    try {
      return await presentAgentBrowserNativeWindow(
        extractScalar(cdp.stdout, "cdpUrl"),
        activeTargetId,
      );
    } catch (error) {
      if (process.platform === "darwin") {
        await this.#setNativeApplicationHidden(input, true).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async revokeNativeHandoff(
    input: DesktopBrowserEngineInvocation & {
      authority: DesktopBrowserNativeHandoffAuthority;
      presentation: DesktopBrowserNativeHandoffPresentation;
    },
  ): Promise<void> {
    if (input.nativeAuthenticationHandoff !== true) {
      throw browserFailure(
        "BROWSER_SERVICE_UNAVAILABLE",
        "Native authentication handoff is unavailable on this Browser host.",
      );
    }
    assertNativeHandoffAuthority(input, input.authority);
    const cdp = await this.#run(input, ["get", "cdp-url"]);
    const cdpUrl = extractScalar(cdp.stdout, "cdpUrl");
    if (process.platform === "darwin") {
      try {
        await this.#setNativeApplicationHidden(input, true);
        await prepareAgentBrowserNativeCaptureWindow(
          cdpUrl,
          input.presentation.targetId,
        );
      } catch (error) {
        await revokeAgentBrowserNativeWindow(cdpUrl, input.presentation).catch(
          () => undefined,
        );
        throw error;
      }
      return;
    }
    await revokeAgentBrowserNativeWindow(cdpUrl, input.presentation);
  }

  async close(
    input: DesktopBrowserEngineInvocation & {
      acceptedOperation?: DesktopBrowserAcceptedOperation | undefined;
    },
  ): Promise<void> {
    await this.#nativeConcealments.get(input.sessionId)?.catch(() => undefined);
    this.#nativeConcealments.delete(input.sessionId);
    this.#nativeCapturePrimed.delete(input.sessionId);
    if (input.acceptedOperation !== undefined) {
      this.#assertAccepted(input, input.acceptedOperation);
    }
    input.stopDownloadInterception?.();
    let pid = input.daemonPid;
    if (pid === undefined) {
      try {
        pid = await readDesktopBrowserOwnedDaemonPid(input);
      } catch (pidError) {
        let socketShutdown = false;
        let socketFailure: unknown;
        try {
          socketShutdown = await requestOwnedAgentBrowserSocketShutdown(input);
        } catch (error) {
          socketFailure = error;
        }
        let launcherFailure: unknown;
        if (input.launchProcessGroupId !== undefined) {
          try {
            await terminateOwnedLaunchProcessGroup(input.launchProcessGroupId);
          } catch (error) {
            launcherFailure = error;
          }
        }
        if (socketShutdown && launcherFailure === undefined) return;
        const socketDirectoryMissing = await pathIsMissing(input.socketPath);
        if (
          input.launchProcessGroupId === undefined &&
          socketDirectoryMissing &&
          socketFailure === undefined &&
          isMissingPathError(pidError)
        ) {
          return;
        }
        throw new AggregateError(
          [pidError, socketFailure, launcherFailure].filter(
            (error) => error !== undefined,
          ),
          "BROWSER_ENGINE_FAILURE: agent-browser termination could not be proven by PID or the owned session socket.",
        );
      }
    }
    await this.#run(input, ["close"], { timeoutMs: 5_000 }).catch(
      () => undefined,
    );
    await terminateOwnedProcessTree({
      pid,
      sessionId: input.sessionId,
      engineExecutablePath: this.#engineExecutablePath,
    });
  }

  #scheduleNativeApplicationConcealment(
    input: DesktopBrowserEngineInvocation,
    cdpUrl: string,
    presentation: DesktopBrowserNativeHandoffPresentation,
  ): void {
    const concealment = new Promise<unknown | undefined>((resolve) => {
      setImmediate(() => {
        void this.#setNativeApplicationHidden(input, true).then(
          () => resolve(undefined),
          async (error) => {
            await revokeAgentBrowserNativeWindow(cdpUrl, presentation).catch(
              () => undefined,
            );
            resolve(error);
          },
        );
      });
    });
    this.#nativeConcealments.set(input.sessionId, concealment);
  }

  async #setNativeApplicationHidden(
    input: DesktopBrowserEngineInvocation,
    hidden: boolean,
  ): Promise<void> {
    const pid = await resolveOwnedChromeApplicationPid({
      daemonPid: await readDesktopBrowserOwnedDaemonPid(input),
      profilePath: input.profilePath,
    });
    await setDarwinApplicationHidden(pid, hidden);
  }

  #assertAccepted(
    input: DesktopBrowserEngineInvocation,
    acceptedOperation: DesktopBrowserAcceptedOperation,
  ): void {
    const accepted = this.#acceptedOperations.get(
      acceptedOperation.acceptanceToken,
    );
    if (
      accepted !== acceptedOperation ||
      accepted.sessionId !== input.sessionId ||
      accepted.grantGeneration !== input.proxy.generation
    ) {
      throw browserFailure(
        "BROWSER_SESSION_LOST",
        "The Browser adapter rejected an unaccepted operation identity.",
      );
    }
  }

  watchForLoss(
    input: DesktopBrowserEngineInvocation,
    onLost: () => void,
  ): () => void {
    let stopped = false;
    let checking = false;
    const timer = setInterval(() => {
      if (stopped || checking) return;
      checking = true;
      void this.#assertOwnedDaemonAlive(input).then(
        () => {
          checking = false;
        },
        () => {
          checking = false;
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          onLost();
        },
      );
    }, 1_000);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async #assertOwnedDaemonAlive(
    input: DesktopBrowserEngineInvocation,
  ): Promise<void> {
    const pid = input.daemonPid ?? (await this.#readOwnedDaemonPid(input));
    await assertDesktopBrowserOwnedDaemonArtifacts(input);
    const command = await readProcessCommand(pid);
    if (
      !desktopBrowserDaemonCommandMatches(command, this.#engineExecutablePath)
    ) {
      throw new Error(
        "BROWSER_SESSION_LOST: agent-browser daemon identity changed.",
      );
    }
  }

  async #openStep<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new Error(`BROWSER_ENGINE_FAILURE: agent-browser ${phase} failed.`);
    }
  }

  async #readOwnedDaemonPid(
    input: DesktopBrowserEngineInvocation,
  ): Promise<number> {
    await assertDesktopBrowserOwnedDaemonArtifacts(input);
    const pidPath = path.join(input.socketPath, `${input.sessionId}.pid`);
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid < 2) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser daemon PID is invalid.",
      );
    }
    const command = await readProcessCommand(pid);
    if (
      !desktopBrowserDaemonCommandMatches(command, this.#engineExecutablePath)
    ) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser daemon identity is invalid.",
      );
    }
    return pid;
  }

  async #run(
    input: DesktopBrowserEngineInvocation,
    command: readonly string[],
    options: {
      timeoutMs?: number | undefined;
      captureLaunchProcessGroup?: boolean | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<DesktopBrowserEngineCommandResult> {
    const launch = buildAgentBrowserCliInvocation({
      input,
      chromeExecutablePath: this.#chromeExecutablePath,
      command,
    });
    return await spawnAndCollect({
      executable: this.#engineExecutablePath,
      args: launch.args,
      cwd: input.runtimePath,
      env: launch.env,
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      detached: options.captureLaunchProcessGroup === true,
      onSpawn:
        options.captureLaunchProcessGroup === true
          ? (pid) => {
              input.launchProcessGroupId = pid;
            }
          : undefined,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

export function buildAgentBrowserCliInvocation(input: {
  input: DesktopBrowserEngineInvocation;
  chromeExecutablePath: string;
  command: readonly string[];
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const nativeAuthenticationHandoff =
    input.input.nativeAuthenticationHandoff === true;
  return {
    args: [
      ...(nativeAuthenticationHandoff ? ["--headed"] : []),
      "--session",
      input.input.sessionId,
      "--profile",
      input.input.profilePath,
      "--executable-path",
      input.chromeExecutablePath,
      "--proxy",
      input.input.proxy.proxyServer,
      "--proxy-bypass",
      "<-loopback>",
      "--pin-tab",
      "--args",
      [
        ...input.input.proxy.chromiumFlags,
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--no-first-run",
        ...(nativeAuthenticationHandoff ? ["--start-minimized"] : []),
      ].join(","),
      "--content-boundaries",
      "--max-output",
      String(MAX_ENGINE_PAGE_OUTPUT_CHARS),
      "--json",
      ...input.command,
    ],
    env: sanitizedAgentBrowserEnvironment(input.input),
  };
}

function sanitizedAgentBrowserEnvironment(
  input: DesktopBrowserEngineInvocation,
): NodeJS.ProcessEnv {
  return {
    HOME: input.configPath,
    TMPDIR: input.socketPath,
    XDG_CONFIG_HOME: input.configPath,
    XDG_CACHE_HOME: input.configPath,
    AGENT_BROWSER_SESSION: input.sessionId,
    AGENT_BROWSER_SOCKET_DIR: input.socketPath,
    AGENT_BROWSER_PROXY_USERNAME: input.proxy.username,
    AGENT_BROWSER_PROXY_PASSWORD: input.proxy.password,
    AGENT_BROWSER_NO_AUTO_DIALOG: "1",
    NO_PROXY: "",
    no_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    PATH: "",
    LANG: "C.UTF-8",
    NODE_ENV: "production",
  };
}

function assertNativeHandoffAuthority(
  input: DesktopBrowserEngineInvocation,
  authority: DesktopBrowserNativeHandoffAuthority,
): void {
  if (
    authority.sessionId !== input.sessionId ||
    authority.generation !== input.proxy.generation ||
    authority.threadId !== input.proxy.threadId ||
    authority.sessionId !== input.proxy.sessionId ||
    !Number.isFinite(Date.parse(authority.expiresAt))
  ) {
    throw browserFailure(
      "BROWSER_SESSION_LOST",
      "The Browser adapter rejected stale native handoff authority.",
    );
  }
}

export async function presentAgentBrowserNativeWindow(
  cdpUrl: string,
  targetId: string,
  sendRequest: typeof sendBrowserCdpRequest = sendBrowserCdpRequest,
  sendPageCommand: typeof sendBrowserPageCdpCommand = sendBrowserPageCdpCommand,
): Promise<DesktopBrowserNativeHandoffPresentation> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  const exactTarget = requireText(targetId, "Browser native handoff targetId");
  const window = await sendRequest(
    parsed.toString(),
    "Browser.getWindowForTarget",
    { targetId: exactTarget },
  );
  const windowId = window.windowId;
  if (!Number.isSafeInteger(windowId) || Number(windowId) < 1) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native handoff window identity is invalid.",
    );
  }
  const presentation = Object.freeze({
    windowId: Number(windowId),
    targetId: exactTarget,
  });
  try {
    await sendRequest(parsed.toString(), "Browser.setWindowBounds", {
      windowId: presentation.windowId,
      bounds: { windowState: "normal" },
    });
    await sendPageCommand(
      parsed.toString(),
      presentation.targetId,
      "Page.bringToFront",
      {},
    );
    await waitForAgentBrowserNativeWindowState(
      parsed.toString(),
      presentation.windowId,
      "normal",
      sendRequest,
      "BROWSER_ENGINE_FAILURE: Browser native handoff presentation was not proven.",
    );
    const current = await resolveNativeHandoffWindow(
      parsed.toString(),
      presentation.targetId,
      sendRequest,
    );
    if (current !== presentation.windowId) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: Browser native handoff target changed windows during presentation.",
      );
    }
    return presentation;
  } catch (error) {
    await revokeAgentBrowserNativeWindow(
      parsed.toString(),
      presentation,
      sendRequest,
    ).catch(() => undefined);
    throw error;
  }
}

export async function minimizeAgentBrowserNativeWindow(
  cdpUrl: string,
  targetId: string,
  sendRequest: typeof sendBrowserCdpRequest = sendBrowserCdpRequest,
): Promise<DesktopBrowserNativeHandoffPresentation> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  const exactTarget = requireText(targetId, "Browser native handoff targetId");
  const window = await sendRequest(
    parsed.toString(),
    "Browser.getWindowForTarget",
    { targetId: exactTarget },
  );
  const windowId = window.windowId;
  if (!Number.isSafeInteger(windowId) || Number(windowId) < 1) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native handoff window identity is invalid.",
    );
  }
  const presentation = Object.freeze({
    windowId: Number(windowId),
    targetId: exactTarget,
  });
  await revokeAgentBrowserNativeWindow(
    parsed.toString(),
    presentation,
    sendRequest,
  );
  return presentation;
}

export async function prepareAgentBrowserNativeCaptureWindow(
  cdpUrl: string,
  targetId: string,
  sendRequest: typeof sendBrowserCdpRequest = sendBrowserCdpRequest,
): Promise<DesktopBrowserNativeHandoffPresentation> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  const exactTarget = requireText(targetId, "Browser native capture targetId");
  const window = await sendRequest(
    parsed.toString(),
    "Browser.getWindowForTarget",
    { targetId: exactTarget },
  );
  const windowId = window.windowId;
  if (!Number.isSafeInteger(windowId) || Number(windowId) < 1) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native capture window identity is invalid.",
    );
  }
  const initialState = requireWindowState(window);
  const presentation = Object.freeze({
    windowId: Number(windowId),
    targetId: exactTarget,
  });
  try {
    if (initialState === "minimized") {
      await sendRequest(parsed.toString(), "Browser.setWindowBounds", {
        windowId: presentation.windowId,
        bounds: { windowState: "normal" },
      });
    }
    await waitForAgentBrowserNativeWindowState(
      parsed.toString(),
      presentation.windowId,
      "normal",
      sendRequest,
      "BROWSER_ENGINE_FAILURE: Browser native capture window activation was not proven.",
    );
    const currentWindowId = await resolveNativeHandoffWindow(
      parsed.toString(),
      exactTarget,
      sendRequest,
    );
    if (currentWindowId !== presentation.windowId) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: Browser native capture target changed windows.",
      );
    }
    return presentation;
  } catch (error) {
    await revokeAgentBrowserNativeWindow(
      parsed.toString(),
      presentation,
      sendRequest,
    ).catch(() => undefined);
    throw error;
  }
}

async function waitForAgentBrowserNativeWindowState(
  cdpUrl: string,
  windowId: number,
  expectedState: "normal" | "minimized",
  sendRequest: typeof sendBrowserCdpRequest,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  do {
    const verified = await sendRequest(cdpUrl, "Browser.getWindowBounds", {
      windowId,
    });
    if (requireWindowState(verified) === expectedState) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(failureMessage);
}

export async function revokeAgentBrowserNativeWindow(
  cdpUrl: string,
  presentation: DesktopBrowserNativeHandoffPresentation,
  sendRequest: typeof sendBrowserCdpRequest = sendBrowserCdpRequest,
): Promise<void> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  if (
    !Number.isSafeInteger(presentation.windowId) ||
    presentation.windowId < 1 ||
    typeof presentation.targetId !== "string" ||
    presentation.targetId.length < 1
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native handoff receipt is invalid.",
    );
  }
  let currentWindowId: number;
  try {
    currentWindowId = await resolveNativeHandoffWindow(
      parsed.toString(),
      presentation.targetId,
      sendRequest,
    );
  } catch (error) {
    await minimizeAndVerifyNativeHandoffWindow(
      parsed.toString(),
      presentation.windowId,
      sendRequest,
    ).catch(() => undefined);
    throw error;
  }

  const windowIds = [...new Set([presentation.windowId, currentWindowId])];
  const failures: unknown[] = [];
  for (const windowId of windowIds) {
    try {
      await minimizeAndVerifyNativeHandoffWindow(
        parsed.toString(),
        windowId,
        sendRequest,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "BROWSER_ENGINE_FAILURE: Browser native handoff revocation was not proven.",
    );
  }

  const verifiedCurrentWindowId = await resolveNativeHandoffWindow(
    parsed.toString(),
    presentation.targetId,
    sendRequest,
  );
  if (!windowIds.includes(verifiedCurrentWindowId)) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native handoff target changed windows during revocation.",
    );
  }
}

async function resolveNativeHandoffWindow(
  cdpUrl: string,
  targetId: string,
  sendRequest: typeof sendBrowserCdpRequest,
): Promise<number> {
  const result = await sendRequest(cdpUrl, "Browser.getWindowForTarget", {
    targetId,
  });
  const windowId = result.windowId;
  if (!Number.isSafeInteger(windowId) || Number(windowId) < 1) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser native handoff window identity is invalid.",
    );
  }
  return Number(windowId);
}

async function minimizeAndVerifyNativeHandoffWindow(
  cdpUrl: string,
  windowId: number,
  sendRequest: typeof sendBrowserCdpRequest,
): Promise<void> {
  await sendRequest(cdpUrl, "Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "minimized" },
  });
  await waitForAgentBrowserNativeWindowState(
    cdpUrl,
    windowId,
    "minimized",
    sendRequest,
    "BROWSER_ENGINE_FAILURE: Browser native handoff revocation was not proven.",
  );
}

function requireWindowState(
  result: Record<string, unknown>,
): "normal" | "minimized" {
  const bounds = requireRecord(result.bounds, "Browser window bounds");
  if (bounds.windowState !== "normal" && bounds.windowState !== "minimized") {
    throw new Error("BROWSER_ENGINE_FAILURE: Browser window state is invalid.");
  }
  return bounds.windowState;
}

export async function denyAgentBrowserDownloads(
  cdpUrl: string,
  sendCommand: (
    cdpUrl: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void> = sendBrowserCdpCommand,
): Promise<void> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  await sendCommand(parsed.toString(), "Browser.setDownloadBehavior", {
    behavior: "deny",
    eventsEnabled: true,
  });
}

export async function installAgentBrowserDownloadInterception(
  cdpUrl: string,
  quarantinePath: string,
  onDownloadIntercepted: (
    download: DesktopBrowserInterceptedDownload,
  ) => void | Promise<void>,
  getCompletedQuarantineUsage: () => {
    count: number;
    measuredBytes: number;
  } = () => ({ count: 0, measuredBytes: 0 }),
  now: () => Date = () => new Date(),
): Promise<{
  stop: () => void;
  synchronize: () => Promise<void>;
}> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  const quarantineRoot = requireAbsolutePath(
    quarantinePath,
    "Browser download quarantine path",
  );
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  return await new Promise<{
    stop: () => void;
    synchronize: () => Promise<void>;
  }>((resolve, reject) => {
    const socket = new WebSocket(parsed.toString());
    const commandId = 1;
    let nextCommandId = commandId;
    let settled = false;
    let stopped = false;
    let eventTail = Promise.resolve();
    let eventFailure: Error | undefined;
    const pendingDownloads = new Map<
      string,
      {
        filename: string;
        normalizedSourceOrigin: string;
        receivedBytes: number;
        completing: boolean;
      }
    >();
    const barriers = new Map<
      number,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const timer = setTimeout(() => {
      finish(
        new Error(
          "BROWSER_ENGINE_TIMEOUT: Browser download interception was not acknowledged.",
        ),
      );
    }, 5_000);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      const error = new Error(
        "BROWSER_ENGINE_FAILURE: Browser download interception stopped.",
      );
      for (const pending of barriers.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      barriers.clear();
      socket.close();
    };
    const synchronize = async (): Promise<void> => {
      if (stopped || socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          "BROWSER_ENGINE_FAILURE: Browser download interception is unavailable.",
        );
      }
      const id = ++nextCommandId;
      await new Promise<void>((resolveBarrier, rejectBarrier) => {
        const barrierTimer = setTimeout(() => {
          barriers.delete(id);
          rejectBarrier(
            new Error(
              "BROWSER_ENGINE_TIMEOUT: Browser download synchronization was not acknowledged.",
            ),
          );
        }, 5_000);
        barriers.set(id, {
          resolve: resolveBarrier,
          reject: rejectBarrier,
          timer: barrierTimer,
        });
        socket.send(
          JSON.stringify({
            id,
            method: "Browser.setDownloadBehavior",
            params: {
              behavior: "allowAndName",
              downloadPath: quarantineRoot,
              eventsEnabled: true,
            },
          }),
        );
      });
      await eventTail;
      if (eventFailure) {
        const failure = eventFailure;
        eventFailure = undefined;
        throw failure;
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        socket.close();
        reject(error);
      } else {
        resolve({ stop, synchronize });
      }
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: commandId,
          method: "Browser.setDownloadBehavior",
          params: {
            behavior: "allowAndName",
            downloadPath: quarantineRoot,
            eventsEnabled: true,
          },
        }),
      );
    });
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = requireRecord(
          JSON.parse(raw.toString("utf8")),
          "Browser CDP message",
        );
      } catch {
        return;
      }
      if (message.id === commandId) {
        if (message.error !== undefined) {
          finish(
            new Error(
              "BROWSER_ENGINE_FAILURE: Browser download interception was rejected.",
            ),
          );
        } else {
          finish();
        }
        return;
      }
      if (typeof message.id === "number") {
        const barrier = barriers.get(message.id);
        if (barrier !== undefined) {
          barriers.delete(message.id);
          clearTimeout(barrier.timer);
          if (message.error === undefined) barrier.resolve();
          else {
            barrier.reject(
              new Error(
                "BROWSER_ENGINE_FAILURE: Browser download synchronization was rejected.",
              ),
            );
          }
        }
        return;
      }
      try {
        const params = requireOptionalRecord(message.params);
        if (params === undefined) return;
        if (message.method === "Browser.downloadWillBegin") {
          const guid = requireBrowserDownloadGuid(params.guid);
          const usage = getCompletedQuarantineUsage();
          if (
            !Number.isSafeInteger(usage.count) ||
            usage.count < 0 ||
            !Number.isSafeInteger(usage.measuredBytes) ||
            usage.measuredBytes < 0
          ) {
            throw new Error(
              "BROWSER_ENGINE_FAILURE: Browser download quarantine usage was invalid.",
            );
          }
          if (
            usage.count + pendingDownloads.size >=
            DESKTOP_MAX_ATTACHMENTS_PER_MESSAGE
          ) {
            const ownedPath = path.join(quarantineRoot, guid);
            socket.send(
              JSON.stringify({
                id: ++nextCommandId,
                method: "Browser.cancelDownload",
                params: { guid },
              }),
            );
            eventTail = eventTail
              .then(() => rm(ownedPath, { force: true }))
              .catch((error) => {
                eventFailure ??=
                  error instanceof Error
                    ? error
                    : new Error("BROWSER_ENGINE_FAILURE");
              });
            eventFailure ??= browserFailure(
              "BROWSER_ARTIFACT_TOO_LARGE",
              "The Browser download quarantine item limit was reached.",
              { browserOutcomeKnown: true, downloadIntercepted: true },
            );
            return;
          }
          pendingDownloads.set(guid, {
            filename: sanitizeBrowserDownloadFilename(params.suggestedFilename),
            normalizedSourceOrigin: normalizeBrowserDownloadSourceOrigin(
              params.url,
            ),
            receivedBytes: 0,
            completing: false,
          });
          return;
        }
        if (message.method !== "Browser.downloadProgress") return;
        const guid = requireBrowserDownloadGuid(params.guid);
        const pending = pendingDownloads.get(guid);
        if (!pending || pending.completing) return;
        const state = params.state;
        const receivedBytes = params.receivedBytes;
        if (state === "completed") pending.completing = true;
        eventTail = eventTail
          .then(async () => {
            const ownedPath = path.join(quarantineRoot, guid);
            if (
              typeof receivedBytes === "number" &&
              (!Number.isSafeInteger(receivedBytes) ||
                receivedBytes < pending.receivedBytes)
            ) {
              socket.send(
                JSON.stringify({
                  id: ++nextCommandId,
                  method: "Browser.cancelDownload",
                  params: { guid },
                }),
              );
              pendingDownloads.delete(guid);
              await rm(ownedPath, { force: true });
              throw new Error(
                "BROWSER_ENGINE_FAILURE: Browser download progress was invalid.",
              );
            }
            if (typeof receivedBytes === "number") {
              pending.receivedBytes = receivedBytes;
            }
            const completedUsage = getCompletedQuarantineUsage();
            const inProgressBytes = [...pendingDownloads.values()].reduce(
              (total, candidate) => total + candidate.receivedBytes,
              0,
            );
            if (
              pending.receivedBytes > DESKTOP_MAX_ATTACHMENT_BYTES ||
              completedUsage.measuredBytes + inProgressBytes >
                DESKTOP_MAX_TOTAL_ATTACHMENT_BYTES
            ) {
              socket.send(
                JSON.stringify({
                  id: ++nextCommandId,
                  method: "Browser.cancelDownload",
                  params: { guid },
                }),
              );
              pendingDownloads.delete(guid);
              await rm(ownedPath, { force: true });
              throw browserFailure(
                "BROWSER_ARTIFACT_TOO_LARGE",
                "The Browser download exceeded the quarantine file limit.",
                { browserOutcomeKnown: true, downloadIntercepted: true },
              );
            }
            if (state === "canceled") {
              pendingDownloads.delete(guid);
              await rm(ownedPath, { force: true });
              return;
            }
            if (state !== "completed") return;
            try {
              const measured = await measureOwnedBrowserDownload(
                ownedPath,
                DESKTOP_MAX_ATTACHMENT_BYTES,
              );
              const createdAt = now().toISOString();
              const download: DesktopBrowserInterceptedDownload = {
                downloadId: `download-${digest({ guid })}`,
                browserGuid: guid,
                filename: pending.filename,
                declaredMediaType: "application/octet-stream",
                normalizedSourceOrigin: pending.normalizedSourceOrigin,
                measuredBytes: measured.measuredBytes,
                sha256: measured.sha256,
                createdAt,
                expiresAt: new Date(
                  Date.parse(createdAt) + BROWSER_DOWNLOAD_RETENTION_MS,
                ).toISOString(),
                ownedPath,
              };
              await onDownloadIntercepted(download);
              pendingDownloads.delete(guid);
            } catch (error) {
              pendingDownloads.delete(guid);
              await rm(ownedPath, { force: true }).catch(() => undefined);
              throw error;
            }
          })
          .catch((error) => {
            eventFailure ??=
              error instanceof Error
                ? error
                : new Error("BROWSER_ENGINE_FAILURE");
          });
      } catch (error) {
        eventFailure ??=
          error instanceof Error ? error : new Error("BROWSER_ENGINE_FAILURE");
      }
    });
    const failConnection = () => {
      const error = new Error(
        "BROWSER_ENGINE_FAILURE: Browser download interception connection failed.",
      );
      if (!settled) finish(error);
      for (const pending of barriers.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      barriers.clear();
    };
    socket.once("error", failConnection);
    socket.once("close", () => {
      if (!stopped) failConnection();
    });
  });
}

function parseLocalBrowserCdpUrl(cdpUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser returned an invalid CDP URL.",
    );
  }
  if (
    parsed.protocol !== "ws:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]") ||
    !parsed.pathname.startsWith("/devtools/browser/")
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser returned a non-local Browser CDP URL.",
    );
  }
  return parsed;
}

async function sendBrowserCdpCommand(
  cdpUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(cdpUrl);
    const commandId = 1;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          "BROWSER_ENGINE_TIMEOUT: Browser download denial was not acknowledged.",
        ),
      );
    }, 5_000);
    socket.once("open", () => {
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    socket.once("error", () => {
      finish(
        new Error(
          "BROWSER_ENGINE_FAILURE: Browser download denial connection failed.",
        ),
      );
    });
    socket.on("message", (raw) => {
      let response: Record<string, unknown>;
      try {
        response = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (response.id !== commandId) return;
      if (response.error !== undefined) {
        finish(
          new Error(
            "BROWSER_ENGINE_FAILURE: Browser rejected download denial.",
          ),
        );
        return;
      }
      finish();
    });
  });
}

async function sendBrowserCdpRequest(
  cdpUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(parsed.toString());
    const commandId = 1;
    let settled = false;
    const finish = (result?: Record<string, unknown>, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error !== undefined) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(() => {
      finish(
        undefined,
        new Error(
          "BROWSER_ENGINE_TIMEOUT: Browser native handoff was not acknowledged.",
        ),
      );
    }, 5_000);
    socket.once("open", () => {
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    socket.once("error", () => {
      finish(
        undefined,
        new Error(
          "BROWSER_ENGINE_FAILURE: Browser native handoff connection failed.",
        ),
      );
    });
    socket.once("close", () => {
      if (!settled) {
        finish(
          undefined,
          new Error(
            "BROWSER_ENGINE_FAILURE: Browser native handoff connection closed.",
          ),
        );
      }
    });
    socket.on("message", (raw) => {
      let response: Record<string, unknown>;
      try {
        response = requireRecord(
          JSON.parse(raw.toString("utf8")),
          "Browser native handoff response",
        );
      } catch {
        return;
      }
      if (response.id !== commandId) return;
      if (response.error !== undefined) {
        finish(
          undefined,
          new Error(
            "BROWSER_ENGINE_FAILURE: Browser native handoff was rejected.",
          ),
        );
        return;
      }
      finish(requireOptionalRecord(response.result) ?? {});
    });
  });
}

async function sendBrowserPageCdpCommand(
  cdpUrl: string,
  targetId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const parsed = parseLocalBrowserCdpUrl(cdpUrl);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(parsed.toString());
    let settled = false;
    let sessionId: string | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          "BROWSER_ENGINE_TIMEOUT: Browser viewer input was not acknowledged.",
        ),
      );
    }, 5_000);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Target.attachToTarget",
          params: { targetId, flatten: true },
        }),
      );
    });
    socket.once("error", () => {
      finish(
        new Error(
          "BROWSER_ENGINE_FAILURE: Browser viewer input connection failed.",
        ),
      );
    });
    socket.once("close", () => {
      if (!settled) {
        finish(
          new Error(
            "BROWSER_ENGINE_FAILURE: Browser viewer input connection closed.",
          ),
        );
      }
    });
    socket.on("message", (raw) => {
      let response: Record<string, unknown>;
      try {
        response = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (response.id === 1) {
        if (response.error !== undefined) {
          finish(
            new Error(
              "BROWSER_ENGINE_FAILURE: Browser viewer target attachment failed.",
            ),
          );
          return;
        }
        const result =
          typeof response.result === "object" &&
          response.result !== null &&
          !Array.isArray(response.result)
            ? (response.result as Record<string, unknown>)
            : undefined;
        sessionId =
          typeof result?.sessionId === "string" ? result.sessionId : undefined;
        if (sessionId === undefined) {
          finish(
            new Error(
              "BROWSER_ENGINE_FAILURE: Browser viewer target attachment was invalid.",
            ),
          );
          return;
        }
        socket.send(JSON.stringify({ id: 2, sessionId, method, params }));
        return;
      }
      if (response.id !== 2) return;
      if (response.error !== undefined) {
        finish(
          new Error(
            "BROWSER_ENGINE_FAILURE: Browser rejected typed viewer input.",
          ),
        );
        return;
      }
      finish();
    });
  });
}

function viewerPointerCdpParameters(
  input: Extract<DesktopBrowserViewerInputV1, { kind: "pointer" }>,
): Record<string, unknown> {
  return {
    type:
      input.phase === "move"
        ? "mouseMoved"
        : input.phase === "down"
          ? "mousePressed"
          : "mouseReleased",
    x: input.x,
    y: input.y,
    button: input.button ?? (input.phase === "move" ? "none" : "left"),
    modifiers: viewerModifierMask(input.modifiers),
    clickCount: input.phase === "move" ? 0 : 1,
  };
}

function viewerKeyboardCdpParameters(
  input: Extract<DesktopBrowserViewerInputV1, { kind: "keyboard" }>,
): Record<string, unknown> {
  return {
    type: input.phase === "down" ? "keyDown" : "keyUp",
    key: input.key,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.phase !== "down" || input.text === undefined
      ? {}
      : { text: input.text }),
    modifiers: viewerModifierMask(input.modifiers),
  };
}

function viewerModifierMask(
  modifiers: DesktopBrowserViewerInputV1["modifiers"],
): number {
  return (
    (modifiers?.includes("alt") ? 1 : 0) |
    (modifiers?.includes("control") ? 2 : 0) |
    (modifiers?.includes("meta") ? 4 : 0) |
    (modifiers?.includes("shift") ? 8 : 0)
  );
}

function requirePinnedViewerResponse(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser viewer metadata was invalid.",
    );
  }
  const response = requireOptionalRecord(parsed);
  const responseKeys = response === undefined ? [] : Object.keys(response);
  const hasBoundary = responseKeys.includes("_boundary");
  if (
    response === undefined ||
    !exactRecordKeys(
      response,
      hasBoundary
        ? ["_boundary", "success", "data", "error"]
        : ["success", "data", "error"],
    ) ||
    response.success !== true ||
    response.error !== null
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser viewer metadata was invalid.",
    );
  }
  if (hasBoundary) {
    const boundary = requireOptionalRecord(response._boundary);
    if (
      boundary === undefined ||
      !exactRecordKeys(boundary, ["nonce", "origin"]) ||
      typeof boundary.nonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(boundary.nonce) ||
      typeof boundary.origin !== "string" ||
      boundary.origin.length === 0 ||
      boundary.origin.length > 8192
    ) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser viewer metadata was invalid.",
      );
    }
  }
  const data = requireOptionalRecord(response.data);
  if (data === undefined) return response.data;
  if (!("lifecycle" in data)) return data;
  if (requireOptionalRecord(data.lifecycle) === undefined) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser viewer metadata was invalid.",
    );
  }
  const normalized = { ...data };
  delete normalized.lifecycle;
  return normalized;
}

export function requirePinnedViewerActiveTarget(stdout: string): string {
  const data = requireOptionalRecord(requirePinnedViewerResponse(stdout));
  if (
    data === undefined ||
    !exactRecordKeys(data, ["tabs"]) ||
    !Array.isArray(data.tabs) ||
    data.tabs.length === 0 ||
    data.tabs.length > MAX_BROWSER_TABS
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser active viewer target was invalid.",
    );
  }
  const targets = data.tabs.map((candidate) => {
    const tab = requireOptionalRecord(candidate);
    if (
      tab === undefined ||
      !exactRecordKeys(tab, [
        "tabId",
        "targetId",
        "label",
        "title",
        "url",
        "type",
        "active",
      ]) ||
      typeof tab.tabId !== "string" ||
      !/^t[1-9][0-9]*$/u.test(tab.tabId) ||
      typeof tab.targetId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(tab.targetId) ||
      (tab.label !== null &&
        (typeof tab.label !== "string" || tab.label.length > 256)) ||
      typeof tab.title !== "string" ||
      tab.title.length > 2048 ||
      typeof tab.url !== "string" ||
      tab.url.length === 0 ||
      tab.url.length > 8192 ||
      typeof tab.type !== "string" ||
      tab.type.length === 0 ||
      tab.type.length > 64 ||
      typeof tab.active !== "boolean"
    ) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser active viewer target was invalid.",
      );
    }
    return tab as {
      targetId: string;
      type: string;
      active: boolean;
    };
  });
  if (
    new Set(targets.map((target) => target.targetId)).size !== targets.length
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser active viewer target was invalid.",
    );
  }
  const active = targets.filter((target) => target.active);
  const activeTarget = active[0];
  if (active.length !== 1 || activeTarget?.type !== "page") {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser active viewer target was invalid.",
    );
  }
  return activeTarget.targetId;
}

function requirePinnedViewerCdpUrl(stdout: string): string {
  const data = requireOptionalRecord(requirePinnedViewerResponse(stdout));
  if (
    data === undefined ||
    !exactRecordKeys(data, ["cdpUrl"]) ||
    typeof data.cdpUrl !== "string"
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser viewer CDP identity was invalid.",
    );
  }
  const parsed = parseLocalBrowserCdpUrl(data.cdpUrl);
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !Number.isSafeInteger(Number(parsed.port)) ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535 ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/u.test(parsed.pathname)
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser viewer CDP identity was invalid.",
    );
  }
  return parsed.toString();
}

function exactRecordKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

async function captureViewerPngThroughCdp(
  cdpUrl: string,
  targetId: string,
  fullPage = false,
): Promise<{ mediaType: "image/png"; dataBase64: string }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(cdpUrl, {
      handshakeTimeout: DESKTOP_BROWSER_VIEWER_CAPTURE_TIMEOUT_MS,
      maxPayload: HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
      perMessageDeflate: false,
    });
    let stage: "attach" | "layout" | "capture" | "detach" = "attach";
    let attachedEventSessionId: string | undefined;
    let detachedEventSeen = false;
    let sessionId: string | undefined;
    let frame: { mediaType: "image/png"; dataBase64: string } | undefined;
    let detachSent = false;
    let settled = false;
    const captureRequestId = fullPage ? 3 : 2;
    const detachRequestId = fullPage ? 4 : 3;
    const close = () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      try {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      } catch {
        socket.terminate();
      }
    };
    const send = (message: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify(message), (error) => {
          if (error) finish(viewerCdpFailure());
        });
      } catch {
        finish(viewerCdpFailure());
      }
    };
    const sendDetach = () => {
      if (
        detachSent ||
        sessionId === undefined ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return false;
      }
      detachSent = true;
      send({
        id: detachRequestId,
        method: "Target.detachFromTarget",
        params: { sessionId },
      });
      return true;
    };
    const finish = (
      error?: Error,
      result?: { mediaType: "image/png"; dataBase64: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined && sendDetach()) {
        setImmediate(close);
      } else {
        close();
      }
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
      else reject(viewerCdpFailure());
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          "BROWSER_ENGINE_TIMEOUT: Browser viewer capture was not acknowledged.",
        ),
      );
    }, DESKTOP_BROWSER_VIEWER_CAPTURE_TIMEOUT_MS);
    socket.once("open", () => {
      send({
        id: 1,
        method: "Target.attachToTarget",
        params: { targetId, flatten: true },
      });
    });
    socket.once("error", () => finish(viewerCdpFailure()));
    socket.once("close", () => {
      if (!settled) finish(viewerCdpFailure());
    });
    socket.on("message", (raw, isBinary) => {
      if (settled) return;
      if (isBinary) {
        finish(viewerCdpFailure());
        return;
      }
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      if (bytes.byteLength > HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES) {
        finish(viewerCdpFailure());
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = requireRecord(
          JSON.parse(bytes.toString("utf8")),
          "Browser viewer CDP response",
        );
      } catch {
        finish(viewerCdpFailure());
        return;
      }
      if (message.error !== undefined) {
        finish(viewerCdpFailure());
        return;
      }
      if (stage === "attach") {
        if (message.method === "Target.attachedToTarget") {
          const params = requireOptionalRecord(message.params);
          const targetInfo = requireOptionalRecord(params?.targetInfo);
          if (
            attachedEventSessionId !== undefined ||
            !exactRecordKeys(message, ["method", "params"]) ||
            params === undefined ||
            !exactRecordKeys(params, [
              "sessionId",
              "targetInfo",
              "waitingForDebugger",
            ]) ||
            typeof params.sessionId !== "string" ||
            !/^[A-Za-z0-9_-]{1,256}$/u.test(params.sessionId) ||
            params.waitingForDebugger !== false ||
            targetInfo === undefined ||
            targetInfo.targetId !== targetId ||
            targetInfo.type !== "page" ||
            targetInfo.attached !== true
          ) {
            finish(viewerCdpFailure());
            return;
          }
          attachedEventSessionId = params.sessionId;
          return;
        }
        const result = requireOptionalRecord(message.result);
        if (
          attachedEventSessionId === undefined ||
          !exactRecordKeys(message, ["id", "result"]) ||
          message.id !== 1 ||
          result === undefined ||
          !exactRecordKeys(result, ["sessionId"]) ||
          typeof result.sessionId !== "string" ||
          result.sessionId !== attachedEventSessionId
        ) {
          finish(viewerCdpFailure());
          return;
        }
        sessionId = result.sessionId;
        stage = fullPage ? "layout" : "capture";
        if (fullPage) {
          send({
            id: 2,
            sessionId,
            method: "Page.getLayoutMetrics",
            params: {},
          });
          return;
        }
        send({
          id: captureRequestId,
          sessionId,
          method: "Page.captureScreenshot",
          params: {
            format: "png",
            fromSurface: true,
          },
        });
        return;
      }
      if (stage === "layout") {
        const result = requireOptionalRecord(message.result);
        const contentSize = requireOptionalRecord(result?.cssContentSize);
        const allowedLayoutMetricKeys = new Set([
          "layoutViewport",
          "visualViewport",
          "contentSize",
          "cssLayoutViewport",
          "cssVisualViewport",
          "cssContentSize",
        ]);
        if (
          !exactRecordKeys(message, ["id", "sessionId", "result"]) ||
          message.id !== 2 ||
          message.sessionId !== sessionId ||
          result === undefined ||
          Object.keys(result).some(
            (key) => !allowedLayoutMetricKeys.has(key),
          ) ||
          contentSize === undefined ||
          !exactRecordKeys(contentSize, ["x", "y", "width", "height"]) ||
          ![
            contentSize.x,
            contentSize.y,
            contentSize.width,
            contentSize.height,
          ].every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ) ||
          (contentSize.width as number) <= 0 ||
          (contentSize.height as number) <= 0 ||
          (contentSize.width as number) > 32_767 ||
          (contentSize.height as number) > 32_767
        ) {
          finish(viewerCdpFailure());
          return;
        }
        stage = "capture";
        send({
          id: captureRequestId,
          sessionId,
          method: "Page.captureScreenshot",
          params: {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: true,
            clip: {
              x: contentSize.x,
              y: contentSize.y,
              width: contentSize.width,
              height: contentSize.height,
              scale: 1,
            },
          },
        });
        return;
      }
      if (stage === "capture") {
        const result = requireOptionalRecord(message.result);
        if (
          !exactRecordKeys(message, ["id", "sessionId", "result"]) ||
          message.id !== captureRequestId ||
          message.sessionId !== sessionId ||
          result === undefined ||
          !exactRecordKeys(result, ["data"]) ||
          typeof result.data !== "string"
        ) {
          finish(viewerCdpFailure());
          return;
        }
        try {
          frame = requireCanonicalViewerPng(result.data);
        } catch {
          finish(viewerCdpFailure());
          return;
        }
        stage = "detach";
        if (!sendDetach()) finish(viewerCdpFailure());
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        const params = requireOptionalRecord(message.params);
        if (
          detachedEventSeen ||
          !exactRecordKeys(message, ["method", "params"]) ||
          params === undefined ||
          !exactRecordKeys(params, ["sessionId", "targetId"]) ||
          params.sessionId !== sessionId ||
          params.targetId !== targetId
        ) {
          finish(viewerCdpFailure());
          return;
        }
        detachedEventSeen = true;
        return;
      }
      const result = requireOptionalRecord(message.result);
      if (
        !detachedEventSeen ||
        !exactRecordKeys(message, ["id", "result"]) ||
        message.id !== detachRequestId ||
        result === undefined ||
        !exactRecordKeys(result, []) ||
        frame === undefined
      ) {
        finish(viewerCdpFailure());
        return;
      }
      finish(undefined, frame);
    });
  });
}

function requireCanonicalViewerPng(dataBase64: string): {
  mediaType: "image/png";
  dataBase64: string;
} {
  const byteLength = hostedBrowserViewerPngBase64ByteLength(dataBase64);
  if (
    byteLength === undefined ||
    byteLength === 0 ||
    byteLength > HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES
  ) {
    throw viewerCdpFailure();
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (
    bytes.byteLength !== byteLength ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    throw viewerCdpFailure();
  }
  return { mediaType: "image/png", dataBase64 };
}

function viewerCdpFailure(): Error {
  return new Error("BROWSER_ENGINE_FAILURE: Browser viewer capture failed.");
}

export async function spawnAndCollect(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  detached?: boolean | undefined;
  onSpawn?: ((pid: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<DesktopBrowserEngineCommandResult> {
  return await new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        detached: input.detached === true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (child.pid !== undefined) input.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error("BROWSER_ACTION_CANCELLED"),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      reject(
        new Error("BROWSER_ENGINE_TIMEOUT: agent-browser did not respond."),
      );
    }, input.timeoutMs);
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const result = {
        stdout,
        stderr,
      };
      if (code !== 0) {
        reject(
          new BrowserChildProcessExitError(
            `BROWSER_ENGINE_FAILURE: agent-browser exited ${String(code ?? signal ?? "unknown")}.`,
            code,
            signal,
            stdout,
            stderr,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

class BrowserChildProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

async function resolveOwnedChromeApplicationPid(input: {
  daemonPid: number;
  profilePath: string;
}): Promise<number> {
  const processTable = (
    await spawnAndCollect({
      executable: "/bin/ps",
      args: ["-axo", "pid=,ppid=,command="],
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" },
      timeoutMs: 2_000,
    })
  ).stdout;
  const rows = processTable.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            command: match[3] ?? "",
          },
        ];
  });
  const owned = new Set([input.daemonPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  const profileArgument = `--user-data-dir=${input.profilePath}`;
  const candidates = rows.filter(
    (row) =>
      owned.has(row.pid) &&
      row.command.includes(profileArgument) &&
      !/(?:^|\s)--type=/u.test(row.command),
  );
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: the exact owned Chrome application process was not proven.",
    );
  }
  return candidates[0].pid;
}

async function setDarwinApplicationHidden(
  pid: number,
  hidden: boolean,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: native Browser application concealment is unavailable.",
    );
  }
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Chrome application PID is invalid.",
    );
  }
  const transition = hidden
    ? "const transitionResult = ObjC.unwrap(app.hide);"
    : "const transitionResult = ObjC.unwrap(app.unhide);";
  const script = [
    "ObjC.import('AppKit');",
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});`,
    "if (!app) throw new Error('Browser application unavailable');",
    transition,
    "delay(0.2);",
    `JSON.stringify({pid: ${pid}, hidden: ObjC.unwrap(app.hidden)});`,
  ].join(" ");
  const result = await spawnAndCollect({
    executable: "/usr/bin/osascript",
    args: ["-l", "JavaScript", "-e", script],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" },
    timeoutMs: 4_000,
  });
  let receipt: unknown;
  try {
    receipt = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: native Browser application concealment receipt is invalid.",
    );
  }
  const record = requireRecord(receipt, "native Browser application receipt");
  if (
    record?.pid !== pid ||
    record.hidden !== hidden ||
    !exactRecordKeys(record, ["pid", "hidden"])
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: native Browser application concealment was not proven.",
    );
  }
}

async function terminateOwnedLaunchProcessGroup(
  processGroupId: number,
): Promise<void> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 2) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser launch process group is invalid.",
    );
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(-processGroupId, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    "BROWSER_ENGINE_FAILURE: agent-browser launch process group termination could not be proven.",
  );
}

async function inspectProcessCommand(
  pid: number,
): Promise<
  | { state: "absent" }
  | { state: "zombie"; command: string }
  | { state: "present"; command: string }
> {
  try {
    const result = await spawnAndCollect({
      executable: "/bin/ps",
      args: ["-p", String(pid), "-o", "state=,command="],
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" },
      timeoutMs: 2_000,
    });
    const process = result.stdout.match(/^\s*(\S+)\s+(.+?)\s*$/u);
    if (process === null) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: process inspection returned no command identity.",
      );
    }
    const state = process[1] ?? "";
    const command = process[2] ?? "";
    if (state.startsWith("Z")) return { state: "zombie", command };
    return { state: "present", command };
  } catch (error) {
    // BSD ps documents exit 1 for a selection that matched no process. Every
    // other failure (including timeout, spawn error, or signal) means process
    // state could not be inspected and must fail closed.
    if (
      error instanceof BrowserChildProcessExitError &&
      error.exitCode === 1 &&
      error.signal === null &&
      error.stdout.trim().length === 0 &&
      error.stderr.trim().length === 0
    ) {
      return { state: "absent" };
    }
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser process inspection was unavailable.",
      { cause: error },
    );
  }
}

async function readProcessCommand(pid: number): Promise<string> {
  const inspection = await inspectProcessCommand(pid);
  if (inspection.state === "absent" || inspection.state === "zombie") {
    throw new Error(
      "BROWSER_SESSION_LOST: agent-browser daemon process is absent.",
    );
  }
  return inspection.command;
}

async function terminateOwnedProcessTree(input: {
  pid: number;
  sessionId: string;
  engineExecutablePath: string;
}): Promise<void> {
  const initialInspection = await inspectProcessCommand(input.pid);
  if (initialInspection.state === "absent") return;
  if (initialInspection.state === "zombie") {
    if (
      desktopBrowserZombieCommandMatches(
        initialInspection.command,
        input.engineExecutablePath,
      )
    )
      return;
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser daemon identity changed before cleanup.",
    );
  }
  const command = initialInspection.command;
  if (
    !desktopBrowserDaemonCommandMatches(command, input.engineExecutablePath)
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser daemon identity changed before cleanup.",
    );
  }
  const processTable = (
    await spawnAndCollect({
      executable: "/bin/ps",
      args: ["-axo", "pid=,ppid=,command="],
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" },
      timeoutMs: 2_000,
    })
  ).stdout;
  const rows = processTable.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            command: match[3] ?? "",
          },
        ];
  });
  const owned = new Set([input.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  for (const pid of [...owned].reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of [...owned].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspection = await inspectProcessCommand(input.pid);
    if (inspection.state === "absent") return;
    if (inspection.state === "zombie") {
      if (
        desktopBrowserZombieCommandMatches(
          inspection.command,
          input.engineExecutablePath,
        )
      )
        return;
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser daemon identity changed during cleanup.",
      );
    }
    if (
      !desktopBrowserDaemonCommandMatches(
        inspection.command,
        input.engineExecutablePath,
      )
    ) {
      throw new Error(
        "BROWSER_ENGINE_FAILURE: agent-browser daemon identity changed during cleanup.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "BROWSER_ENGINE_FAILURE: agent-browser daemon termination could not be proven.",
  );
}

export function desktopBrowserDaemonCommandMatches(
  command: string,
  engineExecutablePath: string,
): boolean {
  return command.trim() === engineExecutablePath;
}

export function desktopBrowserZombieCommandMatches(
  command: string,
  engineExecutablePath: string,
): boolean {
  return (
    command.trim() === `[${path.basename(engineExecutablePath)}] <defunct>`
  );
}

export async function assertDesktopBrowserOwnedDaemonArtifacts(
  input: Pick<DesktopBrowserEngineInvocation, "sessionId" | "socketPath">,
): Promise<void> {
  await assertDesktopBrowserOwnedSocketDirectory(input.socketPath);
  await readDesktopBrowserOwnedDaemonPid(input);
  const controlSocketPath = desktopBrowserOwnedControlSocketPath(input);
  const controlSocket = await lstat(controlSocketPath);
  if (!controlSocket.isSocket() || controlSocket.isSymbolicLink()) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser control socket is invalid.",
    );
  }
}

async function requestOwnedAgentBrowserSocketShutdown(
  input: Pick<DesktopBrowserEngineInvocation, "sessionId" | "socketPath">,
): Promise<boolean> {
  try {
    await assertDesktopBrowserOwnedSocketDirectory(input.socketPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  const controlSocketPath = desktopBrowserOwnedControlSocketPath(input);
  let controlSocket;
  try {
    controlSocket = await lstat(controlSocketPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (!controlSocket.isSocket() || controlSocket.isSymbolicLink()) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser control socket is invalid.",
    );
  }
  await sendAgentBrowserShutdownRequest(controlSocketPath, input.sessionId);
  const deadline = Date.now() + AGENT_BROWSER_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await unixSocketIsReachable(controlSocketPath))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await unixSocketIsReachable(controlSocketPath))) return true;
  throw new Error(
    "BROWSER_ENGINE_FAILURE: agent-browser owned session socket remained reachable after shutdown.",
  );
}

async function sendAgentBrowserShutdownRequest(
  socketPath: string,
  sessionId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = "";
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "BROWSER_ENGINE_FAILURE: agent-browser session shutdown timed out.",
          ),
        ),
      2_000,
    );
    timeout.unref?.();
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: `kestrel-shutdown-${sessionId}`,
          action: AGENT_BROWSER_INTERNAL_SHUTDOWN_ACTION,
        })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response = appendBounded(response, chunk.toString("utf8"));
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error(
            "BROWSER_ENGINE_FAILURE: agent-browser returned an invalid session shutdown response.",
          );
        }
        const record = parsed as Record<string, unknown>;
        if (record.success !== true) {
          throw new Error(
            "BROWSER_ENGINE_FAILURE: agent-browser rejected session shutdown.",
          );
        }
        finish();
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("end", () => {
      if (!settled) {
        finish(
          new Error(
            "BROWSER_ENGINE_FAILURE: agent-browser closed before acknowledging session shutdown.",
          ),
        );
      }
    });
  });
}

async function unixSocketIsReachable(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (reachable: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error === undefined) resolve(reachable);
      else reject(error);
    };
    const timeout = setTimeout(
      () =>
        finish(
          false,
          new Error(
            "BROWSER_ENGINE_FAILURE: agent-browser session socket liveness probe timed out.",
          ),
        ),
      250,
    );
    timeout.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        finish(false);
        return;
      }
      finish(false, error);
    });
  });
}

function desktopBrowserOwnedControlSocketPath(
  input: Pick<DesktopBrowserEngineInvocation, "sessionId" | "socketPath">,
): string {
  const directory = path.resolve(input.socketPath);
  const controlSocketPath = path.resolve(directory, `${input.sessionId}.sock`);
  if (path.dirname(controlSocketPath) !== directory) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser session socket escaped its owned namespace.",
    );
  }
  return controlSocketPath;
}

async function pathIsMissing(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return false;
  } catch (error) {
    if (isMissingPathError(error)) return true;
    throw error;
  }
}

async function readDesktopBrowserOwnedDaemonPid(
  input: Pick<DesktopBrowserEngineInvocation, "sessionId" | "socketPath">,
): Promise<number> {
  await assertDesktopBrowserOwnedSocketDirectory(input.socketPath);
  const pidPath = path.join(input.socketPath, `${input.sessionId}.pid`);
  const pidFile = await lstat(pidPath);
  if (!pidFile.isFile() || pidFile.isSymbolicLink()) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser PID sidecar is invalid.",
    );
  }
  const raw = (await readFile(pidPath, "utf8")).trim();
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid < 2) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser daemon PID is invalid.",
    );
  }
  return pid;
}

async function assertDesktopBrowserOwnedSocketDirectory(
  socketPath: string,
): Promise<void> {
  const directory = await lstat(socketPath);
  const uid = process.getuid?.();
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (uid !== undefined && directory.uid !== uid) ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser socket directory is not owned and private.",
    );
  }
}

function appendBounded(current: string, chunk: string): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_ENGINE_OUTPUT_BYTES)
    return current;
  return `${current}${chunk}`.slice(0, MAX_ENGINE_OUTPUT_BYTES);
}

async function readLedger(ledgerPath: string): Promise<DesktopBrowserLedgerV1> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath, "utf8")) as unknown;
    const record = requireRecord(parsed, "Browser session ledger");
    if (
      record.version !== LEDGER_VERSION ||
      !Array.isArray(record.sessions) ||
      (record.artifacts !== undefined && !Array.isArray(record.artifacts))
    ) {
      throw new Error("Browser session ledger is invalid.");
    }
    const sessions = record.sessions.map(parseBrowserSessionV1);
    const artifacts = (record.artifacts ?? []).map(parsePersistedArtifact);
    if (
      new Set(sessions.map((session) => session.sessionId)).size !==
      sessions.length
    ) {
      throw new Error("Browser session ledger contains duplicate session IDs.");
    }
    if (
      new Set(artifacts.map((artifact) => artifact.authorization.id)).size !==
      artifacts.length
    ) {
      throw new Error(
        "Browser session ledger contains duplicate artifact IDs.",
      );
    }
    return { version: LEDGER_VERSION, sessions, artifacts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: LEDGER_VERSION, sessions: [], artifacts: [] };
    }
    throw error;
  }
}

function parsePersistedArtifact(value: unknown): PendingArtifact {
  const record = requireRecord(value, "Browser persisted artifact");
  const authorization = requireRecord(
    record.authorization,
    "Browser persisted artifact authorization",
  );
  const kind = requireText(authorization.kind, "artifact.kind");
  const bytes = authorization.bytes;
  const sha256 = requireText(authorization.sha256, "artifact.sha256");
  if (
    authorization.version !== BROWSER_AUTHORIZED_ARTIFACT_VERSION ||
    (kind !== "browser-screenshot" && kind !== "browser-download") ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0 ||
    !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    throw new Error("Browser persisted artifact authorization is invalid.");
  }
  return {
    runId: requireText(record.runId, "artifact.runId"),
    threadId: requireText(record.threadId, "artifact.threadId"),
    callId: requireText(record.callId, "artifact.callId"),
    toolName: requirePersistedArtifactToolName(record.toolName),
    sessionId: requireText(record.sessionId, "artifact.sessionId"),
    authorization: {
      version: BROWSER_AUTHORIZED_ARTIFACT_VERSION,
      id: requireText(authorization.id, "artifact.id"),
      title: requireText(authorization.title, "artifact.title"),
      kind,
      mediaType: requireText(authorization.mediaType, "artifact.mediaType"),
      bytes: bytes as number,
      sha256,
    },
  };
}

function requirePersistedArtifactToolName(
  value: unknown,
): "browser.capture" | "browser.download" {
  if (value !== "browser.capture" && value !== "browser.download") {
    throw new Error("Browser persisted artifact tool name is invalid.");
  }
  return value;
}

function requirePreparedBrowserUploadEffect(
  prepared: PreparedToolCallV1,
): BrowserUploadPreparedEffectV1 {
  const adapters = prepared.inputAdapters.filter(
    (adapter) => adapter.adapterId === "kestrel.browser-upload-effect:v1",
  );
  if (adapters.length !== 1) {
    throw browserFailure(
      "BROWSER_SERVICE_UNAVAILABLE",
      "The Browser upload is missing exact prepared-effect authority.",
      { browserOutcomeKnown: true, effectDispatched: false },
    );
  }
  return parseBrowserUploadPreparedEffectV1(adapters[0]!.metadata);
}

function requirePreparedBrowserDownloadEffect(
  prepared: PreparedToolCallV1,
): BrowserDownloadPreparedEffectV1 {
  const adapters = prepared.inputAdapters.filter(
    (adapter) => adapter.adapterId === "kestrel.browser-download-effect:v1",
  );
  if (adapters.length !== 1) {
    throw browserFailure(
      "BROWSER_SERVICE_UNAVAILABLE",
      "The Browser download is missing exact prepared-effect authority.",
      { browserOutcomeKnown: true, effectDispatched: false },
    );
  }
  return parseBrowserDownloadPreparedEffectV1(adapters[0]!.metadata);
}

function canonicalBrowserDownloadMetadata(input: {
  pendingDownloadId?: string;
  downloadId?: string;
  filename: string;
  measuredBytes: number;
  sha256: string;
  declaredMediaType: string;
  normalizedSourceOrigin: string;
  createdAt: string;
  expiresAt: string;
}): Record<string, unknown> {
  return {
    pendingDownloadId: input.pendingDownloadId ?? input.downloadId,
    filename: input.filename,
    measuredBytes: input.measuredBytes,
    sha256: input.sha256,
    declaredMediaType: input.declaredMediaType,
    normalizedSourceOrigin: input.normalizedSourceOrigin,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

function hashCanonicalDownload(
  input: DesktopBrowserInterceptedDownload | BrowserDownloadPreparedEffectV1,
): string {
  return digest(canonicalBrowserDownloadMetadata(input));
}

function publicPendingBrowserDownload(
  download: DesktopBrowserInterceptedDownload,
): Record<string, unknown> {
  return {
    downloadId: download.downloadId,
    filename: download.filename,
    measuredBytes: download.measuredBytes,
    declaredMediaType: download.declaredMediaType,
    normalizedSourceOrigin: download.normalizedSourceOrigin,
    sha256: download.sha256,
    createdAt: download.createdAt,
    expiresAt: download.expiresAt,
  };
}

async function measureOwnedBrowserDownload(
  ownedPath: string,
  maximumBytes: number,
): Promise<{ measuredBytes: number; sha256: string }> {
  const handle = await openExactOwnedBrowserDownload(ownedPath, maximumBytes);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let measuredBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      measuredBytes += bytesRead;
      if (measuredBytes > maximumBytes) {
        throw browserFailure(
          "BROWSER_ARTIFACT_TOO_LARGE",
          "The Browser download exceeded the quarantine file limit.",
          { browserOutcomeKnown: true, downloadIntercepted: true },
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { measuredBytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function openExactOwnedBrowserDownload(
  ownedPath: string,
  maximumBytes: number,
) {
  const before = await lstat(ownedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw browserFailure(
      "BROWSER_DOWNLOAD_UNAVAILABLE",
      "The Browser download quarantine entry is not an exact owned file.",
      { browserOutcomeKnown: true, effectDispatched: false },
    );
  }
  const handle = await open(
    ownedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw browserFailure(
        "BROWSER_DOWNLOAD_UNAVAILABLE",
        "The Browser download quarantine identity changed.",
        { browserOutcomeKnown: true, effectDispatched: false },
      );
    }
    if (opened.size > maximumBytes || opened.size < 0) {
      throw browserFailure(
        "BROWSER_ARTIFACT_TOO_LARGE",
        "The Browser download exceeded the quarantine file limit.",
        { browserOutcomeKnown: true, downloadIntercepted: true },
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function requireBrowserDownloadGuid(value: unknown): string {
  const guid = requireText(value, "Browser download GUID");
  if (!BROWSER_DOWNLOAD_GUID_PATTERN.test(guid)) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser download GUID is invalid.",
    );
  }
  return guid;
}

function sanitizeBrowserDownloadFilename(value: unknown): string {
  if (typeof value !== "string") return "download";
  return sanitizeBrowserUploadResultFilename(value) || "download";
}

function normalizeBrowserDownloadSourceOrigin(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "unknown";
    }
    return parsed.origin;
  } catch {
    return "unknown";
  }
}

function attachmentMatchesAuthorization(
  attachment: DesktopAttachmentMetadata,
  authorization: BrowserAuthorizedArtifactV1,
): boolean {
  return (
    attachment.fileId === authorization.id &&
    attachment.mimeType === authorization.mediaType &&
    attachment.sizeBytes === authorization.bytes &&
    attachment.sha256 === authorization.sha256
  );
}

async function writeLedger(
  ledgerPath: string,
  ledger: DesktopBrowserLedgerV1,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, ledgerPath);
}

function createQaAuthority(input: {
  threadId: string;
  projectId: string;
  destination: string;
  revision: string;
}): BrowserEffectiveDomainAuthorityV1 {
  const qaTarget = canonicalizeTrustedBrowserQaTarget(input.destination);
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "desktop-local",
    projectId: input.projectId,
    userId: "desktop-local-user",
    enabledModes: ["qa"],
    personalGrantsEnabled: false,
    publicDomains: [],
    qaTarget: {
      version: BROWSER_QA_TARGET_VERSION,
      scheme: qaTarget.scheme,
      hostname: qaTarget.hostname,
      port: qaTarget.port,
    },
    effectiveAllowlistRevision: digest({
      revision: input.revision,
      threadId: input.threadId,
      projectId: input.projectId,
      qaTarget,
    }),
  };
}

function browserOutput(
  operation: string,
  output: Record<string, unknown>,
): unknown {
  return {
    version: BROWSER_TOOL_RESULT_VERSION,
    operation,
    ...output,
  };
}

function browserArtifactOutput(
  authorization: BrowserAuthorizedArtifactV1,
): Omit<BrowserAuthorizedArtifactV1, "version"> {
  const { version: _authorizationVersion, ...artifact } = authorization;
  return artifact;
}

function sanitizeBrowserUploadResultFilename(value: string): string {
  const filename = path
    .basename(value.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 255);
  return filename || "attachment";
}

function requirePublicDestination(target: Record<string, unknown>): string {
  if (target.kind !== "public_url") {
    throw browserFailure(
      "BROWSER_DESTINATION_BLOCKED",
      "Operator Browser mode requires a public URL.",
    );
  }
  const destination = requireText(target.url, "target.url");
  canonicalizePublicBrowserDestination(destination);
  return destination;
}

function mapInteraction(
  kind: string,
  ref: string | undefined,
  action: Record<string, unknown>,
): string[] {
  switch (kind) {
    case "click":
    case "check":
    case "uncheck":
      return [kind, requireText(ref, "action.ref")];
    case "fill":
    case "type":
      return [
        kind,
        requireText(ref, "action.ref"),
        requireText(action.text, "action.text"),
      ];
    case "press":
      return ["press", requireText(action.key, "action.key")];
    case "select":
      if (!Array.isArray(action.values) || action.values.length === 0) {
        throw browserFailure(
          "BROWSER_TARGET_STALE",
          "Browser select values are invalid.",
        );
      }
      return [
        "select",
        requireText(ref, "action.ref"),
        ...action.values.map((value) => requireText(value, "action.values")),
      ];
    case "scroll":
      return [
        "scroll",
        requireText(action.direction, "action.direction"),
        String(action.amount),
        ...(ref === undefined ? [] : ["--selector", ref]),
      ];
    default:
      throw browserFailure(
        "BROWSER_TARGET_STALE",
        "Browser interaction is unsupported.",
      );
  }
}

function requireEngineRef(value: string): string {
  if (!/^@e[1-9][0-9]*$/u.test(value)) {
    throw browserFailure(
      "BROWSER_TARGET_STALE",
      "Browser target ref is invalid.",
    );
  }
  return value;
}

function requireTabId(value: unknown): string {
  const tabId = requireText(value, "tabId");
  if (!/^t[1-9][0-9]*$/u.test(tabId)) {
    throw browserFailure("BROWSER_TARGET_STALE", "Browser tab ID is invalid.");
  }
  return tabId;
}

function requireGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw browserFailure(
      "BROWSER_SESSION_LOST",
      "The Browser operation generation is invalid.",
    );
  }
  return value as number;
}

function desktopBrowserSocketPath(sessionId: string): string {
  requireDesktopBrowserSessionId(sessionId, "Browser session ID");
  const uid = process.getuid?.() ?? 0;
  const sessionHash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return path.join("/tmp", `kestrel-browser-${uid}`, sessionHash);
}

interface DesktopBrowserOwnedPaths {
  runtimePath: string;
  socketPath: string;
  profilePath: string;
  configPath: string;
  screenshotPath: string;
  blockedDownloadPath: string;
}

function requireDesktopBrowserSessionId(value: string, label: string): string {
  if (!DESKTOP_BROWSER_SESSION_ID_PATTERN.test(value)) {
    throw new Error(
      `BROWSER_ENGINE_FAILURE: ${label} is not a path-safe opaque identifier.`,
    );
  }
  return value;
}

function desktopBrowserOwnedPaths(
  runtimeRoot: string,
  sessionId: string,
): DesktopBrowserOwnedPaths {
  requireDesktopBrowserSessionId(sessionId, "Browser session ID");
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const runtimePath = path.resolve(resolvedRuntimeRoot, sessionId);
  if (path.dirname(runtimePath) !== resolvedRuntimeRoot) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser runtime path escaped its owned root.",
    );
  }
  const socketRoot = path.resolve(
    "/tmp",
    `kestrel-browser-${process.getuid?.() ?? 0}`,
  );
  const socketPath = path.resolve(desktopBrowserSocketPath(sessionId));
  if (path.dirname(socketPath) !== socketRoot) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser socket path escaped its owned root.",
    );
  }
  return {
    runtimePath,
    socketPath,
    profilePath: path.join(runtimePath, "profile"),
    configPath: path.join(runtimePath, "config"),
    screenshotPath: path.join(runtimePath, "screenshot.png"),
    blockedDownloadPath: path.join(runtimePath, "downloads-disabled"),
  };
}

function assertDesktopBrowserInvocationPaths(
  expected: DesktopBrowserOwnedPaths,
  invocation: DesktopBrowserEngineInvocation,
): void {
  for (const key of [
    "runtimePath",
    "socketPath",
    "profilePath",
    "configPath",
    "screenshotPath",
    "blockedDownloadPath",
  ] as const) {
    if (path.resolve(invocation[key]) !== expected[key]) {
      throw new Error(
        `BROWSER_ENGINE_FAILURE: Browser ${key} escaped its owned session namespace.`,
      );
    }
  }
}

async function removeDesktopBrowserRuntimePaths(
  ownedPaths: DesktopBrowserOwnedPaths,
): Promise<void> {
  // Runtime data is removed before the control socket. If interrupted, the
  // remaining socket can still prove or complete daemon termination on restart.
  await rm(ownedPaths.runtimePath, { recursive: true, force: true });
  await rm(ownedPaths.socketPath, { recursive: true, force: true });
}

async function prepareOwnedSocketDirectory(socketPath: string): Promise<void> {
  const root = path.dirname(socketPath);
  await ensureOwnedPrivateDirectory(root);
  await ensureOwnedPrivateDirectory(socketPath);
}

async function ensureOwnedPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser socket path is not an owned directory.",
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: Browser socket path has another owner.",
    );
  }
  await chmod(directory, 0o700);
}

function parseTabs(stdout: string): {
  activeTabId: string;
  tabs: Array<{
    tabId: string;
    normalizedOrigin: string;
    title: string;
    active: boolean;
  }>;
} {
  const data = unwrapAgentJson(stdout);
  const candidates = Array.isArray(data)
    ? data
    : Array.isArray(requireOptionalRecord(data)?.tabs)
      ? (requireOptionalRecord(data)!.tabs as unknown[])
      : [];
  const hasExplicitActiveTab = candidates.some((candidate) => {
    const record = requireOptionalRecord(candidate);
    return (
      typeof record?.active === "boolean" ||
      typeof record?.isActive === "boolean"
    );
  });
  const tabs = candidates.flatMap((candidate, index) => {
    const record = requireOptionalRecord(candidate);
    if (record === undefined) return [];
    const tabId =
      typeof record.tabId === "string"
        ? record.tabId
        : typeof record.id === "string"
          ? record.id
          : `t${index + 1}`;
    if (typeof record.url !== "string" || record.url.length === 0) {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "Browser engine returned a tab without an exact URL.",
      );
    }
    let normalizedOrigin: string;
    try {
      const parsed = new URL(record.url);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.origin === "null"
      ) {
        throw new Error("unsupported tab URL");
      }
      normalizedOrigin = parsed.origin;
    } catch {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "Browser engine returned an unsupported or invalid tab URL.",
      );
    }
    return [
      {
        tabId,
        normalizedOrigin,
        title:
          typeof record.title === "string" ? record.title.slice(0, 2048) : "",
        active:
          record.active === true ||
          record.isActive === true ||
          (!hasExplicitActiveTab && index === 0),
      },
    ];
  });
  if (tabs.length === 0) {
    throw browserFailure(
      "BROWSER_TARGET_STALE",
      "The Browser Session no longer has a bound tab.",
    );
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) {
    throw browserFailure(
      "BROWSER_ENGINE_FAILURE",
      "Browser engine returned duplicate tab identities.",
    );
  }
  return {
    activeTabId: tabs.find((tab) => tab.active)?.tabId ?? tabs[0]!.tabId,
    tabs,
  };
}

function boundTabsForOutput(
  parsed: ReturnType<typeof parseTabs>,
  requestedTabId?: string | undefined,
): ReturnType<typeof parseTabs> {
  if (parsed.tabs.length <= MAX_BROWSER_TABS) return parsed;
  const preservedIds = new Set([
    parsed.activeTabId,
    ...(requestedTabId === undefined ? [] : [requestedTabId]),
  ]);
  const selectedIds = new Set<string>();
  for (const tab of parsed.tabs) {
    if (preservedIds.has(tab.tabId)) selectedIds.add(tab.tabId);
  }
  for (const tab of parsed.tabs) {
    if (selectedIds.size >= MAX_BROWSER_TABS) break;
    selectedIds.add(tab.tabId);
  }
  return {
    activeTabId: parsed.activeTabId,
    tabs: parsed.tabs.filter((tab) => selectedIds.has(tab.tabId)),
  };
}

function extractScalar(stdout: string, field: string): string {
  const data = unwrapAgentJson(stdout);
  if (typeof data === "string") return data;
  const record = requireOptionalRecord(data);
  const nested = requireOptionalRecord(record?.data);
  const value =
    record?.[field] ?? nested?.[field] ?? record?.value ?? nested?.value;
  return typeof value === "string" ? value : stdout.trim();
}

function extractOptionalAgentAttribute(stdout: string): string | undefined {
  return extractOptionalAgentString(stdout, "value");
}

function extractOptionalAgentString(
  stdout: string,
  field: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  const outer = requireOptionalRecord(parsed);
  if (!outer) return;
  const data = requireOptionalRecord(outer.data);
  const value = data?.[field] ?? outer[field];
  return typeof value === "string" ? value : undefined;
}

function extractSuccessfulAgentString(stdout: string, field: string): string;
function extractSuccessfulAgentString(
  stdout: string,
  field: string,
  allowNull: true,
): string | undefined;
function extractSuccessfulAgentString(
  stdout: string,
  field: string,
  allowNull = false,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser returned invalid JSON.",
    );
  }
  const outer = requireOptionalRecord(parsed);
  const data = requireOptionalRecord(outer?.data);
  if (outer?.success !== true || outer.error !== null || data === undefined) {
    throw new Error(
      "BROWSER_ENGINE_FAILURE: agent-browser returned an unsuccessful response.",
    );
  }
  const value = data[field];
  if (typeof value === "string") return value;
  if (allowNull && value === null) return undefined;
  throw new Error(
    "BROWSER_ENGINE_FAILURE: agent-browser returned invalid response data.",
  );
}

function extractEngineContent(
  result: DesktopBrowserEngineCommandResult,
): string {
  const data = unwrapAgentJson(result.stdout);
  if (typeof data === "string") return data;
  const record = requireOptionalRecord(data);
  const nested = requireOptionalRecord(record?.data);
  const value =
    record?.snapshot ??
    record?.content ??
    record?.text ??
    nested?.snapshot ??
    nested?.content ??
    nested?.text;
  return typeof value === "string" ? value : JSON.stringify(data);
}

function metadataOnlyNetworkSummary(stdout: string): string {
  const data = unwrapAgentJson(stdout);
  const record = requireOptionalRecord(data);
  const requests = Array.isArray(data)
    ? data
    : Array.isArray(record?.requests)
      ? (record!.requests as unknown[])
      : [];
  const byStatus: Record<string, number> = {};
  for (const request of requests) {
    const entry = requireOptionalRecord(request);
    const status =
      typeof entry?.status === "number" ? String(entry.status) : "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return JSON.stringify({ requestCount: requests.length, byStatus });
}

function unwrapAgentJson(stdout: string): unknown {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const record = requireOptionalRecord(parsed);
    return record?.data ?? parsed;
  } catch {
    return stdout;
  }
}

function splitContent(value: string): string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += MAX_PAGE_OUTPUT_CHARS) {
    chunks.push(value.slice(offset, offset + MAX_PAGE_OUTPUT_CHARS));
  }
  return chunks;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runDirectly<T>(action: () => Promise<T>): Promise<T> {
  return await action();
}

function isEngineLost(error: unknown): boolean {
  return (
    error instanceof Error &&
    /ECONNREFUSED|socket|daemon|process exited/iu.test(error.message)
  );
}

function isEngineTabGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    /tab[_ -]?gone|target page.*closed|no bound tab/iu.test(error.message)
  );
}

function isBrowserDownloadUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code ===
      "BROWSER_DOWNLOAD_UNAVAILABLE"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value))
    throw new Error(`${label} must be an absolute path.`);
  return path.normalize(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireOptionalRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object.`);
  return record;
}

function requireOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
