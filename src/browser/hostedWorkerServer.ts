import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import {
  BROWSER_RUNTIME_RELEASE_MANIFEST,
  getHostedBrowserRuntimeRelease,
  requireImmutableHostedBrowserWorkerImage,
} from "./runtimeReleaseManifest.js";
import {
  BROWSER_SERVICE_PORT_VERSION,
  parseBrowserUploadPreparedEffectV1,
  parseBrowserSessionV1,
  type BrowserSessionV1,
  type BrowserUploadPreparationRequestV1,
  type BrowserUploadPreparedEffectV1,
} from "./contracts.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "./domainAuthority.js";
import {
  parsePreparedToolCallV1,
  type PreparedToolCallV1,
} from "../kestrel/contracts/tool-invocation.js";
import { hashCanonical } from "../kestrel/contracts/tool-contract.js";
import { verifyHostedBrowserCapabilitySignature } from "./hostedCapability.js";
import { verifyHostedBrowserUploadPreparationCapability } from "./hostedUploadCapability.js";
import {
  HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED,
  HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE,
  verifyHostedBrowserViewerCleanupCapability,
  verifyHostedBrowserViewerTicket,
  type HostedBrowserViewerCleanupCapabilityV1,
  type HostedBrowserViewerTicketClaimsV1,
} from "./hostedViewer.js";
import {
  HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES,
  HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
  hostedBrowserViewerPngBase64ByteLength,
  parseHostedBrowserViewerServerMessage,
} from "./hostedViewerProtocol.js";
import {
  parseDesktopBrowserViewerInputRequest,
  type DesktopBrowserViewerFrameV1,
  type DesktopBrowserViewerInputV1,
  type DesktopBrowserViewerStateV1,
} from "../desktopShell/contracts.js";
import { DesktopBrowserService } from "../localCore/desktopBrowserService.js";
import type { DesktopAttachmentMetadata } from "../localCore/desktopAttachments.js";
import {
  LOCAL_CORE_BROWSER_EGRESS_LAUNCH_BINDING_VERSION,
  LOCAL_CORE_BROWSER_EGRESS_PROXY_VERSION,
  type LocalCoreBrowserEgressLaunchBindingV1,
  type LocalCoreBrowserEgressProxy,
} from "../localCore/browserEgressProxy.js";

export const HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
export const HOSTED_BROWSER_WORKER_HOME_PATH = "/tmp/kb";
type AcceptedOperation = {
  prepared: PreparedToolCallV1;
  identityHash: string;
  capability: string;
  authority: BrowserEffectiveDomainAuthorityV1;
  gatewayProxy?: HostedBrowserGatewayProxyBindingV1 | undefined;
  session?: BrowserSessionV1 | undefined;
  deadline: ReturnType<typeof setTimeout>;
  execution: Promise<unknown>;
  invoke: () => void;
  cancelInvoke: (error: Error) => void;
  commit: () => void;
  cancelCommit: (error: Error) => void;
  abort: AbortController;
  acknowledged: Promise<void>;
  result: Promise<unknown>;
  acceptOutcome: Promise<unknown>;
  phase: "accepted" | "invoked" | "pre_dispatch_result" | "committing" | "cancelling";
};

export type HostedBrowserWorkerConfig = {
  sessionId: string;
  generation: number;
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  threadId: string;
  engineRevision: string;
  chromeRevision: string;
  effectiveAllowlistRevision: string;
  imageDigest: string;
  capabilityPublicKeyPem: string;
  gatewayHost: string;
  gatewayAddress: string;
  gatewayPort: number;
  engineExecutablePath: string;
  chromeExecutablePath: string;
  port: number;
};

type HostedBrowserGatewayProxyBindingV1 = {
  version: "hosted_browser_gateway_proxy_binding_v1";
  proxyServer: string;
  username: string;
  password: string;
  threadId: string;
  sessionId: string;
  generation: number;
  effectiveAllowlistRevision: string;
  chromiumFlags: readonly string[];
};

export interface HostedBrowserWorkerEngine {
  execute(input: {
    prepared: PreparedToolCallV1;
    authority: BrowserEffectiveDomainAuthorityV1;
    session?: BrowserSessionV1 | undefined;
    gatewayProxy?: HostedBrowserGatewayProxyBindingV1 | undefined;
  }, lifecycle: {
    signal?: AbortSignal | undefined;
    acknowledgeDispatch(): Promise<void>;
    persistCompletedResult(output: unknown): Promise<void>;
  }): Promise<unknown>;
  adopt(input: {
    authority: BrowserEffectiveDomainAuthorityV1;
    cause: "personal_grant" | "personal_revocation";
    gatewayProxy?: HostedBrowserGatewayProxyBindingV1 | undefined;
    gatewayClosedUnauthorizedConnections?: number | undefined;
  }): Promise<number>;
  prepareUpload?(input: BrowserUploadPreparationRequestV1): Promise<BrowserUploadPreparedEffectV1>;
  receiveUpload?(input: {
    operationId: string;
    effect: BrowserUploadPreparedEffectV1;
    body: AsyncIterable<Uint8Array>;
  }): Promise<void>;
  cancelUpload?(operationId: string): Promise<void>;
  viewer?(input: {
    action: "connect" | "frame" | "accept" | "renew" | "input" | "return" | "disconnect" | "close";
    claims: HostedBrowserViewerTicketClaimsV1;
    connectionId?: string | undefined;
    leaseId?: string | undefined;
    viewerInput?: DesktopBrowserViewerInputV1 | undefined;
  }): Promise<DesktopBrowserViewerStateV1 | DesktopBrowserViewerFrameV1 | null>;
  viewerCleanup?(claims: HostedBrowserViewerCleanupCapabilityV1): Promise<void>;
  destroy(): Promise<void>;
}

