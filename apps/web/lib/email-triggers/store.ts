import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { isKestrelRuntimeModelSelectionAvailableInTransaction } from "@/lib/ai/runtime-model-selection";
import { projectEnvironmentBindingLockKey } from "@/lib/environments/lifecycle-lock";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  ProjectAccessError,
  projectRoleAllows,
  requireProjectRole,
} from "@/lib/projects/access";
import { DEFAULT_EMAIL_TRIGGER_INSTRUCTION } from "./shared";

export { DEFAULT_EMAIL_TRIGGER_INSTRUCTION } from "./shared";

export const EMAIL_TRIGGER_DISABLED_REASONS = [
  "manual",
  "project_archived",
  "execution_owner_access_lost",
  "deleted",
] as const;

export const EMAIL_TRIGGER_READINESS_REASONS = [
  "project_archived",
  "execution_owner_access_lost",
  "inbound_receiving_unavailable",
  "environment_model_unavailable",
] as const;

type EmailTriggerReadinessReason =
  (typeof EMAIL_TRIGGER_READINESS_REASONS)[number];
type EmailTriggerTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

export class EmailTriggerConflictError extends Error {
  readonly code = "EMAIL_TRIGGER_REVISION_CONFLICT";

  constructor() {
    super("The Email Trigger changed. Refresh it and try again.");
    this.name = "EmailTriggerConflictError";
  }
}

export class EmailTriggerReadinessError extends Error {
  readonly code = "EMAIL_TRIGGER_NOT_READY";

  constructor(
    readonly reason: EmailTriggerReadinessReason,
    message: string,
  ) {
    super(message);
    this.name = "EmailTriggerReadinessError";
  }
}

export class EmailTriggerAddressConflictError extends Error {
  readonly code = "EMAIL_TRIGGER_ADDRESS_CONFLICT";

  constructor() {
    super("That email alias is already in use.");
    this.name = "EmailTriggerAddressConflictError";
  }
}

export class EmailTriggerPublicAliasError extends Error {
  readonly code = "EMAIL_TRIGGER_PUBLIC_ALIAS";

  constructor() {
    super("Public email aliases are changed by editing the Email Trigger.");
    this.name = "EmailTriggerPublicAliasError";
  }
}

export type ProjectEmailTriggerSummary = {
  id: string;
  organizationId: string;
  project: { id: string; name: string };
  creator: { id: string; name: string } | null;
  executionOwner: { id: string; name: string } | null;
  name: string;
  instruction: string;
  modelId: string;
  claimedFromFilter: string | null;
  accessMode: "private" | "public";
  alias: string;
  address: string;
  enabled: boolean;
  disabledReason: string | null;
  revision: number;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  latestReceipt: {
    id: string;
    state:
      | "queued"
      | "hydrating"
      | "admitted"
      | "materialized"
      | "rejected"
      | "failed";
    receivedAt: Date;
    threadId: string | null;
    reason: string | null;
  } | null;
  readiness: {
    receiving: boolean;
    project: boolean;
    executionOwner: boolean;
    model: boolean;
    reason: EmailTriggerReadinessReason | null;
  };
  permissions: {
    canEdit: boolean;
    canRotate: boolean;
    canEnable: boolean;
    canDisable: boolean;
    canDelete: boolean;
  };
};

function generatePrivateAddressLocalPart() {
  // 16 cryptographically random bytes provide exactly 128 bits of entropy.
  return randomBytes(16).toString("hex");
}

async function withAddressConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const visited = new Set<unknown>();
    let current = error;
    while (current && typeof current === "object" && !visited.has(current)) {
      visited.add(current);
      const constraint =
        "constraint_name" in current
          ? current.constraint_name
          : "constraint" in current
            ? current.constraint
            : undefined;
      if (
        "code" in current &&
        String(current.code) === "23505" &&
        constraint === "project_email_triggers_address_idx"
      ) {
        throw new EmailTriggerAddressConflictError();
      }
      current = "cause" in current ? current.cause : undefined;
    }
    throw error;
  }
}

