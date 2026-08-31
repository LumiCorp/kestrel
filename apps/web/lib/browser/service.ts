import { createHash, createPublicKey } from "node:crypto";
import {
  BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
  BROWSER_DOWNLOAD_PREPARATION_VERSION,
  BROWSER_POLICY_RESOLUTION_VERSION,
  BROWSER_SERVICE_PORT_VERSION,
  BROWSER_UPLOAD_PREPARATION_VERSION,
  isBrowserToolName,
  parseBrowserSessionV1,
  parseBrowserDownloadPreparedEffectV1,
  parseBrowserUploadPreparedEffectV1,
  validateBrowserResultAuthority,
  validateBrowserResultSemantics,
  type BrowserAllowlistAdoptionReceiptV1,
  type BrowserAllowlistAdoptionRequestV1,
  type BrowserArtifactAuthorizationRequestV1,
  type BrowserAuthorizedArtifactV1,
  type BrowserOperationLifecycleV1,
  type BrowserPolicyResolutionV1,
  type BrowserServicePort,
  type BrowserSessionV1,
  type BrowserDownloadPreparationRequestV1,
  type BrowserDownloadPreparedEffectV1,
  type BrowserUploadPreparationRequestV1,
  type BrowserUploadPreparedEffectV1,
} from "../../../../src/browser/contracts.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";
import { browserFailure } from "../../../../src/browser/contracts.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";
import type { PreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import { compileToolJsonSchemaV1 } from "../../../../src/kestrel/contracts/tool-contract.js";
import { getBrowserToolContract } from "../../../../src/browser/browserAppContract.fixture.js";
import type {
  BrowserMachineProvisioningInput,
  BrowserMachineInfrastructureProvider,
} from "@/lib/environments/providers/contracts";
import {
  HOSTED_BROWSER_CAPABILITY_VERSION,
  issueHostedBrowserOperationCapability,
  verifyHostedBrowserOperationCapability,
} from "./capability";
import type {
  HostedBrowserOriginAuthority,
  HostedBrowserResourceRecord,
} from "./store";
import type {
  HostedBrowserRelayAcceptanceV1,
  HostedBrowserCompletionReceiptV1,
  HostedBrowserRelayInstructionV1,
  HostedBrowserRevisionInstructionV1,
} from "./worker-contract";
import type { HostedBrowserArtifactUploadInstructionV1 } from "./artifact-authority";
import {
  HOSTED_BROWSER_UPLOAD_PREPARATION_CAPABILITY_VERSION,
  issueHostedBrowserUploadPreparationCapability,
} from "../../../../src/browser/hostedUploadCapability.js";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract.js";
import type { HostedBrowserUploadWorkerPort } from "./upload-worker-client";
import type { HostedBrowserDownloadWorkerPort } from "./download-worker-client";
import {
  HOSTED_BROWSER_DOWNLOAD_PREPARATION_CAPABILITY_VERSION,
  HOSTED_BROWSER_DOWNLOAD_RELEASE_CAPABILITY_VERSION,
  issueHostedBrowserDownloadPreparationCapability,
  issueHostedBrowserDownloadReleaseCapability,
} from "../../../../src/browser/hostedDownloadCapability.js";

const IDLE_MS = 30 * 60_000;
const HARD_MS = 8 * 60 * 60_000;
const OPERATION_CAPABILITY_MS = 35_000;
const TERMINAL_STATES = new Set(["closed", "expired", "lost", "failed"]);

export interface HostedBrowserSessionStorePort {
  resolveOrigin(input: {
    runId: string;
    threadId: string;
    expectedOrganizationId: string;
    expectedEnvironmentId: string;
    expectedProjectId: string;
    expectedUserId: string;
  }): Promise<HostedBrowserOriginAuthority>;
  createOpening(input: {
    session: BrowserSessionV1;
    origin: HostedBrowserOriginAuthority;
  }): Promise<void>;
  attachMachine(input: {
    sessionId: string;
    originTurnId: string;
    machineId: string;
    previewLeaseId?: string | undefined;
    generation: number;
    workerImageDigest: string;
    proxyAuthorityRevision: string;
  }): Promise<void>;
  read(sessionId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null>;
  readActiveForThread(threadId: string): Promise<{
    session: BrowserSessionV1;
    resource: HostedBrowserResourceRecord | null;
  } | null>;
  resolveCurrentOrigin(sessionId: string): Promise<HostedBrowserOriginAuthority>;
  updateSession(session: BrowserSessionV1): Promise<void>;
  touchActivity(sessionId: string, generation: number, now: Date): Promise<void>;
  adoptRevision(input: {
    sessionId: string;
    expectedRevision: string;
    revision: string;
    now: Date;
  }): Promise<void>;
  markTerminal(input: {
    sessionId: string;
    expectedGeneration?: number | undefined;
    expectedMachineId?: string | undefined;
    state: "closed" | "expired" | "lost" | "failed";
    reason: BrowserSessionV1["terminalReason"] & string;
    now: Date;
  }): Promise<BrowserSessionV1>;
  confirmCleanup(sessionId: string, now?: Date): Promise<void>;
  listForReconciliation(): Promise<
    Array<{ session: BrowserSessionV1; resource: HostedBrowserResourceRecord | null }>
  >;
}

export interface HostedBrowserPolicyPort {
  resolve(input: {
    origin: HostedBrowserOriginAuthority;
    effectiveInput: Record<string, unknown>;
    operation: string;
  }): Promise<{
    resolution: BrowserPolicyResolutionV1;
    authority: BrowserEffectiveDomainAuthorityV1;
  }>;
}

export interface HostedBrowserArtifactPort {
  prepareScreenshotUpload(input: {
    origin: HostedBrowserOriginAuthority;
    sessionId: string;
    generation: number;
    callId: string;
    byteLength: number;
    sha256: string;
  }): Promise<HostedBrowserArtifactUploadInstructionV1>;
  authorize(
    input: BrowserArtifactAuthorizationRequestV1 & {
      origin: HostedBrowserOriginAuthority;
      generation: number;
    },
  ): Promise<BrowserAuthorizedArtifactV1 | undefined>;
  canonicalizeRelayedScreenshot(input: {
    origin: HostedBrowserOriginAuthority;
    sessionId: string;
    generation: number;
    callId: string;
    bytes: Uint8Array;
    sha256: string;
  }): Promise<BrowserAuthorizedArtifactV1>;
  stageDownload?(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
    body: NodeJS.ReadableStream;
  }): Promise<void>;
  reserveDownload?(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<"reserved" | "in_progress" | "staged" | "promoted">;
  cancelDownload?(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<void>;
  commitDownload?(input: {
    origin: HostedBrowserOriginAuthority; operationId: string; sessionId: string;
    generation: number; pendingDownloadId: string; filename: string;
    declaredMediaType: string; sizeBytes: number; sha256: string;
    expiresAt: string;
  }): Promise<BrowserAuthorizedArtifactV1>;
}

export interface HostedBrowserMetricPort {
  emit(name: string, metadata: Record<string, string | number | boolean>): void;
}

type ActiveHostedBrowserRecord = {
  session: BrowserSessionV1;
  resource: HostedBrowserResourceRecord;
};

export type HostedBrowserDispatchReceiptV1 = HostedBrowserRelayAcceptanceV1;

export class HostedBrowserService implements BrowserServicePort {
  readonly version = BROWSER_SERVICE_PORT_VERSION;

  constructor(
    private readonly options: {
      store: HostedBrowserSessionStorePort;
      policy: HostedBrowserPolicyPort;
      machines: BrowserMachineInfrastructureProvider;
      artifacts: HostedBrowserArtifactPort;
      metrics: HostedBrowserMetricPort;
      capabilityPrivateKeyPem: string;
      requestAuthority: {
        organizationId: string;
        environmentId: string;
        userId: string;
      };
      appName: string;
      gatewayMachineId: string;
      region: string;
      runtimeImageDigest: string;
      routerUrl?: string | undefined;
      uploads?: HostedBrowserUploadWorkerPort | undefined;
      downloads?: HostedBrowserDownloadWorkerPort | undefined;
      resolveUploadAttachment?(input: { turnId: string; attachmentId: string }): Promise<{
        attachmentId: string;
        threadId: string;
        filename: string;
        declaredMediaType: string;
        detectedMediaType: string;
        sizeBytes: number;
        sha256: string;
        openStream(signal?: AbortSignal): Promise<NodeJS.ReadableStream>;
      }>;
      now?: (() => Date) | undefined;
    },
  ) {}

  async resolvePolicy(input: Parameters<BrowserServicePort["resolvePolicy"]>[0]) {
    const origin = await this.#resolvePreparedOrigin({
      runId: input.runId,
      threadId: input.threadId,
      stableAuthority: undefined,
      hostProjectId: input.authority.projectId,
    });
    return (await this.options.policy.resolve({
      origin,
      effectiveInput: input.effectiveInput,
      operation: input.operation,
    })).resolution;
  }

  async prepareUpload(
    input: BrowserUploadPreparationRequestV1,
  ): Promise<BrowserUploadPreparedEffectV1> {
    if (input.version !== BROWSER_UPLOAD_PREPARATION_VERSION) {
      throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    }
    if (!(
      this.options.routerUrl
      && this.options.uploads
      && this.options.resolveUploadAttachment
    )) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    const origin = await this.#resolvePreparedOrigin({
      runId: input.runId,
      threadId: input.threadId,
      stableAuthority: undefined,
      hostProjectId: input.authority.projectId,
    });
    const policy = await this.options.policy.resolve({
      origin,
      effectiveInput: input.effectiveInput,
      operation: "browser.upload",
    });
    if (policy.resolution.decision === "deny") {
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    const sessionId = requiredText(input.effectiveInput.sessionId);
    const record = await this.options.store.read(sessionId);
    if (
      !record?.resource ||
      record.session.threadId !== input.threadId ||
      record.session.state !== "ready" ||
      record.session.generation !== input.effectiveInput.generation
    ) throw this.#failure("BROWSER_SESSION_LOST");
    const storedOrigin = await this.options.store.resolveCurrentOrigin(sessionId);
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const attachment = await this.options.resolveUploadAttachment({
      turnId: input.turnId,
      attachmentId: input.attachment.attachmentId,
    });
    if (
      attachment.threadId !== input.threadId ||
      attachment.attachmentId !== input.attachment.attachmentId ||
      attachment.filename !== input.attachment.filename ||
      attachment.declaredMediaType !== input.attachment.declaredMediaType ||
      attachment.detectedMediaType !== input.attachment.detectedMediaType ||
      attachment.sizeBytes !== input.attachment.sizeBytes ||
      attachment.sha256 !== input.attachment.sha256
    ) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    const now = this.#now();
    const capability = issueHostedBrowserUploadPreparationCapability({
      privateKeyPem: this.options.capabilityPrivateKeyPem,
      now,
      claims: {
        version: HOSTED_BROWSER_UPLOAD_PREPARATION_CAPABILITY_VERSION,
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        projectId: origin.projectId,
        userId: origin.userId,
        threadId: origin.threadId,
        turnId: input.turnId,
        runId: input.runId,
        sessionId,
        generation: record.session.generation,
        attachmentId: attachment.attachmentId,
        snapshotId: requiredText(input.effectiveInput.snapshotId),
        targetRef: requiredText(input.effectiveInput.targetRef),
        effectRevision: hashCanonical(input),
        expiresAt: new Date(now.getTime() + OPERATION_CAPABILITY_MS).toISOString(),
      },
    });
    return await this.options.uploads.prepare({
      routerUrl: this.options.routerUrl,
      organizationId: origin.organizationId,
      environmentId: origin.environmentId,
      projectId: origin.projectId,
      userId: origin.userId,
      threadId: origin.threadId,
      runId: input.runId,
      sessionId,
      appName: this.options.appName,
      machineId: record.resource.machineId,
      capability,
      request: input,
    });
  }

  async prepareDownload(
    input: BrowserDownloadPreparationRequestV1,
  ): Promise<BrowserDownloadPreparedEffectV1> {
    if (
      input.version !== BROWSER_DOWNLOAD_PREPARATION_VERSION ||
      !this.options.routerUrl ||
      !this.options.downloads
    ) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    const origin = await this.#resolvePreparedOrigin({
      runId: input.runId,
      threadId: input.threadId,
      stableAuthority: undefined,
      hostProjectId: input.authority.projectId,
    });
    const policy = await this.options.policy.resolve({
      origin,
      effectiveInput: input.effectiveInput,
      operation: "browser.download",
    });
    if (policy.resolution.decision === "deny") {
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    const sessionId = requiredText(input.effectiveInput.sessionId);
    const pendingDownloadId = requiredText(input.effectiveInput.pendingDownloadId);
    const record = await this.options.store.read(sessionId);
    if (
      !record?.resource ||
      record.session.threadId !== input.threadId ||
      record.session.state !== "ready" ||
      record.session.generation !== input.effectiveInput.generation
    ) throw this.#failure("BROWSER_SESSION_LOST");
    const storedOrigin = await this.options.store.resolveCurrentOrigin(sessionId);
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const now = this.#now();
    const capability = issueHostedBrowserDownloadPreparationCapability({
      privateKeyPem: this.options.capabilityPrivateKeyPem,
      now,
      claims: {
        version: HOSTED_BROWSER_DOWNLOAD_PREPARATION_CAPABILITY_VERSION,
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        projectId: origin.projectId,
        userId: origin.userId,
        threadId: origin.threadId,
        runId: input.runId,
        sessionId,
        generation: record.session.generation,
        pendingDownloadId,
        effectRevision: hashCanonical(input),
        expiresAt: new Date(now.getTime() + OPERATION_CAPABILITY_MS).toISOString(),
      },
    });
    return await this.options.downloads.prepare({
      routerUrl: this.options.routerUrl,
      organizationId: origin.organizationId,
      environmentId: origin.environmentId,
      projectId: origin.projectId,
      userId: origin.userId,
      threadId: origin.threadId,
      runId: input.runId,
      sessionId,
      appName: this.options.appName,
      machineId: record.resource.machineId,
      capability,
      request: input,
    });
  }

  async releasePreparedDownload(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
  ): Promise<void> {
    if (prepared.activation.descriptor.toolId !== "browser.download") {
      throw this.#failure("BROWSER_DOWNLOAD_UNAVAILABLE");
    }
    if (!(this.options.routerUrl && this.options.downloads?.release)) {
      throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    }
    const effect = requirePreparedDownloadEffect(prepared);
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    if (effect.threadId !== origin.threadId) throw this.#failure("BROWSER_DOWNLOAD_UNAVAILABLE");
    const record = await this.options.store.read(effect.sessionId);
    if (!record?.resource || record.session.generation !== effect.generation) return;
    const storedOrigin = await this.options.store.resolveCurrentOrigin(effect.sessionId);
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const now = this.#now();
    const capability = issueHostedBrowserDownloadReleaseCapability({
      privateKeyPem: this.options.capabilityPrivateKeyPem,
      now,
      claims: {
        version: HOSTED_BROWSER_DOWNLOAD_RELEASE_CAPABILITY_VERSION,
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        projectId: origin.projectId,
        userId: origin.userId,
        threadId: origin.threadId,
        runId: prepared.runId,
        sessionId: effect.sessionId,
        generation: effect.generation,
        operationId: prepared.callId,
        pendingDownloadId: effect.pendingDownloadId,
        effectRevision: hashCanonical(effect),
        expiresAt: new Date(now.getTime() + OPERATION_CAPABILITY_MS).toISOString(),
      },
    });
    await this.options.downloads.release({
      routerUrl: this.options.routerUrl,
      organizationId: origin.organizationId,
      environmentId: origin.environmentId,
      projectId: origin.projectId,
      userId: origin.userId,
      threadId: origin.threadId,
      runId: prepared.runId,
      sessionId: effect.sessionId,
      appName: this.options.appName,
      machineId: record.resource.machineId,
      operationId: prepared.callId,
      capability,
      effect,
    });
  }

  async execute(
    prepared: PreparedToolCallV1,
    lifecycle: BrowserOperationLifecycleV1,
  ): Promise<unknown> {
    void prepared;
    void lifecycle;
    throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
  }

  async acceptOperation(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
  ): Promise<HostedBrowserRelayInstructionV1> {
    const operation = prepared.activation.descriptor.toolId;
    if (!isBrowserToolName(operation)) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    const policy = await this.options.policy.resolve({
      origin,
      effectiveInput: prepared.effectiveInput,
      operation,
    });
    if (policy.resolution.decision !== "allow") {
      throw this.#failure(
        policy.resolution.decision === "deny"
          ? "BROWSER_DESTINATION_BLOCKED"
          : "BROWSER_GRANT_DENIED",
      );
    }
    const active =
      operation === "browser.open"
        ? await this.#open(prepared, origin, policy.authority)
        : await this.#requireActive(prepared, origin, policy.authority);
    const capability = this.#issueCapability({
      origin,
      session: operation === "browser.request_grant"
        ? {
            ...active.session,
            effectiveAllowlistRevision:
              policy.authority.effectiveAllowlistRevision,
          }
        : active.session,
      operationId: prepared.callId,
    });
    return {
      version: "hosted_browser_relay_instruction_v1",
      phase: "accept",
      operationId: prepared.callId,
      operation,
      capability,
      sessionId: active.session.sessionId,
      generation: active.session.generation,
      machine: {
        appName: this.options.appName,
        machineId: active.resource.machineId,
      },
      authority: policy.authority,
      ...(operation === "browser.open" ? { session: active.session } : {}),
      prepared,
    };
  }

  async dispatchAcceptedOperation(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
    receipt: HostedBrowserDispatchReceiptV1,
    signal?: AbortSignal,
  ): Promise<HostedBrowserRelayInstructionV1> {
    const operation = prepared.activation.descriptor.toolId;
    const accepted = receipt.worker;
    const acceptedInstruction = receipt.instruction;
    if (
      !isBrowserToolName(operation) ||
      receipt.version !== "hosted_browser_relay_acceptance_v1" ||
      acceptedInstruction.version !== "hosted_browser_relay_instruction_v1" ||
      acceptedInstruction.phase !== "accept" ||
      acceptedInstruction.operation !== operation ||
      acceptedInstruction.operationId !== prepared.callId ||
      accepted.operationId !== prepared.callId ||
      accepted.sessionId !== acceptedInstruction.sessionId ||
      accepted.generation !== acceptedInstruction.generation
    ) {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    const policy = await this.options.policy.resolve({
      origin,
      effectiveInput: prepared.effectiveInput,
      operation,
    });
    let policyRevalidationAccepted = false;
    try {
      policyRevalidationAccepted =
        policy.resolution.decision === "allow" &&
        policy.authority.effectiveAllowlistRevision ===
          verifyHostedBrowserOperationCapability({
          token: acceptedInstruction.capability,
          publicKeyPem: createPublicKey(
            this.options.capabilityPrivateKeyPem,
          )
            .export({ type: "spki", format: "pem" })
            .toString(),
          now: this.#now(),
          expected: {
            version: HOSTED_BROWSER_CAPABILITY_VERSION,
            organizationId: origin.organizationId,
            environmentId: origin.environmentId,
            projectId: origin.projectId,
            userId: origin.userId,
            threadId: origin.threadId,
            sessionId: acceptedInstruction.sessionId,
            generation: acceptedInstruction.generation,
            operationId: acceptedInstruction.operationId,
            effectiveAllowlistRevision:
              policy.authority.effectiveAllowlistRevision,
          },
          }).effectiveAllowlistRevision;
    } catch {
      policyRevalidationAccepted = false;
    }
    if (!policyRevalidationAccepted) {
      if (operation === "browser.open") {
        await this.#terminateRejectedOpening(origin, acceptedInstruction);
      }
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    const record = await this.options.store.read(acceptedInstruction.sessionId);
    if (
      !record?.resource ||
      TERMINAL_STATES.has(record.session.state) ||
      record.session.state === "closing" ||
      record.session.generation !== acceptedInstruction.generation ||
      (operation !== "browser.request_grant" &&
        record.session.effectiveAllowlistRevision !==
          policy.authority.effectiveAllowlistRevision) ||
      acceptedInstruction.machine.appName !== this.options.appName ||
      acceptedInstruction.machine.machineId !== record.resource.machineId
    ) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const dispatchNow = this.#now();
    if (
      dispatchNow >= new Date(record.session.idleExpiresAt) ||
      dispatchNow >= new Date(record.session.hardExpiresAt)
    ) {
      await this.#terminate(
        record.session,
        record.resource,
        "expired",
        "BROWSER_SESSION_EXPIRED",
      );
      throw this.#failure("BROWSER_SESSION_EXPIRED");
    }
    const storedOrigin = await this.options.store.resolveCurrentOrigin(
      acceptedInstruction.sessionId,
    );
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    if (
      accepted.identity.sessionId !== record.session.sessionId ||
      accepted.identity.generation !== record.session.generation ||
      accepted.identity.engineRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
      accepted.identity.chromeRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision ||
      accepted.identity.imageDigest !== this.options.runtimeImageDigest
    ) {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    if (operation === "browser.upload") {
      if (!(
        this.options.routerUrl
        && this.options.uploads
        && this.options.resolveUploadAttachment
      )) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
      const effect = requirePreparedUploadEffect(prepared);
      const attachment = await this.options.resolveUploadAttachment({
        turnId: effect.turnId,
        attachmentId: effect.attachmentId,
      });
      if (
        attachment.threadId !== effect.threadId ||
        attachment.filename !== effect.filename ||
        attachment.declaredMediaType !== effect.declaredMediaType ||
        attachment.detectedMediaType !== effect.detectedMediaType ||
        attachment.sizeBytes !== effect.sizeBytes ||
        attachment.sha256 !== effect.sha256 ||
        effect.sessionId !== record.session.sessionId ||
        effect.generation !== record.session.generation
      ) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
      await this.options.uploads.transfer({
        routerUrl: this.options.routerUrl,
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        projectId: origin.projectId,
        userId: origin.userId,
        threadId: origin.threadId,
        runId: prepared.runId,
        sessionId: record.session.sessionId,
        appName: this.options.appName,
        machineId: record.resource.machineId,
        operationId: prepared.callId,
        capability: acceptedInstruction.capability,
        sizeBytes: effect.sizeBytes,
        sha256: effect.sha256,
        body: await attachment.openStream(signal),
        ...(signal ? { signal } : {}),
      });
    }
    if (operation === "browser.download") {
      if (!(
        this.options.routerUrl &&
        this.options.downloads &&
        this.options.artifacts.stageDownload &&
        this.options.artifacts.reserveDownload
      )) throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
      const effect = requirePreparedDownloadEffect(prepared);
      if (
        effect.threadId !== origin.threadId ||
        effect.sessionId !== record.session.sessionId ||
        effect.generation !== record.session.generation
      ) throw this.#failure("BROWSER_SESSION_LOST");
      const artifactIdentity = {
        origin,
        operationId: prepared.callId,
        sessionId: effect.sessionId,
        generation: effect.generation,
        pendingDownloadId: effect.pendingDownloadId,
        filename: effect.filename,
        declaredMediaType: effect.declaredMediaType,
        sizeBytes: effect.measuredBytes,
        sha256: effect.sha256,
        expiresAt: effect.expiresAt,
      };
      const reservation = await this.options.artifacts.reserveDownload(artifactIdentity);
      if (reservation === "in_progress") {
        throw this.#failure("BROWSER_ACTION_OUTCOME_UNKNOWN");
      }
      if (reservation !== "reserved") {
        return {
          version: "hosted_browser_relay_instruction_v1",
          phase: "invoke",
          operationId: prepared.callId,
          operation,
          sessionId: record.session.sessionId,
          generation: record.session.generation,
          capability: acceptedInstruction.capability,
          machine: acceptedInstruction.machine,
        };
      }
      let source: NodeJS.ReadableStream | undefined;
      try {
        source = await this.options.downloads.open({
          routerUrl: this.options.routerUrl,
          organizationId: origin.organizationId,
          environmentId: origin.environmentId,
          projectId: origin.projectId,
          userId: origin.userId,
          threadId: origin.threadId,
          runId: prepared.runId,
          sessionId: record.session.sessionId,
          appName: this.options.appName,
          machineId: record.resource.machineId,
          operationId: prepared.callId,
          capability: acceptedInstruction.capability,
          sizeBytes: effect.measuredBytes,
          sha256: effect.sha256,
          ...(signal ? { signal } : {}),
        });
        await this.options.artifacts.stageDownload({
          ...artifactIdentity,
          body: source,
        });
      } catch (error) {
        try {
          if (!this.options.artifacts.cancelDownload) {
            throw this.#failure("BROWSER_ACTION_OUTCOME_UNKNOWN");
          }
          await this.options.artifacts.cancelDownload(artifactIdentity);
        } catch {
          throw this.#failure("BROWSER_ACTION_OUTCOME_UNKNOWN");
        }
        throw error;
      } finally {
        (source as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined)
          ?.destroy?.();
      }
    }
    return {
      version: "hosted_browser_relay_instruction_v1",
      phase: "invoke",
      operationId: prepared.callId,
      operation,
      sessionId: record.session.sessionId,
      generation: record.session.generation,
      capability: acceptedInstruction.capability,
      machine: acceptedInstruction.machine,
    };
  }

  async completeAcceptedOperation(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
    receipt: HostedBrowserCompletionReceiptV1,
    output: unknown,
  ): Promise<unknown> {
    const operation = prepared.activation.descriptor.toolId;
    const instruction = receipt.instruction;
    const workerIdentity = receipt.worker.identity;
    if (
      !isBrowserToolName(operation) ||
      (receipt.version !== "hosted_browser_relay_acceptance_v1" &&
        receipt.version !== "hosted_browser_pre_dispatch_completion_v1") ||
      instruction.operationId !== prepared.callId ||
      instruction.operation !== operation
    ) {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    const record = await this.options.store.read(instruction.sessionId);
    if (!record?.resource || record.session.generation !== instruction.generation) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const storedOrigin = await this.options.store.resolveCurrentOrigin(
      instruction.sessionId,
    );
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    if (operation === "browser.download") {
      if (!this.options.artifacts.commitDownload) {
        throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
      }
      let envelope: ReturnType<typeof parseHostedBrowserDownloadEnvelope>;
      let effect: BrowserDownloadPreparedEffectV1;
      try {
        envelope = parseHostedBrowserDownloadEnvelope(output);
        effect = requirePreparedDownloadEffect(prepared);
      } catch {
        throw this.#failure("BROWSER_DOWNLOAD_UNAVAILABLE");
      }
      if (hashCanonical(envelope.download) !== hashCanonical(effect)) {
        throw this.#failure("BROWSER_DOWNLOAD_UNAVAILABLE");
      }
      try {
        const artifact = await this.options.artifacts.commitDownload({
          origin,
          operationId: prepared.callId,
          sessionId: effect.sessionId,
          generation: effect.generation,
          pendingDownloadId: effect.pendingDownloadId,
          filename: effect.filename,
          declaredMediaType: effect.declaredMediaType,
          sizeBytes: effect.measuredBytes,
          sha256: effect.sha256,
          expiresAt: effect.expiresAt,
        });
        const { version: _artifactAuthorityVersion, ...artifactOutput } = artifact;
        output = {
          version: "browser_tool_result_v1",
          operation: "browser.download",
          sessionId: effect.sessionId,
          generation: effect.generation,
          artifact: artifactOutput,
        };
      } catch {
        throw this.#failure("BROWSER_ACTION_OUTCOME_UNKNOWN");
      }
    }
    try {
      if (operation === "browser.capture") {
        verifyHostedBrowserOperationCapability({
          token: instruction.capability,
          publicKeyPem: createPublicKey(this.options.capabilityPrivateKeyPem)
            .export({ type: "spki", format: "pem" })
            .toString(),
          now: this.#now(),
          allowExpired: true,
          expected: {
            version: HOSTED_BROWSER_CAPABILITY_VERSION,
            organizationId: origin.organizationId,
            environmentId: origin.environmentId,
            projectId: origin.projectId,
            userId: origin.userId,
            threadId: origin.threadId,
            sessionId: instruction.sessionId,
            generation: instruction.generation,
            operationId: instruction.operationId,
            effectiveAllowlistRevision:
              record.session.effectiveAllowlistRevision,
          },
        });
        output = await this.#canonicalizeRelayedScreenshot({
          output,
          origin,
          session: record.session,
          callId: prepared.callId,
        });
      } else if (isHostedBrowserWorkerResultEnvelope(output)) {
        throw this.#failure("BROWSER_ENGINE_FAILURE");
      }
    } catch {
      await this.#terminate(
        record.session,
        record.resource,
        "failed",
        "BROWSER_ENGINE_FAILURE",
      );
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    const resultRevision = operation === "browser.request_grant" &&
        output && typeof output === "object" && !Array.isArray(output) &&
        typeof (output as Record<string, unknown>).effectiveAllowlistRevision === "string"
      ? (output as Record<string, unknown>).effectiveAllowlistRevision as string
      : record.session.effectiveAllowlistRevision;
    let validatedOutput: unknown;
    try {
      verifyHostedBrowserOperationCapability({
        token: instruction.capability,
        publicKeyPem: createPublicKey(this.options.capabilityPrivateKeyPem)
          .export({ type: "spki", format: "pem" })
          .toString(),
        now: this.#now(),
        allowExpired: true,
        expected: {
          version: HOSTED_BROWSER_CAPABILITY_VERSION,
          organizationId: origin.organizationId,
          environmentId: origin.environmentId,
          projectId: origin.projectId,
          userId: origin.userId,
          threadId: origin.threadId,
          sessionId: instruction.sessionId,
          generation: instruction.generation,
          operationId: instruction.operationId,
          effectiveAllowlistRevision: resultRevision,
        },
      });
      validatedOutput = validateBrowserResultSemantics(operation, output);
      if (
        compileToolJsonSchemaV1(getBrowserToolContract(operation).outputSchema, {
          surface: "output",
        })(validatedOutput) !== true
      ) {
        throw new Error("Browser result schema is invalid.");
      }
      if (operation === "browser.open") {
        const result = validatedOutput as Record<string, unknown>;
        const resultSession = parseBrowserSessionV1(result.session);
        if (
          (result.outcome !== "opened" && result.outcome !== "existing") ||
          resultSession.sessionId !== record.session.sessionId ||
          resultSession.generation !== record.session.generation ||
          resultSession.effectiveAllowlistRevision !==
            record.session.effectiveAllowlistRevision ||
          resultSession.threadId !== record.session.threadId ||
          resultSession.mode !== record.session.mode ||
          (record.session.state !== "opening" && record.session.state !== "ready") ||
          record.session.terminalReason !== undefined ||
          record.session.engineRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
          workerIdentity.sessionId !== record.session.sessionId ||
          workerIdentity.generation !== record.session.generation ||
          workerIdentity.engineRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
          workerIdentity.chromeRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision ||
          workerIdentity.imageDigest !== this.options.runtimeImageDigest
        ) {
          throw new Error("Browser open result does not match hosted authority.");
        }
      }
      validateBrowserResultAuthority(prepared, validatedOutput, {
        runId: prepared.runId,
        sessionId: prepared.sessionId,
        threadId: authority.threadId,
        callId: prepared.callId,
        toolName: operation,
      });
      if (operation === "browser.open") {
        if (record.session.state === "opening") {
          await this.options.store.updateSession({
            ...record.session,
            state: "ready",
          });
        }
        await this.options.store.touchActivity(
          record.session.sessionId,
          record.session.generation,
          this.#now(),
        );
        const ready = await this.options.store.read(record.session.sessionId);
        if (
          !ready?.resource ||
          ready.session.state !== "ready" ||
          ready.session.terminalReason !== undefined ||
          ready.session.generation !== record.session.generation ||
          ready.resource.machineId !== record.resource.machineId ||
          ready.resource.machineGeneration !== record.resource.machineGeneration
        ) {
          throw new Error("Browser open completion did not persist readiness.");
        }
        validatedOutput = {
          ...(validatedOutput as Record<string, unknown>),
          session: ready.session,
        };
      }
    } catch {
      await this.#terminate(
        record.session,
        record.resource,
        "failed",
        "BROWSER_ENGINE_FAILURE",
      );
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    if (operation === "browser.close") {
      await this.#terminate(
        record.session,
        record.resource,
        "closed",
        "closed_by_user",
      );
      return validatedOutput;
    }
    if (
      operation === "browser.request_grant" &&
      resultRevision !== record.session.effectiveAllowlistRevision
    ) {
      await this.options.store.adoptRevision({
        sessionId: record.session.sessionId,
        expectedRevision: record.session.effectiveAllowlistRevision,
        revision: resultRevision,
        now: this.#now(),
      });
    }
    if (operation !== "browser.open") {
      await this.options.store.touchActivity(
        record.session.sessionId,
        record.session.generation,
        this.#now(),
      );
    }
    return validatedOutput;
  }

  async #canonicalizeRelayedScreenshot(input: {
    output: unknown;
    origin: HostedBrowserOriginAuthority;
    session: BrowserSessionV1;
    callId: string;
  }): Promise<unknown> {
    const envelope = parseHostedBrowserScreenshotEnvelope(input.output);
    const bytes = Buffer.from(envelope.screenshot.base64, "base64");
    if (
      bytes.byteLength !== envelope.screenshot.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !==
        envelope.screenshot.sha256 ||
      bytes.byteLength < 8 ||
      !bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    const artifact = await this.options.artifacts.canonicalizeRelayedScreenshot({
      origin: input.origin,
      sessionId: input.session.sessionId,
      generation: input.session.generation,
      callId: input.callId,
      bytes,
      sha256: envelope.screenshot.sha256,
    });
    const { version: _artifactAuthorityVersion, ...artifactOutput } = artifact;
    return {
      ...envelope.output,
      artifact: artifactOutput,
    };
  }

  async markAcceptedOperationUnknown(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
    receipt: HostedBrowserDispatchReceiptV1,
  ): Promise<void> {
    const instruction = receipt.instruction;
    if (instruction.operationId !== prepared.callId) return;
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    const record = await this.options.store.read(instruction.sessionId);
    if (!record?.resource) return;
    const storedOrigin = await this.options.store.resolveCurrentOrigin(
      instruction.sessionId,
    );
    if (!sameBrowserIdentity(storedOrigin, origin)) return;
    await this.#terminate(
      record.session,
      record.resource,
      "lost",
      "BROWSER_ACTION_OUTCOME_UNKNOWN",
    );
  }

  async authorizeArtifact(
    input: BrowserArtifactAuthorizationRequestV1,
  ): Promise<BrowserAuthorizedArtifactV1 | undefined> {
    const record = await this.options.store.read(input.sessionId);
    if (
      !record?.resource ||
      record.session.threadId !== input.threadId ||
      record.session.state !== "ready" ||
      record.session.terminalReason !== undefined
    ) return;
    const storedOrigin = await this.options.store.resolveCurrentOrigin(input.sessionId);
    const currentOrigin = await this.options.store.resolveOrigin({
      runId: input.runId,
      threadId: input.threadId,
      expectedOrganizationId: this.options.requestAuthority.organizationId,
      expectedEnvironmentId: this.options.requestAuthority.environmentId,
      expectedProjectId: storedOrigin.projectId,
      expectedUserId: this.options.requestAuthority.userId,
    });
    if (!sameBrowserIdentity(storedOrigin, currentOrigin)) return;
    return this.options.artifacts.authorize({
      ...input,
      origin: currentOrigin,
      generation: record.session.generation,
    });
  }

  /**
   * Creates a host-private upload instruction after capture metadata is known.
   * The instruction contains bearer authority and must never enter tool output.
   */
  async prepareCaptureArtifactUpload(
    prepared: PreparedToolCallV1,
    authority: BrowserOperationLifecycleV1["authority"],
    metadata: { byteLength: number; sha256: string },
  ): Promise<HostedBrowserArtifactUploadInstructionV1> {
    if (prepared.activation.descriptor.toolId !== "browser.capture") {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    const origin = await this.#resolvePreparedOrigin({
      runId: prepared.runId,
      threadId: authority.threadId,
      stableAuthority: prepared.stableAuthority,
      hostProjectId: authority.projectId,
    });
    const policy = await this.options.policy.resolve({
      origin,
      effectiveInput: prepared.effectiveInput,
      operation: "browser.capture",
    });
    if (policy.resolution.decision !== "allow") {
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    const active = await this.#requireActive(prepared, origin, policy.authority);
    if (active.session.state !== "ready") {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    return this.options.artifacts.prepareScreenshotUpload({
      origin,
      sessionId: active.session.sessionId,
      generation: active.session.generation,
      callId: prepared.callId,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
    });
  }

  async adoptAllowlistRevision(
    input: BrowserAllowlistAdoptionRequestV1,
  ): Promise<BrowserAllowlistAdoptionReceiptV1> {
    void input;
    throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
  }

  async prepareAllowlistAdoption(
    input: BrowserAllowlistAdoptionRequestV1,
  ): Promise<HostedBrowserRevisionInstructionV1> {
    const { record, origin, authority } = await this.#validateAllowlistAdoption(input);
    return {
      version: "hosted_browser_revision_instruction_v1",
      sessionId: input.sessionId,
      generation: record.session.generation,
      revision: input.effectiveAllowlistRevision,
      cause: input.cause,
      authority,
      capability: this.#issueCapability({
        origin,
        session: {
          ...record.session,
          effectiveAllowlistRevision: input.effectiveAllowlistRevision,
        },
        operationId: `revision:${input.effectiveAllowlistRevision}`,
      }),
      machine: {
        appName: this.options.appName,
        machineId: record.resource!.machineId,
      },
    };
  }

  async #validateAllowlistAdoption(input: BrowserAllowlistAdoptionRequestV1) {
    const record = await this.options.store.read(input.sessionId);
    if (!record?.resource || record.session.threadId !== input.threadId) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const storedOrigin = await this.options.store.resolveCurrentOrigin(input.sessionId);
    const origin = await this.options.store.resolveOrigin({
      runId: input.runId,
      threadId: input.threadId,
      expectedOrganizationId: this.options.requestAuthority.organizationId,
      expectedEnvironmentId: this.options.requestAuthority.environmentId,
      expectedProjectId: storedOrigin.projectId,
      expectedUserId: this.options.requestAuthority.userId,
    });
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const policy = await this.options.policy.resolve({
      origin,
      operation: "browser.snapshot",
      effectiveInput: {
        sessionId: input.sessionId,
        generation: record.session.generation,
      },
    });
    if (
      policy.authority.effectiveAllowlistRevision !==
      input.effectiveAllowlistRevision
    ) {
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    return { record, origin, authority: policy.authority };
  }

  async completeAllowlistAdoption(
    input: BrowserAllowlistAdoptionRequestV1,
    adopted: { revision: string; closedUnauthorizedConnections: number },
  ): Promise<BrowserAllowlistAdoptionReceiptV1> {
    const { record } = await this.#validateAllowlistAdoption(input);
    if (adopted.revision !== input.effectiveAllowlistRevision) {
      throw this.#failure("BROWSER_ENGINE_FAILURE");
    }
    await this.options.store.adoptRevision({
      sessionId: record.session.sessionId,
      expectedRevision: record.session.effectiveAllowlistRevision,
      revision: adopted.revision,
      now: this.#now(),
    });
    this.options.metrics.emit("browser_revision_adopted", {
      sessionId: input.sessionId,
      closedConnections: adopted.closedUnauthorizedConnections,
    });
    return {
      version: BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
      sessionId: input.sessionId,
      effectiveAllowlistRevision: adopted.revision,
      closedUnauthorizedConnections: adopted.closedUnauthorizedConnections,
    };
  }

  async reconcile(): Promise<void> {
    const records = await this.options.store.listForReconciliation();
    const machines = await this.options.machines.listBrowserMachines({
      appName: this.options.appName,
    });
    const knownMachineIds = new Set(
      records.flatMap((record) =>
        record.resource ? [record.resource.machineId] : [],
      ),
    );
    for (const machine of machines) {
      if (!knownMachineIds.has(machine.id)) {
        await this.#deleteMachine(machine.id);
      }
    }
    for (const record of records) {
      if (!record.resource) {
        if (!TERMINAL_STATES.has(record.session.state)) {
          await this.options.store.markTerminal({
            sessionId: record.session.sessionId,
            state: "lost",
            reason: "BROWSER_SESSION_LOST",
            now: this.#now(),
          });
        }
        continue;
      }
      const machine = await this.options.machines.getMachine({
        appName: this.options.appName,
        machineId: record.resource.machineId,
      });
      if (TERMINAL_STATES.has(record.session.state)) {
        await this.#cleanup(record.session, record.resource);
      } else if (!machine) {
        await this.options.store.markTerminal({
          sessionId: record.session.sessionId,
          state: "lost",
          reason: "BROWSER_SESSION_LOST",
          now: this.#now(),
        });
        await this.options.store.confirmCleanup(record.session.sessionId);
      }
    }
  }

  async terminateViewerSession(input: {
    sessionId: string;
    generation: number;
    reason: "closed_by_user" | "BROWSER_SESSION_LOST";
  }): Promise<void> {
    const record = await this.options.store.read(input.sessionId);
    if (
      !record?.resource ||
      record.session.generation !== input.generation ||
      (record.session.state !== "ready" &&
        record.session.state !== "human_control")
    ) throw this.#failure("BROWSER_SESSION_LOST");
    const origin = await this.options.store.resolveCurrentOrigin(input.sessionId);
    if (
      origin.organizationId !== this.options.requestAuthority.organizationId ||
      origin.environmentId !== this.options.requestAuthority.environmentId ||
      origin.userId !== this.options.requestAuthority.userId
    ) throw this.#failure("BROWSER_SESSION_LOST");
    const terminal = await this.options.store.markTerminal({
      sessionId: record.session.sessionId,
      expectedGeneration: input.generation,
      expectedMachineId: record.resource.machineId,
      state: input.reason === "closed_by_user" ? "closed" : "lost",
      reason: input.reason,
      now: this.#now(),
    });
    await this.#cleanup(terminal, record.resource);
  }

  async #open(
    prepared: PreparedToolCallV1,
    origin: HostedBrowserOriginAuthority,
    authority: BrowserEffectiveDomainAuthorityV1,
  ): Promise<ActiveHostedBrowserRecord> {
    const now = this.#now();
    const mode = prepared.effectiveInput.mode;
    if (mode !== "qa" && mode !== "operator") {
      throw this.#failure("BROWSER_DESTINATION_BLOCKED");
    }
    const sessionId = hostedBrowserSessionId(prepared, origin);
    const persisted =
      (await this.options.store.read(sessionId)) ??
      (await this.options.store.readActiveForThread(origin.threadId));
    if (persisted) {
      const persistedOrigin = await this.options.store.resolveCurrentOrigin(
        persisted.session.sessionId,
      );
      if (
        persisted.session.threadId !== origin.threadId ||
        persisted.session.mode !== mode ||
        persisted.session.effectiveAllowlistRevision !==
          authority.effectiveAllowlistRevision ||
        persisted.resource?.previewLeaseId !==
          (readPreviewLeaseId(prepared.effectiveInput) ?? null) ||
        TERMINAL_STATES.has(persisted.session.state) ||
        !sameBrowserIdentity(persistedOrigin, origin)
      ) {
        throw this.#failure("BROWSER_SESSION_CONFLICT");
      }
      return this.#ensureOpenMachine(
        prepared,
        origin,
        authority,
        persisted.session,
        persisted.resource,
      );
    }
    const session: BrowserSessionV1 = parseBrowserSessionV1({
      version: "browser_session_v1",
      sessionId,
      threadId: origin.threadId,
      mode,
      state: "opening",
      engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
      generation: 1,
      effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + IDLE_MS).toISOString(),
      hardExpiresAt: new Date(now.getTime() + HARD_MS).toISOString(),
    });
    await this.options.store.createOpening({ session, origin });
    return this.#ensureOpenMachine(
      prepared,
      origin,
      authority,
      session,
      null,
    );
  }

  async #ensureOpenMachine(
    prepared: PreparedToolCallV1,
    origin: HostedBrowserOriginAuthority,
    authority: BrowserEffectiveDomainAuthorityV1,
    session: BrowserSessionV1,
    persistedResource: HostedBrowserResourceRecord | null,
  ): Promise<ActiveHostedBrowserRecord> {
    let machineId: string | undefined;
    let createdMachineId: string | undefined;
    let ownsMachine = Boolean(persistedResource);
    try {
      if (
        !["opening", "ready"].includes(session.state) ||
        session.generation < 1 ||
        session.engineRevision !== BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
        (session.state === "ready" && !persistedResource) ||
        (persistedResource &&
          (persistedResource.sessionId !== session.sessionId ||
            persistedResource.machineGeneration !== session.generation))
      ) {
        throw this.#failure("BROWSER_SESSION_LOST");
      }
      let resource = persistedResource;
      if (resource) {
        machineId = resource.machineId;
      } else {
        const labeled = await this.options.machines.listBrowserMachines({
          appName: this.options.appName,
          sessionId: session.sessionId,
        });
        if (labeled.length > 1) {
          throw this.#failure("BROWSER_ENGINE_FAILURE");
        }
        machineId = labeled[0]?.id;
      }
      const machineInput: BrowserMachineProvisioningInput = {
        appName: this.options.appName,
        gatewayMachineId: this.options.gatewayMachineId,
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        projectId: origin.projectId,
        userId: origin.userId,
        threadId: origin.threadId,
        sessionId: session.sessionId,
        generation: session.generation,
        region: this.options.region,
        runtimeImageDigest: this.options.runtimeImageDigest,
        engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
        chromeRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
        effectiveAllowlistRevision: session.effectiveAllowlistRevision,
        capabilityPublicKeyPem: createPublicKey(
          this.options.capabilityPrivateKeyPem,
        )
          .export({ type: "spki", format: "pem" })
          .toString(),
      };
      if (!machineId) {
        const machine = await this.options.machines.createBrowserMachine(machineInput);
        machineId = machine.id;
        createdMachineId = machine.id;
      }
      if (!resource) {
        await this.options.store.attachMachine({
          sessionId: session.sessionId,
          originTurnId: origin.turnId,
          machineId,
          ...(readPreviewLeaseId(prepared.effectiveInput)
            ? { previewLeaseId: readPreviewLeaseId(prepared.effectiveInput) }
            : {}),
          generation: session.generation,
          workerImageDigest: this.options.runtimeImageDigest,
          proxyAuthorityRevision: authority.effectiveAllowlistRevision,
        });
        ownsMachine = true;
        resource = {
          sessionId: session.sessionId,
          originatingTurnId: origin.turnId,
          previewLeaseId: readPreviewLeaseId(prepared.effectiveInput) ?? null,
          machineId,
          machineGeneration: session.generation,
          workerImageDigest: this.options.runtimeImageDigest,
          proxyAuthorityRevision: authority.effectiveAllowlistRevision,
          cleanupRequestedAt: null,
          cleanupConfirmedAt: null,
        };
      }
      await this.options.machines.waitForMachine({
        appName: this.options.appName,
        machineId,
        state: "started",
        timeoutSeconds: 20,
      });
      const startedMachine = await this.options.machines.getMachine({
        appName: this.options.appName,
        machineId,
      });
      const requestedDigest = this.options.runtimeImageDigest.split("@").at(-1);
      if (
        !startedMachine ||
        startedMachine.state !== "started" ||
        startedMachine.region !== this.options.region ||
        startedMachine.resolvedImageDigest !== requestedDigest ||
        (startedMachine.mounts?.length ?? 0) !== 0 ||
        startedMachine.browserSessionId !== session.sessionId ||
        startedMachine.browserGeneration !== session.generation
      ) {
        throw this.#failure("BROWSER_ENGINE_FAILURE");
      }
      const current = await this.options.store.read(session.sessionId);
      if (
        !(current?.resource &&["opening", "ready"].includes(current.session.state) ) ||
        current.session.generation !== session.generation ||
        current.session.engineRevision !==
          BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision ||
        current.resource.machineId !== machineId ||
        current.resource.machineGeneration !== session.generation
      ) {
        throw this.#failure("BROWSER_SESSION_LOST");
      }
      this.options.metrics.emit("browser_worker_started", {
        sessionId: session.sessionId,
        generation: session.generation,
      });
      return {
        session,
        resource,
      };
    } catch (error) {
      let terminalIntentPersisted = false;
      if (ownsMachine && machineId) {
        terminalIntentPersisted = await this.options.store
          .markTerminal({
            sessionId: session.sessionId,
            expectedGeneration: session.generation,
            expectedMachineId: machineId,
            state: "failed",
            reason: "BROWSER_ENGINE_FAILURE",
            now: this.#now(),
          })
          .then(() => true)
          .catch(() => false);
      }
      const cleanupMachineId = ownsMachine
        ? terminalIntentPersisted
          ? machineId
          : undefined
        : createdMachineId;
      if (cleanupMachineId) {
        const cleanupConfirmed = await this.#deleteMachine(cleanupMachineId)
          .then(() => true)
          .catch(() => false);
        if (cleanupConfirmed && ownsMachine) {
          await this.options.store
            .confirmCleanup(session.sessionId, this.#now())
            .catch(() => {});
        }
      }
      throw error;
    }
  }

  async #requireActive(
    prepared: PreparedToolCallV1,
    origin: HostedBrowserOriginAuthority,
    authority: BrowserEffectiveDomainAuthorityV1,
  ): Promise<ActiveHostedBrowserRecord> {
    const sessionId = prepared.effectiveInput.sessionId;
    const generation = prepared.effectiveInput.generation;
    if (typeof sessionId !== "string" || !Number.isInteger(generation)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const record = await this.options.store.read(sessionId);
    if (
      !record?.resource ||
      record.session.threadId !== origin.threadId ||
      record.session.generation !== generation ||
      record.resource.machineGeneration !== generation ||
      (prepared.activation.descriptor.toolId !== "browser.request_grant" &&
        record.session.effectiveAllowlistRevision !==
          authority.effectiveAllowlistRevision)
    ) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const storedOrigin = await this.options.store.resolveCurrentOrigin(sessionId);
    if (!sameBrowserIdentity(storedOrigin, origin)) {
      throw this.#failure("BROWSER_SESSION_LOST");
    }
    const now = this.#now();
    if (
      TERMINAL_STATES.has(record.session.state) ||
      now >= new Date(record.session.idleExpiresAt) ||
      now >= new Date(record.session.hardExpiresAt)
    ) {
      await this.#terminate(
        record.session,
        record.resource,
        "expired",
        "BROWSER_SESSION_EXPIRED",
      );
      throw this.#failure("BROWSER_SESSION_EXPIRED");
    }
    return { session: record.session, resource: record.resource };
  }

  async #terminate(
    session: BrowserSessionV1,
    resource: HostedBrowserResourceRecord,
    state: "closed" | "expired" | "lost" | "failed",
    reason: BrowserSessionV1["terminalReason"] & string,
  ): Promise<BrowserSessionV1> {
    const terminal = await this.options.store.markTerminal({
      sessionId: session.sessionId,
      state,
      reason,
      now: this.#now(),
    });
    await this.#cleanup(terminal, resource);
    return terminal;
  }

  async #terminateRejectedOpening(
    origin: HostedBrowserOriginAuthority,
    instruction: HostedBrowserRelayInstructionV1,
  ): Promise<void> {
    const record = await this.options.store.read(instruction.sessionId);
    if (
      !record?.resource ||
      record.session.state !== "opening" ||
      record.session.generation !== instruction.generation ||
      instruction.machine.appName !== this.options.appName ||
      instruction.machine.machineId !== record.resource.machineId
    ) return;
    const storedOrigin = await this.options.store.resolveCurrentOrigin(
      instruction.sessionId,
    );
    if (!sameBrowserIdentity(storedOrigin, origin)) return;
    try {
      verifyHostedBrowserOperationCapability({
        token: instruction.capability,
        publicKeyPem: createPublicKey(this.options.capabilityPrivateKeyPem)
          .export({ type: "spki", format: "pem" })
          .toString(),
        now: this.#now(),
        allowExpired: true,
        expected: {
          version: HOSTED_BROWSER_CAPABILITY_VERSION,
          organizationId: origin.organizationId,
          environmentId: origin.environmentId,
          projectId: origin.projectId,
          userId: origin.userId,
          threadId: origin.threadId,
          sessionId: record.session.sessionId,
          generation: record.session.generation,
          operationId: instruction.operationId,
          effectiveAllowlistRevision:
            record.session.effectiveAllowlistRevision,
        },
      });
    } catch {
      return;
    }
    await this.#terminate(
      record.session,
      record.resource,
      "failed",
      "BROWSER_DESTINATION_BLOCKED",
    );
  }

  async #cleanup(
    session: BrowserSessionV1,
    resource: HostedBrowserResourceRecord,
  ): Promise<void> {
    await this.#deleteMachine(resource.machineId);
    await this.options.store.confirmCleanup(session.sessionId, this.#now());
    this.options.metrics.emit("browser_worker_cleanup", {
      sessionId: session.sessionId,
      generation: session.generation,
    });
  }

  async #deleteMachine(machineId: string): Promise<void> {
    await this.options.machines.deleteMachine({
      appName: this.options.appName,
      machineId,
    });
    await this.options.machines.waitForMachine({
      appName: this.options.appName,
      machineId,
      state: "destroyed",
      timeoutSeconds: 30,
    });
    const remaining = await this.options.machines.getMachine({
      appName: this.options.appName,
      machineId,
    });
    if (remaining) throw this.#failure("BROWSER_ENGINE_FAILURE");
  }

  async #resolvePreparedOrigin(input: {
    runId: string;
    threadId: string;
    stableAuthority: PreparedToolCallV1["stableAuthority"];
    hostProjectId?: string | undefined;
  }): Promise<HostedBrowserOriginAuthority> {
    const stable = input.stableAuthority;
    if (
      !input.hostProjectId ||
      (stable !== undefined &&
        (stable.actor.actorType === "service" ||
          stable.threadId !== input.threadId ||
          stable.projectId !== input.hostProjectId ||
          stable.organizationId !==
            this.options.requestAuthority.organizationId ||
          stable.environmentId !== this.options.requestAuthority.environmentId ||
          stable.actor.actorId !== this.options.requestAuthority.userId))
    ) {
      throw this.#failure("BROWSER_SERVICE_UNAVAILABLE");
    }
    return this.options.store.resolveOrigin({
      runId: input.runId,
      threadId: input.threadId,
      expectedOrganizationId: this.options.requestAuthority.organizationId,
      expectedEnvironmentId: this.options.requestAuthority.environmentId,
      expectedProjectId: input.hostProjectId,
      expectedUserId: this.options.requestAuthority.userId,
    });
  }

  #issueCapability(input: {
    origin: HostedBrowserOriginAuthority;
    session: BrowserSessionV1;
    operationId: string;
  }): string {
    return issueHostedBrowserOperationCapability({
      privateKeyPem: this.options.capabilityPrivateKeyPem,
      now: this.#now(),
      claims: {
        version: HOSTED_BROWSER_CAPABILITY_VERSION,
        organizationId: input.origin.organizationId,
        environmentId: input.origin.environmentId,
        projectId: input.origin.projectId,
        userId: input.origin.userId,
        threadId: input.origin.threadId,
        sessionId: input.session.sessionId,
        generation: input.session.generation,
        operationId: input.operationId,
        effectiveAllowlistRevision:
          input.session.effectiveAllowlistRevision,
        expiresAt: new Date(
          this.#now().getTime() + OPERATION_CAPABILITY_MS,
        ).toISOString(),
      },
    });
  }

  #failure(code: Parameters<typeof browserFailure>[0]) {
    return browserFailure(code, code, { browserOutcomeKnown: true });
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function sameBrowserIdentity(
  left: HostedBrowserOriginAuthority,
  right: HostedBrowserOriginAuthority,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.threadId === right.threadId &&
    left.userId === right.userId
  );
}