export function startHostedBrowserWorker(input: {
  config: HostedBrowserWorkerConfig;
  engine?: HostedBrowserWorkerEngine | undefined;
  onControlLoss?: (() => void) | undefined;
}) {
  const config = validateConfig(input.config);
  const engine = input.engine ?? new AgentBrowserHostedWorkerEngine(config);
  const accepted = new Map<string, AcceptedOperation>();
  let terminating = false;
  const terminationStarted = deferred<void>();
  let revisionInstalling = false;
  let viewerFrameSettlement: Promise<void> | undefined;
  let installedAllowlistRevision = config.effectiveAllowlistRevision;
  const beginTermination = () => {
    if (terminating) return false;
    terminating = true;
    terminationStarted.resolve();
    return true;
  };
  const loseControl = async () => {
    if (!beginTermination()) return;
    for (const operation of accepted.values()) {
      clearTimeout(operation.deadline);
      operation.cancelInvoke(new Error("BROWSER_ACTION_OUTCOME_UNKNOWN"));
      operation.cancelCommit(new Error("BROWSER_ACTION_OUTCOME_UNKNOWN"));
    }
    accepted.clear();
    await engine.destroy().catch(() => {});
    input.onControlLoss?.();
    server.close();
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") return writeError(response, 404, "BROWSER_ENGINE_FAILURE");
      const pathname = new URL(request.url ?? "/", "http://worker.internal").pathname;
      if (terminating && pathname !== "/v1/viewer-cleanup") {
        throw new Error("BROWSER_SESSION_LOST");
      }
      if (pathname === "/v1/upload/bytes") {
        const operationId = requiredHeader(request, "x-kestrel-browser-operation-id");
        const capability = requiredHeader(request, "x-kestrel-browser-operation-capability");
        const operation = accepted.get(operationId);
        if (
          !operation ||
          operation.capability !== capability ||
          operation.prepared.activation.descriptor.toolId !== "browser.upload" ||
          typeof engine.receiveUpload !== "function"
        ) throw new Error("BROWSER_SESSION_LOST");
        const effect = requirePreparedUploadEffect(operation.prepared);
        const declared = Number(request.headers["content-length"] ?? "-1");
        if (declared !== effect.sizeBytes) throw new Error("BROWSER_ENGINE_FAILURE");
        await engine.receiveUpload({
          operationId,
          effect,
          body: incomingBody(request, effect.sizeBytes),
        });
        return writeJson(response, 200, { staged: true, operationId });
      }
      const body = await readJson(request);
      if (terminating && pathname !== "/v1/viewer-cleanup") {
        throw new Error("BROWSER_SESSION_LOST");
      }
      if (pathname === "/v1/operations/accept") {
        if (revisionInstalling) {
          throw new Error("BROWSER_ENGINE_FAILURE");
        }
        const record = requireRecord(body);
        const prepared = parsePreparedToolCallV1(record.prepared);
        const authority = requireAuthority(record.authority);
        const gatewayProxy = record.gatewayProxy === undefined
          ? undefined
          : requireGatewayProxyBinding(record.gatewayProxy, config);
        const operation = prepared.activation.descriptor.toolId;
        const capability = requiredString(record.capability);
        const claims = verifyHostedBrowserCapabilitySignature({
          token: capability,
          publicKeyPem: config.capabilityPublicKeyPem,
        });
        if (
          claims.organizationId !== config.organizationId ||
          claims.environmentId !== config.environmentId ||
          claims.projectId !== config.projectId ||
          claims.userId !== config.userId ||
          claims.threadId !== config.threadId ||
          claims.sessionId !== config.sessionId ||
          claims.generation !== config.generation ||
          claims.operationId !== prepared.callId ||
          claims.effectiveAllowlistRevision !==
            authority.effectiveAllowlistRevision ||
          authority.environmentId !== config.environmentId ||
          authority.projectId !== config.projectId ||
          authority.userId !== config.userId ||
          (gatewayProxy !== undefined &&
            (gatewayProxy.threadId !== config.threadId ||
              gatewayProxy.sessionId !== config.sessionId ||
              gatewayProxy.generation !== config.generation ||
              (operation !== "browser.request_grant" &&
                gatewayProxy.effectiveAllowlistRevision !==
                  authority.effectiveAllowlistRevision)))
        ) throw new Error("BROWSER_ENGINE_FAILURE");
        if (
          authority.effectiveAllowlistRevision !== installedAllowlistRevision &&
          operation !== "browser.request_grant"
        ) throw new Error("BROWSER_ENGINE_FAILURE");
        const session = record.session === undefined
          ? undefined
          : parseBrowserSessionV1(record.session);
        if (session &&
          (session.sessionId !== config.sessionId ||
            session.generation !== config.generation ||
            session.threadId !== config.threadId)) {
          throw new Error("BROWSER_SESSION_LOST");
        }
        const pendingFrame = viewerFrameSettlement;
        if (pendingFrame) {
          await Promise.race([pendingFrame, terminationStarted.promise]);
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          if (revisionInstalling) throw new Error("BROWSER_ENGINE_FAILURE");
          // The immutable token and key passed exact validation above; after
          // this await, only the verifier's authoritative expiry check can change.
          try {
            verifyHostedBrowserCapabilitySignature({
              token: capability,
              publicKeyPem: config.capabilityPublicKeyPem,
            });
          } catch {
            throw knownWorkerFailure("BROWSER_ENGINE_FAILURE");
          }
        }
        const identityHash = hashCanonical({
          prepared,
          authority,
          session: session ?? null,
          gatewayProxy: gatewayProxy ?? null,
        });
        const duplicate = accepted.get(prepared.callId);
        if (duplicate) {
          if (
            duplicate.capability !== capability ||
            duplicate.identityHash !== identityHash
          ) throw new Error("BROWSER_ENGINE_FAILURE");
          const outcome = await duplicate.acceptOutcome;
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          return writeJson(response, 200, outcome);
        }
        if (accepted.size !== 0) throw new Error("BROWSER_ENGINE_FAILURE");
        const delay = Math.max(1, new Date(claims.expiresAt).getTime() - Date.now());
        const deadline = setTimeout(() => void loseControl(), delay);
        deadline.unref();
        const gate = deferred<void>();
        const commitGate = deferred<void>();
        const acknowledged = deferred<void>();
        const result = deferred<unknown>();
        const abort = new AbortController();
        void gate.promise.catch(() => {});
        void commitGate.promise.catch(() => {});
        void acknowledged.promise.catch(() => {});
        void result.promise.catch(() => {});
        let dispatchAcknowledged = false;
        const operationInput = {
          prepared,
          identityHash,
          capability,
          authority,
          gatewayProxy,
          session,
          deadline,
        };
        const execution = engine.execute(operationInput, {
          signal: abort.signal,
          async acknowledgeDispatch() {
            dispatchAcknowledged = true;
            acknowledged.resolve();
            await gate.promise;
          },
          async persistCompletedResult(output) {
            if (operation === "browser.request_grant") {
              const adoptedRevision = requestGrantResultRevision(output);
              if (adoptedRevision !== authority.effectiveAllowlistRevision) {
                throw new Error("BROWSER_ENGINE_FAILURE");
              }
              installedAllowlistRevision = adoptedRevision;
            }
            result.resolve(output);
            await commitGate.promise;
          },
        }).catch((error) => {
          acknowledged.reject(error);
          result.reject(error);
          if (
            dispatchAcknowledged &&
            readDetails(error)?.browserOutcomeKnown !== true
          ) {
            void loseControl();
          } else if (operation !== "browser.upload") {
            clearTimeout(deadline);
            accepted.delete(prepared.callId);
          }
          throw error;
        });
        // The execution promise is owned by /invoke; suppress an unhandled
        // rejection if the engine fails before the caller receives acceptance.
        void execution.catch(() => {});
        const acceptOutcome = operation === "browser.upload"
          ? Promise.resolve(acceptanceResponse(config, prepared.callId))
          : Promise.race([
          acknowledged.promise.then(() =>
            acceptanceResponse(config, prepared.callId)
          ),
          result.promise.then((output) =>
            completionBeforeDispatchResponse(config, prepared.callId, output)
          ),
          ]);
        const acceptedOperation: AcceptedOperation = {
          ...operationInput,
          execution,
          invoke: gate.resolve,
          cancelInvoke: gate.reject,
          commit: commitGate.resolve,
          cancelCommit: commitGate.reject,
          abort,
          acknowledged: acknowledged.promise,
          result: result.promise,
          acceptOutcome,
          phase: "accepted",
        };
        accepted.set(prepared.callId, acceptedOperation);
        try {
          const outcome = await acceptOutcome;
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          if (
            isCompletionBeforeDispatchResponse(outcome) &&
            !dispatchAcknowledged
          ) {
            acceptedOperation.phase = "pre_dispatch_result";
          }
          return writeJson(response, 200, outcome);
        } catch (error) {
          clearTimeout(deadline);
          accepted.delete(prepared.callId);
          throw error;
        }
      }
      if (pathname === "/v1/upload/prepare") {
        const record = requireRecord(body);
        const requestBody = record.request as BrowserUploadPreparationRequestV1;
        const claims = verifyHostedBrowserUploadPreparationCapability({
          token: requiredString(record.capability),
          publicKeyPem: config.capabilityPublicKeyPem,
        });
        if (
          typeof engine.prepareUpload !== "function" ||
          claims.organizationId !== config.organizationId ||
          claims.environmentId !== config.environmentId ||
          claims.projectId !== config.projectId ||
          claims.userId !== config.userId ||
          claims.threadId !== config.threadId ||
          claims.sessionId !== config.sessionId ||
          claims.generation !== config.generation ||
          claims.turnId !== requestBody?.turnId ||
          claims.runId !== requestBody?.runId ||
          claims.attachmentId !== requestBody?.attachment?.attachmentId ||
          claims.snapshotId !== requestBody?.effectiveInput?.snapshotId ||
          claims.targetRef !== requestBody?.effectiveInput?.targetRef ||
          claims.effectRevision !== hashCanonical(requestBody)
        ) throw new Error("BROWSER_SESSION_LOST");
        return writeJson(response, 200, await engine.prepareUpload(requestBody));
      }
      if (pathname === "/v1/operations/invoke") {
        const record = requireRecord(body);
        const operationId = requiredString(record.operationId);
        const capability = requiredString(record.capability);
        const operation = accepted.get(operationId);
        if (!operation || operation.capability !== capability) {
          throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        }
        if (operation.phase !== "accepted") {
          throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        }
        operation.phase = "invoked";
        operation.invoke();
        const output = await operation.result;
        if (terminating) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        return writeJson(response, 200, output);
      }
      if (pathname === "/v1/operations/commit") {
        if (terminating) throw new Error("BROWSER_SESSION_LOST");
        const record = requireRecord(body);
        const operationId = requiredString(record.operationId);
        const capability = requiredString(record.capability);
        const operation = accepted.get(operationId);
        if (
          !operation ||
          operation.capability !== capability ||
          (operation.phase !== "invoked" &&
            operation.phase !== "pre_dispatch_result")
        ) {
          throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        }
        operation.phase = "committing";
        operation.commit();
        try {
          await operation.execution;
          if (terminating) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        } finally {
          accepted.delete(operationId);
          clearTimeout(operation.deadline);
        }
        return writeJson(response, 200, { committed: true, operationId });
      }
      if (pathname === "/v1/operations/cancel") {
        const record = requireRecord(body);
        const operationId = requiredString(record.operationId);
        const capability = requiredString(record.capability);
        const reason = record.reason === "BROWSER_ARTIFACT_TOO_LARGE"
          ? record.reason
          : "BROWSER_DESTINATION_BLOCKED";
        const operation = accepted.get(operationId);
        if (
          !operation ||
          operation.capability !== capability ||
          (operation.phase !== "accepted" &&
            operation.phase !== "pre_dispatch_result" &&
            operation.phase !== "invoked")
        ) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        const cancelledPhase = operation.phase;
        operation.phase = "cancelling";
        operation.abort.abort(new Error("BROWSER_ACTION_CANCELLED"));
        if (operation.prepared.activation.descriptor.toolId === "browser.upload") {
          if (typeof engine.cancelUpload !== "function") {
            throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
          }
          await engine.cancelUpload(operationId);
        }
        if (cancelledPhase === "accepted") {
          operation.cancelInvoke(knownWorkerFailure("BROWSER_DESTINATION_BLOCKED"));
        } else {
          operation.cancelCommit(knownWorkerFailure(reason));
        }
        try {
          await operation.execution.catch(() => {});
          if (terminating) throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
        } finally {
          accepted.delete(operationId);
          clearTimeout(operation.deadline);
        }
        return writeJson(response, 200, { cancelled: true, operationId });
      }
      if (pathname === "/v1/operations/revision") {
        const record = requireRecord(body);
        const authority = requireAuthority(record.authority);
        const revision = requiredString(record.revision);
        const capability = requiredString(record.capability);
        const gatewayProxy = record.gatewayProxy === undefined
          ? undefined
          : requireGatewayProxyBinding(record.gatewayProxy, config);
        const gatewayClosedUnauthorizedConnections =
          record.gatewayClosedUnauthorizedConnections === undefined
            ? undefined
            : requiredNonNegativeInteger(
                record.gatewayClosedUnauthorizedConnections,
              );
        const claims = verifyHostedBrowserCapabilitySignature({
          token: capability,
          publicKeyPem: config.capabilityPublicKeyPem,
        });
        if (
          record.sessionId !== config.sessionId ||
          record.generation !== config.generation ||
          claims.operationId !== `revision:${revision}` ||
          claims.effectiveAllowlistRevision !== revision ||
          claims.organizationId !== config.organizationId ||
          claims.environmentId !== config.environmentId ||
          claims.projectId !== config.projectId ||
          claims.userId !== config.userId ||
          claims.threadId !== config.threadId ||
          claims.sessionId !== config.sessionId ||
          claims.generation !== config.generation ||
          authority.environmentId !== config.environmentId ||
          authority.projectId !== config.projectId ||
          authority.userId !== config.userId ||
          authority.effectiveAllowlistRevision !== revision ||
          (gatewayProxy !== undefined &&
            (gatewayProxy.sessionId !== config.sessionId ||
              gatewayProxy.generation !== config.generation ||
              gatewayProxy.threadId !== config.threadId ||
              gatewayProxy.effectiveAllowlistRevision !== revision)) ||
          (record.cause !== "personal_grant" &&
            record.cause !== "personal_revocation")
        ) throw new Error("BROWSER_SESSION_LOST");
        if (
          terminating ||
          accepted.size !== 0 ||
          revisionInstalling ||
          viewerFrameSettlement !== undefined
        ) {
          throw new Error("BROWSER_ENGINE_FAILURE");
        }
        revisionInstalling = true;
        let closedUnauthorizedConnections: number;
        try {
          closedUnauthorizedConnections = await engine.adopt({
            authority,
            cause: record.cause,
            gatewayProxy,
            gatewayClosedUnauthorizedConnections,
          });
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          installedAllowlistRevision = revision;
        } finally {
          revisionInstalling = false;
        }
        return writeJson(response, 200, {
          revision,
          closedUnauthorizedConnections,
        });
      }
      if (pathname === "/v1/viewer") {
        const record = requireRecord(body);
        const claims = verifyHostedBrowserViewerTicket({
          token: requiredString(record.ticket),
          publicKeyPem: config.capabilityPublicKeyPem,
          allowExpired: true,
        });
        if (
          claims.organizationId !== config.organizationId ||
          claims.environmentId !== config.environmentId ||
          claims.projectId !== config.projectId ||
          claims.actorId !== config.userId ||
          claims.threadId !== config.threadId ||
          claims.sessionId !== config.sessionId ||
          claims.generation !== config.generation
        ) throw new Error("BROWSER_SESSION_LOST");
        const action = requireViewerAction(record.action);
        const connectionId = requireViewerConnectionId(record.connectionId);
        if (connectionId !== claims.connectionId) {
          throw new Error("BROWSER_SESSION_LOST");
        }
        if (Date.parse(claims.expiresAt) <= Date.now()) {
          throw knownWorkerFailure(HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED);
        }
        if (
          (accepted.size !== 0 ||
            revisionInstalling ||
            viewerFrameSettlement !== undefined) &&
          action === "frame"
        ) {
          throw knownWorkerFailure(HOSTED_BROWSER_VIEWER_FRAME_UNAVAILABLE);
        }
        if (revisionInstalling || accepted.size !== 0) {
          throw new Error("BROWSER_ENGINE_FAILURE");
        }
        if (!engine.viewer) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
        const viewerInput: Parameters<
          NonNullable<HostedBrowserWorkerEngine["viewer"]>
        >[0] = {
          action,
          claims,
          connectionId,
          ...(record.leaseId === undefined
            ? {}
            : { leaseId: requiredString(record.leaseId) }),
          ...(record.viewerInput === undefined
            ? {}
            : { viewerInput: requireViewerInput(record.viewerInput) }),
        };
        if (action !== "frame") {
          const output = await engine.viewer(viewerInput);
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          return writeJson(response, 200, output);
        }
        const frameSettlement = deferred<void>();
        viewerFrameSettlement = frameSettlement.promise;
        try {
          const output = await engine.viewer(viewerInput);
          if (terminating) throw new Error("BROWSER_SESSION_LOST");
          const record = requireRecord(output);
          const rawBytes = hostedBrowserViewerPngBase64ByteLength(
            record.dataBase64,
          );
          if (
            rawBytes !== undefined &&
            rawBytes > HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES
          ) throw knownWorkerFailure("BROWSER_ARTIFACT_TOO_LARGE");
          const frame = parseHostedBrowserViewerServerMessage({
            version: HOSTED_BROWSER_VIEWER_ROUTE_VERSION,
            type: "frame",
            frame: record,
          }, {
            sessionId: config.sessionId,
            generation: config.generation,
          });
          if (frame.type !== "frame") throw new Error("BROWSER_SESSION_LOST");
          return writeViewerFrameJson(response, frame.frame);
        } finally {
          if (viewerFrameSettlement === frameSettlement.promise) {
            viewerFrameSettlement = undefined;
          }
          frameSettlement.resolve();
        }
      }
      if (pathname === "/v1/viewer-cleanup") {
        const record = requireRecord(body);
        if (!hasExactKeys(record, [
          "organizationId",
          "environmentId",
          "projectId",
          "actorId",
          "threadId",
          "sessionId",
          "generation",
          "connectionId",
          "purpose",
          "cleanupCapability",
        ])) throw new Error("BROWSER_SESSION_LOST");
        const claims = verifyHostedBrowserViewerCleanupCapability({
          token: requiredString(record.cleanupCapability),
          publicKeyPem: config.capabilityPublicKeyPem,
        });
        if (
          claims.organizationId !== config.organizationId ||
          claims.environmentId !== config.environmentId ||
          claims.projectId !== config.projectId ||
          claims.actorId !== config.userId ||
          claims.threadId !== config.threadId ||
          claims.sessionId !== config.sessionId ||
          claims.generation !== config.generation ||
          claims.connectionId !== requiredString(record.connectionId) ||
          claims.purpose !== record.purpose ||
          claims.organizationId !== requiredString(record.organizationId) ||
          claims.environmentId !== requiredString(record.environmentId) ||
          claims.projectId !== requiredString(record.projectId) ||
          claims.actorId !== requiredString(record.actorId) ||
          claims.threadId !== requiredString(record.threadId) ||
          claims.sessionId !== requiredString(record.sessionId) ||
          claims.generation !== record.generation
        ) throw new Error("BROWSER_SESSION_LOST");
        if (!engine.viewerCleanup) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
        await engine.viewerCleanup(claims);
        return writeJson(response, 200, null);
      }
      return writeError(response, 404, "BROWSER_ENGINE_FAILURE");
    } catch (error) {
      const code = readCode(error);
      return writeError(
        response,
        code === "BROWSER_ACTION_OUTCOME_UNKNOWN" ? 409 : 400,
        code,
        readDetails(error),
      );
    }
  });
  server.listen(config.port, "::");
  return {
    server,
    async close() {
      beginTermination();
      for (const operation of accepted.values()) {
        clearTimeout(operation.deadline);
        operation.cancelInvoke(new Error("BROWSER_ACTION_OUTCOME_UNKNOWN"));
        operation.cancelCommit(new Error("BROWSER_ACTION_OUTCOME_UNKNOWN"));
      }
      accepted.clear();
      await engine.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function hostedBrowserWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HostedBrowserWorkerConfig {
  const release = getHostedBrowserRuntimeRelease();
  const runtimeRoot = env.KESTREL_BROWSER_RUNTIME_ROOT?.trim() || "/opt/kestrel/browser-runtime";
  return validateConfig({
    sessionId: requiredEnv(env, "KESTREL_BROWSER_SESSION_ID"),
    generation: Number(requiredEnv(env, "KESTREL_BROWSER_GENERATION")),
    organizationId: requiredEnv(env, "KESTREL_BROWSER_ORGANIZATION_ID"),
    environmentId: requiredEnv(env, "KESTREL_BROWSER_ENVIRONMENT_ID"),
    projectId: requiredEnv(env, "KESTREL_BROWSER_PROJECT_ID"),
    userId: requiredEnv(env, "KESTREL_BROWSER_USER_ID"),
    threadId: requiredEnv(env, "KESTREL_BROWSER_THREAD_ID"),
    effectiveAllowlistRevision: requiredEnv(
      env,
      "KESTREL_BROWSER_EFFECTIVE_ALLOWLIST_REVISION",
    ),
    engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    chromeRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    imageDigest: requiredEnv(env, "KESTREL_BROWSER_WORKER_IMAGE_DIGEST"),
    capabilityPublicKeyPem: requiredEnv(env, "KESTREL_BROWSER_CAPABILITY_PUBLIC_KEY"),
    gatewayHost: requiredEnv(env, "KESTREL_BROWSER_EGRESS_GATEWAY_HOST"),
    gatewayAddress: requiredEnv(env, "KESTREL_BROWSER_EGRESS_GATEWAY_ADDRESS"),
    gatewayPort: Number(requiredEnv(env, "KESTREL_BROWSER_EGRESS_GATEWAY_PORT")),
    engineExecutablePath: path.join(runtimeRoot, release.engine.executableRelativePath),
    chromeExecutablePath: path.join(runtimeRoot, release.chrome.executableRelativePath),
    port: Number(env.PORT ?? "43105"),
  });
}

export type AgentBrowserHostedWorkerEngineOptions = {
  createDesktopBrowserService?:
    | ((options: ConstructorParameters<typeof DesktopBrowserService>[0]) => DesktopBrowserService)
    | undefined;
  now?: (() => Date) | undefined;
  setTimeout?: typeof setTimeout | undefined;
  clearTimeout?: typeof clearTimeout | undefined;
  viewerRetirementLimit?: number | undefined;
  runtimeRoot?: string | undefined;
};

export const HOSTED_BROWSER_VIEWER_RETIREMENT_LIMIT = 4096;

export class AgentBrowserHostedWorkerEngine implements HostedBrowserWorkerEngine {
  readonly #config: HostedBrowserWorkerConfig;
  readonly #runtimeRoot: string;
  readonly #createDesktopBrowserService: (
    options: ConstructorParameters<typeof DesktopBrowserService>[0],
  ) => DesktopBrowserService;
  readonly #now: () => Date;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #viewerExpiries = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    claims: HostedBrowserViewerTicketClaimsV1;
    retirementEstablished: boolean;
  }>();
  readonly #viewerAdmissions = new Map<string, HostedBrowserViewerTicketClaimsV1>();
  readonly #retiredViewerConnections = new Map<string, { expiresAt: string }>();
  readonly #viewerRetirementLimit: number;
  #retiredViewerAuthorityExpiresAt = 0;
  #authority: BrowserEffectiveDomainAuthorityV1 | undefined;
  #session: BrowserSessionV1 | undefined;
  #service: DesktopBrowserService | undefined;
  readonly #screenshots = new HostedRelayScreenshotStore();
  readonly #uploads = new Map<string, { effect: BrowserUploadPreparedEffectV1; path: string }>();
  readonly #uploadWaiters = new Map<string, ReturnType<typeof deferred<{ effect: BrowserUploadPreparedEffectV1; path: string }>>>();
  readonly #consumedUploadAuthorities = new Set<string>();
  readonly #uploadReconciliation: Promise<void>;
  #gatewayProxy: HostedBrowserGatewayProxyBindingV1 | undefined;
  #remoteProxy: RemoteGatewayBrowserProxy | undefined;

  constructor(
    config: HostedBrowserWorkerConfig,
    options: AgentBrowserHostedWorkerEngineOptions = {},
  ) {
    this.#config = config;
    this.#runtimeRoot = options.runtimeRoot ?? HOSTED_BROWSER_WORKER_HOME_PATH;
    this.#uploadReconciliation = reconcileHostedUploadResidue(this.#runtimeRoot);
    this.#createDesktopBrowserService =
      options.createDesktopBrowserService ??
      ((serviceOptions) => new DesktopBrowserService(serviceOptions));
    this.#now = options.now ?? (() => new Date());
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    this.#viewerRetirementLimit = options.viewerRetirementLimit ??
      HOSTED_BROWSER_VIEWER_RETIREMENT_LIMIT;
    if (!Number.isSafeInteger(this.#viewerRetirementLimit) || this.#viewerRetirementLimit < 1) {
      throw new Error("BROWSER_SERVICE_UNAVAILABLE");
    }
  }

  async execute(input: {
    prepared: PreparedToolCallV1;
    authority: BrowserEffectiveDomainAuthorityV1;
    session?: BrowserSessionV1 | undefined;
    gatewayProxy?: HostedBrowserGatewayProxyBindingV1 | undefined;
  }, lifecycle: {
    signal?: AbortSignal | undefined;
    acknowledgeDispatch(): Promise<void>;
    persistCompletedResult(output: unknown): Promise<void>;
  }): Promise<unknown> {
    await this.#uploadReconciliation;
    lifecycle.signal?.throwIfAborted();
    this.#authority = input.authority;
    const operation = input.prepared.activation.descriptor.toolId;
    this.#installGatewayProxy(input.gatewayProxy, input.authority, operation);
    if (operation === "browser.download") throw new Error("BROWSER_SERVICE_UNAVAILABLE");
    if (!this.#service) {
      if (operation !== "browser.open" || !input.session) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      this.#session = input.session;
      this.#service = this.#createService(input.session);
      await this.#service.initialize();
    } else if (
      input.session &&
      (input.session.sessionId !== this.#session?.sessionId ||
        input.session.generation !== this.#session.generation)
    ) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    const projectRoot = hostedProjectRoot(input.authority.projectId);
    return await this.#service.execute(input.prepared, {
      authority: {
        threadId: this.#session!.threadId,
        projectId: input.authority.projectId,
        projectRoot,
      },
      ...(lifecycle.signal ? { signal: lifecycle.signal } : {}),
      acknowledgeDispatch: lifecycle.acknowledgeDispatch,
      persistCompletedResult: async (output) => {
        const relayed = operation === "browser.capture"
          ? this.#screenshots.projectCaptureResult(output)
          : output;
        const encoded = Buffer.from(JSON.stringify(relayed));
        if (encoded.byteLength > HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES) {
          throw knownWorkerFailure("BROWSER_ARTIFACT_TOO_LARGE");
        }
        await lifecycle.persistCompletedResult(relayed);
      },
    });
  }

  async prepareUpload(
    input: BrowserUploadPreparationRequestV1,
  ): Promise<BrowserUploadPreparedEffectV1> {
    await this.#uploadReconciliation;
    if (!(this.#service && this.#session)) throw new Error("BROWSER_SESSION_LOST");
    if (
      input.threadId !== this.#config.threadId ||
      input.effectiveInput.sessionId !== this.#config.sessionId ||
      input.effectiveInput.generation !== this.#config.generation
    ) throw new Error("BROWSER_SESSION_LOST");
    return await this.#service.prepareUpload(input);
  }

  async receiveUpload(input: {
    operationId: string;
    effect: BrowserUploadPreparedEffectV1;
    body: AsyncIterable<Uint8Array>;
  }): Promise<void> {
    await this.#uploadReconciliation;
    if (this.#consumedUploadAuthorities.has(input.operationId)) {
      throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
    }
    this.#consumedUploadAuthorities.add(input.operationId);
    const pathName = path.join(
      this.#runtimeRoot,
      `hosted-upload-${createHash("sha256").update(input.operationId).digest("hex")}.bin`,
    );
    await mkdir(this.#runtimeRoot, { recursive: true, mode: 0o700 });
    const waiter = this.#uploadWaiters.get(input.operationId) ??
      deferred<{ effect: BrowserUploadPreparedEffectV1; path: string }>();
    void waiter.promise.catch(() => {});
    this.#uploadWaiters.set(input.operationId, waiter);
    const handle = await open(pathName, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const value of input.body) {
        const chunk = Buffer.from(value);
        size += chunk.byteLength;
        if (size > input.effect.sizeBytes) {
          throw new Error("BROWSER_ARTIFACT_TOO_LARGE");
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(pathName, { force: true }).catch(() => {});
      waiter.reject(error instanceof Error ? error : new Error("BROWSER_ENGINE_FAILURE"));
      throw error;
    }
    await handle.close();
    if (size !== input.effect.sizeBytes || hash.digest("hex") !== input.effect.sha256) {
      await rm(pathName, { force: true }).catch(() => {});
      waiter.reject(new Error("BROWSER_ENGINE_FAILURE"));
      throw new Error("BROWSER_ENGINE_FAILURE");
    }
    const staged = { effect: input.effect, path: pathName };
    this.#uploads.set(input.operationId, staged);
    waiter.resolve(staged);
  }

  async cancelUpload(operationId: string): Promise<void> {
    await this.#uploadReconciliation;
    const waiter = this.#uploadWaiters.get(operationId);
    this.#uploadWaiters.delete(operationId);
    waiter?.reject(new Error("BROWSER_ACTION_CANCELLED"));
    const upload = this.#uploads.get(operationId);
    this.#uploads.delete(operationId);
    if (upload) await rm(upload.path, { force: true });
  }

  async adopt(input: {
    authority: BrowserEffectiveDomainAuthorityV1;
    cause: "personal_grant" | "personal_revocation";
    gatewayProxy?: HostedBrowserGatewayProxyBindingV1 | undefined;
    gatewayClosedUnauthorizedConnections?: number | undefined;
  }): Promise<number> {
    this.#authority = input.authority;
    if (!(this.#service && this.#session)) throw new Error("BROWSER_SESSION_LOST");
    if (!input.gatewayProxy || input.gatewayClosedUnauthorizedConnections === undefined) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    this.#installGatewayProxy(
      input.gatewayProxy,
      input.authority,
      "browser.request_grant",
    );
    this.#remoteProxy?.setGatewayAdoption(
      input.gatewayProxy,
      input.gatewayClosedUnauthorizedConnections,
    );
    const receipt = await this.#service.adoptAllowlistRevision({
      version: "browser_allowlist_adoption_v1",
      runId: `hosted-session-${this.#session.sessionId}`,
      threadId: this.#session.threadId,
      sessionId: this.#session.sessionId,
      effectiveAllowlistRevision: input.authority.effectiveAllowlistRevision,
      cause: input.cause,
    });
    return receipt.closedUnauthorizedConnections;
  }

  async viewer(input: {
    action: "connect" | "frame" | "accept" | "renew" | "input" | "return" | "disconnect" | "close";
    claims: HostedBrowserViewerTicketClaimsV1;
    connectionId?: string | undefined;
    leaseId?: string | undefined;
    viewerInput?: DesktopBrowserViewerInputV1 | undefined;
  }): Promise<DesktopBrowserViewerStateV1 | DesktopBrowserViewerFrameV1 | null> {
    const service = this.#service;
    if (!(service && this.#session)) throw new Error("BROWSER_SESSION_LOST");
    const binding = {
      principalId: input.claims.actorId,
      threadId: input.claims.threadId,
      projectId: input.claims.projectId,
      sessionId: input.claims.sessionId,
      generation: input.claims.generation,
    };
    if (input.action === "connect") {
      const connectionId = requireViewerConnectionId(input.connectionId);
      if (connectionId !== input.claims.connectionId) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      this.#pruneViewerRetirements();
      const identity = viewerConnectionIdentity(input.claims);
      if (
        this.#retiredViewerAuthorityExpiresAt > this.#now().getTime() ||
        this.#retiredViewerConnections.has(identity) ||
        this.#viewerAdmissions.has(identity)
      ) throw new Error("BROWSER_SESSION_LOST");
      if (
        this.#retiredViewerConnections.size + this.#viewerAdmissions.size >=
          this.#viewerRetirementLimit
      ) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
      this.#viewerAdmissions.set(identity, input.claims);
      let state: DesktopBrowserViewerStateV1;
      try {
        state = await service.connectViewer({ ...binding, connectionId });
      } catch (error) {
        this.#viewerAdmissions.delete(identity);
        throw error;
      }
      this.#scheduleViewerExpiry(input.claims, state);
      return state;
    }
    const connectionId = requiredString(input.connectionId);
    this.#pruneViewerRetirements();
    const identity = viewerConnectionIdentity(input.claims);
    if (this.#retiredViewerAuthorityExpiresAt > this.#now().getTime()) {
      throw new Error("BROWSER_SESSION_LOST");
    }
    if (this.#retiredViewerConnections.has(identity)) {
      throw knownWorkerFailure(HOSTED_BROWSER_VIEWER_AUTHORITY_EXPIRED);
    }
    const connected = { ...binding, connectionId };
    if (input.action === "frame") return service.readViewerFrame(connected);
    if (input.action === "accept") {
      const state = await service.acceptViewerTakeover(connected);
      this.#scheduleViewerExpiry(input.claims, state);
      return state;
    }
    if (input.action === "disconnect") {
      this.#retireViewerConnection(input.claims);
      await service.cleanupViewerConnection(connected);
      this.#clearViewerExpiry(connectionId);
      return null;
    }
    if (input.action === "close") {
      this.#retireViewerConnection(input.claims);
      await service.closeViewerSession(connected);
      this.#clearViewerExpiry(connectionId);
      return null;
    }
    const leaseId = requiredString(input.leaseId);
    if (input.action === "renew") {
      const state = await service.renewViewerInputLease({ ...connected, leaseId });
      this.#scheduleViewerExpiry(input.claims, state);
      return state;
    }
    if (input.action === "return") {
      const state = await service.returnViewerControl({ ...connected, leaseId });
      this.#retireViewerConnection(input.claims);
      await service.cleanupViewerConnection(connected);
      this.#clearViewerExpiry(connectionId);
      return state;
    }
    if (!input.viewerInput) throw new Error("BROWSER_SESSION_LOST");
    const state = await service.sendViewerInput({
      ...connected,
      leaseId,
      viewerInput: input.viewerInput,
    });
    this.#scheduleViewerExpiry(input.claims, state);
    return state;
  }

  async viewerCleanup(
    claims: HostedBrowserViewerCleanupCapabilityV1,
  ): Promise<void> {
    if (
      claims.organizationId !== this.#config.organizationId ||
      claims.environmentId !== this.#config.environmentId ||
      claims.projectId !== this.#config.projectId ||
      claims.threadId !== this.#config.threadId ||
      claims.sessionId !== this.#config.sessionId ||
      claims.generation !== this.#config.generation ||
      claims.actorId !== this.#config.userId
    ) throw new Error("BROWSER_SESSION_LOST");
    const exact = {
      principalId: claims.actorId,
      threadId: claims.threadId,
      projectId: claims.projectId,
      sessionId: claims.sessionId,
      generation: claims.generation,
      connectionId: claims.connectionId,
    };
    if (claims.purpose === "authority_loss") {
      this.#retireViewerAuthority(claims);
    } else {
      this.#retireViewerConnection(claims);
    }
    const service = this.#service;
    if (!(service && this.#session)) return;
    if (claims.purpose === "authority_loss") {
      await service.loseViewerAuthority(exact);
    } else {
      await service.cleanupViewerConnection(exact);
    }
    this.#clearViewerExpiry(claims.connectionId);
  }

  async destroy(): Promise<void> {
    for (const entry of this.#viewerExpiries.values()) {
      this.#clearTimeout(entry.timer);
    }
    this.#viewerExpiries.clear();
    this.#viewerAdmissions.clear();
    this.#retiredViewerConnections.clear();
    this.#retiredViewerAuthorityExpiresAt = 0;
    this.#uploads.clear();
    for (const waiter of this.#uploadWaiters.values()) {
      waiter.reject(new Error("BROWSER_SESSION_LOST"));
    }
    this.#uploadWaiters.clear();
    this.#consumedUploadAuthorities.clear();
    await this.#service?.close().catch(() => {});
    await rm(this.#runtimeRoot, { recursive: true, force: true });
  }

  #scheduleViewerExpiry(
    claims: HostedBrowserViewerTicketClaimsV1,
    state?: DesktopBrowserViewerStateV1,
  ): void {
    this.#clearViewerExpiry(claims.connectionId);
    const expiresAt = Math.min(
      Date.parse(claims.expiresAt),
      state?.inputLeaseExpiresAt
        ? Date.parse(state.inputLeaseExpiresAt)
        : Number.POSITIVE_INFINITY,
    );
    const delay = Math.max(1, expiresAt - this.#now().getTime());
    const timer = this.#setTimeout(
      () => void this.#expireViewerConnection(claims),
      delay,
    );
    timer.unref?.();
    this.#viewerExpiries.set(claims.connectionId, {
      timer,
      claims,
      retirementEstablished: false,
    });
  }

  async #expireViewerConnection(
    claims: HostedBrowserViewerTicketClaimsV1,
  ): Promise<void> {
    const entry = this.#viewerExpiries.get(claims.connectionId);
    if (!entry || entry.claims !== claims) return;
    try {
      if (!entry.retirementEstablished) {
        this.#retireViewerConnection(claims);
        entry.retirementEstablished = true;
      }
      await this.#service?.cleanupViewerConnection({
        principalId: claims.actorId,
        threadId: claims.threadId,
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        generation: claims.generation,
        connectionId: claims.connectionId,
      });
      if (this.#viewerExpiries.get(claims.connectionId) === entry) {
        this.#viewerExpiries.delete(claims.connectionId);
      }
    } catch {
      if (this.#viewerExpiries.get(claims.connectionId) !== entry) return;
      entry.timer = this.#setTimeout(
        () => void this.#expireViewerConnection(claims),
        1_000,
      );
      entry.timer.unref?.();
    }
  }

  #clearViewerExpiry(connectionId: string): void {
    const entry = this.#viewerExpiries.get(connectionId);
    if (entry) this.#clearTimeout(entry.timer);
    this.#viewerExpiries.delete(connectionId);
  }

  #retireViewerConnection(
    claims: Pick<HostedBrowserViewerTicketClaimsV1,
      "organizationId" | "environmentId" | "projectId" | "threadId" |
      "sessionId" | "generation" | "actorId" | "connectionId" | "expiresAt">,
  ): void {
    this.#pruneViewerRetirements();
    const identity = viewerConnectionIdentity(claims);
    const admitted = this.#viewerAdmissions.has(identity);
    if (this.#retiredViewerConnections.has(identity)) return;
    if (
      !admitted &&
      this.#retiredViewerConnections.size + this.#viewerAdmissions.size >=
        this.#viewerRetirementLimit
    ) {
      throw new Error("BROWSER_SERVICE_UNAVAILABLE");
    }
    if (admitted) this.#viewerAdmissions.delete(identity);
    this.#retiredViewerConnections.set(identity, { expiresAt: claims.expiresAt });
  }

  #retireViewerAuthority(
    claims: Pick<HostedBrowserViewerTicketClaimsV1,
      "organizationId" | "environmentId" | "projectId" | "threadId" |
      "sessionId" | "generation" | "actorId" | "expiresAt">,
  ): void {
    let expiresAt = Date.parse(claims.expiresAt);
    for (const admitted of this.#viewerAdmissions.values()) {
      if (!sameViewerPrincipal(admitted, claims)) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      expiresAt = Math.max(expiresAt, Date.parse(admitted.expiresAt));
      this.#clearViewerExpiry(admitted.connectionId);
    }
    this.#viewerAdmissions.clear();
    this.#retiredViewerAuthorityExpiresAt = Math.max(
      this.#retiredViewerAuthorityExpiresAt,
      expiresAt,
    );
  }

  #pruneViewerRetirements(): void {
    const now = this.#now().getTime();
    if (this.#retiredViewerAuthorityExpiresAt <= now) {
      this.#retiredViewerAuthorityExpiresAt = 0;
    }
    for (const [identity, retired] of this.#retiredViewerConnections) {
      if (Date.parse(retired.expiresAt) <= now) {
        this.#retiredViewerConnections.delete(identity);
      }
    }
  }

  #createService(session: BrowserSessionV1): DesktopBrowserService {
    if (!this.#remoteProxy) throw new Error("BROWSER_SESSION_LOST");
    return this.#createDesktopBrowserService({
      homePath: this.#runtimeRoot,
      engineExecutablePath: this.#config.engineExecutablePath,
      chromeExecutablePath: this.#config.chromeExecutablePath,
      authorityResolver: {
        resolve: async () => this.#requireAuthority(),
      },
      projectRunRegistry: {
        resolvePreviewUrl: (input) => {
          const authority = this.#requireAuthority();
          const target = authority.qaTarget;
          if (!target || input.runId !== input.urlId) {
            throw new Error("BROWSER_SESSION_LOST");
          }
          return {
            url: qaTargetUrl(target),
            run: { projectPath: hostedProjectRoot(authority.projectId) } as never,
          };
        },
      },
      hostedSession: {
        session,
        resolveQaDestination: ({ target, authority }) => {
          const effective = this.#requireAuthority();
          const qaTarget = effective.qaTarget;
          const previewId = requiredString(target.previewId);
          if (
            target.kind !== "kestrel_edge_preview" ||
            !qaTarget ||
            authority.projectId !== effective.projectId
          ) throw new Error("BROWSER_DESTINATION_BLOCKED");
          const projectRoot = hostedProjectRoot(effective.projectId);
          return {
            destination: qaTargetUrl(qaTarget),
            targetIdentity: `qa:edge:${previewId}`,
            authority: { runId: previewId, urlId: previewId, projectRoot },
          };
        },
      },
      createProxy: async () => this.#remoteProxy!,
      scheduleExpiry: false,
      attachmentStore: this.#screenshots,
      uploadStream: {
        open: async (request) => {
          const waiter = this.#uploadWaiters.get(request.operationId) ??
            deferred<{ effect: BrowserUploadPreparedEffectV1; path: string }>();
          void waiter.promise.catch(() => {});
          this.#uploadWaiters.set(request.operationId, waiter);
          const upload = this.#uploads.get(request.operationId) ??
            await abortable(waiter.promise, request.signal);
          if (
            upload.effect.threadId !== request.threadId ||
            upload.effect.sessionId !== request.sessionId ||
            upload.effect.generation !== request.generation ||
            upload.effect.attachmentId !== request.attachmentId ||
            upload.effect.sizeBytes > request.maximumBytes
          ) throw new Error("BROWSER_SESSION_LOST");
          this.#uploads.delete(request.operationId);
          this.#uploadWaiters.delete(request.operationId);
          const source = createReadStream(upload.path, {
            ...(request.signal ? { signal: request.signal } : {}),
          });
          return (async function* () {
            try {
              for await (const chunk of source) yield Buffer.from(chunk);
            } finally {
              source.destroy();
              await rm(upload.path, { force: true });
            }
          })();
        },
      },
      writeLedger: async () => {},
    });
  }

  #requireAuthority(): BrowserEffectiveDomainAuthorityV1 {
    if (!this.#authority) throw new Error("BROWSER_SESSION_LOST");
    return this.#authority;
  }

  #installGatewayProxy(
    next: HostedBrowserGatewayProxyBindingV1 | undefined,
    authority: BrowserEffectiveDomainAuthorityV1,
    operation: string,
  ): void {
    if (!next) throw new Error("BROWSER_SESSION_LOST");
    if (
      next.sessionId !== this.#config.sessionId ||
      next.generation !== this.#config.generation ||
      next.threadId !== this.#config.threadId ||
      (operation !== "browser.request_grant" &&
        next.effectiveAllowlistRevision !==
          authority.effectiveAllowlistRevision)
    ) throw new Error("BROWSER_SESSION_LOST");
    if (this.#gatewayProxy) assertSameGatewayProxy(this.#gatewayProxy, next);
    this.#gatewayProxy = next;
    this.#remoteProxy ??= new RemoteGatewayBrowserProxy(next);
    if (
      operation === "browser.request_grant" &&
      next.effectiveAllowlistRevision !==
        authority.effectiveAllowlistRevision
    ) {
      this.#remoteProxy.stageRequestGrantRevision(
        authority.effectiveAllowlistRevision,
      );
    }
  }
}

