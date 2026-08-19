import {
  COMMAND_VERSION,
  EVENT_VERSION,
  RESULT_VERSION,
  connectorResultSchema,
  type QualificationReport,
} from "./contracts.js";
import {
  type ActiveIdentity,
  type ConnectorClaim,
  ControlPlaneClient,
  isActiveIdentity,
} from "./control-plane-client.js";
import type { ConnectorConfig } from "./config.js";
import { ConnectorIdentityStore, type ConnectorIdentity } from "./identity.js";
import type { KubernetesClient } from "./kubernetes-client.js";
import { runQualification } from "./qualification.js";
import { executeLifecycleCommand } from "./lifecycle.js";
import { connectorLog } from "./redaction.js";

export class ConnectorRuntime {
  private stopped = false;
  private ready = false;
  private activeCommands = new Set<string>();

  constructor(
    private readonly config: ConnectorConfig,
    private readonly kubernetes: KubernetesClient,
    private readonly identityStore: ConnectorIdentityStore,
    private readonly controlPlane: ControlPlaneClient,
  ) {}

  isReady() {
    return this.ready;
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    let identity: ConnectorIdentity | null = null;
    while (!this.stopped) {
      try {
        if (!identity) {
          identity = await this.identityStore.loadOrCreate();
          this.ready = true;
          connectorLog("info", "connector.identity.ready", {
            fingerprint: this.identityStore.fingerprint(identity),
            replicaId: this.config.replicaId,
          });
        }
        identity = isActiveIdentity(identity)
          ? await this.runActive(identity)
          : await this.runEnrollment(identity);
        identity = (await this.identityStore.read()) ?? identity;
      } catch (error) {
        connectorLog("error", "connector.loop.failed", { error });
      }
      if (!this.stopped) await wait(5_000);
    }
  }

  private async runEnrollment(identity: ConnectorIdentity) {
    if (!(await this.identityStore.isEnrollmentLeader())) return identity;
    if (
      !identity.enrollmentRequestId ||
      !identity.enrollmentRequestSecret ||
      !identity.enrollmentExpiresAt ||
      new Date(identity.enrollmentExpiresAt) <= new Date()
    ) {
      const enrollment = await this.controlPlane.createEnrollment(identity);
      const updated = await this.identityStore.update({
        ...identity,
        enrollmentRequestId: enrollment.requestId,
        enrollmentRequestSecret: enrollment.requestSecret,
        enrollmentExpiresAt: enrollment.expiresAt,
      });
      connectorLog("info", "connector.enrollment.pending", {
        verificationPath: enrollment.verificationPath,
        fingerprint: enrollment.fingerprint,
      });
      return updated;
    }
    const status = await this.controlPlane.consumeEnrollment(identity);
    if (status.status !== "active") {
      connectorLog("info", "connector.enrollment.waiting", {
        requestId: identity.enrollmentRequestId,
        status: status.status,
      });
      return identity;
    }
    const updated = await this.identityStore.update({
      ...identity,
      connectionId: status.connectionId,
      organizationId: status.organizationId,
      credential: status.credential,
      credentialRotatedAt: new Date().toISOString(),
      enrollmentRequestSecret: undefined,
    });
    connectorLog("info", "connector.enrollment.active", {
      connectionId: status.connectionId,
    });
    return updated;
  }

  private async runActive(identity: ActiveIdentity): Promise<ActiveIdentity> {
    const presence = await this.controlPlane.presence(identity);
    let currentIdentity = "credential" in presence
      ? await this.identityStore.update({
          ...identity,
          credential: presence.credential,
          credentialRotatedAt: presence.rotatedAt ?? new Date().toISOString(),
        }) as ActiveIdentity
      : identity;
    const claim = await this.controlPlane.claim(currentIdentity, [
      ...this.activeCommands,
    ]);
    if (!claim) {
      await wait(5_000);
      return currentIdentity;
    }
    this.activeCommands.add(claim.command.id);
    try {
      currentIdentity = await this.executeClaim(currentIdentity, claim);
    } finally {
      this.activeCommands.delete(claim.command.id);
    }
    return currentIdentity;
  }

