import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  decryptDesktopCredential,
  desktopCredentialEnvelopeContext,
  generateDesktopCredentialEncryptionKeyPair,
  getDesktopEnvironmentExecutionTarget,
  verifyEnvironmentExecutionTicket,
  type DesktopCredentialEnvelope,
} from "@lumi/kestrel-environment-auth";
import {
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  parseRunnerCommandV2,
  parseRunnerEventV2,
  type RunnerCommand,
  type RunnerEvent,
} from "@kestrel-agents/protocol";

import type { DesktopProjectRegistration } from "../desktopShell/contracts.js";
import {
  registerEmbeddedGatewayCredentialLease,
  type GatewayCredentialLease,
  type GatewayCredentialReference,
} from "../../cli/runtime/gateway-credential-broker.js";
import type { LocalCoreClient } from "./client.js";
import type { LocalCoreCredentialStore } from "./credentialStore.js";
import {
  LocalCoreDesktopEnvironmentConfigStore,
  type DesktopEnvironmentWorkspaceMapping,
  type LocalCoreDesktopEnvironment,
} from "./desktopEnvironmentConfig.js";

const COMMAND_POLL_MS = 2_000;
const PRESENCE_INTERVAL_MS = 30_000;
const ENROLLMENT_POLL_MS = 5_000;
const COMMAND_LEASE_RENEW_MS = 30_000;
const MAX_ACTIVE_RUNTIME_RELEASES_PER_CONNECTION = 4;

type EnrollmentSecret = {
  privateKey: string;
  encryptionPrivateKey: string;
  requestSecret: string;
};

type EnvironmentSecret = {
  privateKey: string;
  encryptionPrivateKey: string;
  connectorCredential: string;
};

type CommandTerminal = {
  status: "completed" | "failed" | "cancelled";
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
};

type JournalEvent = {
  sequence: number;
  event: Record<string, unknown>;
};

type CommandJournalEntry = {
  connectionId: string;
  commandId: string;
  started: boolean;
  events: JournalEvent[];
  nextSequence: number;
  terminal?: CommandTerminal | undefined;
};

type ConnectorJournal = {
  version: 1;
  commands: CommandJournalEntry[];
};

export type DesktopEnvironmentStatusProjection = {
  enrollments: Array<{
    requestId: string;
    desktopName: string;
    fingerprint: string;
    verificationUrl: string;
    expiresAt: string;
  }>;
  environments: Array<{
    connectionId: string;
    environmentId: string;
    organizationId: string;
    baseUrl: string;
    desktopName: string;
    status: "active" | "error";
    connectionStatus: "online" | "offline";
    capacity: number;
    activeRuns: number;
    models: Array<{
      provider: string;
      model: string;
      health: "ready" | "unavailable";
    }>;
    lastConnectedAt?: string | undefined;
    lastError?: string | undefined;
    workspaces: Array<{
      projectId: string;
      workspaceRef: string;
      label: string;
      available: boolean;
    }>;
  }>;
  globalCapacity: number;
  activeRuns: number;
  activity: Array<{
    commandId: string;
    connectionId: string;
    organizationId: string;
    organizationName: string;
    projectId?: string | undefined;
    projectName: string;
    threadId: string;
    threadTitle: string;
    requestingUserId: string;
    requestingUserName: string;
    workspaceRef: string;
    queueState: "claimed";
    runState: "starting" | "running";
    queuedAt: string;
  }>;
};

type ActiveDesktopCommand = {
  controller: AbortController;
  connectionId: string;
  organizationId: string;
  organizationName: string;
  projectId?: string | undefined;
  projectName: string;
  threadId: string;
  threadTitle: string;
  requestingUserId: string;
  requestingUserName: string;
  workspaceRef: string;
  runState: "starting" | "running";
  queuedAt: string;
};