function normalizeName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("A Trigger name is required.");
  if (name.length > 120) {
    throw new Error("Trigger name must be 120 characters or fewer.");
  }
  return name;
}

function normalizeAddressAlias(value: string) {
  const alias = value.trim().toLowerCase();
  if (
    alias.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(alias) ||
    alias.includes("..")
  ) {
    throw new Error(
      "Use an email alias with lowercase letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return alias;
}

function normalizeInstruction(value: string) {
  const instruction = value.trim();
  if (!instruction) throw new Error("A Trigger instruction is required.");
  return instruction;
}

function normalizeModelId(value: string) {
  const modelId = value.trim();
  if (!modelId) throw new Error("A model is required.");
  if (modelId.length > 200) {
    throw new Error("Model IDs must be 200 characters or fewer.");
  }
  return modelId;
}

function normalizeClaimedFromFilter(value: string | null | undefined) {
  const filter = value?.trim() || null;
  if (filter && filter.length > 320) {
    throw new Error("Claimed-From filters must be 320 characters or fewer.");
  }
  return filter;
}

async function lockProjectEmailTriggerAccessInTransaction(
  tx: EmailTriggerTransaction,
  input: {
    organizationId: string;
    projectId: string;
    userId: string;
  },
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectEnvironmentBindingLockKey(input.projectId)}, 0))`,
  );
  const [project] = await tx
    .select({
      archivedAt: schema.projects.archivedAt,
      environmentId: schema.projects.environmentId,
    })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.organizationId, input.organizationId),
      ),
    )
    .limit(1)
    .for("update");
  if (!project) return null;

  const [access] = await tx
    .select({ role: schema.projectMembers.role })
    .from(schema.projectMembers)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
    )
    .where(eq(schema.projectMembers.projectId, input.projectId))
    .limit(1)
    .for("update");
  if (!access) return null;

  return { ...project, role: access.role };
}

async function receivingIsReadyInTransaction(
  tx: EmailTriggerTransaction,
  organizationId: string,
) {
  const [connection] = await tx
    .select({ id: schema.organizationReceivingConnections.id })
    .from(schema.organizationReceivingConnections)
    .where(
      and(
        eq(
          schema.organizationReceivingConnections.organizationId,
          organizationId,
        ),
        eq(
          schema.organizationReceivingConnections.credentialStatus,
          "full_access",
        ),
        eq(
          schema.organizationReceivingConnections.receivingDomainStatus,
          "verified",
        ),
        eq(schema.organizationReceivingConnections.mxStatus, "verified"),
        eq(schema.organizationReceivingConnections.webhookStatus, "active"),
        eq(schema.organizationReceivingConnections.inboundEnabled, true),
        isNull(schema.organizationReceivingConnections.lastErrorCode),
        sql`${schema.organizationReceivingConnections.lastHealthCheckedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  return Boolean(connection);
}

async function executionOwnerHasAccessInTransaction(
  tx: EmailTriggerTransaction,
  input: {
    organizationId: string;
    projectId: string;
    executionOwnerUserId: string | null;
  },
) {
  if (!input.executionOwnerUserId) return false;
  const [access] = await tx
    .select({ id: schema.projectMembers.organizationMemberId })
    .from(schema.projectMembers)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.executionOwnerUserId),
      ),
    )
    .where(eq(schema.projectMembers.projectId, input.projectId))
    .limit(1);
  return Boolean(access);
}

function readinessReason(input: {
  project: boolean;
  executionOwner: boolean;
  receiving: boolean;
  model: boolean;
}): EmailTriggerReadinessReason | null {
  if (!input.project) return "project_archived";
  if (!input.executionOwner) return "execution_owner_access_lost";
  if (!input.receiving) return "inbound_receiving_unavailable";
  if (!input.model) return "environment_model_unavailable";
  return null;
}