class RemoteGatewayBrowserProxy implements LocalCoreBrowserEgressProxy {
  readonly version = LOCAL_CORE_BROWSER_EGRESS_PROXY_VERSION;
  #binding: HostedBrowserGatewayProxyBindingV1;
  #adoption: {
    binding: HostedBrowserGatewayProxyBindingV1;
    closed: number;
  } | undefined;

  constructor(binding: HostedBrowserGatewayProxyBindingV1) {
    this.#binding = binding;
  }

  get launchBinding(): LocalCoreBrowserEgressLaunchBindingV1 {
    return projectGatewayLaunchBinding(this.#binding);
  }

  setGatewayAdoption(binding: HostedBrowserGatewayProxyBindingV1, closed: number) {
    assertSameGatewayProxy(this.#binding, binding);
    this.#adoption = { binding, closed };
  }

  stageRequestGrantRevision(revision: string) {
    this.#adoption = {
      binding: { ...this.#binding, effectiveAllowlistRevision: revision },
      closed: 0,
    };
  }

  async adoptAuthority(binding: {
    threadId: string;
    sessionId: string;
    generation: number;
    authority: BrowserEffectiveDomainAuthorityV1;
  }) {
    const adoption = this.#adoption;
    if (
      !adoption ||
      binding.threadId !== adoption.binding.threadId ||
      binding.sessionId !== adoption.binding.sessionId ||
      binding.generation !== adoption.binding.generation ||
      binding.authority.effectiveAllowlistRevision !==
        adoption.binding.effectiveAllowlistRevision
    ) throw new Error("BROWSER_SESSION_LOST");
    this.#binding = adoption.binding;
    this.#adoption = undefined;
    return {
      receipt: {
        version: "browser_allowlist_adoption_receipt_v1" as const,
        sessionId: binding.sessionId,
        effectiveAllowlistRevision:
          binding.authority.effectiveAllowlistRevision,
        closedUnauthorizedConnections: adoption.closed,
      },
      launchBinding: this.launchBinding,
    };
  }

  async close() {}
}

class HostedRelayScreenshotStore {
  readonly #metadata = new Map<string, DesktopAttachmentMetadata>();
  readonly #bytes = new Map<string, Buffer>();

  async importPath(input: {
    threadId: string;
    filename: string;
    sourcePath: string;
    mimeType?: string | undefined;
    now?: Date | undefined;
  }): Promise<DesktopAttachmentMetadata> {
    const bytes = await readFile(input.sourcePath);
    if (
      input.mimeType !== "image/png" ||
      bytes.byteLength < 8 ||
      !bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) throw knownWorkerFailure("BROWSER_ENGINE_FAILURE");
    const fileId = `file-worker-${randomUUID()}`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata: DesktopAttachmentMetadata = {
      fileId,
      attachmentId: fileId,
      threadId: input.threadId,
      filename: input.filename,
      mimeType: "image/png",
      declaredMimeType: "image/png",
      detectedMimeType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256,
      kind: "image",
      lifecycleState: "ready",
      representationStatus: "native_image",
      createdAt: (input.now ?? new Date()).toISOString(),
    };
    this.#metadata.set(fileId, metadata);
    this.#bytes.set(fileId, bytes);
    return metadata;
  }

  async list(threadId: string): Promise<DesktopAttachmentMetadata[]> {
    return [...this.#metadata.values()].filter(
      (metadata) => metadata.threadId === threadId,
    );
  }

  projectCaptureResult(output: unknown): unknown {
    const record = requireRecord(output);
    const artifact = requireRecord(record.artifact);
    const fileId = requiredString(artifact.id);
    const metadata = this.#metadata.get(fileId);
    const bytes = this.#bytes.get(fileId);
    if (
      !metadata ||
      !bytes ||
      artifact.kind !== "browser-screenshot" ||
      artifact.mediaType !== "image/png" ||
      artifact.bytes !== metadata.sizeBytes ||
      artifact.sha256 !== metadata.sha256
    ) throw knownWorkerFailure("BROWSER_ENGINE_FAILURE");
    this.#metadata.delete(fileId);
    this.#bytes.delete(fileId);
    return {
      version: "hosted_browser_worker_result_v1",
      output: record,
      screenshot: {
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        sha256: metadata.sha256,
        base64: bytes.toString("base64"),
      },
    };
  }
}

function validateConfig(config: HostedBrowserWorkerConfig) {
  if (
    !Number.isInteger(config.generation) || config.generation < 1 ||
    config.engineRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
    config.chromeRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision ||
    !config.effectiveAllowlistRevision.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.vm\.[a-z0-9][a-z0-9-]{0,62}\.internal$/u.test(
      config.gatewayHost,
    ) ||
    isIP(config.gatewayAddress) === 0 ||
    config.gatewayPort !== 43_109 ||
    !Number.isInteger(config.port) || config.port < 0 || config.port > 65_535
  ) throw new Error("Hosted Browser worker configuration is invalid.");
  return {
    ...config,
    imageDigest: requireImmutableHostedBrowserWorkerImage(config.imageDigest),
  };
}

function requestGrantResultRevision(output: unknown): string {
  const record = requireRecord(output);
  if (
    record.operation !== "browser.request_grant" ||
    (record.outcome !== "granted" && record.outcome !== "already_allowed")
  ) throw new Error("BROWSER_ENGINE_FAILURE");
  return requiredString(record.effectiveAllowlistRevision);
}

function workerIdentity(config: HostedBrowserWorkerConfig) {
  return {
    sessionId: config.sessionId,
    generation: config.generation,
    engineRevision: config.engineRevision,
    chromeRevision: config.chromeRevision,
    imageDigest: config.imageDigest,
  };
}

function acceptanceResponse(config: HostedBrowserWorkerConfig, operationId: string) {
  return {
    accepted: true,
    operationId,
    sessionId: config.sessionId,
    generation: config.generation,
    identity: workerIdentity(config),
  };
}

function completionBeforeDispatchResponse(
  config: HostedBrowserWorkerConfig,
  operationId: string,
  output: unknown,
) {
  return {
    completedBeforeDispatch: true,
    operationId,
    sessionId: config.sessionId,
    generation: config.generation,
    identity: workerIdentity(config),
    output,
  };
}

function isCompletionBeforeDispatchResponse(
  value: unknown,
): value is ReturnType<typeof completionBeforeDispatchResponse> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).completedBeforeDispatch === true,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function reconcileHostedUploadResidue(runtimeRoot: string): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^hosted-upload-[0-9a-f]{64}\.bin$/u.test(entry.name)) continue;
    const candidate = path.join(runtimeRoot, entry.name);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue;
    await rm(candidate);
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  let rejectAbort!: (error: Error) => void;
  const onAbort = () => rejectAbort(
    signal.reason instanceof Error
      ? signal.reason
      : new Error("BROWSER_ACTION_CANCELLED"),
  );
  const aborted = new Promise<T>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function hostedProjectRoot(projectId: string) {
  return path.join("/kestrel/hosted-projects", projectId);
}