export class LocalCoreDesktopEnvironmentManager {
  readonly #credentialStore: LocalCoreCredentialStore;
  readonly #configStore: LocalCoreDesktopEnvironmentConfigStore;
  readonly #journalStore: DesktopEnvironmentJournalStore;
  readonly #coreVersion: string;
  #client: LocalCoreClient | undefined;
  #projects: DesktopProjectRegistration[] = [];
  #capacity = 1;
  #roundRobinIndex = 0;
  #closed = false;
  #tickActive = false;
  #releaseTickActive = false;
  #presenceTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #enrollmentTimer: NodeJS.Timeout | undefined;
  #advertisedModels: Array<{
    provider: string;
    model: string;
    health: "ready" | "unavailable";
  }> = [];
  readonly #activeCommands = new Map<string, ActiveDesktopCommand>();
  readonly #activeReleases = new Map<
    string,
    { connectionId: string; controller: AbortController }
  >();

  constructor(input: {
    homePath: string;
    credentialStore: LocalCoreCredentialStore;
    coreVersion: string;
  }) {
    this.#credentialStore = input.credentialStore;
    this.#configStore = new LocalCoreDesktopEnvironmentConfigStore(
      input.homePath,
    );
    this.#journalStore = new DesktopEnvironmentJournalStore(input.homePath);
    this.#coreVersion = input.coreVersion;
  }

  async start(client: LocalCoreClient): Promise<void> {
    this.#client = client;
    await this.#refreshAdvertisedModels();
    const config = await this.#configStore.read();
    this.#capacity = config.environments[0]?.capacity ?? 1;
    await this.refreshEnrollments();
    await this.#synchronizeAll();
    await Promise.all([this.#pollCommands(), this.#pollRuntimeReleases()]);
    this.#presenceTimer = setInterval(() => {
      void this.#synchronizeAll();
    }, PRESENCE_INTERVAL_MS);
    this.#pollTimer = setInterval(() => {
      void this.#pollCommands();
      void this.#pollRuntimeReleases();
    }, COMMAND_POLL_MS);
    this.#enrollmentTimer = setInterval(() => {
      void this.refreshEnrollments();
    }, ENROLLMENT_POLL_MS);
    this.#presenceTimer.unref();
    this.#pollTimer.unref();
    this.#enrollmentTimer.unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#presenceTimer) clearInterval(this.#presenceTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#enrollmentTimer) clearInterval(this.#enrollmentTimer);
    for (const active of this.#activeCommands.values()) {
      active.controller.abort();
    }
    for (const active of this.#activeReleases.values()) {
      active.controller.abort();
    }
    await Promise.allSettled(
      [...this.#activeCommands.keys()].map(async (commandId) => {
        await this.#markLost(commandId);
      }),
    );
  }

  async snapshot(): Promise<DesktopEnvironmentStatusProjection> {
    const config = await this.#configStore.read();
    return {
      enrollments: config.enrollments.map((enrollment) => ({
        requestId: enrollment.requestId,
        desktopName: enrollment.desktopName,
        fingerprint: enrollment.fingerprint,
        verificationUrl: enrollment.verificationUrl,
        expiresAt: enrollment.expiresAt,
      })),
      environments: config.environments.map((environment) => ({
        connectionId: environment.connectionId,
        environmentId: environment.environmentId,
        organizationId: environment.organizationId,
        baseUrl: environment.baseUrl,
        desktopName: environment.desktopName,
        status: environment.status,
        connectionStatus: isRecentlyConnected(environment)
          ? "online"
          : "offline",
        capacity: this.#capacity,
        activeRuns: this.#activeRunCount(environment.connectionId),
        models: this.#advertisedModels.map((model) => ({ ...model })),
        ...(environment.lastConnectedAt
          ? { lastConnectedAt: environment.lastConnectedAt }
          : {}),
        ...(environment.lastError ? { lastError: environment.lastError } : {}),
        workspaces: environment.workspaces.map((workspace) => ({
          projectId: workspace.projectId,
          workspaceRef: workspace.workspaceRef,
          label: workspace.label,
          available: workspace.available,
        })),
      })),
      globalCapacity: this.#capacity,
      activeRuns: this.#activeCommands.size,
      activity: [...this.#activeCommands.entries()].map(
        ([commandId, active]) => ({
          commandId,
          connectionId: active.connectionId,
          organizationId: active.organizationId,
          organizationName: active.organizationName,
          ...(active.projectId ? { projectId: active.projectId } : {}),
          projectName: active.projectName,
          threadId: active.threadId,
          threadTitle: active.threadTitle,
          requestingUserId: active.requestingUserId,
          requestingUserName: active.requestingUserName,
          workspaceRef: active.workspaceRef,
          queueState: "claimed",
          runState: active.runState,
          queuedAt: active.queuedAt,
        }),
      ),
    };
  }

  async startEnrollment(input: {
    baseUrl: string;
    desktopName: string;
  }): Promise<DesktopEnvironmentStatusProjection> {
    if (!this.#credentialStore.available) {
      throw new Error(
        "Desktop Environment enrollment requires the Local Core credential store.",
      );
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const desktopName = requireText(input.desktopName, "desktopName");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const encryption = generateDesktopCredentialEncryptionKeyPair();
    const response = await fetchJson(
      new URL("/api/desktop/v1/enrollments", baseUrl),
      {
        method: "POST",
        body: JSON.stringify({
          desktopName,
          publicKey,
          encryptionPublicKey: encryption.publicKey,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const requestId = requireText(response.requestId, "requestId");
    const requestSecret = requireText(response.requestSecret, "requestSecret");
    const fingerprint = requireText(response.fingerprint, "fingerprint");
    const expiresAt = requireDateTime(response.expiresAt, "expiresAt");
    const verificationPath = requireText(
      response.verificationPath,
      "verificationPath",
    );
    if (!/^\/desktop\/enroll\/[0-9a-f-]{36}$/u.test(verificationPath)) {
      throw new Error("Kestrel One returned an invalid enrollment path.");
    }
    await this.#credentialStore.set(
      `kestrel_one.enrollment.${requestId}`,
      JSON.stringify({
        privateKey,
        encryptionPrivateKey: encryption.privateKey,
        requestSecret,
      } satisfies EnrollmentSecret),
    );
    await this.#configStore.update((current) => ({
      ...current,
      enrollments: [
        ...current.enrollments.filter(
          (enrollment) => enrollment.requestId !== requestId,
        ),
        {
          requestId,
          baseUrl,
          desktopName,
          fingerprint,
          verificationUrl: new URL(verificationPath, baseUrl).toString(),
          expiresAt,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    return this.snapshot();
  }

  async refreshEnrollments(): Promise<DesktopEnvironmentStatusProjection> {
    const config = await this.#configStore.read();
    for (const enrollment of config.enrollments) {
      try {
        const secret = await this.#readEnrollmentSecret(enrollment.requestId);
        const response = await fetchJson(
          new URL(
            `/api/desktop/v1/enrollments/${encodeURIComponent(enrollment.requestId)}`,
            enrollment.baseUrl,
          ),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestSecret: secret.requestSecret }),
          },
        );
        if (response.status !== "active") continue;
        const connectionId = requireText(response.connectionId, "connectionId");
        const environmentSecret: EnvironmentSecret = {
          privateKey: secret.privateKey,
          encryptionPrivateKey: secret.encryptionPrivateKey,
          connectorCredential: requireText(
            response.connectorCredential,
            "connectorCredential",
          ),
        };
        const ticketPublicKey = requireText(
          response.ticketPublicKey,
          "ticketPublicKey",
        );
        await this.#credentialStore.set(
          `kestrel_one.environment.${connectionId}`,
          JSON.stringify(environmentSecret),
        );
        await this.#credentialStore.delete(
          `kestrel_one.enrollment.${enrollment.requestId}`,
        );
        const now = new Date().toISOString();
        const workspaces = await this.#workspaceMappings({
          connectionId,
          privateKey: secret.privateKey,
        });
        await this.#configStore.update((current) => ({
          ...current,
          enrollments: current.enrollments.filter(
            (candidate) => candidate.requestId !== enrollment.requestId,
          ),
          environments: [
            ...current.environments.filter(
              (candidate) => candidate.connectionId !== connectionId,
            ),
            {
              connectionId,
              environmentId: requireText(
                response.environmentId,
                "environmentId",
              ),
              organizationId: requireText(
                response.organizationId,
                "organizationId",
              ),
              baseUrl: enrollment.baseUrl,
              desktopName: enrollment.desktopName,
              ticketPublicKey,
              status: "active",
              capacity: this.#capacity,
              workspaces,
              createdAt: now,
              updatedAt: now,
            },
          ],
        }));
      } catch {
        // Pending enrollment polling is best-effort. The status projection
        // retains the request and its verification URL for the user.
      }
    }
    return this.snapshot();
  }

  async setProjects(
    projects: DesktopProjectRegistration[],
  ): Promise<DesktopEnvironmentStatusProjection> {
    this.#projects = projects.map(normalizeProject);
    const config = await this.#configStore.read();
    for (const environment of config.environments) {
      const secret = await this.#readEnvironmentSecret(
        environment.connectionId,
      );
      const workspaces = await this.#workspaceMappings({
        connectionId: environment.connectionId,
        privateKey: secret.privateKey,
      });
      await this.#configStore.update((current) => ({
        ...current,
        environments: current.environments.map((candidate) =>
          candidate.connectionId === environment.connectionId
            ? {
                ...candidate,
                workspaces,
              }
            : candidate,
        ),
      }));
    }
    await this.#synchronizeAll();
    return this.snapshot();
  }

  async setCapacity(
    capacity: number,
  ): Promise<DesktopEnvironmentStatusProjection> {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
      throw new Error("Desktop remote-task capacity must be between 1 and 16.");
    }
    this.#capacity = capacity;
    await this.#configStore.update((current) => ({
      ...current,
      environments: current.environments.map((environment) => ({
        ...environment,
        capacity,
        updatedAt: new Date().toISOString(),
      })),
    }));
    await this.#synchronizeAll();
    return this.snapshot();
  }

  async disconnect(
    connectionId: string,
  ): Promise<DesktopEnvironmentStatusProjection> {
    const config = await this.#configStore.read();
    const environment = config.environments.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    if (!environment) return this.snapshot();
    await signedFetchJson({
      environment,
      secret: await this.#readEnvironmentSecret(connectionId),
      pathname: `/api/runtime/desktop-environments/${encodeURIComponent(connectionId)}/disconnect`,
      body: {},
      method: "POST",
    });
    await this.#credentialStore.delete(
      `kestrel_one.environment.${connectionId}`,
    );
    await this.#configStore.update((current) => ({
      ...current,
      environments: current.environments.filter(
        (candidate) => candidate.connectionId !== connectionId,
      ),
    }));
    return this.snapshot();
  }

  async #workspaceMappings(input: {
    connectionId: string;
    privateKey: string;
  }): Promise<DesktopEnvironmentWorkspaceMapping[]> {
    return this.#projects.map((project) => ({
      workspaceRef: createHmac("sha256", input.privateKey)
        .update(project.id!)
        .digest("base64url"),
      projectId: project.id!,
      label: project.label,
      path: project.path,
      available: true,
    }));
  }

  async #synchronizeAll(): Promise<void> {
    await this.#refreshAdvertisedModels();
    const config = await this.#configStore.read();
    await Promise.allSettled(
      config.environments.map(async (environment) => {
        const secret = await this.#readEnvironmentSecret(
          environment.connectionId,
        );
        const presence = await signedFetchJson({
          environment,
          secret,
          pathname: `/api/runtime/desktop-environments/${encodeURIComponent(environment.connectionId)}/presence`,
          method: "POST",
          body: {
            capacity: this.#capacity,
            activeRuns: this.#activeRunCount(environment.connectionId),
            desktopVersion: this.#coreVersion,
            runtimeVersion: this.#coreVersion,
            models: this.#advertisedModels,
          },
        });
        if (
          typeof presence?.connectorCredential === "string" &&
          presence.connectorCredential.length >= 32
        ) {
          secret.connectorCredential = presence.connectorCredential;
          await this.#credentialStore.set(
            `kestrel_one.environment.${environment.connectionId}`,
            JSON.stringify(secret),
          );
        }
        await signedFetchJson({
          environment,
          secret,
          pathname: `/api/runtime/desktop-environments/${encodeURIComponent(environment.connectionId)}/catalog`,
          method: "POST",
          body: {
            workspaces: environment.workspaces.map((workspace) => ({
              workspaceRef: workspace.workspaceRef,
              label: workspace.label,
              available: workspace.available,
            })),
          },
        });
        const now = new Date().toISOString();
        await this.#configStore.update((current) => ({
          ...current,
          environments: current.environments.map((candidate) =>
            candidate.connectionId === environment.connectionId
              ? {
                  ...candidate,
                  status: "active",
                  lastConnectedAt: now,
                  lastError: undefined,
                  updatedAt: now,
                }
              : candidate,
          ),
        }));
      }),
    );
  }

  async #refreshAdvertisedModels(): Promise<void> {
    if (!this.#client) return;
    try {
      const configuration = await this.#client.desktopExecutionConfig();
      this.#advertisedModels = [
        {
          provider: configuration.resolvedProfile.modelProvider,
          model: configuration.resolvedProfile.model,
          health: "ready",
        },
      ];
    } catch {
      this.#advertisedModels = [];
    }
  }

  async #pollRuntimeReleases(): Promise<void> {
    if (this.#closed || this.#releaseTickActive || !this.#client) return;
    this.#releaseTickActive = true;
    try {
      const config = await this.#configStore.read();
      for (const environment of config.environments) {
        const activeForConnection = [...this.#activeReleases.values()].filter(
          (active) => active.connectionId === environment.connectionId,
        ).length;
        const available =
          MAX_ACTIVE_RUNTIME_RELEASES_PER_CONNECTION - activeForConnection;
        if (available <= 0) continue;
        const secret = await this.#readEnvironmentSecret(
          environment.connectionId,
        );
        for (let claimedCount = 0; claimedCount < available; claimedCount += 1) {
          try {
            const claimed = await signedFetchJson({
              environment,
              secret,
              pathname: `/api/runtime/desktop-environments/${encodeURIComponent(environment.connectionId)}/runtime-releases/claim`,
              method: "POST",
              body: {},
              allowNoContent: true,
            });
            if (!claimed) break;
            const release = requireRecord(claimed.release, "release");
            const releaseId = requireText(release.id, "release.id");
            if (this.#activeReleases.has(releaseId)) continue;
            const controller = new AbortController();
            this.#activeReleases.set(releaseId, {
              connectionId: environment.connectionId,
              controller,
            });
            void this.#executeRuntimeRelease({
              environment,
              secret,
              claimed,
              controller,
            })
              .catch((error) =>
                this.#completeRuntimeReleaseFailure({
                  environment,
                  secret,
                  claimed,
                  error,
                }),
              )
              .catch((error) => this.#recordConnectionError(environment, error))
              .finally(() => this.#activeReleases.delete(releaseId));
          } catch (error) {
            await this.#recordConnectionError(environment, error);
            break;
          }
        }
      }
    } finally {
      this.#releaseTickActive = false;
    }
  }

  async #executeRuntimeRelease(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    claimed: Record<string, unknown>;
    controller: AbortController;
  }): Promise<void> {
    if (!this.#client) throw new Error("Local Core is unavailable.");
    const release = requireRecord(input.claimed.release, "release");
    const releaseId = requireText(release.id, "release.id");
    const claimToken = requireText(input.claimed.claimToken, "claimToken");
    const runtimeId = requireRuntimeId(release.runtimeId);
    if (runtimeId === "kestrel") {
      throw Object.assign(new Error("Kestrel bindings do not require native release."), {
        code: "RUNTIME_RELEASE_DELIVERY_FAILED",
      });
    }
    const command = parseRunnerCommandV2({
      version: "runner_command_v2",
      id: releaseId,
      type: "runtime.release",
      payload: {
        runtimeId,
        bindingId: requireText(release.bindingId, "release.bindingId"),
        participantId: requireText(release.participantId, "release.participantId"),
        threadId: requireText(release.threadId, "release.threadId"),
        environmentId: requireText(release.environmentId, "release.environmentId"),
      },
      metadata: {
        tenantId: input.environment.organizationId,
        actor: {
          actorId: requireText(release.actorUserId, "release.actorUserId"),
          actorType: "operator",
          tenantId: input.environment.organizationId,
          orgRole: "org_admin",
        },
        profile: {
          id: `runtime-release-${runtimeId}`,
          label: `Runtime release (${runtimeId})`,
          agent: "kestrel",
          sessionPrefix: "runtime-release",
          defaultInteractionMode: "build",
          runtimeId,
        },
      },
    });
    let acknowledgement: RunnerEvent | undefined;
    let runnerFailure: { code: string; message: string } | undefined;
    const leaseTimer = setInterval(() => {
      void signedFetchJson({
        environment: input.environment,
        secret: input.secret,
        pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/runtime-releases/${encodeURIComponent(releaseId)}/lease`,
        method: "POST",
        body: { claimToken },
      }).catch(() => input.controller.abort());
    }, COMMAND_LEASE_RENEW_MS);
    leaseTimer.unref();
    try {
      await this.#client.sendRunnerCommand(JSON.stringify(command), {
        signal: input.controller.signal,
        onLine: (line) => {
          const event = parseRunnerEventV2(JSON.parse(line) as unknown);
          if (event.type === "runtime.released" && event.commandId === releaseId) {
            acknowledgement = event;
          } else if (event.type === "runner.error" && event.commandId === releaseId) {
            runnerFailure = { code: event.payload.code, message: event.payload.message };
          }
        },
      });
      if (runnerFailure) {
        throw Object.assign(new Error(runnerFailure.message), {
          code: runnerFailure.code,
        });
      }
      if (!acknowledgement) {
        throw Object.assign(
          new Error("Local Core did not acknowledge the Runtime release."),
          { code: "RUNTIME_RELEASE_DELIVERY_FAILED" },
        );
      }
      await signedFetchJson({
        environment: input.environment,
        secret: input.secret,
        pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/runtime-releases/${encodeURIComponent(releaseId)}/complete`,
        method: "POST",
        body: {
          claimToken,
          outcome: { status: "released", event: acknowledgement },
        },
      });
    } finally {
      clearInterval(leaseTimer);
    }
  }

  async #completeRuntimeReleaseFailure(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    claimed: Record<string, unknown>;
    error: unknown;
  }): Promise<void> {
    if (isAbortError(input.error)) return;
    const release = requireRecord(input.claimed.release, "release");
    const releaseId = requireText(release.id, "release.id");
    await signedFetchJson({
      environment: input.environment,
      secret: input.secret,
      pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/runtime-releases/${encodeURIComponent(releaseId)}/complete`,
      method: "POST",
      body: {
        claimToken: requireText(input.claimed.claimToken, "claimToken"),
        outcome: {
          status: "failed",
          failureCode: runtimeReleaseFailureCode(input.error),
        },
      },
    });
  }

  async #pollCommands(): Promise<void> {
    if (
      this.#closed ||
      this.#tickActive ||
      !this.#client ||
      this.#activeCommands.size >= this.#capacity
    ) {
      return;
    }
    this.#tickActive = true;
    try {
      const config = await this.#configStore.read();
      if (config.environments.length === 0) return;
      const journal = await this.#journalStore.read();
      for (let offset = 0; offset < config.environments.length; offset += 1) {
        if (this.#activeCommands.size >= this.#capacity) break;
        const index =
          (this.#roundRobinIndex + offset) % config.environments.length;
        const environment = config.environments[index]!;
        const secret = await this.#readEnvironmentSecret(
          environment.connectionId,
        );
        const resumeCommandIds = journal.commands
          .filter(
            (entry) =>
              entry.connectionId === environment.connectionId &&
              !this.#activeCommands.has(entry.commandId),
          )
          .map((entry) => entry.commandId)
          .slice(0, 16);
        const activeCommandIds = [...this.#activeCommands.entries()]
          .filter(
            ([, active]) => active.connectionId === environment.connectionId,
          )
          .map(([commandId]) => commandId)
          .slice(0, 16);
        try {
          const claimed = await signedFetchJson({
            environment,
            secret,
            pathname: `/api/runtime/desktop-environments/${encodeURIComponent(environment.connectionId)}/commands/claim`,
            method: "POST",
            body: { resumeCommandIds, activeCommandIds },
            allowNoContent: true,
          });
          if (!claimed) continue;
          const command = requireRecord(claimed.command, "command");
          const commandId = requireText(command.id, "command.id");
          if (this.#activeCommands.has(commandId)) continue;
          const controller = new AbortController();
          const provenance = requireRecord(
            claimed.provenance,
            "command.provenance",
          );
          const projectId =
            typeof provenance.projectId === "string" &&
            provenance.projectId.trim().length > 0
              ? provenance.projectId
              : undefined;
          this.#activeCommands.set(commandId, {
            controller,
            connectionId: environment.connectionId,
            organizationId: requireText(
              provenance.organizationId,
              "command.provenance.organizationId",
            ),
            organizationName: requireText(
              provenance.organizationName,
              "command.provenance.organizationName",
            ),
            ...(projectId ? { projectId } : {}),
            projectName: requireText(
              provenance.projectName,
              "command.provenance.projectName",
            ),
            threadId: requireText(
              provenance.threadId,
              "command.provenance.threadId",
            ),
            threadTitle: requireText(
              provenance.threadTitle,
              "command.provenance.threadTitle",
            ),
            requestingUserId: requireText(
              provenance.requestingUserId,
              "command.provenance.requestingUserId",
            ),
            requestingUserName: requireText(
              provenance.requestingUserName,
              "command.provenance.requestingUserName",
            ),
            workspaceRef: requireText(
              provenance.workspaceRef,
              "command.provenance.workspaceRef",
            ),
            runState: "starting",
            queuedAt: requireText(
              provenance.queuedAt,
              "command.provenance.queuedAt",
            ),
          });
          void this.#executeClaim({
            environment,
            secret,
            claimed,
            controller,
          })
            .catch((error) => {
              return this.#recoverClaimFailure({
                environment,
                secret,
                claimed,
                error,
              });
            })
            .finally(() => {
              this.#activeCommands.delete(commandId);
            });
        } catch (error) {
          await this.#recordConnectionError(environment, error);
        }
      }
      this.#roundRobinIndex =
        (this.#roundRobinIndex + 1) % config.environments.length;
    } finally {
      this.#tickActive = false;
    }
  }

  async #executeClaim(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    claimed: Record<string, unknown>;
    controller: AbortController;
  }): Promise<void> {
    const commandRecord = requireRecord(input.claimed.command, "command");
    const commandId = requireText(commandRecord.id, "command.id");
    const claimToken = requireText(input.claimed.claimToken, "claimToken");
    const executionTicket = requireText(
      input.claimed.executionTicket,
      "executionTicket",
    );
    const existing = await this.#journalStore.get(commandId);
    if (existing) {
      await this.#flushJournalEntry({
        environment: input.environment,
        secret: input.secret,
        claimToken,
        entry: existing,
      });
      const current = await this.#journalStore.get(commandId);
      if (current?.terminal) {
        await this.#completeCommand({
          environment: input.environment,
          secret: input.secret,
          commandId,
          claimToken,
          terminal: current.terminal,
        });
        return;
      }
      if (current?.started) {
        await this.#finishLostCommand({
          environment: input.environment,
          secret: input.secret,
          commandId,
          claimToken,
        });
        return;
      }
    }
    if (input.claimed.cancelRequested === true) {
      await this.#completeCommand({
        environment: input.environment,
        secret: input.secret,
        commandId,
        claimToken,
        terminal: { status: "cancelled" },
      });
      return;
    }
    const prepared = this.#prepareRunnerCommand({
      environment: input.environment,
      secret: input.secret,
      commandRecord,
      executionTicket,
      authorizationRenewal: input.claimed.authorizationRenewal,
      modelGrant: input.claimed.modelGrant,
    });
    const command = prepared.command;
    await this.#journalStore.put({
      connectionId: input.environment.connectionId,
      commandId,
      started: true,
      events: [],
      nextSequence: 1,
    });
    const activeCommand = this.#activeCommands.get(commandId);
    if (activeCommand) activeCommand.runState = "running";
    let terminal: CommandTerminal | undefined;
    let cancellationSent = false;
    let eventChain = Promise.resolve();
    const leaseTimer = setInterval(() => {
      void signedFetchJson({
        environment: input.environment,
        secret: input.secret,
        pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/commands/${encodeURIComponent(commandId)}/lease`,
        method: "POST",
        body: { claimToken },
      })
        .then(async (response) => {
          if (
            prepared.modelCredentialReference &&
            response?.modelGrant !== undefined
          ) {
            this.#registerEmbeddedModelGrant({
              environment: input.environment,
              secret: input.secret,
              reference: prepared.modelCredentialReference,
              modelGrant: response.modelGrant,
            });
          }
          if (response?.cancelRequested === true && !cancellationSent) {
            cancellationSent = true;
            await this.#cancelLocalRun(command);
          }
        })
        .catch(() => {
          // The server lease may be renewed again after connectivity returns.
          // The local run remains authoritative and its journal is retained.
        });
    }, COMMAND_LEASE_RENEW_MS);
    leaseTimer.unref();
    try {
      await this.#client!.sendRunnerCommand(JSON.stringify(command), {
        signal: input.controller.signal,
        onLine: (line) => {
          eventChain = eventChain
            .then(async () => {
              const event = redactDesktopRunnerEventForUpload(
                parseRunnerEventV2(JSON.parse(line) as unknown),
                input.environment.workspaces,
              );
              terminal = terminalFromRunnerEvent(event) ?? terminal;
              const entry = await this.#journalStore.append(commandId, event);
              const result = await this.#flushJournalEntry({
                environment: input.environment,
                secret: input.secret,
                claimToken,
                entry,
              });
              if (result.cancelRequested && !cancellationSent) {
                cancellationSent = true;
                await this.#cancelLocalRun(command);
              }
            })
            .catch(() => {
              // The event is already persisted before an upload attempt. A later
              // resume claim will replay from the acknowledged server cursor.
            });
        },
      });
      await eventChain;
    } catch (error) {
      if (!input.controller.signal.aborted) {
        terminal = {
          status: "failed",
          failureCode: "DESKTOP_RUN_LOST",
          failureMessage: errorMessage(error),
        };
      }
    } finally {
      clearInterval(leaseTimer);
    }
    terminal ??= {
      status: "failed",
      failureCode: "DESKTOP_RUN_LOST",
      failureMessage:
        "Local Core lost the Desktop run before receiving a terminal event.",
    };
    await this.#journalStore.setTerminal(commandId, terminal);
    await this.#flushJournalEntry({
      environment: input.environment,
      secret: input.secret,
      claimToken,
      entry: (await this.#journalStore.get(commandId))!,
    });
    await this.#completeCommand({
      environment: input.environment,
      secret: input.secret,
      commandId,
      claimToken,
      terminal,
    });
  }

  async #recoverClaimFailure(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    claimed: Record<string, unknown>;
    error: unknown;
  }): Promise<void> {
    try {
      const command = requireRecord(input.claimed.command, "command");
      const commandId = requireText(command.id, "command.id");
      const claimToken = requireText(input.claimed.claimToken, "claimToken");
      const existing = await this.#journalStore.get(commandId);
      const terminal: CommandTerminal = existing?.terminal ?? {
        status: "failed",
        failureCode: existing?.started
          ? "DESKTOP_RUN_LOST"
          : "DESKTOP_COMMAND_INVALID",
        failureMessage: errorMessage(input.error),
      };
      if (existing) {
        if (!existing.terminal) {
          await this.#journalStore.setTerminal(commandId, terminal);
        }
        const current = await this.#journalStore.get(commandId);
        if (current) {
          await this.#flushJournalEntry({
            environment: input.environment,
            secret: input.secret,
            claimToken,
            entry: current,
          });
        }
      }
      await this.#completeCommand({
        environment: input.environment,
        secret: input.secret,
        commandId,
        claimToken,
        terminal,
      });
    } catch (recoveryError) {
      const original = errorMessage(input.error);
      const recovery = errorMessage(recoveryError);
      await this.#recordConnectionError(
        input.environment,
        new Error(
          `Desktop command failed before completion: ${original}. Recovery failed: ${recovery}`,
        ),
      ).catch(() => undefined);
    }
  }

  #prepareRunnerCommand(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    commandRecord: Record<string, unknown>;
    executionTicket: string;
    authorizationRenewal: unknown;
    modelGrant: unknown;
  }): {
    command: RunnerCommand;
    modelCredentialReference?: GatewayCredentialReference | undefined;
  } {
    const ticket = verifyEnvironmentExecutionTicket({
      token: input.executionTicket,
      publicKey: input.environment.ticketPublicKey,
    });
    const target = getDesktopEnvironmentExecutionTarget(ticket);
    if (
      !target ||
      target.connectionId !== input.environment.connectionId ||
      ticket.environmentId !== input.environment.environmentId ||
      ticket.organizationId !== input.environment.organizationId
    ) {
      throw new Error("Desktop execution ticket target does not match.");
    }
    const workspace = input.environment.workspaces.find(
      (candidate) =>
        candidate.workspaceRef === target.workspaceRef && candidate.available,
    );
    if (!workspace) {
      throw new Error("Desktop execution workspace is unavailable.");
    }
    const payload = requireRecord(
      input.commandRecord.payload,
      "command.payload",
    );
    const rawCommand =
      "command" in payload
        ? requireRecord(payload.command, "payload.command")
        : payload;
    const base = parseRunnerCommandV2(rawCommand);
    if (base.type !== "run.start") {
      throw new Error("Desktop Environment accepts only run.start commands.");
    }
    if (
      base.metadata?.actor?.actorId !== ticket.actorId ||
      base.metadata?.tenantId !== ticket.organizationId
    ) {
      throw new Error("Desktop execution actor does not match its ticket.");
    }
    if (
      base.payload.turn.runId !== undefined &&
      base.payload.turn.runId !== ticket.runId
    ) {
      throw new Error("Desktop execution run does not match its ticket.");
    }
    const profile =
      base.payload.profile &&
      typeof base.payload.profile === "object" &&
      !Array.isArray(base.payload.profile)
        ? (base.payload.profile as Record<string, unknown>)
        : undefined;
    const modelCredential =
      profile?.modelCredential &&
      typeof profile.modelCredential === "object" &&
      !Array.isArray(profile.modelCredential)
        ? (profile.modelCredential as Record<string, unknown>)
        : undefined;
    let embeddedModelLease:
      | {
          reference: GatewayCredentialReference;
          lease: GatewayCredentialLease;
        }
      | undefined;
    if (modelCredential) {
      if (modelCredential.runId !== ticket.runId) {
        throw new Error("Desktop model credential run does not match.");
      }
      const envelope = parseDesktopCredentialEnvelope(input.modelGrant);
      const lease = decryptDesktopCredential<GatewayCredentialLease>({
        envelope,
        recipientPrivateKey: input.secret.encryptionPrivateKey,
        context: desktopCredentialEnvelopeContext({
          organizationId: ticket.organizationId,
          environmentId: ticket.environmentId,
          connectionId: input.environment.connectionId,
          runId: ticket.runId,
        }),
      });
      assertDesktopModelLease(
        lease as unknown as Record<string, unknown>,
        modelCredential,
        ticket,
      );
      embeddedModelLease = {
        reference: parseGatewayCredentialReference(modelCredential),
        lease,
      };
    } else if (input.modelGrant !== undefined) {
      throw new Error(
        "Desktop received a model grant without a model credential reference.",
      );
    }
    const command = parseRunnerCommandV2({
      ...base,
      payload: {
        ...base.payload,
        ...(profile ? { profile } : {}),
        turn: {
          ...base.payload.turn,
          runId: ticket.runId,
          workspace: {
            workspaceId: workspace.projectId,
            workspaceRoot: workspace.path,
            label: workspace.label,
          },
          mcpAuthorization: {
            executionTicket: input.executionTicket,
            ...(input.authorizationRenewal !== undefined
              ? { renewal: input.authorizationRenewal }
              : {}),
          },
        },
      },
    });
    if (embeddedModelLease) {
      registerEmbeddedGatewayCredentialLease(embeddedModelLease);
    }
    return {
      command,
      ...(embeddedModelLease
        ? { modelCredentialReference: embeddedModelLease.reference }
        : {}),
    };
  }

  #registerEmbeddedModelGrant(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    reference: GatewayCredentialReference;
    modelGrant: unknown;
  }) {
    const envelope = parseDesktopCredentialEnvelope(input.modelGrant);
    const lease = decryptDesktopCredential<GatewayCredentialLease>({
      envelope,
      recipientPrivateKey: input.secret.encryptionPrivateKey,
      context: desktopCredentialEnvelopeContext({
        organizationId: input.reference.organizationId,
        environmentId: input.reference.environmentId,
        connectionId: input.environment.connectionId,
        runId: input.reference.runId,
      }),
    });
    registerEmbeddedGatewayCredentialLease({
      reference: input.reference,
      lease,
    });
  }

  async #flushJournalEntry(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    claimToken: string;
    entry: CommandJournalEntry;
  }): Promise<{ cancelRequested: boolean }> {
    if (input.entry.events.length === 0) {
      return { cancelRequested: false };
    }
    const response = await signedFetchJson({
      environment: input.environment,
      secret: input.secret,
      pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/commands/${encodeURIComponent(input.entry.commandId)}/events`,
      method: "POST",
      body: {
        claimToken: input.claimToken,
        events: input.entry.events,
      },
    });
    const acknowledgedSequence = requireInteger(
      response?.acknowledgedSequence,
      "acknowledgedSequence",
    );
    await this.#journalStore.acknowledge(
      input.entry.commandId,
      acknowledgedSequence,
    );
    return { cancelRequested: response?.cancelRequested === true };
  }

  async #completeCommand(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    commandId: string;
    claimToken: string;
    terminal: CommandTerminal;
  }): Promise<void> {
    await signedFetchJson({
      environment: input.environment,
      secret: input.secret,
      pathname: `/api/runtime/desktop-environments/${encodeURIComponent(input.environment.connectionId)}/commands/${encodeURIComponent(input.commandId)}/complete`,
      method: "POST",
      body: {
        claimToken: input.claimToken,
        ...input.terminal,
      },
    });
    await this.#journalStore.delete(input.commandId);
  }

  async #finishLostCommand(input: {
    environment: LocalCoreDesktopEnvironment;
    secret: EnvironmentSecret;
    commandId: string;
    claimToken: string;
  }): Promise<void> {
    const terminal: CommandTerminal = {
      status: "failed",
      failureCode: "DESKTOP_RUN_LOST",
      failureMessage:
        "Local Core restarted without a terminal event for this Desktop run.",
    };
    await this.#journalStore.setTerminal(input.commandId, terminal);
    await this.#completeCommand({ ...input, terminal });
  }

  async #markLost(commandId: string): Promise<void> {
    const entry = await this.#journalStore.get(commandId);
    if (!entry || entry.terminal) return;
    await this.#journalStore.setTerminal(commandId, {
      status: "failed",
      failureCode: "DESKTOP_RUN_LOST",
      failureMessage: "Local Core stopped before the Desktop run completed.",
    });
  }

  async #cancelLocalRun(command: RunnerCommand): Promise<void> {
    if (command.type !== "run.start") return;
    const cancellation = parseRunnerCommandV2({
      id: randomUUID(),
      type: "run.cancel",
      payload: {
        sessionId: command.payload.turn.sessionId,
        ...(command.payload.turn.runId
          ? { runId: command.payload.turn.runId }
          : {}),
        commandId: command.id,
      },
      metadata: command.metadata,
    });
    await this.#client!.sendRunnerCommand(JSON.stringify(cancellation), {
      onLine() {},
    });
  }

  async #readEnrollmentSecret(requestId: string): Promise<EnrollmentSecret> {
    const value = await this.#credentialStore.get(
      `kestrel_one.enrollment.${requestId}`,
    );
    const record = requireRecord(
      JSON.parse(value ?? "null"),
      "enrollment secret",
    );
    return {
      privateKey: requireText(record.privateKey, "privateKey"),
      encryptionPrivateKey: requireText(
        record.encryptionPrivateKey,
        "encryptionPrivateKey",
      ),
      requestSecret: requireText(record.requestSecret, "requestSecret"),
    };
  }

  async #readEnvironmentSecret(
    connectionId: string,
  ): Promise<EnvironmentSecret> {
    const value = await this.#credentialStore.get(
      `kestrel_one.environment.${connectionId}`,
    );
    const record = requireRecord(
      JSON.parse(value ?? "null"),
      "environment secret",
    );
    return {
      privateKey: requireText(record.privateKey, "privateKey"),
      encryptionPrivateKey: requireText(
        record.encryptionPrivateKey,
        "encryptionPrivateKey",
      ),
      connectorCredential: requireText(
        record.connectorCredential,
        "connectorCredential",
      ),
    };
  }

  #activeRunCount(connectionId: string): number {
    return [...this.#activeCommands.values()].filter(
      (active) => active.connectionId === connectionId,
    ).length;
  }

  async #recordConnectionError(
    environment: LocalCoreDesktopEnvironment,
    error: unknown,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#configStore.update((current) => ({
      ...current,
      environments: current.environments.map((candidate) =>
        candidate.connectionId === environment.connectionId
          ? {
              ...candidate,
              status: "error",
              lastError: errorMessage(error),
              updatedAt: now,
            }
          : candidate,
      ),
    }));
  }
}

export function redactDesktopRunnerEventForUpload(
  event: RunnerEvent,
  workspaces: readonly DesktopEnvironmentWorkspaceMapping[],
): RunnerEvent {
  const roots = [
    ...new Set(
      workspaces.flatMap((workspace) => {
        const raw = workspace.path.trim();
        return raw ? [raw, path.resolve(raw)] : [];
      }),
    ),
  ].sort((left, right) => right.length - left.length);
  if (roots.length === 0) return event;
  return redactValue(event, roots) as RunnerEvent;
}

function redactValue(value: unknown, roots: readonly string[]): unknown {
  if (typeof value === "string") {
    return roots.reduce(
      (current, root) => current.split(root).join("[desktop-workspace]"),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, roots));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, roots),
      ]),
    );
  }
  return value;
}

class DesktopEnvironmentJournalStore {
  readonly #filePath: string;
  #journal: ConnectorJournal = { version: 1, commands: [] };
  #loaded = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(homePath: string) {
    this.#filePath = path.join(
      homePath,
      "settings",
      "desktop-environment-command-journal-v1.json",
    );
  }

  async read(): Promise<ConnectorJournal> {
    return this.#withLock(async () => structuredClone(this.#journal));
  }

  async get(commandId: string): Promise<CommandJournalEntry | undefined> {
    return this.#withLock(async () =>
      structuredClone(
        this.#journal.commands.find((entry) => entry.commandId === commandId),
      ),
    );
  }

  async put(entry: CommandJournalEntry): Promise<void> {
    await this.#withLock(async () => {
      this.#journal.commands = [
        ...this.#journal.commands.filter(
          (candidate) => candidate.commandId !== entry.commandId,
        ),
        structuredClone(entry),
      ];
      await this.#persist();
    });
  }

  async append(
    commandId: string,
    event: RunnerEvent,
  ): Promise<CommandJournalEntry> {
    return this.#withLock(async () => {
      const entry = this.#journal.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (!entry) throw new Error("Desktop command journal is unavailable.");
      entry.events.push({
        sequence: entry.nextSequence,
        event: event as unknown as Record<string, unknown>,
      });
      entry.nextSequence += 1;
      await this.#persist();
      return structuredClone(entry);
    });
  }

  async acknowledge(commandId: string, sequence: number): Promise<void> {
    await this.#withLock(async () => {
      const entry = this.#journal.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (!entry) return;
      entry.events = entry.events.filter((event) => event.sequence > sequence);
      await this.#persist();
    });
  }

  async setTerminal(
    commandId: string,
    terminal: CommandTerminal,
  ): Promise<void> {
    await this.#withLock(async () => {
      const entry = this.#journal.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (!entry) return;
      entry.terminal = terminal;
      await this.#persist();
    });
  }

  async delete(commandId: string): Promise<void> {
    await this.#withLock(async () => {
      this.#journal.commands = this.#journal.commands.filter(
        (entry) => entry.commandId !== commandId,
      );
      await this.#persist();
    });
  }

  async #withLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      await this.#load();
      return action();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const value = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as unknown;
      this.#journal = parseJournal(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#journal, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
  }
}

async function signedFetchJson(input: {
  environment: LocalCoreDesktopEnvironment;
  secret: EnvironmentSecret;
  pathname: string;
  method: "POST";
  body: Record<string, unknown>;
  allowNoContent?: boolean | undefined;
}): Promise<Record<string, unknown> | undefined> {
  const bodyText = JSON.stringify(input.body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString("base64url");
  const digest = createHash("sha256").update(bodyText).digest("hex");
  const signingInput = [
    input.method,
    input.pathname,
    timestamp,
    nonce,
    digest,
  ].join("\n");
  const signature = sign(
    null,
    Buffer.from(signingInput),
    input.secret.privateKey,
  ).toString("base64url");
  const response = await fetch(
    new URL(input.pathname, input.environment.baseUrl),
    {
      method: input.method,
      body: bodyText,
      headers: {
        authorization: `Bearer ${input.secret.connectorCredential}`,
        "content-type": "application/json",
        "x-kestrel-timestamp": timestamp,
        "x-kestrel-nonce": nonce,
        "x-kestrel-signature": signature,
      },
    },
  );
  if (response.status === 204 && input.allowNoContent) return undefined;
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Desktop Environment request failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  return requireRecord(JSON.parse(raw) as unknown, "connector response");
}

async function fetchJson(
  url: URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Kestrel One request failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  return requireRecord(JSON.parse(raw) as unknown, "Kestrel One response");
}

function terminalFromRunnerEvent(
  event: RunnerEvent,
): CommandTerminal | undefined {
  if (!isRunnerRunStreamEvent(event) || !isRunnerRunTerminalEvent(event)) {
    return undefined;
  }
  if (event.type === "run.completed") return { status: "completed" };
  if (event.type === "run.cancelled") return { status: "cancelled" };
  return {
    status: "failed",
    failureCode: "DESKTOP_RUN_FAILED",
    failureMessage: "The Desktop runner reported a failed terminal event.",
  };
}

function normalizeProject(
  project: DesktopProjectRegistration,
): DesktopProjectRegistration {
  return {
    id: project.id ?? randomUUID(),
    path: requireText(project.path, "project.path"),
    label: requireText(project.label, "project.label"),
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Kestrel One enrollment requires an HTTPS origin or development loopback origin.",
    );
  }
  return url.origin;
}

function isRecentlyConnected(
  environment: LocalCoreDesktopEnvironment,
): boolean {
  return Boolean(
    environment.lastConnectedAt &&
    Date.now() - Date.parse(environment.lastConnectedAt) <= 90_000,
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireRuntimeId(value: unknown): "kestrel" | "codex" | "claude" {
  if (value !== "kestrel" && value !== "codex" && value !== "claude") {
    throw new Error("release.runtimeId is invalid.");
  }
  return value;
}

function runtimeReleaseFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,80}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "RUNTIME_RELEASE_DELIVERY_FAILED";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer.`);
  return value as number;
}

function requireDateTime(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDesktopCredentialEnvelope(
  value: unknown,
): DesktopCredentialEnvelope {
  const envelope = requireRecord(value, "Desktop model grant");
  if (envelope.version !== 1) {
    throw new Error("Desktop model grant version is invalid.");
  }
  const ephemeralPublicKey = requireText(
    envelope.ephemeralPublicKey,
    "modelGrant.ephemeralPublicKey",
  );
  const iv = requireBase64Url(envelope.iv, "modelGrant.iv", 12);
  const ciphertext = requireBase64Url(
    envelope.ciphertext,
    "modelGrant.ciphertext",
  );
  const authTag = requireBase64Url(envelope.authTag, "modelGrant.authTag", 16);
  return {
    version: 1,
    ephemeralPublicKey,
    iv,
    ciphertext,
    authTag,
  };
}

function assertDesktopModelLease(
  lease: Record<string, unknown>,
  reference: Record<string, unknown>,
  ticket: {
    organizationId: string;
    environmentId: string;
    runId: string;
  },
) {
  if (
    lease.version !== "gateway-credential-lease-v3" ||
    lease.organizationId !== ticket.organizationId ||
    lease.environmentId !== ticket.environmentId ||
    lease.gatewayId !== reference.gatewayId ||
    lease.rawModelId !== reference.rawModelId ||
    !leaseProviderMatchesReference(lease.provider, reference.provider)
  ) {
    throw new Error("Desktop model grant does not match its execution.");
  }
  const expiresAt = Date.parse(requireText(lease.expiresAt, "lease.expiresAt"));
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 6 * 60_000
  ) {
    throw new Error("Desktop model grant expiry is invalid.");
  }
}

function parseGatewayCredentialReference(
  value: Record<string, unknown>,
): GatewayCredentialReference {
  const provider = value.provider;
  if (
    provider !== "openai" &&
    provider !== "openrouter" &&
    provider !== "anthropic" &&
    provider !== "ollama"
  ) {
    throw new Error("Desktop model credential provider is invalid.");
  }
  return {
    source: "kestrel-one",
    runId: requireText(value.runId, "modelCredential.runId"),
    gatewayId: requireText(value.gatewayId, "modelCredential.gatewayId"),
    organizationId: requireText(
      value.organizationId,
      "modelCredential.organizationId",
    ),
    environmentId: requireText(
      value.environmentId,
      "modelCredential.environmentId",
    ),
    rawModelId: requireText(value.rawModelId, "modelCredential.rawModelId"),
    provider,
  };
}

function leaseProviderMatchesReference(
  leaseProvider: unknown,
  referenceProvider: unknown,
) {
  return (
    leaseProvider === referenceProvider ||
    (referenceProvider === "openai" &&
      (leaseProvider === "lumi" || leaseProvider === "runpod"))
  );
}

function requireBase64Url(
  value: unknown,
  field: string,
  expectedBytes?: number,
) {
  const text = requireText(value, field);
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) {
    throw new Error(`${field} must be base64url.`);
  }
  const decoded = Buffer.from(text, "base64url");
  if (
    decoded.length === 0 ||
    (expectedBytes && decoded.length !== expectedBytes)
  ) {
    throw new Error(`${field} has an invalid length.`);
  }
  return text;
}

