import "server-only";

import { createHash } from "node:crypto";
import {
  encryptConnectorCommandSecrets,
  serializeConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import {
  enqueueInfrastructureConnectorCommand,
  readInfrastructureConnectorCommand,
} from "../connector-store";
import {
  listEnvironmentProviderResources,
  tombstoneEnvironmentProviderResource,
  upsertEnvironmentProviderResource,
} from "../provider-persistence";
import {
  kubernetesConnectionConfigRevision,
  kubernetesConnectionConfigV1Schema,
} from "../kubernetes-connector-contracts";
import {
  INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
  parseKubernetesLifecyclePayload,
  type InfrastructureConnectorCommandV1,
  type InfrastructureConnectorResultV1,
  type KubernetesConnectorCommandType,
} from "./connector-contracts";
import {
  EnvironmentProviderErrorV2,
  type EnvironmentInfrastructureProviderV2,
  type EnvironmentProviderEvidence,
  type EnvironmentResourceRef,
} from "./contracts-v2";

type LifecycleCommandType = Exclude<KubernetesConnectorCommandType, "qualify_connection">;
type JsonRecord = Record<string, unknown>;

export type KubernetesConnectorProxyBinding = {
  operationId: string;
  organizationId: string;
  environmentId: string;
  connectionId: string;
  connectorEncryptionPublicKey: string;
  configuration: unknown;
  workspaceLimit: number;
  runtimeTemplate: string;
};

export type KubernetesConnectorProxyDependencies = {
  enqueue: typeof enqueueInfrastructureConnectorCommand;
  read: typeof readInfrastructureConnectorCommand;
  upsert: typeof upsertEnvironmentProviderResource;
  list: typeof listEnvironmentProviderResources;
  tombstone: typeof tombstoneEnvironmentProviderResource;
  sleep: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: KubernetesConnectorProxyDependencies = {
  enqueue: enqueueInfrastructureConnectorCommand,
  read: readInfrastructureConnectorCommand,
  upsert: upsertEnvironmentProviderResource,
  list: listEnvironmentProviderResources,
  tombstone: tombstoneEnvironmentProviderResource,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export class KubernetesConnectorInfrastructureProviderV2
  implements EnvironmentInfrastructureProviderV2
{
  readonly descriptor = {
    provider: "kubernetes" as const,
    label: "Kubernetes BYOC connector",
    capabilities: [
      "environment_scope",
      "public_gateway",
      "private_workspace_routing",
      "persistent_workspace_storage",
      "workspace_compute",
      "workspace_start_stop",
      "immutable_image_updates",
      "volume_snapshots",
      "regional_placement",
      "health_readiness",
      "resource_inventory",
    ],
    evidenceLevel: "implementation" as const,
    contractVersion: "environment-infrastructure-provider-v2" as const,
  };

  private readonly config;
  private readonly configRevision: string;

  constructor(
    private readonly binding: KubernetesConnectorProxyBinding,
    private readonly dependencies: KubernetesConnectorProxyDependencies = defaultDependencies,
  ) {
    this.config = kubernetesConnectionConfigV1Schema.parse(binding.configuration);
    this.configRevision = kubernetesConnectionConfigRevision(this.config);
    if (!this.config.runtimeTemplateAllowlist.includes(binding.runtimeTemplate)) {
      throw providerError(
        "PROVIDER_REJECTED",
        `Runtime template ${binding.runtimeTemplate} is not allowed by this connection.`,
        false,
        "connector.proxy.configuration",
      );
    }
  }

  async ensureEnvironmentScope(input: Parameters<EnvironmentInfrastructureProviderV2["ensureEnvironmentScope"]>[0]) {
    const result = await this.execute("ensure_environment_scope", input.identity, {
      workspaceLimit: this.binding.workspaceLimit,
      runtimeTemplate: this.binding.runtimeTemplate,
    });
    return {
      resource: requireResource(result, "environment_scope"),
      placement: requirePlacement(result),
      evidence: result.evidence,
    };
  }

  async ensureEnvironmentGateway(input: Parameters<EnvironmentInfrastructureProviderV2["ensureEnvironmentGateway"]>[0]) {
    const tokenHash = hashToken(input.serviceToken);
    const result = await this.execute("ensure_environment_gateway", input.identity, {
      scope: input.scope,
      placement: input.placement,
      runtimeImage: input.runtimeImage,
      ticketPublicKey: input.ticketPublicKey,
      controlPlaneUrl: input.controlPlaneUrl,
      serviceTokenHash: tokenHash,
    }, { serviceToken: input.serviceToken });
    const routerUrl = requireOutputString(result, "routerUrl");
    assertExactGatewayUrl(
      routerUrl,
      input.identity.environmentId,
      this.config.profile.baseDomain,
    );
    return {
      resource: requireResource(result, "gateway"),
      edgeRoute: requireResource(result, "edge_route"),
      state: requireOutputString(result, "state"),
      routerUrl,
      placement: requirePlacement(result),
      evidence: result.evidence,
    };
  }

  async ensureWorkspaceStorage(input: Parameters<EnvironmentInfrastructureProviderV2["ensureWorkspaceStorage"]>[0]) {
    const result = await this.execute("ensure_workspace_storage", input.identity, {
      scope: input.scope,
      placement: input.placement,
      sizeGb: 20,
    });
    return storageState(result);
  }

  async ensureWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["ensureWorkspaceCompute"]>[0]) {
    const { desired } = input;
    const { serviceToken, ...desiredWithoutSecret } = desired;
    const serviceTokenHash = serviceToken ? hashToken(serviceToken) : undefined;
    const result = await this.execute("ensure_workspace_compute", input.identity, {
      scope: input.scope,
      storage: input.storage,
      placement: input.placement,
      desired: { ...desiredWithoutSecret, serviceTokenHash },
    }, serviceToken ? { serviceToken } : undefined);
    return computeState(result);
  }

  async getWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["getWorkspaceCompute"]>[0]) {
    const result = await this.execute("get_workspace_compute", input.identity, {
      scope: input.scope,
      compute: input.compute,
    });
    return result.output?.state === "destroyed" ? null : computeState(result);
  }

  async startWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["startWorkspaceCompute"]>[0]) {
    await this.computeMutation("start_workspace_compute", input);
  }

  async stopWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["stopWorkspaceCompute"]>[0]) {
    await this.computeMutation("stop_workspace_compute", input);
  }

  async updateWorkspaceImage(input: Parameters<EnvironmentInfrastructureProviderV2["updateWorkspaceImage"]>[0]) {
    const result = await this.execute("update_workspace_image", input.identity, {
      scope: input.scope,
      compute: input.compute,
      runtimeImage: input.runtimeImage,
      environmentPatch: input.environmentPatch,
      stopConfig: input.stopConfig,
    });
    return computeState(result);
  }

  async createWorkspaceSnapshot(input: Parameters<EnvironmentInfrastructureProviderV2["createWorkspaceSnapshot"]>[0]) {
    const result = await this.execute("create_workspace_snapshot", input.identity, {
      scope: input.scope,
      storage: input.storage,
    });
    return {
      resource: requireResource(result, "snapshot"),
      state: requireOutputString(result, "state"),
      evidence: result.evidence,
    };
  }

  async isWorkspaceSnapshotUsable(input: Parameters<EnvironmentInfrastructureProviderV2["isWorkspaceSnapshotUsable"]>[0]) {
    const result = await this.execute("is_workspace_snapshot_usable", input.identity, {
      scope: input.scope,
      storage: input.storage,
      snapshot: input.snapshot,
    });
    return result.output?.usable === true;
  }

  async createReplacementWorkspaceStorage(input: Parameters<EnvironmentInfrastructureProviderV2["createReplacementWorkspaceStorage"]>[0]) {
    if (!input.snapshot) {
      throw providerError(
        "CAPABILITY_UNSUPPORTED",
        "Kubernetes replacement storage requires a ready VolumeSnapshot.",
        false,
        "connector.proxy.replacement",
      );
    }
    const result = await this.execute("create_replacement_workspace_storage", input.identity, {
      scope: input.scope,
      placement: input.placement,
      replacementId: input.replacementId,
      sourceStorage: input.sourceStorage,
      snapshot: input.snapshot,
    });
    return storageState(result);
  }

  async createReplacementWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["createReplacementWorkspaceCompute"]>[0]) {
    const { serviceToken, ...desiredWithoutSecret } = input.desired;
    const serviceTokenHash = serviceToken ? hashToken(serviceToken) : undefined;
    const result = await this.execute("create_replacement_workspace_compute", input.identity, {
      scope: input.scope,
      storage: input.storage,
      placement: input.placement,
      replacementId: input.replacementId,
      desired: { ...desiredWithoutSecret, serviceTokenHash },
    }, serviceToken ? { serviceToken } : undefined);
    return computeState(result);
  }

  async listEnvironmentResources(input: Parameters<EnvironmentInfrastructureProviderV2["listEnvironmentResources"]>[0]) {
    const result = await this.execute("list_environment_resources", input.identity, { scope: input.scope });
    return {
      resources: (result.output?.resourceObservations ?? []).map((item) => ({
        ref: item.resource,
        state: item.state ?? null,
        workspaceId: item.workspaceId ?? null,
        replacementId: item.replacementId ?? null,
        relatedResources: item.relatedResources ?? [],
      })),
      evidence: result.evidence,
    };
  }

  async deleteWorkspaceCompute(input: Parameters<EnvironmentInfrastructureProviderV2["deleteWorkspaceCompute"]>[0]) {
    await this.execute("delete_workspace_compute", input.identity, { scope: input.scope, compute: input.compute });
  }

  async deleteWorkspaceStorage(input: Parameters<EnvironmentInfrastructureProviderV2["deleteWorkspaceStorage"]>[0]) {
    await this.execute("delete_workspace_storage", input.identity, { scope: input.scope, storage: input.storage });
  }

  async deleteEnvironmentScope(input: Parameters<EnvironmentInfrastructureProviderV2["deleteEnvironmentScope"]>[0]) {
    await this.execute("delete_environment_scope", input.identity, { scope: input.scope });
  }

  async waitForWorkspaceState(input: Parameters<EnvironmentInfrastructureProviderV2["waitForWorkspaceState"]>[0]) {
    await this.execute("wait_for_workspace_state", input.identity, {
      scope: input.scope,
      compute: input.compute,
      state: input.state,
      timeoutSeconds: input.timeoutSeconds,
    });
  }

  async waitForWorkspaceHealth(input: Parameters<EnvironmentInfrastructureProviderV2["waitForWorkspaceHealth"]>[0]) {
    await this.execute("wait_for_workspace_health", input.identity, {
      scope: input.scope,
      compute: input.compute,
      checkName: input.checkName,
      timeoutSeconds: input.timeoutSeconds,
    });
  }

  private async computeMutation(
    type: "start_workspace_compute" | "stop_workspace_compute",
    input: Parameters<EnvironmentInfrastructureProviderV2["startWorkspaceCompute"]>[0],
  ) {
    await this.execute(type, input.identity, { scope: input.scope, compute: input.compute });
  }

  private async execute(
    type: LifecycleCommandType,
    identity: { organizationId: string; environmentId: string; workspaceId?: string },
    specificPayload: JsonRecord,
    secrets?: Record<string, string>,
  ): Promise<InfrastructureConnectorResultV1> {
    this.assertIdentity(identity);
    const payload = parseKubernetesLifecyclePayload(type, {
      configurationRevision: this.configRevision,
      profile: this.config.profile,
      ...withoutUndefined(specificPayload),
    });
    const desiredRevision = sha256(stableJson(payload));
    const replacementId = typeof specificPayload.replacementId === "string"
      ? specificPayload.replacementId
      : "primary";
    const logicalIdentity = [
      identity.environmentId,
      identity.workspaceId ?? "environment",
      replacementId,
      desiredRevision,
    ].join(":");
    const idempotencyKey = sha256(`${this.binding.operationId}:${type}:${logicalIdentity}`);
    const commandId = `k8s-${sha256(`command:${idempotencyKey}`).slice(0, 48)}`;
    const command: InfrastructureConnectorCommandV1 = {
      contract: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      id: commandId,
      idempotencyKey,
      connectionId: this.binding.connectionId,
      organizationId: identity.organizationId,
      environmentId: identity.environmentId,
      ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
      desiredRevision,
      type,
      payload,
      ...(secrets && Object.keys(secrets).length > 0
        ? {
            encryptedSecrets: serializeConnectorCommandSecrets(
              encryptConnectorCommandSecrets({
                value: secrets,
                recipientPublicKey: this.binding.connectorEncryptionPublicKey,
                commandId,
              }),
            ),
          }
        : {}),
    };
    await this.dependencies.enqueue({ operationId: this.binding.operationId, command });
    const result = await this.awaitResult(commandId);
    if (result.status === "failed") {
      throw providerError(
        result.error!.code,
        result.error!.message,
        result.error!.retryable,
        result.evidence[0]?.phase ?? type,
        result.evidence[0],
      );
    }
    await this.persistObservations(identity.workspaceId ?? null, desiredRevision, result);
    return result;
  }

  private async awaitResult(commandId: string) {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const row = await this.dependencies.read({
        organizationId: this.binding.organizationId,
        commandId,
      });
      if (!row) throw providerError("RESPONSE_INVALID", "Connector command disappeared after enqueue.", false, "connector.proxy.poll");
      if (row.result) return row.result;
      if (row.status === "cancelled") {
        throw providerError("PROVIDER_UNAVAILABLE", "Connector command was cancelled.", true, "connector.proxy.poll");
      }
      await this.dependencies.sleep(500);
    }
    throw providerError("OPERATION_TIMEOUT", "Connector command did not complete within five minutes.", true, "connector.proxy.poll");
  }

  private async persistObservations(
    workspaceId: string | null,
    desiredRevision: string,
    result: InfrastructureConnectorResultV1,
  ) {
    for (const observation of result.output?.resourceObservations ?? []) {
      if (observation.disposition === "deleted") {
        const persisted = await this.dependencies.list({
          organizationId: this.binding.organizationId,
          environmentId: this.binding.environmentId,
          ...(workspaceId ? { workspaceId } : {}),
        });
        const match = persisted.find((item) =>
          item.resourceRole === observation.resource.role &&
          item.externalId === observation.resource.externalId,
        );
        if (match) await this.dependencies.tombstone({
          organizationId: this.binding.organizationId,
          resourceId: match.id,
          state: observation.state ?? "deleted",
        });
        continue;
      }
      await this.dependencies.upsert({
        organizationId: this.binding.organizationId,
        environmentId: this.binding.environmentId,
        workspaceId: observation.workspaceId ?? workspaceId,
        replacementId: observation.replacementId ?? null,
        providerConnectionId: this.binding.connectionId,
        provider: "kubernetes",
        resourceRole: observation.resource.role,
        externalId: observation.resource.externalId,
        providerUid: observation.providerUid ?? null,
        desiredRevision,
        observedGeneration: observation.observedGeneration ?? observation.resource.observedGeneration ?? null,
        state: observation.state ?? result.output?.state ?? null,
        providerMetadata: {
          contract: "provider-resource-metadata-v1",
          source: "provider_observation",
          detail: `${observation.kind} ${observation.disposition}`,
        },
      });
    }
  }

  private assertIdentity(identity: { organizationId: string; environmentId: string }) {
    if (
      identity.organizationId !== this.binding.organizationId ||
      identity.environmentId !== this.binding.environmentId
    ) {
      throw providerError("RESOURCE_CONFLICT", "Lifecycle identity does not match the bound Kubernetes connection.", false, "connector.proxy.identity");
    }
  }
}