function readinessMessage(reason: EmailTriggerReadinessReason) {
  switch (reason) {
    case "project_archived":
      return "Restore the Project before enabling this Email Trigger.";
    case "execution_owner_access_lost":
      return "The Execution Owner must have current Project access.";
    case "inbound_receiving_unavailable":
      return "Inbound receiving must be active and healthy before enabling this Email Trigger.";
    case "environment_model_unavailable":
      return "The selected model is not available in this Project Environment.";
  }
}

async function emailTriggerReadinessInTransaction(
  tx: EmailTriggerTransaction,
  input: {
    organizationId: string;
    projectId: string;
    projectArchivedAt: Date | null;
    environmentId: string;
    executionOwnerUserId: string | null;
    modelId: string;
  },
) {
  const readiness = {
    project: !input.projectArchivedAt,
    executionOwner: await executionOwnerHasAccessInTransaction(tx, input),
    receiving: await receivingIsReadyInTransaction(tx, input.organizationId),
    model: await isKestrelRuntimeModelSelectionAvailableInTransaction(tx, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      modelId: input.modelId,
    }),
  };
  const reason = readinessReason(readiness);
  return { ...readiness, reason };
}

async function assertEnablementReady(
  tx: EmailTriggerTransaction,
  input: {
    organizationId: string;
    projectId: string;
    projectArchivedAt: Date | null;
    environmentId: string;
    executionOwnerUserId: string | null;
    modelId: string;
  },
) {
  const readiness = await emailTriggerReadinessInTransaction(tx, input);
  const reason = readiness.reason;
  if (reason) {
    throw new EmailTriggerReadinessError(reason, readinessMessage(reason));
  }
}

