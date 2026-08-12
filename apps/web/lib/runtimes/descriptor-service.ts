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
  if (environment.provider !== "fly") {
    throw new Error(
      "Kestrel One cannot perform a read-only Runtime probe through this Desktop Environment connection.",
    );
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
    return await client.describeRuntime(
      {
        environmentPresetId: "workspace_hosted",
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
  } finally {
    await client.close();
  }
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