function requireResource(result: InfrastructureConnectorResultV1, role: EnvironmentResourceRef["role"]) {
  const resource = result.resources.find((item) => item.role === role);
  if (!resource) throw providerError("RESPONSE_INVALID", `Connector result omitted ${role}.`, false, "connector.proxy.result");
  return resource;
}

function requireOutputString(result: InfrastructureConnectorResultV1, key: "state" | "routerUrl") {
  const value = result.output?.[key];
  if (!value) throw providerError("RESPONSE_INVALID", `Connector result omitted ${key}.`, false, "connector.proxy.result");
  return value;
}

function requirePlacement(result: InfrastructureConnectorResultV1) {
  if (!result.output?.placement) throw providerError("RESPONSE_INVALID", "Connector result omitted placement.", false, "connector.proxy.result");
  return result.output.placement;
}

function storageState(result: InfrastructureConnectorResultV1) {
  if (!(result.output?.sizeGb && result.output.storageSecurity)) {
    throw providerError("RESPONSE_INVALID", "Connector storage result is incomplete.", false, "connector.proxy.result");
  }
  return {
    resource: requireResource(result, "workspace_storage"),
    sizeGb: result.output.sizeGb,
    placement: requirePlacement(result),
    security: result.output.storageSecurity,
    evidence: result.evidence,
  };
}

