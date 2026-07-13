import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type CreateEnvironmentInput,
  ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
  ENVIRONMENT_RUNTIME_TEMPLATE,
  EnvironmentContractError,
  environmentProvisionIdempotencyKey,
  toEnvironmentSlug,
  type WorkspaceSource,
  workspaceProvisionIdempotencyKey,
} from "./contracts";

const UNAVAILABLE_ENVIRONMENT_STATES = ["deleting", "deleted"] as const;

export async function listOrganizationEnvironments(organizationId: string) {
  return knowledgeDb
    .select()
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.organizationId, organizationId),
        isNull(schema.environments.archivedAt)
      )
    )
    .orderBy(
      sql`${schema.environments.isDefault} desc`,
      asc(schema.environments.name),
      asc(schema.environments.id)
    );
}

export async function getOrganizationEnvironment(input: {
  organizationId: string;
  environmentId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.id, input.environmentId),
        eq(table.organizationId, input.organizationId),
        input.includeArchived ? undefined : isNull(table.archivedAt)
      ),
  });
}

export async function createOrganizationEnvironment(input: {
  organizationId: string;
  userId: string;
  environment: CreateEnvironmentInput;
}) {
  const environmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = new Date();
  const slug =
    input.environment.slug ?? toEnvironmentSlug(input.environment.name);
  const lockKey = `kestrel:environment:create:${input.organizationId}`;

  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const existingDefault = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.isDefault, true),
          isNull(table.archivedAt)
        ),
      columns: { id: true },
    });
    const isDefault = input.environment.isDefault ?? !existingDefault;
    if (isDefault && existingDefault) {
      await transaction
        .update(schema.environments)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(schema.environments.id, existingDefault.id));
    }

    const [environment] = await transaction
      .insert(schema.environments)
      .values({
        id: environmentId,
        organizationId: input.organizationId,
        createdByUserId: input.userId,
        name: input.environment.name,
        slug,
        region: input.environment.region,
        status: "requested",
        isDefault,
        runtimeTemplate: ENVIRONMENT_RUNTIME_TEMPLATE,
        idleTimeoutMinutes: ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!environment) {
      throw new Error("Environment creation failed.");
    }

    const [operation] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: operationId,
        organizationId: input.organizationId,
        environmentId,
        requestedByUserId: input.userId,
        type: "environment.provision",
        status: "queued",
        stage: "environment.activation.requested",
        idempotencyKey: environmentProvisionIdempotencyKey(environmentId),
        input: {
          region: input.environment.region,
          runtimeTemplate: ENVIRONMENT_RUNTIME_TEMPLATE,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { environment, operation };
  });
}

