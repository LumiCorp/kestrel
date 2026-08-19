import {
  createConnectorRequestNonce,
  decryptConnectorCredential,
  signConnectorRequest,
  type ConnectorCredentialEnvelope,
} from "@lumi/kestrel-environment-auth";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { z } from "zod";
import type { ConnectorConfig } from "./config.js";
import {
  COMMAND_VERSION,
  connectorCommandSchema,
  RESULT_VERSION,
  type ConnectorCommand,
  type QualificationReport,
} from "./contracts.js";
import type { ConnectorIdentity } from "./identity.js";

const enrollmentResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    requestSecret: z.string().min(32),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: z.string().datetime(),
    verificationPath: z.string().startsWith("/"),
  })
  .strict();

const enrollmentStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "rejected", "expired"]), expiresAt: z.string().datetime() }).strict(),
  z
    .object({
      status: z.literal("active"),
      connectionId: z.string().uuid(),
      organizationId: z.string().min(1),
      credentialEnvelope: z.custom<ConnectorCredentialEnvelope>(),
      ticketPublicKey: z.string(),
      commandVersion: z.literal(COMMAND_VERSION),
      resultVersion: z.literal(RESULT_VERSION),
    })
    .strict(),
]);

const claimSchema = z
  .object({
    command: connectorCommandSchema,
    claimToken: z.string().min(32),
    claimExpiresAt: z.string().datetime(),
    attempt: z.number().int().positive(),
    eventCursor: z.number().int().nonnegative(),
  })
  .strict()
  .nullable();

const presenceResponseSchema = z
  .object({
    status: z.literal("active"),
    negotiated: z
      .object({
        commandVersion: z.literal(COMMAND_VERSION),
        resultVersion: z.literal(RESULT_VERSION),
        connectorVersion: z.string(),
      })
      .strict(),
    credentialEnvelope: z.custom<ConnectorCredentialEnvelope>().optional(),
    rotatedAt: z.string().datetime().optional(),
  })
  .strict();

export type ConnectorClaim = NonNullable<z.infer<typeof claimSchema>>;

export class ControlPlaneClient {
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly config: ConnectorConfig) {
    this.dispatcher = config.outboundProxy
      ? new ProxyAgent(config.outboundProxy)
      : undefined;
  }

  async createEnrollment(identity: ConnectorIdentity) {
    const response = await this.request("POST", "/api/runtime/infrastructure-connectors/enrollments", {
      body: {
        connectorName: this.config.displayName,
        signingPublicKey: identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        connectorVersion: this.config.connectorVersion,
        commandVersions: [COMMAND_VERSION],
        resultVersions: [RESULT_VERSION],
        clusterMetadata: { identityId: identity.identityId },
      },
    });
    return enrollmentResponseSchema.parse(response);
  }

  async consumeEnrollment(identity: ConnectorIdentity) {
    if (!(identity.enrollmentRequestId && identity.enrollmentRequestSecret)) {
      throw new Error("Connector enrollment state is incomplete.");
    }
    const response = enrollmentStatusSchema.parse(
      await this.request(
        "GET",
        `/api/runtime/infrastructure-connectors/enrollments/${identity.enrollmentRequestId}`,
        { enrollmentSecret: identity.enrollmentRequestSecret },
      ),
    );
    if (response.status !== "active") return response;
    const decrypted = decryptConnectorCredential<{ credential: string }>({
      envelope: response.credentialEnvelope,
      recipientPrivateKey: identity.encryptionPrivateKey,
      requestId: identity.enrollmentRequestId,
    });
    return { ...response, credential: decrypted.credential };
  }

  async presence(identity: ActiveIdentity) {
    const response = presenceResponseSchema.parse(await this.signed(identity, "POST", this.runtimePath(identity, "/presence"), {
      connectionId: identity.connectionId,
      connectorVersion: this.config.connectorVersion,
      commandVersions: [COMMAND_VERSION],
      resultVersions: [RESULT_VERSION],
      replicaId: this.config.replicaId,
    }));
    if (!response.credentialEnvelope) return response;
    const decrypted = decryptConnectorCredential<{ credential: string }>({
      envelope: response.credentialEnvelope,
      recipientPrivateKey: identity.encryptionPrivateKey,
      requestId: identity.connectionId,
    });
    return { ...response, credential: decrypted.credential };
  }

  async claim(identity: ActiveIdentity, resumeCommandIds: string[] = []) {
    return claimSchema.parse(
      await this.signed(identity, "POST", this.runtimePath(identity, "/commands/claim"), {
        resumeCommandIds,
      }),
    );
  }

  async renewLease(identity: ActiveIdentity, claim: ConnectorClaim) {
    return this.signed(
      identity,
      "POST",
      this.runtimePath(identity, `/commands/${claim.command.id}/lease`),
      { claimToken: claim.claimToken, leaseSeconds: 90 },
    );
  }

  async event(identity: ActiveIdentity, claim: ConnectorClaim, event: unknown) {
    return this.signed(
      identity,
      "POST",
      this.runtimePath(identity, `/commands/${claim.command.id}/events`),
      { claimToken: claim.claimToken, event },
    );
  }

  async complete(input: {
    identity: ActiveIdentity;
    claim: ConnectorClaim;
    result: unknown;
    qualification?: QualificationReport | undefined;
  }) {
    return this.signed(
      input.identity,
      "POST",
      this.runtimePath(input.identity, `/commands/${input.claim.command.id}/complete`),
      {
        claimToken: input.claim.claimToken,
        result: input.result,
        ...(input.qualification ? { qualification: input.qualification } : {}),
      },
    );
  }

  async provePublicEndpoint(input: {
    identity: ActiveIdentity;
    runId: string;
    url: string;
    nonce: string;
  }) {
    return this.signed(
      input.identity,
      "POST",
      this.runtimePath(input.identity, "/qualification-probe"),
      { runId: input.runId, url: input.url, nonce: input.nonce },
    );
  }

  private runtimePath(identity: ActiveIdentity, suffix: string) {
    return `/api/runtime/infrastructure-connectors/${identity.connectionId}${suffix}`;
  }

  private signed(
    identity: ActiveIdentity,
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ) {
    return this.request(method, path, {
      body,
      identity,
    });
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: unknown;
      identity?: ActiveIdentity;
      enrollmentSecret?: string;
    },
  ) {
    const bodyText = options.body === undefined ? "" : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    };
    if (options.enrollmentSecret) {
      headers["x-kestrel-enrollment-secret"] = options.enrollmentSecret;
    }
    if (options.identity) {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = createConnectorRequestNonce();
      headers.authorization = `Bearer ${options.identity.credential}`;
      headers["x-kestrel-timestamp"] = String(timestamp);
      headers["x-kestrel-nonce"] = nonce;
      headers["x-kestrel-signature"] = signConnectorRequest({
        privateKey: options.identity.signingPrivateKey,
        method,
        path,
        timestamp,
        nonce,
        bodyText,
      });
    }
    const response = await fetch(new URL(path, this.config.kestrelBaseUrl), {
      method,
      headers,
      ...(bodyText ? { body: bodyText } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Kestrel connector request failed (${response.status}).`);
    }
    return value;
  }
}

export type ActiveIdentity = ConnectorIdentity & {
  connectionId: string;
  organizationId: string;
  credential: string;
};

export function isActiveIdentity(identity: ConnectorIdentity): identity is ActiveIdentity {
  return Boolean(identity.connectionId && identity.organizationId && identity.credential);
}

export function commandResumeId(command: ConnectorCommand) {
  return `${command.id}:${command.desiredRevision}`;
}