function computeState(result: InfrastructureConnectorResultV1) {
  return {
    resource: requireResource(result, "workspace_compute"),
    state: requireOutputString(result, "state"),
    placement: requirePlacement(result),
    image: result.output?.image ?? null,
    resolvedImageDigest: result.output?.resolvedImageDigest ?? null,
    cpuKind: result.output?.cpuKind ?? null,
    cpus: result.output?.cpus ?? null,
    memoryMb: result.output?.memoryMb ?? null,
    workspaceId: result.output?.workspaceId ?? null,
    standbyFor: [],
    storage: result.output?.resourceObservations?.flatMap((item) => item.relatedResources ?? []).filter((item) => item.role === "workspace_storage") ?? [],
    evidence: result.evidence,
  };
}

function providerError(
  code: ConstructorParameters<typeof EnvironmentProviderErrorV2>[0]["code"],
  message: string,
  retryable: boolean,
  phase: string,
  evidence?: EnvironmentProviderEvidence,
) {
  return new EnvironmentProviderErrorV2({
    code,
    message,
    retryable,
    evidence: evidence ?? { level: "implementation", phase },
  });
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function assertExactGatewayUrl(
  value: string,
  environmentId: string,
  baseDomain: string,
) {
  const expectedHost = `${sha256(environmentId).slice(0, 12)}.${baseDomain}`;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw providerError(
      "RESPONSE_INVALID",
      "Connector returned a Router URL outside the configured Environment hostname.",
      false,
      "connector.proxy.gateway-url",
    );
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutUndefined(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