function qaTargetUrl(target: NonNullable<BrowserEffectiveDomainAuthorityV1["qaTarget"]>) {
  return `${target.scheme}://${target.hostname}:${target.port}/`;
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES) {
      throw new Error("BROWSER_ARTIFACT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  return value;
}

async function* incomingBody(
  request: IncomingMessage,
  maximumBytes: number,
): AsyncIterable<Uint8Array> {
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new Error("BROWSER_ARTIFACT_TOO_LARGE");
    yield chunk;
  }
  if (bytes !== maximumBytes) throw new Error("BROWSER_ENGINE_FAILURE");
}

function requirePreparedUploadEffect(
  prepared: PreparedToolCallV1,
): BrowserUploadPreparedEffectV1 {
  const matches = prepared.inputAdapters.filter(
    (adapter) => adapter.adapterId === "kestrel.browser-upload-effect:v1",
  );
  if (matches.length !== 1) throw new Error("BROWSER_SESSION_LOST");
  return parseBrowserUploadPreparedEffectV1(matches[0]!.metadata);
}

function requireAuthority(value: unknown): BrowserEffectiveDomainAuthorityV1 {
  const record = requireRecord(value);
  if (typeof record.effectiveAllowlistRevision !== "string") {
    throw new Error("BROWSER_DESTINATION_BLOCKED");
  }
  return value as BrowserEffectiveDomainAuthorityV1;
}

