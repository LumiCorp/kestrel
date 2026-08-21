import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  KUBERNETES_BYOC_PROOF_VERSION,
  kubernetesProofScenarioSchema,
  parseKubernetesByocProof,
  redactKubernetesProofIdentifier,
  requiredKubernetesProofScenarioIds,
  type KubernetesProofEvidenceClass,
  type KubernetesProofProfile,
} from "@/lib/environments/kubernetes-proof";

const execFileAsync = promisify(execFile);
const TERMINAL_OPERATION_STATES = new Set(["completed", "failed", "cancelled"]);

type JsonObject = Record<string, unknown>;
type ScenarioStatus = "passed" | "failed" | "blocked" | "not_run";

type Scenario = {
  id: string;
  status: ScenarioStatus;
  evidenceClass: KubernetesProofEvidenceClass;
  startedAt: string;
  completedAt: string;
  operationIds: string[];
  commandIds: string[];
  requestIds: string[];
  auditIds: string[];
  resources: Array<{
    kind: string;
    name: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    conditions: Array<Record<string, unknown>>;
  }>;
  assertions: Array<{ name: string; passed: boolean; detail: string }>;
};

type CleanupInventory = {
  deletedKestrelResources: string[];
  retainedCustomerResources: string[];
  residualKestrelResources: string[];
  unknownResources: string[];
};

type ClientResponse<T> = { value: T; requestId: string };

