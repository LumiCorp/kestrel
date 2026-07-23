import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertEnvironmentTransition,
  assertWorkspaceTransition,
  type CreateEnvironmentInput,
  ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
  ENVIRONMENT_RUNTIME_TEMPLATE,
  EnvironmentContractError,
  environmentDeleteIdempotencyKey,
  environmentProvisionIdempotencyKey,
  toEnvironmentSlug,
  type WorkspaceSource,
  selectDefaultEnvironmentRecoveryAction,
  workspaceProvisionIdempotencyKey,
} from "./contracts";
import {
  environmentLifecycleLockKey,
  organizationEnvironmentCreateLockKey,
  organizationEnvironmentDefaultLockKey,
  workspaceLifecycleLockKey,
} from "./lifecycle-lock";

const UNAVAILABLE_ENVIRONMENT_STATES = ["deleting", "deleted"] as const;

export async function listOrganizationEnvironments(organizationId: string) {
  return knowledgeDb
    .select()
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.organizationId, organizationId),
        isNull(schema.environments.archivedAt),
      ),
    )
    .orderBy(
      sql`${schema.environments.isDefault} desc`,
      asc(schema.environments.name),
      asc(schema.environments.id),
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
        input.includeArchived ? undefined : isNull(table.archivedAt),
      ),
  });
}

export async function ensureOrganizationDefaultEnvironment(input: {
  organizationId: string;
  userId: string;
}) {
  const existing = await knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull, notInArray }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.isDefault, true),
        isNull(table.archivedAt),
        notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
      ),
  });
  if (existing)
    return { environment: existing, operation: null, created: false };

  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentCreateLockKey(input.organizationId)}, 0))`,
    );
    const currentDefault = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.isDefault, true),
          isNull(table.archivedAt),
          notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
        ),
    });
    if (currentDefault) {
      return {
        environment: currentDefault,
        operation: null,
        created: false,
      };
    }
    while (true) {
      const activeEnvironment = await transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull, notInArray }) =>
          and(
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
            notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
          ),
        orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
      });
      if (!activeEnvironment) break;
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(activeEnvironment.id)}, 0))`,
      );
      const [environment] = await transaction
        .update(schema.environments)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.environments.id, activeEnvironment.id),
            eq(schema.environments.organizationId, input.organizationId),
            isNull(schema.environments.archivedAt),
            notInArray(schema.environments.status, [
              ...UNAVAILABLE_ENVIRONMENT_STATES,
            ]),
          ),
        )
        .returning();
      if (environment) {
        return { environment, operation: null, created: false };
      }
    }

    const now = new Date();
    const environmentId = crypto.randomUUID();
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`,
    );
    const [environment] = await transaction
      .insert(schema.environments)
      .values({
        id: environmentId,
        organizationId: input.organizationId,
        createdByUserId: input.userId,
        name: "Default",
        slug: "default",
        region: process.env.KESTREL_ENVIRONMENT_DEFAULT_REGION?.trim() || "iad",
        status: "requested",
        isDefault: true,
        runtimeTemplate: ENVIRONMENT_RUNTIME_TEMPLATE,
        idleTimeoutMinutes: ENVIRONMENT_IDLE_TIMEOUT_MINUTES,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!environment) throw new Error("Default Environment creation failed.");
    const [operation] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        environmentId,
        requestedByUserId: input.userId,
        type: "environment.provision",
        status: "queued",
        stage: "environment.activation.requested",
        idempotencyKey: environmentProvisionIdempotencyKey(environmentId),
        input: {
          region: environment.region,
          runtimeTemplate: ENVIRONMENT_RUNTIME_TEMPLATE,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!operation) throw new Error("Default Environment operation failed.");
    return { environment, operation, created: true };
  });
}

export async function recoverDefaultEnvironmentProvisioning(input: {
  organizationId: string;
  userId: string;
}) {
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`
    );
    const environment = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.isDefault, true),
          isNull(table.archivedAt),
          notInArray(table.status, ["deleting", "deleted"])
        ),
    });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "The default Environment is unavailable. Open Environments to repair it."
      );
    }
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environment.id)}, 0))`
    );
    const operation = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.environmentId, environment.id),
          eq(table.type, "environment.provision")
        ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    if (!operation) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        `Default Environment provisioning history is missing. Open /settings/organization/environments/${environment.id}/activity.`
      );
    }
    const recoveryAction = selectDefaultEnvironmentRecoveryAction({
      environmentStatus: environment.status,
      operationStatus: operation.status,
    });
    if (recoveryAction === "ready") {
      return { environment, operation, action: "ready" as const };
    }
    if (recoveryAction === "existing") {
      return { environment, operation, action: "existing" as const };
    }
    if (recoveryAction === "unsupported") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        `Default Environment state '${environment.status}' cannot be retried automatically. Open /settings/organization/environments/${environment.id}/activity.`
      );
    }
    const now = new Date();
    const [requeued] = await transaction
      .update(schema.environmentOperations)
      .set({
        status: "queued",
        stage: "environment.activation.requested",
        requestedByUserId: input.userId,
        providerRequestId: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environmentOperations.id, operation.id),
          inArray(schema.environmentOperations.status, ["failed", "cancelled"])
        )
      )
      .returning();
    if (!requeued) {
      const current = await transaction.query.environmentOperations.findFirst({
        where: (table, { eq }) => eq(table.id, operation.id),
      });
      if (current?.status === "queued" || current?.status === "running") {
        return { environment, operation: current, action: "existing" as const };
      }
      throw new Error("Default Environment provisioning retry was not queued.");
    }
    return { environment, operation: requeued, action: "requeued" as const };
  });
}

export async function createOrganizationEnvironment(input: {
  organizationId: string;
  userId: string;
  environment: CreateEnvironmentInput;
  runtimeTemplate?: string;
}) {
  const environmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = new Date();
  const slug =
    input.environment.slug ?? toEnvironmentSlug(input.environment.name);

  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentCreateLockKey(input.organizationId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`,
    );
    const existingDefault = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.isDefault, true),
          isNull(table.archivedAt),
          notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
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
        runtimeTemplate: input.runtimeTemplate ?? ENVIRONMENT_RUNTIME_TEMPLATE,
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
          runtimeTemplate: input.runtimeTemplate ?? ENVIRONMENT_RUNTIME_TEMPLATE,
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
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
    );
    const environment = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt),
          notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
        ),
    });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment not found or unavailable.",
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