type HostedBrowserScreenshotEnvelopeV1 = {
  version: "hosted_browser_worker_result_v1";
  output: Record<string, unknown>;
  screenshot: {
    mediaType: "image/png";
    byteLength: number;
    sha256: string;
    base64: string;
  };
};

function isHostedBrowserWorkerResultEnvelope(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).version ===
        "hosted_browser_worker_result_v1",
  );
}

function parseHostedBrowserScreenshotEnvelope(
  value: unknown,
): HostedBrowserScreenshotEnvelopeV1 {
  if (!isHostedBrowserWorkerResultEnvelope(value)) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  const output = value.output;
  const screenshot = value.screenshot;
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    !screenshot ||
    typeof screenshot !== "object" ||
    Array.isArray(screenshot)
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  const record = screenshot as Record<string, unknown>;
  if (
    record.mediaType !== "image/png" ||
    !Number.isSafeInteger(record.byteLength) ||
    Number(record.byteLength) < 1 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256) ||
    typeof record.base64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      record.base64,
    )
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return {
    version: "hosted_browser_worker_result_v1",
    output: output as Record<string, unknown>,
    screenshot: {
      mediaType: "image/png",
      byteLength: record.byteLength as number,
      sha256: record.sha256,
      base64: record.base64,
    },
  };
}