export async function setDefaultOrganizationEnvironment(input: {
  organizationId: string;
  environmentId: string;
}) {
  const now = new Date();
  const lockKey = `kestrel:environment:default:${input.organizationId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const environment = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt),
          notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
        ),
    });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment not found or unavailable."
      );
    }
    await transaction
      .update(schema.environments)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(schema.environments.organizationId, input.organizationId));
    const [updated] = await transaction
      .update(schema.environments)
      .set({ isDefault: true, updatedAt: now })
      .where(eq(schema.environments.id, environment.id))
      .returning();
    return updated;
  });
}

export async function bindProjectToEnvironment(input: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}) {
  const environment = await getOrganizationEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (
    !environment ||
    UNAVAILABLE_ENVIRONMENT_STATES.includes(
      environment.status as (typeof UNAVAILABLE_ENVIRONMENT_STATES)[number]
    )
  ) {
    throw new EnvironmentContractError(
      "ENVIRONMENT_NOT_FOUND",
      "Environment not found or unavailable."
    );
  }
  const now = new Date();
  const [binding] = await knowledgeDb
    .insert(schema.projectEnvironmentBindings)
    .values({
      projectId: input.projectId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      boundByUserId: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.projectEnvironmentBindings.projectId,
      set: {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        boundByUserId: input.userId,
        updatedAt: now,
      },
    })
    .returning();
  return binding;
}

export async function getProjectEnvironmentBinding(input: {
  organizationId: string;
  projectId: string;
}) {
  return knowledgeDb.query.projectEnvironmentBindings.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.projectId, input.projectId),
        eq(table.organizationId, input.organizationId)
      ),
  });
}

export async function resolveOrCreateThreadExecutionBinding(input: {
  organizationId: string;
  threadId: string;
  userId: string;
}) {
  const lockKey = `kestrel:thread-environment:${input.threadId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const thread = await transaction.query.threads.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.threadId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt)
        ),
    });
    if (!thread) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_BINDING_NOT_FOUND",
        "Thread is unavailable for Environment execution."
      );
    }

    const existing = await transaction.query.threadExecutionBindings.findFirst({
      where: (table, { eq }) => eq(table.threadId, input.threadId),
    });
    if (existing) {
      const workspace = await transaction.query.environmentWorkspaces.findFirst(
        {
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.id, existing.workspaceId),
              eq(table.organizationId, input.organizationId),
              eq(table.environmentId, existing.environmentId),
              isNull(table.deletedAt)
            ),
        }
      );
      if (!workspace) {
        throw new EnvironmentContractError(
          "ENVIRONMENT_BINDING_NOT_FOUND",
          "Thread Environment binding references an unavailable Workspace."
        );
      }
      return { binding: existing, workspace, operation: null, created: false };
    }

    const projectBinding = thread.projectId
      ? await transaction.query.projectEnvironmentBindings.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.projectId, thread.projectId!),
              eq(table.organizationId, input.organizationId)
            ),
        })
      : null;
    const environment = projectBinding
      ? await transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, notInArray }) =>
            and(
              eq(table.id, projectBinding.environmentId),
              eq(table.organizationId, input.organizationId),
              isNull(table.archivedAt),
              notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
            ),
        })
      : await transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, notInArray }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.isDefault, true),
              isNull(table.archivedAt),
              notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
            ),
        });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_BINDING_NOT_FOUND",
        "No available Environment is configured for this Thread."
      );
    }

    if (thread.projectId && !projectBinding) {
      await transaction.insert(schema.projectEnvironmentBindings).values({
        projectId: thread.projectId,
        organizationId: input.organizationId,
        environmentId: environment.id,
        boundByUserId: input.userId,
      });
    }

    const workspace = await findOrCreateWorkspace(transaction, {
      organizationId: input.organizationId,
      environmentId: environment.id,
      projectId: thread.projectId,
      threadId: thread.id,
      userId: input.userId,
    });
    const source = projectBinding ? "project" : "organization";
    const [binding] = await transaction
      .insert(schema.threadExecutionBindings)
      .values({
        threadId: thread.id,
        organizationId: input.organizationId,
        environmentId: environment.id,
        workspaceId: workspace.id,
        source,
        boundByUserId: input.userId,
      })
      .returning();
    if (!binding) {
      throw new Error("Thread Environment binding creation failed.");
    }
    const operation = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.workspaceId, workspace.id),
          eq(table.type, "workspace.provision")
        ),
      columns: { id: true, status: true },
    });
    return { binding, workspace, operation: operation ?? null, created: true };
  });
}

export async function getThreadExecutionBindingState(input: {
  organizationId: string;
  threadId: string;
}) {
  const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.threadId, input.threadId),
        eq(table.organizationId, input.organizationId)
      ),
  });
  if (!binding) return null;

  const [environment, workspace] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, binding.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt)
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, binding.workspaceId),
          eq(table.environmentId, binding.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.deletedAt)
        ),
    }),
  ]);
  if (!(environment && workspace)) return null;
  return { binding, environment, workspace };
}

type EnvironmentTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

async function findOrCreateWorkspace(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    projectId: string | null;
    threadId: string;
    userId: string;
  }
) {
  const existing = await transaction.query.environmentWorkspaces.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        input.projectId
          ? eq(table.projectId, input.projectId)
          : eq(table.standaloneThreadId, input.threadId),
        isNull(table.deletedAt)
      ),
  });
  if (existing) {
    return existing;
  }

  const workspaceId = crypto.randomUUID();
  const now = new Date();
  const [workspace] = await transaction
    .insert(schema.environmentWorkspaces)
    .values({
      id: workspaceId,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      projectId: input.projectId,
      standaloneThreadId: input.projectId ? null : input.threadId,
      createdByUserId: input.userId,
      name: input.projectId ? "Project workspace" : "Thread workspace",
      kind: input.projectId ? "project" : "scratch",
      sourceType: "blank",
      status: "requested",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!workspace) {
    throw new Error("Workspace creation failed.");
  }
  await transaction.insert(schema.environmentOperations).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    workspaceId,
    requestedByUserId: input.userId,
    type: "workspace.provision",
    status: "queued",
    stage: "environment.activation.requested",
    idempotencyKey: workspaceProvisionIdempotencyKey(workspaceId),
    input: { sourceType: "blank" },
    createdAt: now,
    updatedAt: now,
  });
  return workspace;
}

export async function listEnvironmentOperations(input: {
  organizationId: string;
  environmentId: string;
}) {
  return knowledgeDb.query.environmentOperations.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId)
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
}