class AdminCanaryClient {
  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string,
  ) {}

  async request<T>(pathname: string, init: RequestInit = {}): Promise<ClientResponse<T>> {
    const requestId = randomUUID();
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    headers.set("accept", "application/json");
    headers.set("x-kestrel-canary-request-id", requestId);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(new URL(pathname, this.baseUrl), { ...init, headers });
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(`${init.method ?? "GET"} ${pathname} returned malformed JSON.`);
      }
    }
    if (!response.ok) {
      const message = value && typeof value === "object" && typeof (value as JsonObject).error === "string"
        ? String((value as JsonObject).error)
        : text || `HTTP ${response.status}`;
      throw new Error(`${init.method ?? "GET"} ${pathname} failed: ${response.status} ${message}`);
    }
    return { value: value as T, requestId };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new AdminCanaryClient(
    required("KESTREL_ONE_CANARY_URL"),
    required("KESTREL_ONE_CANARY_COOKIE"),
  );
  const profile = args.profile;
  const imageDigest = required("KESTREL_KUBERNETES_CANARY_IMAGE_DIGEST");
  const chartDigest = required("KESTREL_KUBERNETES_CANARY_CHART_DIGEST");
  const imageSignature = required("KESTREL_KUBERNETES_CANARY_IMAGE_SIGNATURE");
  const imageProvenance = required("KESTREL_KUBERNETES_CANARY_IMAGE_PROVENANCE");
  const chartSignature = required("KESTREL_KUBERNETES_CANARY_CHART_SIGNATURE");
  const chartProvenance = required("KESTREL_KUBERNETES_CANARY_CHART_PROVENANCE");
  const now = new Date();
  const proofId = randomUUID();
  const organizationId = required("KESTREL_KUBERNETES_CANARY_ORGANIZATION_ID");
  let qualificationExpiresAt = process.env.KESTREL_KUBERNETES_QUALIFICATION_EXPIRES_AT?.trim() ||
    new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const requestIds: string[] = [];
  const scenarios = new Map<string, Scenario>();
  const identity = {
    environmentId: String(randomUUID()),
    threadId: randomUUID(),
    workspaceId: "",
    environmentName: `BYOC canary ${args.tag}`,
  };
  let environmentCreated = false;
  let threadCreated = false;
  let workspaceCreated = false;
  let cleanupSucceeded = false;
  let cleanupDetail = "Canary cleanup did not run.";
  let cleanupInventory: CleanupInventory = emptyCleanupInventory();

  const record = (id: string, input: {
    status: ScenarioStatus;
    detail: string;
    passed?: boolean;
    operationIds?: string[];
    commandIds?: string[];
    requestIds?: string[];
    resources?: Scenario["resources"];
  }) => {
    const startedAt = now.toISOString();
    scenarios.set(id, {
      id,
      status: input.status,
      evidenceClass: "isolated_provider",
      startedAt,
      completedAt: new Date().toISOString(),
      operationIds: (input.operationIds ?? []).slice(0, 100),
      commandIds: (input.commandIds ?? []).slice(0, 100),
      requestIds: (input.requestIds ?? []).slice(-100),
      auditIds: [],
      resources: input.resources ?? [],
      assertions: [{
        name: "canary",
        passed: input.passed ?? input.status === "passed",
        detail: input.detail,
      }],
    });
  };

  try {
    const connections = await client.request<{ connections?: JsonObject[] }>(
      "/api/organization/infrastructure/kubernetes/connections",
    );
    requestIds.push(connections.requestId);
    const connection = connections.value.connections?.find((item) => item.id === args.connection);
    if (!connection) throw new Error(`Kubernetes connection ${args.connection} was not found for this organization.`);
    const connectionStatus = String(connection.status ?? "");
    if (connectionStatus !== "ready") throw new Error(`Kubernetes connection is not ready: ${connectionStatus || "unknown"}.`);
    const qualification = connection.qualification as JsonObject | null | undefined;
    if (qualification?.status !== "passed" || typeof qualification.expiresAt !== "string") {
      throw new Error("Kubernetes connection has no current passed qualification.");
    }
    qualificationExpiresAt = qualification.expiresAt;
    if (new Date(qualificationExpiresAt) <= now) {
      throw new Error("Kubernetes connection qualification is expired.");
    }
    record("connector.qualification", {
      status: "passed",
      detail: "The selected connection is organization-owned and ready; qualification is checked by Environment admission.",
      requestIds: [connections.requestId],
    });

    const created = await client.request<{ environment: JsonObject; operation: JsonObject }>(
      "/api/organization/environments",
      {
        method: "POST",
        body: JSON.stringify({
          provider: "kubernetes",
          name: identity.environmentName,
          slug: `byoc-canary-${args.tag}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 63),
          providerConnectionId: args.connection,
          runtimeTemplate: "kestrel-standard-v1",
          workspaceLimit: 1,
          isDefault: false,
        }),
      },
    );
    requestIds.push(created.requestId);
    environmentCreated = true;
    const environmentId = String(created.value.environment.id ?? identity.environmentId);
    identity.environmentId = environmentId;
    const provision = await waitForOperation(client, environmentId, String(created.value.operation.id));
    requestIds.push(...provision.requestIds);
    record("environment.idempotency", {
      status: provision.status === "completed" ? "passed" : "failed",
      passed: provision.status === "completed",
      detail: provision.status === "completed" ? "Environment provisioning completed through the durable admin operation." : provision.detail,
      operationIds: [provision.id],
      commandIds: provision.commandIds,
      requestIds: provision.requestIds,
      resources: provision.resources,
    });

    const thread = await client.request<JsonObject>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ id: identity.threadId, workspaceMode: "primary" }),
    });
    requestIds.push(thread.requestId);
    threadCreated = true;
    const binding = await client.request<JsonObject>(`/api/threads/${identity.threadId}/environment`, { method: "POST" });
    requestIds.push(binding.requestId);
    const workspaces = await client.request<{ workspaces?: JsonObject[] }>(
      `/api/organization/environments/${environmentId}/workspaces`,
    );
    requestIds.push(workspaces.requestId);
    const workspace = workspaces.value.workspaces?.[0];
    if (!workspace?.id) throw new Error("The canary thread did not create a Workspace.");
    identity.workspaceId = String(workspace.id);
    workspaceCreated = true;
    const operations = await client.request<{ operations?: JsonObject[] }>(
      `/api/organization/environments/${environmentId}/operations`,
    );
    requestIds.push(operations.requestId);
    const workspaceOperation = operations.value.operations?.find((item) => item.type === "workspace.provision");
    const workspaceResult = workspaceOperation?.id
      ? await waitForOperation(client, environmentId, String(workspaceOperation.id))
      : {
          id: "",
          status: "failed" as const,
          detail: "Workspace provisioning operation was not recorded.",
          requestIds: [],
          commandIds: [],
          resources: [],
        };
    requestIds.push(...workspaceResult.requestIds);
    record("environment.resources", {
      status: workspaceResult.status === "completed" ? "passed" : "failed",
      passed: workspaceResult.status === "completed",
      detail: workspaceResult.status === "completed" ? "Gateway and Workspace provisioning completed through the provider registry." : workspaceResult.detail,
      operationIds: workspaceResult.id ? [workspaceResult.id] : [],
      commandIds: workspaceResult.commandIds,
      requestIds: workspaceResult.requestIds,
      resources: workspaceResult.resources,
    });

    record("workspace.persistence", await runWorkspaceLifecycle(client, environmentId, identity.workspaceId, requestIds));
    const reconcile = await client.request<{ operation?: JsonObject }>(
      `/api/organization/environments/${environmentId}/reconcile`,
      { method: "POST", body: JSON.stringify({}) },
    );
    requestIds.push(reconcile.requestId);
    const reconcileOperationId = String(reconcile.value.operation?.id ?? "");
    const reconcileResult = reconcileOperationId
      ? await waitForOperation(client, environmentId, reconcileOperationId)
      : {
          id: "",
          status: "failed" as const,
          detail: "Reconciliation did not return an operation.",
          requestIds: [],
          commandIds: [],
          resources: [],
        };
    record("reconciliation.idempotency", {
      status: reconcileResult.status === "completed" ? "passed" : "failed",
      passed: reconcileResult.status === "completed",
      detail: reconcileResult.status === "completed" ? "Reconciliation completed through the durable operation API." : reconcileResult.detail,
      operationIds: reconcileResult.id ? [reconcileResult.id] : [],
      commandIds: reconcileResult.commandIds,
      requestIds: [reconcile.requestId, ...reconcileResult.requestIds],
      resources: reconcileResult.resources,
    });

    if (args.scenarioEvidence) {
      const externalScenarios = await loadScenarioEvidence(args.scenarioEvidence, profile);
      for (const scenario of externalScenarios) scenarios.set(scenario.id, scenario);
    }
    for (const id of requiredKubernetesProofScenarioIds(profile)) {
      if (!scenarios.has(id)) {
        record(id, {
          status: "failed",
          detail: "This scenario requires the live profile-specific Router, CSI, network, or fault harness and was not asserted by the admin API canary.",
          passed: false,
        });
      }
    }
  } finally {
    await cleanup(client, args.connection, identity, requestIds, threadCreated, workspaceCreated, environmentCreated)
      .then((inventory) => {
        cleanupInventory = inventory;
        cleanupSucceeded = true;
        cleanupDetail = "Cleanup completed through admin operations and the prior default Environment was restored.";
        record("cleanup.environment", {
          status: "passed",
          detail: cleanupDetail,
          requestIds,
        });
      })
      .catch((error) => {
        cleanupDetail = error instanceof Error ? error.message : "Canary cleanup failed.";
        record("cleanup.environment", {
          status: "failed",
          detail: cleanupDetail,
          passed: false,
          requestIds,
        });
      });
  }

  const proof = {
    contract: KUBERNETES_BYOC_PROOF_VERSION,
    proofId,
    recordedAt: new Date().toISOString(),
    codeRevision: await gitRevision(),
    profile,
    evidenceClass: "isolated_provider" as const,
    connectorImageDigest: normalizeDigest(imageDigest),
    helmChartDigest: normalizeDigest(chartDigest),
    connectorImageAttestation: { signature: imageSignature, provenance: imageProvenance },
    helmChartAttestation: { signature: chartSignature, provenance: chartProvenance },
    connectorVersion: required("KESTREL_KUBERNETES_CONNECTOR_VERSION"),
    commandContract: "infrastructure-connector-command-v1" as const,
    resultContract: "infrastructure-connector-result-v1" as const,
    organizationIdHash: redactKubernetesProofIdentifier(organizationId),
    connectionIdHash: redactKubernetesProofIdentifier(args.connection),
    environmentIdHash: redactKubernetesProofIdentifier(identity.environmentId),
    workspaceIdHash: redactKubernetesProofIdentifier(identity.workspaceId || identity.threadId),
    qualificationExpiresAt,
    platform: {
      kubernetesVersion: required("KESTREL_KUBERNETES_VERSION"),
      distribution: profile === "gke" ? "gke" : profile === "eks" ? "eks" : "other",
      edgeMode: profile === "gke" ? "gateway_api" : "ingress",
      edgeController: required("KESTREL_KUBERNETES_EDGE_CONTROLLER"),
      cni: required("KESTREL_KUBERNETES_CNI"),
      storageCsi: required("KESTREL_KUBERNETES_STORAGE_CSI"),
      snapshotCsi: required("KESTREL_KUBERNETES_SNAPSHOT_CSI"),
      networkPolicy: required("KESTREL_KUBERNETES_NETWORK_POLICY"),
    },
    scenarios: requiredKubernetesProofScenarioIds(profile).map((id) => scenarios.get(id) ?? {
      id,
      status: "failed" as const,
      evidenceClass: "isolated_provider" as const,
      startedAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      operationIds: [],
      commandIds: [],
      requestIds: [],
      auditIds: [],
      resources: [],
      assertions: [{ name: "canary", passed: false, detail: "Scenario did not execute." }],
    }),
    cleanup: {
      startedAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      ...cleanupInventory,
      status: cleanupSucceeded ? "passed" as const : "failed" as const,
      assertions: [{ name: "cleanup", passed: cleanupSucceeded, detail: cleanupDetail }],
    },
    passed: cleanupSucceeded && [...scenarios.values()].length === requiredKubernetesProofScenarioIds(profile).length &&
      [...scenarios.values()].every((scenario) => scenario.status === "passed"),
  };
  const parsed = parseKubernetesByocProof(proof, { now: new Date() });
  await writeFile(args.evidence, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (!parsed.passed) process.exitCode = 2;
}

async function runWorkspaceLifecycle(
  client: AdminCanaryClient,
  environmentId: string,
  workspaceId: string,
  requestIds: string[],
) {
  const stop = await client.request<{ operation?: JsonObject }>(
    `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/stop`,
    { method: "POST" },
  );
  requestIds.push(stop.requestId);
  const stopId = String(stop.value.operation?.id ?? "");
  const stopped = stopId ? await waitForOperation(client, environmentId, stopId) : null;
  if (stopped) requestIds.push(...stopped.requestIds);
  const start = await client.request<{ operation?: JsonObject }>(
    `/api/organization/environments/${environmentId}/workspaces/${workspaceId}/start`,
    { method: "POST" },
  );
  requestIds.push(start.requestId);
  const startId = String(start.value.operation?.id ?? "");
  const started = startId ? await waitForOperation(client, environmentId, startId) : null;
  if (started) requestIds.push(...started.requestIds);
  const passed = stopped?.status === "completed" && started?.status === "completed";
  const commandIds = [...(stopped?.commandIds ?? []), ...(started?.commandIds ?? [])];
  const resources = [...(stopped?.resources ?? []), ...(started?.resources ?? [])];
  return {
    status: passed ? "passed" as const : "failed" as const,
    passed,
    detail: passed ? "Workspace stop reached completion before start and the RWO lifecycle was replayed." : "Workspace stop/start did not complete.",
    operationIds: [stopId, startId].filter(Boolean),
    commandIds,
    requestIds: [stop.requestId, start.requestId, ...(stopped?.requestIds ?? []), ...(started?.requestIds ?? [])],
    resources,
  };
}

async function cleanup(
  client: AdminCanaryClient,
  connectionId: string,
  identity: { environmentId: string; threadId: string; workspaceId: string; environmentName: string },
  requestIds: string[],
  threadCreated: boolean,
  workspaceCreated: boolean,
  environmentCreated: boolean,
) {
  if (workspaceCreated && identity.workspaceId) {
    const retired = await client.request<{ operation?: JsonObject }>(
      `/api/organization/environments/${identity.environmentId}/workspaces/${identity.workspaceId}/retire`,
      {
        method: "POST",
        body: JSON.stringify({ confirmationName: identity.environmentName }),
      },
    );
    requestIds.push(retired.requestId);
    const operationId = String(retired.value.operation?.id ?? "");
    if (operationId) await waitForOperation(client, identity.environmentId, operationId);
  }
  if (environmentCreated) {
    const deleted = await client.request<{ operation?: JsonObject }>(
      `/api/organization/environments/${identity.environmentId}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirmationName: identity.environmentName }),
      },
    );
    requestIds.push(deleted.requestId);
    const operationId = String(deleted.value.operation?.id ?? "");
    if (operationId) await waitForOperation(client, identity.environmentId, operationId);
  }
  if (threadCreated) {
    await client.request<JsonObject>(`/api/threads/${identity.threadId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    await client.request<JsonObject>(`/api/threads/${identity.threadId}`, { method: "DELETE" });
  }
  const resources = await waitForCleanInventory(
    client,
    connectionId,
    identity.environmentId,
    requestIds,
  );
  const residual = resources.filter((resource) => {
    return resource && typeof resource === "object" && !((resource as JsonObject).deletedAt);
  });
  return {
    deletedKestrelResources: resources
      .filter((resource) => resource && typeof resource === "object" && Boolean((resource as JsonObject).deletedAt))
      .map((resource) => resourceLabel(resource as JsonObject)),
    retainedCustomerResources: [],
    residualKestrelResources: residual.map((resource) => resourceLabel(resource as JsonObject)),
    unknownResources: [],
  } satisfies CleanupInventory;
}

async function waitForCleanInventory(
  client: AdminCanaryClient,
  connectionId: string,
  environmentId: string,
  requestIds: string[],
) {
  const deadline = Date.now() + 60_000;
  let lastResources: unknown[] = [];
  while (Date.now() < deadline) {
    const diagnostic = await client.request<JsonObject>(
      `/api/organization/infrastructure/kubernetes/connections/${connectionId}/diagnostics`,
    );
    requestIds.push(diagnostic.requestId);
    const allResources = Array.isArray(diagnostic.value.resources)
      ? diagnostic.value.resources
      : [];
    lastResources = allResources.filter((resource) => {
      return resource &&
        typeof resource === "object" &&
        (resource as JsonObject).environmentId === environmentId;
    });
    const activeResources = lastResources.filter((resource) => {
      return resource && typeof resource === "object" && !((resource as JsonObject).deletedAt);
    });
    if (activeResources.length === 0) return lastResources;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Kubernetes cleanup inventory still contains ${lastResources.length} active resource(s).`);
}