function requireGatewayProxyBinding(
  value: unknown,
  config: HostedBrowserWorkerConfig,
): HostedBrowserGatewayProxyBindingV1 {
  const record = requireRecord(value);
  const chromiumFlags = record.chromiumFlags;
  if (
    record.version !== "hosted_browser_gateway_proxy_binding_v1" ||
    typeof record.proxyServer !== "string" ||
    !record.proxyServer.startsWith("http://") ||
    typeof record.username !== "string" ||
    typeof record.password !== "string" ||
    typeof record.threadId !== "string" ||
    typeof record.sessionId !== "string" ||
    !Number.isSafeInteger(record.generation) ||
    typeof record.effectiveAllowlistRevision !== "string" ||
    !Array.isArray(chromiumFlags) ||
    chromiumFlags.some((flag) => typeof flag !== "string")
  ) throw new Error("BROWSER_ENGINE_FAILURE");
  const url = new URL(record.proxyServer);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.port ||
    url.hostname !== config.gatewayHost ||
    Number(url.port) !== config.gatewayPort
  ) throw new Error("BROWSER_ENGINE_FAILURE");
  const pinnedProxyServer =
    `http://${isIP(config.gatewayAddress) === 6 ? `[${config.gatewayAddress}]` : config.gatewayAddress}:${config.gatewayPort}`;
  const expectedProxyFlag = `--proxy-server=${record.proxyServer}`;
  if (
    !chromiumFlags.includes(expectedProxyFlag) ||
    chromiumFlags.filter((flag) => flag.startsWith("--proxy-server=")).length !== 1
  ) throw new Error("BROWSER_ENGINE_FAILURE");
  return {
    version: "hosted_browser_gateway_proxy_binding_v1",
    proxyServer: pinnedProxyServer,
    username: requiredString(record.username),
    password: requiredString(record.password),
    threadId: requiredString(record.threadId),
    sessionId: requiredString(record.sessionId),
    generation: record.generation as number,
    effectiveAllowlistRevision:
      requiredString(record.effectiveAllowlistRevision),
    chromiumFlags: chromiumFlags.map((flag) =>
      flag === expectedProxyFlag ? `--proxy-server=${pinnedProxyServer}` : flag
    ) as string[],
  };
}