export async function requestOrganizationEnvironmentDelete(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
  confirmationName: string;
}) {
  const now = new Date();
  const idempotencyKey = environmentDeleteIdempotencyKey(
    input.environmentId
  );
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationEnvironmentDefaultLockKey(input.organizationId)}, 0))`
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`
    );
    const environment = await transaction.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt)
        ),
    });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Environment not found or unavailable."
      );
    }
    if (environment.name !== input.confirmationName) {
      throw new Error("Type the Environment name exactly to confirm deletion.");
    }

    const existing = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.idempotencyKey, idempotencyKey)
        ),
    });
    if (existing?.status === "queued" || existing?.status === "running") {
      return { environment, operation: existing, action: "existing" as const };
    }

    if (environment.isDefault) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_IS_DEFAULT",
        "Select another ready Environment as default before deleting this Environment."
      );
    }
    if (environment.status === "deleting") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Environment deletion is already in progress."
      );
    }
    assertEnvironmentTransition(environment.status, "deleting");

    const [readyDefault, project, deployment, gateway, activeOperation] =
      await Promise.all([
        transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, ne }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.isDefault, true),
              eq(table.status, "ready"),
              ne(table.id, input.environmentId),
              isNull(table.archivedAt)
            ),
          columns: { id: true },
        }),
        transaction.query.projects.findFirst({
          where: (table, { eq }) => eq(table.environmentId, input.environmentId),
          columns: { id: true },
        }),
        transaction.query.aiDeployments.findFirst({
          where: (table, { and, eq, isNull }) =>
            and(
              eq(table.environmentId, input.environmentId),
              isNull(table.deletedAt)
            ),
          columns: { id: true },
        }),
        transaction.query.aiGateways.findFirst({
          where: (table, { eq }) => eq(table.environmentId, input.environmentId),
          columns: { id: true },
        }),
        transaction.query.environmentOperations.findFirst({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.environmentId, input.environmentId),
              inArray(table.status, ["queued", "running"])
            ),
          columns: { id: true },
        }),
      ]);
    if (!readyDefault) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "A different ready Environment must be the organization default before deletion."
      );
    }
    if (project) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_HAS_PROJECTS",
        "Move every Project to another Environment before deleting this Environment."
      );
    }
    if (deployment || gateway) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_HAS_PRIVATE_INFERENCE",
        "Remove private inference before deleting this Environment."
      );
    }
    if (activeOperation) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Wait for the Environment's active lifecycle operation before deleting it."
      );
    }

    const [updatedEnvironment] = await transaction
      .update(schema.environments)
      .set({
        status: "deleting",
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.environments.id, environment.id))
      .returning();
    if (!updatedEnvironment) {
      throw new Error("Environment deletion state was not persisted.");
    }

    const operation = existing
      ? (
          await transaction
            .update(schema.environmentOperations)
            .set({
              status: "queued",
              stage: "requested",
              requestedByUserId: input.userId,
              providerRequestId: null,
              result: null,
              errorCode: null,
              errorMessage: null,
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            })
            .where(eq(schema.environmentOperations.id, existing.id))
            .returning()
        )[0]
      : (
          await transaction
            .insert(schema.environmentOperations)
            .values({
              id: crypto.randomUUID(),
              organizationId: input.organizationId,
              environmentId: input.environmentId,
              requestedByUserId: input.userId,
              type: "environment.delete",
              status: "queued",
              stage: "requested",
              idempotencyKey,
              input: { confirmationName: environment.name },
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        )[0];
    if (!operation) {
      throw new Error("Environment deletion operation was not created.");
    }
    return {
      environment: updatedEnvironment,
      operation,
      action: existing ? ("requeued" as const) : ("requested" as const),
    };
  });
}