export async function listProjectEmailTriggersForUser(input: {
  organizationId: string;
  userId: string;
  projectId?: string;
}): Promise<ProjectEmailTriggerSummary[]> {
  if (input.projectId) {
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      includeArchived: true,
    });
  }

  return knowledgeDb.transaction(async (tx) => {
    const rows = await tx
      .select({
        trigger: schema.projectEmailTriggers,
        projectName: schema.projects.name,
        projectArchivedAt: schema.projects.archivedAt,
        projectEnvironmentId: schema.projects.environmentId,
        role: schema.projectMembers.role,
        creatorName: schema.users.name,
      })
      .from(schema.projectEmailTriggers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectEmailTriggers.projectId),
          eq(
            schema.projects.organizationId,
            schema.projectEmailTriggers.organizationId,
          ),
        ),
      )
      .innerJoin(
        schema.projectMembers,
        eq(schema.projectMembers.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.members,
        and(
          eq(schema.members.id, schema.projectMembers.organizationMemberId),
          eq(schema.members.organizationId, input.organizationId),
          eq(schema.members.userId, input.userId),
        ),
      )
      .leftJoin(
        schema.users,
        eq(schema.users.id, schema.projectEmailTriggers.executionOwnerUserId),
      )
      .where(
        and(
          eq(schema.projectEmailTriggers.organizationId, input.organizationId),
          isNull(schema.projectEmailTriggers.deletedAt),
          input.projectId
            ? eq(schema.projectEmailTriggers.projectId, input.projectId)
            : undefined,
        ),
      )
      .orderBy(
        asc(schema.projects.name),
        asc(schema.projectEmailTriggers.createdAt),
      );

    const receiving = await receivingIsReadyInTransaction(
      tx,
      input.organizationId,
    );
    return Promise.all(
      rows.map(async ({
        trigger,
        projectName,
        projectArchivedAt,
        projectEnvironmentId,
        role,
        creatorName,
      }) => {
        const [executionOwner, model, latestReceipt] = await Promise.all([
          executionOwnerHasAccessInTransaction(tx, {
            organizationId: trigger.organizationId,
            projectId: trigger.projectId,
            executionOwnerUserId: trigger.executionOwnerUserId,
          }),
          isKestrelRuntimeModelSelectionAvailableInTransaction(tx, {
            organizationId: trigger.organizationId,
            environmentId: projectEnvironmentId,
            modelId: trigger.modelId,
          }),
          tx
            .select({
              id: schema.emailDeliveryReceipts.id,
              state: schema.emailDeliveryReceipts.state,
              receivedAt: schema.emailDeliveryReceipts.eventAt,
              threadId: schema.emailDeliveryReceipts.materializedThreadId,
              reason: schema.emailDeliveryReceipts.reason,
            })
            .from(schema.emailDeliveryReceipts)
            .where(
              and(
                eq(
                  schema.emailDeliveryReceipts.organizationId,
                  trigger.organizationId,
                ),
                eq(schema.emailDeliveryReceipts.triggerId, trigger.id),
              ),
            )
            .orderBy(sql`${schema.emailDeliveryReceipts.eventAt} DESC`)
            .limit(1)
            .then(([receipt]) => receipt ?? null),
        ]);
        const project = !projectArchivedAt;
        const reason = readinessReason({
          receiving,
          project,
          executionOwner,
          model,
        });
        const canMutate = projectRoleAllows(role, "editor");
        return {
          id: trigger.id,
          organizationId: trigger.organizationId,
          project: { id: trigger.projectId, name: projectName },
          creator: trigger.createdByUserId
            ? { id: trigger.createdByUserId, name: creatorName ?? "Former member" }
            : null,
          executionOwner: trigger.executionOwnerUserId
            ? {
                id: trigger.executionOwnerUserId,
                name: creatorName ?? "Former member",
              }
            : null,
          name: trigger.name,
          instruction: trigger.instruction,
          modelId: trigger.modelId,
          claimedFromFilter: trigger.claimedFromFilter,
          accessMode: trigger.accessMode,
          alias: trigger.addressLocalPart,
          address: `${trigger.addressLocalPart}@${trigger.addressDomain}`,
          enabled: trigger.enabled,
          disabledReason: trigger.disabledReason,
          revision: trigger.revision,
          rotatedAt: trigger.rotatedAt,
          createdAt: trigger.createdAt,
          updatedAt: trigger.updatedAt,
          latestReceipt: projectLatestEmailReceipt(latestReceipt),
          readiness: {
            receiving,
            project,
            executionOwner,
            model,
            reason,
          },
          permissions: {
            canEdit: canMutate,
            canRotate: canMutate && trigger.accessMode === "private",
            canEnable: canMutate && !trigger.enabled && reason === null,
            canDisable: canMutate && trigger.enabled,
            canDelete: canMutate,
          },
        } satisfies ProjectEmailTriggerSummary;
      }),
    );
  });
}

function projectLatestEmailReceipt(
  receipt: {
    id: string;
    state: typeof schema.emailDeliveryReceipts.$inferSelect.state;
    receivedAt: Date;
    threadId: string | null;
    reason: string | null;
  } | null,
): ProjectEmailTriggerSummary["latestReceipt"] {
  if (!receipt) return null;
  switch (receipt.state) {
    case "queued":
      return { ...receipt, state: "queued" };
    case "hydrating":
      return { ...receipt, state: "hydrating" };
    case "admitted":
      return { ...receipt, state: "admitted" };
    case "materialized":
      return { ...receipt, state: "materialized" };
    case "rejected":
      return { ...receipt, state: "rejected" };
    case "failed":
      return { ...receipt, state: "failed" };
  }
}