function assertSameGatewayProxy(
  current: HostedBrowserGatewayProxyBindingV1,
  next: HostedBrowserGatewayProxyBindingV1,
) {
  if (
    current.proxyServer !== next.proxyServer ||
    current.username !== next.username ||
    current.password !== next.password ||
    current.threadId !== next.threadId ||
    current.sessionId !== next.sessionId ||
    current.generation !== next.generation ||
    JSON.stringify(current.chromiumFlags) !== JSON.stringify(next.chromiumFlags)
  ) throw new Error("BROWSER_SESSION_LOST");
}

function projectGatewayLaunchBinding(
  input: HostedBrowserGatewayProxyBindingV1,
): LocalCoreBrowserEgressLaunchBindingV1 {
  return {
    version: LOCAL_CORE_BROWSER_EGRESS_LAUNCH_BINDING_VERSION,
    proxyServer: input.proxyServer,
    username: input.username,
    password: input.password,
    threadId: input.threadId,
    sessionId: input.sessionId,
    generation: input.generation,
    effectiveAllowlistRevision: input.effectiveAllowlistRevision,
    chromiumFlags: input.chromiumFlags,
  };
}

function requiredNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return Number(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROWSER_ENGINE_FAILURE");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("BROWSER_ENGINE_FAILURE");
  return value.trim();
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function requireViewerConnectionId(value: unknown): string {
  try {
    return requiredString(value);
  } catch {
    throw new Error("BROWSER_SESSION_LOST");
  }
}

function requireViewerAction(value: unknown) {
  if (
    value !== "connect" &&
    value !== "frame" &&
    value !== "accept" &&
    value !== "renew" &&
    value !== "input" &&
    value !== "return" &&
    value !== "disconnect" &&
    value !== "close"
  ) throw new Error("BROWSER_SESSION_LOST");
  return value;
}

function viewerConnectionIdentity(
  claims: Pick<HostedBrowserViewerTicketClaimsV1,
    "organizationId" | "environmentId" | "projectId" | "threadId" |
    "sessionId" | "generation" | "actorId" | "connectionId">,
): string {
  return JSON.stringify([
    claims.organizationId,
    claims.environmentId,
    claims.projectId,
    claims.threadId,
    claims.sessionId,
    claims.generation,
    claims.actorId,
    claims.connectionId,
  ]);
}

function sameViewerPrincipal(
  left: Pick<HostedBrowserViewerTicketClaimsV1,
    "organizationId" | "environmentId" | "projectId" | "threadId" |
    "sessionId" | "generation" | "actorId">,
  right: Pick<HostedBrowserViewerTicketClaimsV1,
    "organizationId" | "environmentId" | "projectId" | "threadId" |
    "sessionId" | "generation" | "actorId">,
): boolean {
  return left.organizationId === right.organizationId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.threadId === right.threadId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.actorId === right.actorId;
}

function requireViewerInput(value: unknown): DesktopBrowserViewerInputV1 {
  try {
    return parseDesktopBrowserViewerInputRequest({
      version: "desktop_browser_viewer_request_v1",
      threadId: "hosted-worker-boundary",
      projectId: "hosted-worker-boundary",
      sessionId: "hosted-worker-boundary",
      generation: 1,
      connectionId: "hosted-worker-boundary",
      leaseId: "hosted-worker-boundary",
      input: value,
    }).input;
  } catch {
    throw new Error("BROWSER_SESSION_LOST");
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  return requiredString(env[name]);
}

function readCode(error: unknown) {
  const propertyCode = error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
  const code = typeof propertyCode === "string"
    ? propertyCode
    : error instanceof Error
      ? error.message
      : "BROWSER_ENGINE_FAILURE";
  return code.startsWith("BROWSER_") ? code : "BROWSER_ENGINE_FAILURE";
}

function readDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) return;
  const details = error.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

function knownWorkerFailure(code: string) {
  return Object.assign(new Error(code), {
    code,
    details: { browserOutcomeKnown: true },
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  const serialized = Buffer.from(JSON.stringify(value));
  if (serialized.byteLength > HOSTED_BROWSER_WORKER_MAX_SERIALIZED_BYTES) {
    response.writeHead(413, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({
      error: {
        code: "BROWSER_ARTIFACT_TOO_LARGE",
        details: { browserOutcomeKnown: true },
      },
    }));
    return;
  }
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(serialized);
}

function writeViewerFrameJson(
  response: ServerResponse,
  frame: DesktopBrowserViewerFrameV1,
) {
  const serialized = Buffer.from(JSON.stringify(frame));
  if (
    serialized.byteLength > HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES
  ) {
    return writeError(
      response,
      413,
      "BROWSER_ARTIFACT_TOO_LARGE",
      { browserOutcomeKnown: true },
    );
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(serialized);
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  details?: Record<string, unknown>,
) {
  writeJson(response, status, {
    error: { code, ...(details ? { details } : {}) },
  });
}