export async function bindProjectToEnvironment(input: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}) {
  const now = new Date();
  const lockKey = `kestrel:project-environment:${input.projectId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(input.environmentId)}, 0))`,
    );
    const [project, environment] = await Promise.all([
      transaction.query.projects.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.projectId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
          ),
      }),
      transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull, notInArray }) =>
          and(
            eq(table.id, input.environmentId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
            notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
          ),
      }),
    ]);
    if (!(project && environment)) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Project or Environment not found or unavailable.",
      );
    }
    if (project.environmentId !== environment.id) {
      const activeExecution =
        await transaction.query.environmentRunExecutions.findFirst({
          where: (table, { and, eq, inArray }) =>
            and(
              eq(table.projectId, project.id),
              inArray(table.status, ["routed", "running"]),
            ),
          columns: { id: true },
        });
      if (activeExecution) {
        throw new EnvironmentContractError(
          "ENVIRONMENT_UNAVAILABLE",
          "Project Environment cannot change while a run is active.",
        );
      }
      const activeTurn = await transaction
        .select({ id: schema.threadTurns.id })
        .from(schema.threadTurns)
        .innerJoin(
          schema.threads,
          eq(schema.threads.id, schema.threadTurns.threadId)
        )
        .where(
          and(
            eq(schema.threads.projectId, project.id),
            inArray(schema.threadTurns.status, [
              "queued",
              "running",
              "waiting_for_input",
            ])
          )
        )
        .limit(1);
      if (activeTurn.length > 0) {
        throw new EnvironmentContractError(
          "ENVIRONMENT_UNAVAILABLE",
          "Project Environment cannot change while a Thread turn is active."
        );
      }
      await transaction
        .delete(schema.threadExecutionBindings)
        .where(
          inArray(
            schema.threadExecutionBindings.threadId,
            transaction
              .select({ id: schema.threads.id })
              .from(schema.threads)
              .where(eq(schema.threads.projectId, project.id)),
          ),
        );
    }
    const [updatedProject] = await transaction
      .update(schema.projects)
      .set({ environmentId: environment.id, updatedAt: now })
      .where(eq(schema.projects.id, project.id))
      .returning();
    await transaction
      .insert(schema.projectEnvironmentBindings)
      .values({
        projectId: project.id,
        organizationId: input.organizationId,
        environmentId: environment.id,
        boundByUserId: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.projectEnvironmentBindings.projectId,
        set: {
          organizationId: input.organizationId,
          environmentId: environment.id,
          boundByUserId: input.userId,
          updatedAt: now,
        },
      });
    if (project.environmentId !== environment.id) {
      await transaction.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        actorUserId: input.userId,
        action: "project.environment.moved",
        targetType: "environment",
        targetId: environment.id,
        metadata: {
          previousEnvironmentId: project.environmentId,
          environmentId: environment.id,
        },
        createdAt: now,
      });
    }
    return updatedProject;
  });
}