export async function createProjectEmailTrigger(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  name: string;
  alias: string;
  instruction?: string;
  modelId: string;
  claimedFromFilter?: string | null;
  enabled?: boolean;
}) {
  const name = normalizeName(input.name);
  const alias = normalizeAddressAlias(input.alias);
  const instruction = normalizeInstruction(
    input.instruction ?? DEFAULT_EMAIL_TRIGGER_INSTRUCTION,
  );
  const modelId = normalizeModelId(input.modelId);
  const claimedFromFilter = normalizeClaimedFromFilter(
    input.claimedFromFilter,
  );
  return withAddressConflict(() => knowledgeDb.transaction(async (tx) => {
    const access = await lockProjectEmailTriggerAccessInTransaction(tx, input);
    if (!access || access.archivedAt) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Project not found or unavailable.",
      );
    }
    if (!projectRoleAllows(access.role, "editor")) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Project editor access is required.",
      );
    }

    const [connection] = await tx
      .select({ receivingDomain: schema.organizationReceivingConnections.receivingDomain })
      .from(schema.organizationReceivingConnections)
      .where(
        eq(
          schema.organizationReceivingConnections.organizationId,
          input.organizationId,
        ),
      )
      .limit(1)
      .for("update");
    const addressDomain = connection?.receivingDomain?.trim().toLowerCase();
    if (!addressDomain) {
      throw new EmailTriggerReadinessError(
        "inbound_receiving_unavailable",
        readinessMessage("inbound_receiving_unavailable"),
      );
    }

    const readiness = await emailTriggerReadinessInTransaction(tx, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      projectArchivedAt: access.archivedAt,
      environmentId: access.environmentId,
      executionOwnerUserId: input.userId,
      modelId,
    });
    if (!readiness.model) {
      throw new EmailTriggerReadinessError(
        "environment_model_unavailable",
        readinessMessage("environment_model_unavailable"),
      );
    }
    if (input.enabled === true && readiness.reason) {
      throw new EmailTriggerReadinessError(
        readiness.reason,
        readinessMessage(readiness.reason),
      );
    }
    const enabled = input.enabled ?? readiness.reason === null;

    const now = new Date();
    const [created] = await tx
      .insert(schema.projectEmailTriggers)
      .values({
        id: randomUUID(),
        organizationId: input.organizationId,
        projectId: input.projectId,
        createdByUserId: input.userId,
        executionOwnerUserId: input.userId,
        name,
        instruction,
        modelId,
        claimedFromFilter,
        accessMode: "public",
        addressLocalPart: alias,
        addressDomain,
        enabled,
        disabledReason: enabled ? null : "manual",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("Email Trigger creation failed.");
    await tx.insert(schema.projectAuditEvents).values({
      id: randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "project.email_trigger.created",
      targetType: "project_email_trigger",
      targetId: created.id,
      metadata: { accessMode: "public", revision: 1, enabled },
      createdAt: now,
    });
    return created;
  }));
}