  private async executeClaim(identity: ActiveIdentity, claim: ConnectorClaim) {
    let activeIdentity = identity;
    const abort = new AbortController();
    const lease = setInterval(() => {
      void this.controlPlane.renewLease(activeIdentity, claim).catch((error) => {
        connectorLog("warn", "connector.command.lease_lost", {
          commandId: claim.command.id,
          error,
        });
        abort.abort(error);
      });
    }, 30_000);
    const presenceHeartbeat = setInterval(() => {
      void this.controlPlane.presence(activeIdentity).then(async (presence) => {
        if (!("credential" in presence)) return;
        activeIdentity = await this.identityStore.update({
          ...activeIdentity,
          credential: presence.credential,
          credentialRotatedAt: presence.rotatedAt ?? new Date().toISOString(),
        }) as ActiveIdentity;
      }).catch((error) => {
        connectorLog("warn", "connector.presence.failed", {
          commandId: claim.command.id,
          error,
        });
      });
    }, 30_000);
    let sequence = claim.eventCursor;
    let eventDeliveryAvailable = true;
    const event = async (state: string, message: string) => {
      if (!eventDeliveryAvailable) return;
      const nextSequence = sequence + 1;
      try {
        await this.controlPlane.event(activeIdentity, claim, {
          contract: EVENT_VERSION,
          commandId: claim.command.id,
          sequence: nextSequence,
          type: "progress",
          state,
          message,
        });
        sequence = nextSequence;
      } catch (error) {
        eventDeliveryAvailable = false;
        connectorLog("warn", "connector.command.event_delivery_failed", {
          commandId: claim.command.id,
          error,
        });
      }
    };
    let qualification: QualificationReport | undefined;
    let result: ReturnType<typeof connectorResultSchema.parse>;
    try {
      await event("running", `Executing ${claim.command.type}.`);
      if (claim.command.type === "qualify_connection") {
        qualification = await runQualification({
          commandPayload: claim.command.payload,
          connectionId: identity.connectionId,
          kubernetes: this.kubernetes,
          controlPlane: this.controlPlane,
          identity: activeIdentity,
          connectorNamespace: this.config.namespace,
          signal: abort.signal,
          onProgress: event,
        });
        const passed = qualification.checks.every((check) => check.status === "passed");
        result = connectorResultSchema.parse({
          contract: RESULT_VERSION,
          commandId: claim.command.id,
          connectionId: identity.connectionId,
          commandType: claim.command.type,
          status: passed ? "succeeded" : "failed",
          observedRevision: claim.command.desiredRevision,
          resources: [],
          evidence: [{ level: "isolated_provider", connectorCommandId: claim.command.id }],
          output: { state: passed ? "qualified" : "degraded" },
          ...(passed
            ? {}
            : {
                error: {
                  code: "PROVIDER_REJECTED",
                  message: "Kubernetes qualification did not pass every required check.",
                  retryable: false,
                },
              }),
        });
      } else {
        result = await executeLifecycleCommand({
          command: claim.command,
          kubernetes: this.kubernetes,
          identity: activeIdentity,
          connectorNamespace: this.config.namespace,
          signal: abort.signal,
          onProgress: event,
          provePublicEndpoint: ({ url, nonce }) =>
            this.controlPlane.provePublicEndpoint({
              identity: activeIdentity,
              runId: claim.command.id,
              url,
              nonce,
            }) as Promise<{ passed?: unknown }>,
        });
      }
    } catch (error) {
      result = connectorResultSchema.parse({
        contract: RESULT_VERSION,
        commandId: claim.command.id,
        connectionId: identity.connectionId,
        commandType: claim.command.type,
        status: "failed",
        observedRevision: claim.command.desiredRevision,
        resources: [],
        evidence: [{ level: "implementation", connectorCommandId: claim.command.id }],
        error: {
          code: "PROVIDER_REJECTED",
          message: safeError(error),
          retryable: true,
        },
      });
    }
    try {
      await this.completeWithRetry({
        identity: activeIdentity,
        claim,
        result,
        qualification,
      });
    } finally {
      clearInterval(lease);
      clearInterval(presenceHeartbeat);
    }
    return activeIdentity;
  }

  private async completeWithRetry(
    input: Parameters<ControlPlaneClient["complete"]>[0],
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.controlPlane.complete(input);
        return;
      } catch (error) {
        lastError = error;
        connectorLog("warn", "connector.command.completion_delivery_failed", {
          commandId: input.claim.command.id,
          attempt,
          error,
        });
        if (attempt < 3) await wait(attempt * 250);
      }
    }
    throw lastError;
  }
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Connector command failed.")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 500);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
