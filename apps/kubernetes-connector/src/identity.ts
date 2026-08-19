import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  generateConnectorCredentialEncryptionKeyPair,
  normalizeConnectorSigningPublicKey,
} from "@lumi/kestrel-environment-auth";
import { z } from "zod";
import type { ConnectorConfig } from "./config.js";
import { KubernetesApiError, KubernetesClient } from "./kubernetes-client.js";

const identitySchema = z
  .object({
    version: z.literal(1),
    identityId: z.string().uuid(),
    signingPublicKey: z.string().min(64),
    signingPrivateKey: z.string().min(64),
    encryptionPublicKey: z.string().min(64),
    encryptionPrivateKey: z.string().min(64),
    enrollmentRequestId: z.string().uuid().optional(),
    enrollmentRequestSecret: z.string().min(32).optional(),
    enrollmentExpiresAt: z.string().datetime().optional(),
    connectionId: z.string().uuid().optional(),
    organizationId: z.string().min(1).optional(),
    credential: z.string().min(32).optional(),
    credentialRotatedAt: z.string().datetime().optional(),
  })
  .strict();

export type ConnectorIdentity = z.infer<typeof identitySchema>;

type KubernetesSecret = {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string>;
};

type KubernetesLease = {
  metadata?: { resourceVersion?: string };
  spec?: {
    holderIdentity?: string;
    renewTime?: string;
    leaseDurationSeconds?: number;
  };
};

export class ConnectorIdentityStore {
  constructor(
    private readonly kubernetes: KubernetesClient,
    private readonly config: ConnectorConfig,
  ) {}

  async loadOrCreate(): Promise<ConnectorIdentity> {
    const raw = await this.readSecret();
    const existing = parseSecretIdentity(raw);
    if (existing) return existing;
    const signing = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const encryption = generateConnectorCredentialEncryptionKeyPair();
    const identity = identitySchema.parse({
      version: 1,
      identityId: randomUUID(),
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
    });
    try {
      if (raw?.metadata?.resourceVersion) {
        await this.kubernetes.replace(
          this.secretPath(),
          secretBody(this.config, identity, raw.metadata.resourceVersion),
        );
        return identity;
      }
      await this.kubernetes.create(this.secretsPath(), secretBody(this.config, identity));
      return identity;
    } catch (error) {
      if (!(error instanceof KubernetesApiError && error.status === 409)) throw error;
      const raced = await this.read();
      if (!raced) throw new Error("Connector identity creation raced without a stored identity.");
      return raced;
    }
  }

  async read(): Promise<ConnectorIdentity | null> {
    return parseSecretIdentity(await this.readSecret());
  }

  async update(identity: ConnectorIdentity): Promise<ConnectorIdentity> {
    const parsed = identitySchema.parse(identity);
    const current = await this.kubernetes.get(this.secretPath()) as KubernetesSecret;
    const resourceVersion = current.metadata?.resourceVersion;
    if (!resourceVersion) throw new Error("Connector identity Secret has no resourceVersion.");
    await this.kubernetes.replace(
      this.secretPath(),
      secretBody(this.config, parsed, resourceVersion),
    );
    return parsed;
  }

  async isEnrollmentLeader(now = new Date()): Promise<boolean> {
    const path = this.leasePath();
    const current = await this.kubernetes.get(path, {
      allowNotFound: true,
    }) as KubernetesLease | null;
    const duration = 30;
    const expired =
      !current?.spec?.renewTime ||
      new Date(current.spec.renewTime).getTime() +
          (current.spec.leaseDurationSeconds ?? duration) * 1000 <
        now.getTime();
    if (
      current &&
      current.spec?.holderIdentity !== this.config.replicaId &&
      !expired
    ) {
      return false;
    }
    const body = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: {
        name: this.config.leaderLeaseName,
        namespace: this.config.namespace,
        ...(current?.metadata?.resourceVersion
          ? { resourceVersion: current.metadata.resourceVersion }
          : {}),
      },
      spec: {
        holderIdentity: this.config.replicaId,
        leaseDurationSeconds: duration,
        acquireTime: now.toISOString(),
        renewTime: now.toISOString(),
      },
    };
    try {
      if (current) await this.kubernetes.replace(path, body);
      else await this.kubernetes.create(this.leasesPath(), body);
      return true;
    } catch (error) {
      if (error instanceof KubernetesApiError && error.status === 409) return false;
      throw error;
    }
  }

  fingerprint(identity: ConnectorIdentity) {
    return normalizeConnectorSigningPublicKey(identity.signingPublicKey).fingerprint;
  }

  private secretsPath() {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/secrets`;
  }

  private async readSecret() {
    return await this.kubernetes.get(this.secretPath(), {
      allowNotFound: true,
    }) as KubernetesSecret | null;
  }

  private secretPath() {
    return `${this.secretsPath()}/${encodeURIComponent(this.config.identitySecretName)}`;
  }

  private leasesPath() {
    return `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.config.namespace)}/leases`;
  }

  private leasePath() {
    return `${this.leasesPath()}/${encodeURIComponent(this.config.leaderLeaseName)}`;
  }
}

function parseSecretIdentity(value: KubernetesSecret | null) {
  if (!value) return null;
  const encoded = value.data?.identity;
  if (!encoded) return null;
  return identitySchema.parse(
    JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
  );
}

function secretBody(
  config: ConnectorConfig,
  identity: ConnectorIdentity,
  resourceVersion?: string,
) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: config.identitySecretName,
      namespace: config.namespace,
      labels: { "app.kubernetes.io/name": "kestrel-connector" },
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    type: "Opaque",
    data: {
      identity: Buffer.from(JSON.stringify(identity)).toString("base64"),
    },
  };
}