export async function updateProjectEmailTrigger(input: {
  triggerId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  expectedRevision: number;
  name?: string;
  alias?: string;
  instruction?: string;
  modelId?: string;
  claimedFromFilter?: string | null;
  enabled?: boolean;
}) {
  return withAddressConflict(() => knowledgeDb.transaction(async (tx) => {
    const access = await lockProjectEmailTriggerAccessInTransaction(tx, input);
    if (!access) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Email Trigger not found or unavailable.",
      );
    }
    if (!projectRoleAllows(access.role, "editor")) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Project editor access is required.",
      );
    }
    const [trigger] = await tx
      .select()
      .from(schema.projectEmailTriggers)
      .where(
        and(
          eq(schema.projectEmailTriggers.id, input.triggerId),
          eq(schema.projectEmailTriggers.projectId, input.projectId),
          eq(schema.projectEmailTriggers.organizationId, input.organizationId),
          isNull(schema.projectEmailTriggers.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!trigger) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Email Trigger not found or unavailable.",
      );
    }
    if (trigger.revision !== input.expectedRevision) {
      throw new EmailTriggerConflictError();
    }
    const name =
      input.name === undefined ? trigger.name : normalizeName(input.name);
    const alias =
      input.alias === undefined
        ? trigger.addressLocalPart
        : normalizeAddressAlias(input.alias);
    const aliasChanged = alias !== trigger.addressLocalPart;
    let addressDomain = trigger.addressDomain;
    if (aliasChanged) {
      const [connection] = await tx
        .select({
          receivingDomain:
            schema.organizationReceivingConnections.receivingDomain,
        })
        .from(schema.organizationReceivingConnections)
        .where(
          eq(
            schema.organizationReceivingConnections.organizationId,
            input.organizationId,
          ),
        )
        .limit(1)
        .for("update");
      const configuredDomain = connection?.receivingDomain
        ?.trim()
        .toLowerCase();
      if (!configuredDomain) {
        throw new EmailTriggerReadinessError(
          "inbound_receiving_unavailable",
          readinessMessage("inbound_receiving_unavailable"),
        );
      }
      addressDomain = configuredDomain;
    }
    const instruction =
      input.instruction === undefined
        ? trigger.instruction
        : normalizeInstruction(input.instruction);
    const modelId =
      input.modelId === undefined
        ? trigger.modelId
        : normalizeModelId(input.modelId);
    const claimedFromFilter =
      input.claimedFromFilter === undefined
        ? trigger.claimedFromFilter
        : normalizeClaimedFromFilter(input.claimedFromFilter);
    const enabled = input.enabled ?? trigger.enabled;
    if (
      (input.modelId !== undefined || input.enabled === true) &&
      !(await isKestrelRuntimeModelSelectionAvailableInTransaction(tx, {
        organizationId: input.organizationId,
        environmentId: access.environmentId,
        modelId,
      }))
    ) {
      throw new EmailTriggerReadinessError(
        "environment_model_unavailable",
        readinessMessage("environment_model_unavailable"),
      );
    }
    if (input.enabled === true) {
      await assertEnablementReady(tx, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectArchivedAt: access.archivedAt,
        environmentId: access.environmentId,
        executionOwnerUserId: trigger.executionOwnerUserId,
        modelId,
      });
    }

    const revisionChanges =
      instruction !== trigger.instruction ||
      modelId !== trigger.modelId ||
      claimedFromFilter !== trigger.claimedFromFilter ||
      aliasChanged ||
      enabled !== trigger.enabled;
    const disableTransition = input.enabled === false && trigger.enabled;
    const disabledReason = disableTransition
      ? "manual"
      : input.enabled === true
        ? null
        : trigger.disabledReason;
    if (
      name === trigger.name &&
      alias === trigger.addressLocalPart &&
      !revisionChanges &&
      disabledReason === trigger.disabledReason
    ) {
      return trigger;
    }
    const revision = trigger.revision + (revisionChanges ? 1 : 0);
    const now = new Date();
    const [updated] = await tx
      .update(schema.projectEmailTriggers)
      .set({
        name,
        addressLocalPart: alias,
        addressDomain,
        accessMode: aliasChanged ? "public" : trigger.accessMode,
        instruction,
        modelId,
        claimedFromFilter,
        enabled,
        disabledReason,
        revision,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectEmailTriggers.id, trigger.id),
          eq(schema.projectEmailTriggers.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!updated) throw new EmailTriggerConflictError();
    await tx.insert(schema.projectAuditEvents).values({
      id: randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action:
        disableTransition
          ? "project.email_trigger.disabled"
          : input.enabled === true
            ? "project.email_trigger.enabled"
            : "project.email_trigger.updated",
      targetType: "project_email_trigger",
      targetId: trigger.id,
      metadata: { revision },
      createdAt: now,
    });
    return updated;
  }));
}

