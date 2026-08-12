import "server-only";

import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { KestrelClient } from "@kestrel-agents/sdk/runner";
import { and, eq, isNull } from "drizzle-orm";

import { toKestrelOneRuntimeModelSelection } from "@/lib/agent/kestrel-runtime-model";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireProjectRole } from "@/lib/projects/access";
import { requestDesktopRuntimeDescriptorProbe } from "@/lib/runtimes/desktop-descriptor-probes";

export async function describeRuntimeForAdmission(input: {
  organizationId: string;
  userId: string;
  runtimeId: "codex" | "claude";
  modelId?: string | undefined;
  projectId?: string | null | undefined;
}) {
  if (input.projectId) {
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
  }
  const project = input.projectId
    ? await knowledgeDb.query.projects.findFirst({
        where: and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
        ),
      })
    : null;
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.organizationId, input.organizationId),
      project
        ? eq(schema.environments.id, project.environmentId)
        : eq(schema.environments.isDefault, true),
      eq(schema.environments.status, "ready"),
      isNull(schema.environments.archivedAt),
    ),
  });
  if (!environment) throw new Error("No ready Environment is available for this Runtime.");
  if (environment.provider === "desktop") {
    const model = await resolveDesktopDescriptorModel({
      organizationId: input.organizationId,
      environmentId: environment.id,
      modelId: input.modelId,
    });
    const resolution = await requestDesktopRuntimeDescriptorProbe({
      organizationId: input.organizationId,
      environmentId: environment.id,
      actorUserId: input.userId,
      runtimeId: input.runtimeId,
      requestedModelId: model.id,
      request: {
        client: "web",
        runtimeId: input.runtimeId,
        modelProvider: model.provider,
        model: model.model,
        environmentId: environment.id,
      },
    });
    return { ...resolution, selectedModelId: model.id };
  }
  const workspace = await knowledgeDb.query.environmentWorkspaces.findFirst({
    where: and(
      eq(schema.environmentWorkspaces.organizationId, input.organizationId),
      eq(schema.environmentWorkspaces.environmentId, environment.id),
      ...(project
        ? [eq(schema.environmentWorkspaces.projectId, project.id)]
        : []),
      eq(schema.environmentWorkspaces.status, "ready"),
      isNull(schema.environmentWorkspaces.deletedAt),
    ),
  });
  if (
    !(
      workspace?.flyMachineId &&
      workspace.runtimeImage &&
      environment.flyAppName &&
      environment.routerUrl
    )
  ) {
    throw new Error("The selected Environment has no ready Runtime workspace to probe.");
  }
  const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
    selection: input.modelId,
    organizationId: input.organizationId,
    environmentId: environment.id,
  });
  if (!resolvedModel) throw new Error("The selected Runtime model is unavailable.");
  const model = toKestrelOneRuntimeModelSelection({
    ...resolvedModel.model,
    organizationId: input.organizationId,
    environmentId: environment.id,
  });
  const probeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ticket = signEnvironmentExecutionTicket({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: 2,
      audience: ENVIRONMENT_ROUTER_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: environment.id,
      workspaceId: workspace.id,
      threadId: `runtime-descriptor:${project?.id ?? input.userId}`,
      runId: probeId,
      actorId: input.userId,
      agentId: "kestrel-one-runtime-descriptor",
      target: {
        provider: "fly",
        appName: environment.flyAppName,
        machineId: workspace.flyMachineId,
      },
      capabilities: ["profile.read"],
      issuedAt: now,
      expiresAt: now + 300,
      nonce: crypto.randomUUID(),
    },
  });
  const client = new KestrelClient({
    target: { kind: "remote", baseUrl: environment.routerUrl, authToken: ticket },
  });
  try {
    const resolution = await client.describeRuntime(
      {
        environmentPresetId: "workspace_hosted",
        environmentId: environment.id,
        managedConfiguration: {
          runtimeId: input.runtimeId,
          label: input.runtimeId === "codex" ? "Codex" : "Claude Code",
          modelProvider: model.provider,
          model: model.model,
          modelCredential: {
            source: "kestrel-one",
            runId: probeId,
            gatewayId: model.gatewayId,
            organizationId: model.organizationId,
            environmentId: model.environmentId,
            rawModelId: model.model,
            provider: model.provider,
          },
        },
      },
      {
        actor: { actorId: input.userId, actorType: "end_user" },
        tenantId: input.organizationId,
      },
    );
    return { ...resolution, selectedModelId: model.id };
  } finally {
    await client.close();
  }
}

async function resolveDesktopDescriptorModel(input: {
  organizationId: string;
  environmentId: string;
  modelId?: string | undefined;
}) {
  const match = input.modelId?.match(
    /^desktop-local:(openai|openrouter|anthropic|ollama|lmstudio):(.+)$/u,
  );
  if (!(input.modelId && match?.[1] && match[2])) {
    throw new Error("A Desktop-local model is required for this Runtime probe.");
  }
  let model: string;
  try {
    model = decodeURIComponent(match[2]);
  } catch {
    throw new Error("The selected Desktop-local model ID is invalid.");
  }
  if (!model || model.length > 200 || encodeURIComponent(model) !== match[2]) {
    throw new Error("The selected Desktop-local model ID is invalid.");
  }
  const provider = match[1] as
    | "openai"
    | "openrouter"
    | "anthropic"
    | "ollama"
    | "lmstudio";
  const connection = await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
    where: and(
      eq(schema.desktopEnvironmentConnections.organizationId, input.organizationId),
      eq(schema.desktopEnvironmentConnections.environmentId, input.environmentId),
      eq(schema.desktopEnvironmentConnections.status, "active"),
    ),
    columns: { advertisedModels: true },
  });
  if (!connection?.advertisedModels.some(
    (candidate) => candidate.provider === provider &&
      candidate.model === model && candidate.health === "ready",
  )) {
    throw new Error("The selected Desktop-local Runtime model is unavailable.");
  }
  return { id: input.modelId, provider, model };
}

export async function assertRuntimeAdmissionReady(
  input: Parameters<typeof describeRuntimeForAdmission>[0],
) {
  let resolution;
  try {
    resolution = await describeRuntimeForAdmission(input);
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error)),
      { code: "RUNTIME_UNAVAILABLE" },
    );
  }
  if (
    resolution.descriptor.runtimeId !== input.runtimeId ||
    resolution.descriptor.availability !== "ready"
  ) {
    throw Object.assign(
      new Error(
        resolution.descriptor.unavailableReason ??
          `${resolution.descriptor.displayName} is ${resolution.descriptor.availability}.`,
      ),
      { code: "RUNTIME_UNAVAILABLE" },
    );
  }
  return resolution;
}