export async function getProjectEnvironmentBinding(input: {
  organizationId: string;
  projectId: string;
}) {
  return knowledgeDb.query.projects.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.projectId),
        eq(table.organizationId, input.organizationId),
      ),
    columns: {
      id: true,
      organizationId: true,
      environmentId: true,
      updatedAt: true,
    },
  });
}

export async function resolveThreadEnvironment(input: {
  organizationId: string;
  threadId: string;
}) {
  const thread = await knowledgeDb.query.threads.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.id, input.threadId),
        eq(table.organizationId, input.organizationId),
        isNull(table.archivedAt)
      ),
    columns: { id: true, projectId: true },
  });
  if (!thread) return null;
  const binding = await knowledgeDb.query.threadExecutionBindings.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.threadId, thread.id),
        eq(table.organizationId, input.organizationId)
      ),
    columns: { environmentId: true },
  });
  const project =
    !binding && thread.projectId
      ? await knowledgeDb.query.projects.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, thread.projectId!),
              eq(table.organizationId, input.organizationId)
            ),
          columns: { environmentId: true },
        })
      : null;
  return knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull, notInArray }) =>
      and(
        eq(table.organizationId, input.organizationId),
        binding
          ? eq(table.id, binding.environmentId)
          : project
            ? eq(table.id, project.environmentId)
            : eq(table.isDefault, true),
        isNull(table.archivedAt),
        notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
      ),
    columns: { id: true, name: true, slug: true, status: true },
  });
}

export async function getDefaultOrganizationEnvironment(
  organizationId: string
) {
  return knowledgeDb.query.environments.findFirst({
    where: (table, { and, eq, isNull, notInArray }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.isDefault, true),
        isNull(table.archivedAt),
        notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
      ),
    columns: { id: true, name: true, slug: true, status: true },
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const thread = await transaction.query.threads.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.threadId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt),
        ),
    });
    if (!thread) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_BINDING_NOT_FOUND",
        "Thread is unavailable for Environment execution.",
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
              isNull(table.deletedAt),
            ),
        },
      );
      if (!workspace) {
        throw new EnvironmentContractError(
          "ENVIRONMENT_BINDING_NOT_FOUND",
          "Thread Environment binding references an unavailable Workspace.",
        );
      }
      return { binding: existing, workspace, operation: null, created: false };
    }

    const project = thread.projectId
      ? await transaction.query.projects.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.id, thread.projectId!),
              eq(table.organizationId, input.organizationId),
            ),
        })
      : null;
    const environment = project
      ? await transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, notInArray }) =>
            and(
              eq(table.id, project.environmentId),
              eq(table.organizationId, input.organizationId),
              isNull(table.archivedAt),
              notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
            ),
        })
      : await transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, notInArray }) =>
            and(
              eq(table.organizationId, input.organizationId),
              eq(table.isDefault, true),
              isNull(table.archivedAt),
              notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES]),
            ),
        });
    if (!environment) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_BINDING_NOT_FOUND",
        "No available Environment is configured for this Thread.",
      );
    }

    const workspace = await findOrCreateWorkspace(transaction, {
      organizationId: input.organizationId,
      environmentId: environment.id,
      projectId: thread.projectId,
      threadId: thread.id,
      userId: input.userId,
    });
    const source = project ? "project" : "organization";
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
          eq(table.type, "workspace.provision"),
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
        eq(table.organizationId, input.organizationId),
      ),
  });
  if (!binding) return null;

  const [environment, workspace] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, binding.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt),
        ),
    }),
    knowledgeDb.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, binding.workspaceId),
          eq(table.environmentId, binding.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.deletedAt),
        ),
    }),
  ]);
  if (!(environment && workspace)) return null;
  return { binding, environment, workspace };
}

type EnvironmentTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

async function resolveWorkspaceSourceForActor(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    userId: string;
    source: WorkspaceSource;
  }
) {
  if (input.source.type === "blank") {
    return {
      sourceType: "blank" as const,
      sourceResourceId: null,
      sourceRepository: null,
      sourceDefaultBranch: null,
    };
  }
  const resourceId = input.source.resourceId;
  const [sourceResourceRow] = await transaction
    .select({ resource: schema.appConnectionResources })
    .from(schema.appConnectionResources)
    .innerJoin(
      schema.appConnections,
      eq(schema.appConnections.id, schema.appConnectionResources.connectionId)
    )
    .where(
      and(
        eq(schema.appConnectionResources.id, resourceId),
        eq(schema.appConnectionResources.resourceType, "repository"),
        eq(schema.appConnectionResources.enabled, true),
        eq(schema.appConnections.organizationId, input.organizationId),
        eq(schema.appConnections.appKey, "github"),
        eq(schema.appConnections.ownerType, "personal"),
        eq(schema.appConnections.userId, input.userId),
        eq(schema.appConnections.status, "connected")
      )
    )
    .limit(1);
  const sourceResource = sourceResourceRow?.resource ?? null;
  const grant = sourceResource
    ? await transaction.query.environmentAppCapabilityGrants.findFirst({
        where: (table, { and, eq, notInArray }) =>
          and(
            eq(table.environmentId, input.environmentId),
            eq(table.appKey, "github"),
            eq(table.capabilityKey, "repository.read"),
            eq(table.enabled, true),
            notInArray(table.approvalMode, ["deny"])
          ),
      })
    : null;
  if (!(sourceResource && sourceResource.permissions?.pull && grant)) {
    throw new EnvironmentContractError(
      "WORKSPACE_SOURCE_FORBIDDEN",
      "You or this Environment cannot read the repository."
    );
  }
  const metadata = sourceResource.metadata;
  return {
    sourceType: "github" as const,
    sourceResourceId: sourceResource.id,
    sourceRepository: sourceResource.label,
    sourceDefaultBranch:
      metadata &&
      typeof metadata === "object" &&
      "defaultBranch" in metadata &&
      typeof metadata.defaultBranch === "string"
        ? metadata.defaultBranch
        : null,
  };
}

async function findOrCreateWorkspace(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    environmentId: string;
    projectId: string | null;
    threadId: string;
    userId: string;
  },
) {
  const existing = await transaction.query.environmentWorkspaces.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        input.projectId
          ? eq(table.projectId, input.projectId)
          : eq(table.standaloneThreadId, input.threadId),
        isNull(table.deletedAt),
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
        eq(table.environmentId, input.environmentId),
      ),
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
}