function parseJournal(value: unknown): ConnectorJournal {
  const record = requireRecord(value, "Desktop command journal");
  if (record.version !== 1 || !Array.isArray(record.commands)) {
    throw new Error("Desktop command journal is invalid.");
  }
  return {
    version: 1,
    commands: record.commands.map((candidate) => {
      const entry = requireRecord(candidate, "Desktop command journal entry");
      if (!Array.isArray(entry.events) || typeof entry.started !== "boolean") {
        throw new Error("Desktop command journal entry is invalid.");
      }
      const terminal =
        entry.terminal === undefined
          ? undefined
          : parseCommandTerminal(entry.terminal);
      return {
        connectionId: requireText(entry.connectionId, "connectionId"),
        commandId: requireText(entry.commandId, "commandId"),
        started: entry.started,
        nextSequence: requireInteger(entry.nextSequence, "nextSequence"),
        events: entry.events.map((item) => {
          const event = requireRecord(item, "Desktop command event");
          return {
            sequence: requireInteger(event.sequence, "sequence"),
            event: requireRecord(event.event, "event"),
          };
        }),
        ...(terminal ? { terminal } : {}),
      };
    }),
  };
}

function parseCommandTerminal(value: unknown): CommandTerminal {
  const terminal = requireRecord(value, "Desktop command terminal");
  if (
    terminal.status !== "completed" &&
    terminal.status !== "failed" &&
    terminal.status !== "cancelled"
  ) {
    throw new Error("Desktop command terminal status is invalid.");
  }
  return {
    status: terminal.status,
    ...(terminal.failureCode === undefined
      ? {}
      : {
          failureCode: requireText(
            terminal.failureCode,
            "terminal.failureCode",
          ),
        }),
    ...(terminal.failureMessage === undefined
      ? {}
      : {
          failureMessage: requireText(
            terminal.failureMessage,
            "terminal.failureMessage",
          ),
        }),
  };
}