async function waitForOperation(client: AdminCanaryClient, environmentId: string, operationId: string) {
  const deadline = Date.now() + 15 * 60 * 1_000;
  const requestIds: string[] = [];
  while (Date.now() < deadline) {
    const response = await client.request<{ operations?: JsonObject[] }>(
      `/api/organization/environments/${environmentId}/operations`,
    );
    requestIds.push(response.requestId);
    const operation = response.value.operations?.find((item) => item.id === operationId);
    const status = String(operation?.status ?? "queued");
    if (TERMINAL_OPERATION_STATES.has(status)) {
      return {
        id: operationId,
        status: status as "completed" | "failed" | "cancelled",
        detail: String(operation?.errorMessage ?? operation?.stage ?? status),
        requestIds,
        commandIds: typeof operation?.connectorCommandId === "string" ? [operation.connectorCommandId] : [],
        resources: extractOperationResources(operation),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return {
    id: operationId,
    status: "failed" as const,
    detail: "Operation polling timed out.",
    requestIds,
    commandIds: [],
    resources: [],
  };
}

function extractOperationResources(operation: JsonObject | undefined): Scenario["resources"] {
  const result = operation?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const output = (result as JsonObject).output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const observations = (output as JsonObject).resourceObservations;
  if (!Array.isArray(observations)) return [];
  return observations.flatMap((observation) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return [];
    const value = observation as JsonObject;
    const resource = value.resource;
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return [];
    const ref = resource as JsonObject;
    const name = typeof ref.externalId === "string" ? ref.externalId : null;
    const kind = typeof value.kind === "string" ? value.kind : null;
    if (!name || !kind) return [];
    const conditions = Array.isArray(value.conditions)
      ? value.conditions.filter((condition): condition is Record<string, unknown> => Boolean(condition && typeof condition === "object" && !Array.isArray(condition)))
      : [];
    const observedGeneration = typeof value.observedGeneration === "string" && /^\d+$/u.test(value.observedGeneration)
      ? Number(value.observedGeneration)
      : undefined;
    return [{
      kind,
      name,
      ...(typeof value.namespace === "string" ? { namespace: value.namespace } : {}),
      ...(typeof value.providerUid === "string" ? { uid: value.providerUid } : {}),
      ...(observedGeneration === undefined ? {} : { generation: observedGeneration }),
      conditions,
    }];
  });
}

function resourceLabel(resource: JsonObject) {
  const role = typeof resource.resourceRole === "string" ? resource.resourceRole : "resource";
  const id = typeof resource.id === "string" ? resource.id : String(resource.externalId ?? "unknown");
  return `${role}:${redactKubernetesProofIdentifier(id)}`;
}

function emptyCleanupInventory(): CleanupInventory {
  return {
    deletedKestrelResources: [],
    retainedCustomerResources: [],
    residualKestrelResources: [],
    unknownResources: [],
  };
}

function parseArgs(argv: string[]): {
  connection: string;
  profile: KubernetesProofProfile;
  tag: string;
  evidence: string;
  scenarioEvidence?: string;
} {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    const result = argv[index + 1]?.trim();
    if (index < 0 || !result) throw new Error(`${name} is required.`);
    return result;
  };
  const profile = value("--profile");
  if (profile !== "gke" && profile !== "eks" && profile !== "qualified") {
    throw new Error("--profile must be gke, eks, or qualified.");
  }
  const scenarioEvidenceIndex = argv.indexOf("--scenario-evidence");
  const scenarioEvidence = scenarioEvidenceIndex >= 0
    ? argv[scenarioEvidenceIndex + 1]?.trim()
    : undefined;
  return {
    connection: value("--connection"),
    profile,
    tag: value("--tag"),
    evidence: value("--evidence"),
    ...(scenarioEvidence ? { scenarioEvidence } : {}),
  };
}

async function loadScenarioEvidence(path: string, profile: KubernetesProofProfile) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read scenario evidence ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Scenario evidence must be a proof object containing scenarios.");
  }
  const document = parsed as JsonObject;
  if (document.profile !== profile) {
    throw new Error(
      `Scenario evidence profile ${String(document.profile ?? "unknown")} does not match ${profile}.`,
    );
  }
  const scenarios = kubernetesProofScenarioSchema.array().parse(document.scenarios);
  const required = new Set(requiredKubernetesProofScenarioIds(profile));
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (!required.has(scenario.id)) {
      throw new Error(`Scenario evidence contains unsupported scenario ${scenario.id}.`);
    }
    if (seen.has(scenario.id)) {
      throw new Error(`Scenario evidence contains duplicate scenario ${scenario.id}.`);
    }
    seen.add(scenario.id);
  }
  return scenarios;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeDigest(value: string) {
  const trimmed = value.trim();
  const digest = trimmed.startsWith("sha256:") ? trimmed : trimmed.split("@").pop() ?? "";
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Canary artifacts must be immutable sha256 digests.");
  return digest;
}

async function gitRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return process.env.GIT_COMMIT?.trim() || "unknown-revision";
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