export async function requestFailedWorkspaceProvisionRetry(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  userId: string;
}) {
  const lockKey = workspaceLifecycleLockKey(input.workspaceId);
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
    if (!workspace) return null;
    const operation =
      await transaction.query.environmentOperations.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.workspaceId, workspace.id),
            eq(table.type, "workspace.provision")
          ),
      });
    if (!operation) return null;
    if (
      workspace.status === "provisioning" &&
      (operation.status === "queued" || operation.status === "running")
    ) {
      return operation;
    }
    if (
      workspace.status !== "failed" ||
      (operation.status !== "failed" && operation.status !== "cancelled")
    ) {
      return null;
    }
    assertWorkspaceTransition(workspace.status, "provisioning");
    const now = new Date();
    const [retriedOperation] = await transaction
      .update(schema.environmentOperations)
      .set({
        status: "queued",
        stage: "environment.activation.requested",
        requestedByUserId: input.userId,
        providerRequestId: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.environmentOperations.id, operation.id))
      .returning();
    if (!retriedOperation) {
      throw new Error("Workspace provisioning retry was not persisted.");
    }
    await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: "provisioning",
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.environmentWorkspaces.id, workspace.id));
    return retriedOperation;
  });
}

export async function requestWorkspaceStart(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  userId: string;
}) {
  const lockKey = workspaceLifecycleLockKey(input.workspaceId);
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const workspace = await transaction.query.environmentWorkspaces.findFirst({
      where: (table, { and, eq, isNull }) =>
        and(
          eq(table.id, input.workspaceId),
          eq(table.environmentId, input.environmentId),
          eq(table.organizationId, input.organizationId),
          isNull(table.deletedAt),
        ),
    });
    if (!workspace?.flyMachineId) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace Machine is unavailable.",
      );
    }
    const active = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.workspaceId, workspace.id),
          eq(table.type, "workspace.start"),
          inArray(table.status, ["queued", "running"]),
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