export async function rotateProjectEmailTriggerAddress(input: {
  triggerId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  expectedRevision: number;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const access = await lockProjectEmailTriggerAccessInTransaction(tx, input);
    if (!(access && projectRoleAllows(access.role, "editor"))) {
      throw new ProjectAccessError(
        access ? "PROJECT_FORBIDDEN" : "PROJECT_NOT_FOUND",
        access
          ? "Project editor access is required."
          : "Email Trigger not found or unavailable.",
      );
    }
    const [trigger] = await tx
      .select()
      .from(schema.projectEmailTriggers)
      .where(
        and(
          eq(schema.projectEmailTriggers.id, input.triggerId),
          eq(schema.projectEmailTriggers.projectId, input.projectId),
          eq(schema.projectEmailTriggers.organizationId, input.organizationId),
          isNull(schema.projectEmailTriggers.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!trigger) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Email Trigger not found or unavailable.",
      );
    }
    if (trigger.revision !== input.expectedRevision) {
      throw new EmailTriggerConflictError();
    }
    if (trigger.accessMode === "public") {
      throw new EmailTriggerPublicAliasError();
    }
    const [connection] = await tx
      .select({
        receivingDomain: schema.organizationReceivingConnections.receivingDomain,
      })
      .from(schema.organizationReceivingConnections)
      .where(
        eq(
          schema.organizationReceivingConnections.organizationId,
          input.organizationId,
        ),
      )
      .limit(1)
      .for("update");
    const addressDomain = connection?.receivingDomain?.trim().toLowerCase();
    if (!addressDomain) {
      throw new EmailTriggerReadinessError(
        "inbound_receiving_unavailable",
        readinessMessage("inbound_receiving_unavailable"),
      );
    }
    if (trigger.enabled) {
      await assertEnablementReady(tx, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectArchivedAt: access.archivedAt,
        environmentId: access.environmentId,
        executionOwnerUserId: trigger.executionOwnerUserId,
        modelId: trigger.modelId,
      });
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.projectEmailTriggers)
      .set({
        addressLocalPart: generatePrivateAddressLocalPart(),
        addressDomain,
        revision: sql`${schema.projectEmailTriggers.revision} + 1`,
        rotatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectEmailTriggers.id, trigger.id),
          eq(schema.projectEmailTriggers.revision, input.expectedRevision),
          isNull(schema.projectEmailTriggers.deletedAt),
        ),
      )
      .returning();
    if (!updated) throw new EmailTriggerConflictError();
    await tx.insert(schema.projectAuditEvents).values({
      id: randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "project.email_trigger.rotated",
      targetType: "project_email_trigger",
      targetId: input.triggerId,
      metadata: { revision: updated.revision },
      createdAt: now,
    });
    return updated;
  });
}

export async function deleteProjectEmailTrigger(input: {
  triggerId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  expectedRevision: number;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const access = await lockProjectEmailTriggerAccessInTransaction(tx, input);
    if (!(access && projectRoleAllows(access.role, "editor"))) {
      throw new ProjectAccessError(
        access ? "PROJECT_FORBIDDEN" : "PROJECT_NOT_FOUND",
        access
          ? "Project editor access is required."
          : "Email Trigger not found or unavailable.",
      );
    }
    const now = new Date();
    const [deleted] = await tx
      .update(schema.projectEmailTriggers)
      .set({
        enabled: false,
        disabledReason: "deleted",
        deletedAt: now,
        revision: sql`${schema.projectEmailTriggers.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectEmailTriggers.id, input.triggerId),
          eq(schema.projectEmailTriggers.projectId, input.projectId),
          eq(schema.projectEmailTriggers.organizationId, input.organizationId),
          eq(schema.projectEmailTriggers.revision, input.expectedRevision),
          isNull(schema.projectEmailTriggers.deletedAt),
        ),
      )
      .returning();
    if (!deleted) throw new EmailTriggerConflictError();
    await tx.insert(schema.projectAuditEvents).values({
      id: randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "project.email_trigger.deleted",
      targetType: "project_email_trigger",
      targetId: input.triggerId,
      metadata: { revision: deleted.revision },
      createdAt: now,
    });
    return deleted;
  });
}