export async function requestWorkspaceStart(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  userId: string;
}) {
  const lockKey = `kestrel:workspace:start:${input.workspaceId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const workspace = await transaction.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.deletedAt)
        ),
    });
    if (!workspace?.flyMachineId) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace Machine is unavailable."
      );
    }
    const active = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.workspaceId, workspace.id),
          eq(table.type, "workspace.start"),
          inArray(table.status, ["queued", "running"])
        ),
    });
    if (active) return active;
    const operationId = crypto.randomUUID();
    const now = new Date();
    const [operation] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: operationId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        requestedByUserId: input.userId,
        type: "workspace.start",
        status: "queued",
        stage: "environment.machine.starting",
        idempotencyKey: `workspace.start:${workspace.id}:${now.getTime()}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return operation;
  });
}

export async function createOrConfigureProjectWorkspace(input: {
  organizationId: string;
  environmentId: string;
  projectId: string;
  userId: string;
  source: WorkspaceSource;
}) {
  const lockKey = `kestrel:project-workspace:${input.projectId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const [project, environment] = await Promise.all([
      transaction.query.projects.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.projectId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt)
          ),
      }),
      transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.environmentId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt)
          ),
      }),
    ]);
    if (!(project && environment)) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Project or Environment is unavailable."
      );
    }
    if (input.source.type === "github") {
      const source = input.source;
      const resource =
        await transaction.query.toolConnectionResources.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, source.connectionId),
              eq(table.organizationId, input.organizationId),
              eq(table.providerKey, "github"),
              eq(table.resourceType, "repository"),
              eq(table.externalId, `repository:${source.repository}`),
              eq(table.enabled, true)
            ),
        });
      const grant = resource
        ? await transaction.query.environmentCapabilityGrants.findFirst({
            where: (table, { and, eq, notInArray }) =>
              and(
                eq(table.environmentId, input.environmentId),
                eq(table.providerKey, "github"),
                eq(table.capabilityKey, "repository.read"),
                eq(table.resourceId, resource.id),
                notInArray(table.approvalMode, ["deny"])
              ),
          })
        : null;
      if (!(resource && grant)) {
        throw new EnvironmentContractError(
          "WORKSPACE_SOURCE_FORBIDDEN",
          "Repository is not granted to this Environment."
        );
      }
    }
    await transaction
      .insert(schema.projectEnvironmentBindings)
      .values({
        projectId: input.projectId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        boundByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: schema.projectEnvironmentBindings.projectId,
        set: {
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          boundByUserId: input.userId,
          updatedAt: new Date(),
        },
      });
    const existing = await transaction.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.environmentId, input.environmentId),
          eq(table.projectId, input.projectId),
          isNull(table.deletedAt)
        ),
    });
    if (existing && existing.status !== "requested") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace source cannot change after provisioning has started."
      );
    }
    const now = new Date();
    const workspaceId = existing?.id ?? crypto.randomUUID();
    const values = {
      sourceType: input.source.type,
      sourceConnectionId:
        input.source.type === "github" ? input.source.connectionId : null,
      sourceRepository:
        input.source.type === "github" ? input.source.repository : null,
      sourceDefaultBranch:
        input.source.type === "github"
          ? (input.source.defaultBranch ?? null)
          : null,
      updatedAt: now,
    } as const;
    const workspace = existing
      ? (
          await transaction
            .update(schema.environmentWorkspaces)
            .set(values)
            .where(eq(schema.environmentWorkspaces.id, existing.id))
            .returning()
        )[0]
      : (
          await transaction
            .insert(schema.environmentWorkspaces)
            .values({
              id: workspaceId,
              organizationId: input.organizationId,
              environmentId: input.environmentId,
              projectId: input.projectId,
              createdByUserId: input.userId,
              name: project.name,
              kind: "project",
              status: "requested",
              createdAt: now,
              ...values,
            })
            .returning()
        )[0];
    if (!workspace) throw new Error("Project Workspace creation failed.");
    let operation = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.workspaceId, workspace.id),
          eq(table.type, "workspace.provision")
        ),
    });
    if (!operation) {
      [operation] = await transaction
        .insert(schema.environmentOperations)
        .values({
          id: crypto.randomUUID(),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: workspace.id,
          requestedByUserId: input.userId,
          type: "workspace.provision",
          status: "queued",
          stage: "environment.activation.requested",
          idempotencyKey: workspaceProvisionIdempotencyKey(workspace.id),
          input: { sourceType: input.source.type },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }
    return { workspace, operation };
  });
}