export async function requestWorkspaceIdleStop(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  machineId: string;
  lastActivityAt: Date;
}) {
  const lockKey = workspaceLifecycleLockKey(input.workspaceId);
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
          eq(table.flyMachineId, input.machineId),
          isNull(table.deletedAt)
        ),
    });
    if (!workspace) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_FORBIDDEN",
        "Workspace idle identity does not match the provisioned Machine."
      );
    }
    const activePreview = await transaction.query.workspacePreviewLeases.findFirst({
      where: (table, { and, eq, gt, inArray }) => and(
        eq(table.workspaceId, workspace.id),
        inArray(table.status, ["provisioning", "active"]),
        gt(table.expiresAt, new Date())
      ),
      columns: { id: true },
    });
    if (activePreview) return null;
    const active = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq, inArray }) =>
        and(
          eq(table.workspaceId, workspace.id),
          eq(table.type, "workspace.stop"),
          inArray(table.status, ["queued", "running"])
        ),
    });
    if (active) return active;
    if (workspace.status !== "ready") {
      throw new EnvironmentContractError(
        "WORKSPACE_INVALID_TRANSITION",
        `Workspace cannot enter idle stop from '${workspace.status}'.`
      );
    }
    const operationId = crypto.randomUUID();
    const now = new Date();
    const [updatedWorkspace] = await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: "stopping",
        lastActivityAt: input.lastActivityAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environmentWorkspaces.id, workspace.id),
          eq(schema.environmentWorkspaces.status, "ready")
        )
      )
      .returning({ id: schema.environmentWorkspaces.id });
    if (!updatedWorkspace) {
      throw new EnvironmentContractError(
        "WORKSPACE_INVALID_TRANSITION",
        "Workspace lifecycle changed before the idle stop was accepted."
      );
    }
    const [operation] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: operationId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        type: "workspace.stop",
        status: "queued",
        stage: "environment.machine.stopping",
        idempotencyKey: `workspace.idle-stop:${workspace.id}:${input.lastActivityAt.toISOString()}`,
        input: {
          reason: "idle_timeout",
          lastActivityAt: input.lastActivityAt.toISOString(),
          machineId: input.machineId,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!operation) {
      throw new Error("Workspace idle stop operation could not be created.");
    }
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const [project, environment] = await Promise.all([
      transaction.query.projects.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.projectId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
          ),
      }),
      transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.environmentId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
          ),
      }),
    ]);
    if (!(project && environment)) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Project or Environment is unavailable.",
      );
    }
    if (project.environmentId !== input.environmentId) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Move the Project to this Environment before configuring its Workspace.",
      );
    }
    const source = input.source;
    const [sourceResourceRow] =
      source.type === "github"
        ? await transaction
            .select({ resource: schema.appConnectionResources })
            .from(schema.appConnectionResources)
            .innerJoin(
              schema.appConnections,
              eq(
                schema.appConnections.id,
                schema.appConnectionResources.connectionId,
              ),
            )
            .innerJoin(
              schema.projectAppConnections,
              and(
                eq(
                  schema.projectAppConnections.connectionId,
                  schema.appConnections.id,
                ),
                eq(schema.projectAppConnections.projectId, input.projectId),
                eq(schema.projectAppConnections.appKey, "github"),
              ),
            )
            .where(
              and(
                eq(schema.appConnectionResources.id, source.resourceId),
                eq(schema.appConnectionResources.resourceType, "repository"),
                eq(schema.appConnectionResources.enabled, true),
                eq(schema.appConnections.organizationId, input.organizationId),
                eq(schema.appConnections.appKey, "github"),
                eq(schema.appConnections.ownerType, "personal"),
                eq(schema.appConnections.userId, input.userId),
                eq(schema.appConnections.status, "connected"),
                eq(schema.projectAppConnections.scope, "personal"),
                eq(schema.projectAppConnections.userId, input.userId),
              ),
            )
            .limit(1)
        : [];
    const sourceResource = sourceResourceRow?.resource ?? null;
    if (source.type === "github") {
      const grant = sourceResource
        ? await transaction.query.environmentAppCapabilityGrants.findFirst({
            where: (table, { and, eq, notInArray }) =>
              and(
                eq(table.environmentId, input.environmentId),
                eq(table.appKey, "github"),
                eq(table.capabilityKey, "repository.read"),
                eq(table.enabled, true),
                notInArray(table.approvalMode, ["deny"]),
              ),
          })
        : null;
      const projectApp = sourceResource
        ? await transaction.query.projectApps.findFirst({
            where: (table, { and, eq }) =>
              and(
                eq(table.projectId, input.projectId),
                eq(table.appKey, "github"),
                eq(table.enabled, true),
              ),
          })
        : null;
      const projectPolicy = projectApp
        ? await transaction.query.projectAppCapabilityPolicies.findFirst({
            where: (table, { and, eq }) =>
              and(
                eq(table.projectId, input.projectId),
                eq(table.appKey, "github"),
                eq(table.capabilityKey, "repository.read"),
              ),
          })
        : null;
      if (
        !(
          sourceResource &&
          sourceResource.permissions?.pull &&
          grant &&
          projectApp &&
          (!projectPolicy ||
            (projectPolicy.enabled && projectPolicy.approvalMode !== "deny"))
        )
      ) {
        throw new EnvironmentContractError(
          "WORKSPACE_SOURCE_FORBIDDEN",
          "You or this Environment cannot read the repository.",
        );
      }
    }
    const sourceValues = sourceResource
      ? {
          sourceType: "github" as const,
          sourceResourceId: sourceResource.id,
          sourceRepository: sourceResource.label,
          sourceDefaultBranch:
            sourceResource.metadata &&
            typeof sourceResource.metadata === "object" &&
            "defaultBranch" in sourceResource.metadata &&
            typeof sourceResource.metadata.defaultBranch === "string"
              ? sourceResource.metadata.defaultBranch
              : null,
        }
      : {
          sourceType: "blank" as const,
          sourceResourceId: null,
          sourceRepository: null,
          sourceDefaultBranch: null,
        };
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
          isNull(table.deletedAt),
        ),
    });
    if (existing && existing.status !== "requested") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace source cannot change after provisioning has started.",
      );
    }
    const now = new Date();
    const workspaceId = existing?.id ?? crypto.randomUUID();
    const values = {
      ...sourceValues,
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
          eq(table.type, "workspace.provision"),
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

export async function createOrConfigureStandaloneThreadWorkspace(input: {
  organizationId: string;
  environmentId: string;
  threadId: string;
  userId: string;
  source: WorkspaceSource;
}) {
  const lockKey = `kestrel:thread-environment:${input.threadId}`;
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
    );
    const [thread, environment] = await Promise.all([
      transaction.query.threads.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.id, input.threadId),
            eq(table.organizationId, input.organizationId),
            eq(table.createdByUserId, input.userId),
            isNull(table.projectId),
            isNull(table.archivedAt)
          ),
      }),
      transaction.query.environments.findFirst({
        where: (table, { and, eq, isNull, notInArray }) =>
          and(
            eq(table.id, input.environmentId),
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
            notInArray(table.status, [...UNAVAILABLE_ENVIRONMENT_STATES])
          ),
      }),
    ]);
    if (!(thread && environment)) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_NOT_FOUND",
        "Standalone Thread or Environment is unavailable."
      );
    }
    const [existing, existingBinding] = await Promise.all([
      transaction.query.environmentWorkspaces.findFirst({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            eq(table.standaloneThreadId, input.threadId),
            isNull(table.deletedAt)
          ),
      }),
      transaction.query.threadExecutionBindings.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.threadId, input.threadId),
            eq(table.organizationId, input.organizationId)
          ),
      }),
    ]);
    if (existing && existing.status !== "requested") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace source cannot change after provisioning has started."
      );
    }
    if (
      existingBinding &&
      (!existing || existingBinding.workspaceId !== existing.id)
    ) {
      throw new EnvironmentContractError(
        "ENVIRONMENT_BINDING_NOT_FOUND",
        "Thread Environment binding references a different Workspace."
      );
    }
    const existingOperation = existing
      ? await transaction.query.environmentOperations.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.workspaceId, existing.id),
              eq(table.type, "workspace.provision")
            ),
        })
      : null;
    if (existingOperation && existingOperation.status !== "queued") {
      throw new EnvironmentContractError(
        "ENVIRONMENT_UNAVAILABLE",
        "Workspace source cannot change after provisioning has started."
      );
    }
    const sourceValues = await resolveWorkspaceSourceForActor(transaction, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      userId: input.userId,
      source: input.source,
    });
    const now = new Date();
    const workspaceId = existing?.id ?? crypto.randomUUID();
    const workspace = existing
      ? (
          await transaction
            .update(schema.environmentWorkspaces)
            .set({
              environmentId: input.environmentId,
              ...sourceValues,
              updatedAt: now,
            })
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
              standaloneThreadId: input.threadId,
              createdByUserId: input.userId,
              name: thread.title || "Thread workspace",
              kind: "scratch",
              status: "requested",
              createdAt: now,
              updatedAt: now,
              ...sourceValues,
            })
            .returning()
        )[0];
    if (!workspace) {
      throw new Error("Standalone Thread Workspace creation failed.");
    }
    const [binding] = await transaction
      .insert(schema.threadExecutionBindings)
      .values({
        threadId: input.threadId,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: workspace.id,
        source: "thread",
        boundByUserId: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.threadExecutionBindings.threadId,
        set: {
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: workspace.id,
          source: "thread",
          boundByUserId: input.userId,
          updatedAt: now,
        },
      })
      .returning();
    if (!binding) {
      throw new Error("Standalone Thread Environment binding failed.");
    }
    const operation = existingOperation
      ? (
          await transaction
            .update(schema.environmentOperations)
            .set({
              environmentId: input.environmentId,
              input: { sourceType: input.source.type },
              updatedAt: now,
            })
            .where(eq(schema.environmentOperations.id, existingOperation.id))
            .returning()
        )[0]
      : (
          await transaction
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
            .returning()
        )[0];
    if (!operation) {
      throw new Error("Standalone Thread Workspace operation failed.");
    }
    return { binding, workspace, operation };
  });
}