function readPreviewLeaseId(input: Record<string, unknown>): string | undefined {
  const target = input.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  const record = target as Record<string, unknown>;
  return record.kind === "kestrel_edge_preview" &&
    typeof record.previewId === "string" &&
    record.previewId.length > 0
    ? record.previewId
    : undefined;
}

function hostedBrowserSessionId(
  prepared: PreparedToolCallV1,
  origin: HostedBrowserOriginAuthority,
): string {
  const digest = createHash("sha256")
    .update("kestrel-hosted-browser-session-v1\0", "utf8")
    .update(origin.organizationId, "utf8")
    .update("\0", "utf8")
    .update(origin.environmentId, "utf8")
    .update("\0", "utf8")
    .update(origin.threadId, "utf8")
    .update("\0", "utf8")
    .update(origin.userId, "utf8")
    .update("\0", "utf8")
    .update(prepared.callId, "utf8")
    .digest("hex");
  return `browser-${digest}`;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  return value;
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

function requirePreparedDownloadEffect(
  prepared: PreparedToolCallV1,
): BrowserDownloadPreparedEffectV1 {
  const matches = prepared.inputAdapters.filter(
    (adapter) => adapter.adapterId === "kestrel.browser-download-effect:v1",
  );
  if (matches.length !== 1) throw new Error("BROWSER_SESSION_LOST");
  return parseBrowserDownloadPreparedEffectV1(matches[0]!.metadata);
}

function parseHostedBrowserDownloadEnvelope(value: unknown): {
  version: "hosted_browser_download_result_v1";
  download: BrowserDownloadPreparedEffectV1;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== "hosted_browser_download_result_v1") {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return {
    version: "hosted_browser_download_result_v1",
    download: parseBrowserDownloadPreparedEffectV1(record.download),
  };
}
