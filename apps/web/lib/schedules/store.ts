import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isKestrelRuntimeModelSelectionAvailableInTransaction } from "@/lib/ai/runtime-model-selection";
import {
  type ProjectRole,
  ProjectAccessError,
  projectRoleAllows,
  requireProjectRole,
} from "@/lib/projects/access";
import {
  latestDueProjectPromptScheduleOccurrence,
  nextProjectPromptScheduleOccurrence,
  validateProjectPromptSchedule,
} from "./cron";

export const PROJECT_PROMPT_SCHEDULE_PAUSE_REASONS = [
  "manual",
  "project_archived",
  "creator_access_lost",
  "environment_model_unavailable",
] as const;

type SchedulePauseReason =
  (typeof PROJECT_PROMPT_SCHEDULE_PAUSE_REASONS)[number];

export type ProjectPromptScheduleSummary = {
  id: string;
  organizationId: string;
  project: { id: string; name: string };
  creator: { id: string; name: string } | null;
  cronExpression: string;
  timeZone: string;
  prompt: string;
  modelId: string | null;
  enabled: boolean;
  pauseReason: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  permissions: {
    canEdit: boolean;
    canEnable: boolean;
    canPause: boolean;
    canDelete: boolean;
  };
  latestRun: {
    id: string;
    scheduledFor: Date;
    catchUpFrom: Date | null;
    status: "queued" | "materialized" | "failed" | "cancelled";
    threadId: string | null;
    threadTitle: string | null;
    turnStatus:
      | "queued"
      | "running"
      | "waiting_for_input"
      | "completed"
      | "failed"
      | "cancelled"
      | null;
    failure: { code: string | null; message: string | null } | null;
  } | null;
};

function schedulePermissions(input: {
  creatorUserId: string | null;
  role: ProjectRole;
  userId: string;
}) {
  const isCreator = input.creatorUserId === input.userId;
  const isOwner = input.role === "owner";
  return {
    canEdit: isCreator,
    canEnable: isCreator,
    canPause: isCreator || isOwner,
    canDelete: isCreator || isOwner,
  };
}

async function latestScheduleRun(scheduleId: string) {
  const [latest] = await knowledgeDb
    .select({
      id: schema.projectPromptScheduleRuns.id,
      scheduledFor: schema.projectPromptScheduleRuns.scheduledFor,
      catchUpFrom: schema.projectPromptScheduleRuns.catchUpFrom,
      status: schema.projectPromptScheduleRuns.status,
      threadId: schema.threads.id,
      threadTitle: schema.threads.title,
      turnStatus: schema.threadTurns.status,
      failureCode: schema.projectPromptScheduleRuns.failureCode,
      failureMessage: schema.projectPromptScheduleRuns.failureMessage,
    })
    .from(schema.projectPromptScheduleRuns)
    .leftJoin(
      schema.threads,
      eq(schema.threads.id, schema.projectPromptScheduleRuns.threadId),
    )
    .leftJoin(
      schema.threadTurns,
      eq(schema.threadTurns.id, schema.projectPromptScheduleRuns.turnId),
    )
    .where(eq(schema.projectPromptScheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(schema.projectPromptScheduleRuns.scheduledFor))
    .limit(1);
  if (!latest) return null;
  return {
    id: latest.id,
    scheduledFor: latest.scheduledFor,
    catchUpFrom: latest.catchUpFrom,
    status: latest.status,
    threadId: latest.threadId,
    threadTitle: latest.threadTitle,
    turnStatus: latest.turnStatus,
    failure:
      latest.failureCode || latest.failureMessage
        ? { code: latest.failureCode, message: latest.failureMessage }
        : null,
  };
}

export async function listProjectPromptSchedulesForUser(input: {
  organizationId: string;
  userId: string;
  projectId?: string;
}) {
  if (input.projectId) {
    await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      includeArchived: true,
    });
  }
  const rows = await knowledgeDb
    .select({
      schedule: schema.projectPromptSchedules,
      projectName: schema.projects.name,
      role: schema.projectMembers.role,
      creatorName: schema.users.name,
    })
    .from(schema.projectPromptSchedules)
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.projectPromptSchedules.projectId),
        eq(
          schema.projects.organizationId,
          schema.projectPromptSchedules.organizationId,
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
        eq(
          schema.members.id,
          schema.projectMembers.organizationMemberId,
        ),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
    )
    .leftJoin(
      schema.users,
      eq(schema.users.id, schema.projectPromptSchedules.createdByUserId),
    )
    .where(
      and(
        eq(schema.projectPromptSchedules.organizationId, input.organizationId),
        input.projectId
          ? eq(schema.projectPromptSchedules.projectId, input.projectId)
          : undefined,
      ),
    )
    .orderBy(
      asc(schema.projects.name),
      asc(schema.projectPromptSchedules.createdAt),
    );

  return Promise.all(
    rows.map(async ({ schedule, projectName, role, creatorName }) => ({
      ...schedule,
      project: { id: schedule.projectId, name: projectName },
      creator: schedule.createdByUserId
        ? { id: schedule.createdByUserId, name: creatorName ?? "Former member" }
        : null,
      permissions: schedulePermissions({
        creatorUserId: schedule.createdByUserId,
        role,
        userId: input.userId,
      }),
      latestRun: await latestScheduleRun(schedule.id),
    })),
  ) satisfies Promise<ProjectPromptScheduleSummary[]>;
}

export async function createProjectPromptSchedule(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  cronExpression: string;
  timeZone: string;
  prompt: string;
  modelId: string;
}) {
  const validated = validateProjectPromptSchedule(input);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("A prompt is required.");
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error("A model is required.");
  const now = new Date();
  const schedule = await knowledgeDb.transaction(async (tx) => {
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
    if (!project || project.archivedAt) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Project not found or unavailable.",
      );
    }
    const [access] = await tx
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .innerJoin(
        schema.members,
        and(
          eq(
            schema.members.id,
            schema.projectMembers.organizationMemberId,
          ),
          eq(schema.members.organizationId, input.organizationId),
          eq(schema.members.userId, input.userId),
        ),
      )
      .where(eq(schema.projectMembers.projectId, input.projectId))
      .limit(1)
      .for("update");
    if (!access) {
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
    if (
      !(await isKestrelRuntimeModelSelectionAvailableInTransaction(tx, {
        organizationId: input.organizationId,
        environmentId: project.environmentId,
        modelId,
      }))
    ) {
      throw Object.assign(
        new Error("The selected model is not available in this Project Environment."),
        { code: "SCHEDULE_MODEL_UNAVAILABLE" },
      );
    }
    const [inserted] = await tx
      .insert(schema.projectPromptSchedules)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        projectId: input.projectId,
        createdByUserId: input.userId,
        cronExpression: validated.cronExpression,
        timeZone: validated.timeZone,
        prompt,
        modelId,
        enabled: true,
        pauseReason: null,
        nextRunAt: nextProjectPromptScheduleOccurrence({
          ...validated,
          after: now,
        }),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error("Schedule creation failed.");
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "project.schedule.created",
      targetType: "project_prompt_schedule",
      targetId: inserted.id,
      createdAt: now,
    });
    return inserted;
  });
  return schedule;
}

export async function updateProjectPromptSchedule(input: {
  scheduleId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  cronExpression?: string;
  timeZone?: string;
  prompt?: string;
  modelId?: string;
  enabled?: boolean;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const [schedule] = await tx
      .select()
      .from(schema.projectPromptSchedules)
      .where(
        and(
          eq(schema.projectPromptSchedules.id, input.scheduleId),
          eq(schema.projectPromptSchedules.projectId, input.projectId),
          eq(
            schema.projectPromptSchedules.organizationId,
            input.organizationId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!schedule) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Schedule not found or unavailable.",
      );
    }
    const [access] = await tx
      .select({
        projectArchivedAt: schema.projects.archivedAt,
        projectEnvironmentId: schema.projects.environmentId,
        role: schema.projectMembers.role,
      })
      .from(schema.projects)
      .innerJoin(
        schema.projectMembers,
        eq(schema.projectMembers.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.members,
        and(
          eq(
            schema.members.id,
            schema.projectMembers.organizationMemberId,
          ),
          eq(schema.members.organizationId, input.organizationId),
          eq(schema.members.userId, input.userId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!access) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Schedule not found or unavailable.",
      );
    }

    const isCreator = schedule.createdByUserId === input.userId;
    const isOwner = access.role === "owner";
    const changesDefinition =
      input.cronExpression !== undefined ||
      input.timeZone !== undefined ||
      input.prompt !== undefined ||
      input.modelId !== undefined;
    if (changesDefinition && !isCreator) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Only the schedule creator can edit it.",
      );
    }
    if (input.enabled === true && !isCreator) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Only the schedule creator can enable it.",
      );
    }
    if (input.enabled === false && !(isCreator || isOwner)) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Only the schedule creator or a Project owner can pause it.",
      );
    }
    if (input.enabled === true && access.projectArchivedAt) {
      throw new Error("Restore the Project before enabling this schedule.");
    }

    const cronExpression =
      input.cronExpression ?? schedule.cronExpression;
    const timeZone = input.timeZone ?? schedule.timeZone;
    const validated = validateProjectPromptSchedule({
      cronExpression,
      timeZone,
    });
    const prompt = (input.prompt ?? schedule.prompt).trim();
    if (!prompt) throw new Error("A prompt is required.");
    const modelId = (input.modelId ?? schedule.modelId)?.trim() || null;
    if (input.modelId !== undefined && !modelId) {
      throw new Error("A model is required.");
    }
    const enabled = input.enabled ?? schedule.enabled;
    if (
      modelId &&
      (input.modelId !== undefined || enabled) &&
      !(await isKestrelRuntimeModelSelectionAvailableInTransaction(tx, {
        organizationId: input.organizationId,
        environmentId: access.projectEnvironmentId,
        modelId,
      }))
    ) {
      throw Object.assign(
        new Error("The selected model is not available in this Project Environment."),
        { code: "SCHEDULE_MODEL_UNAVAILABLE" },
      );
    }
    const now = new Date();
    const nextRunAt = enabled
      ? input.enabled === true || changesDefinition || !schedule.nextRunAt
        ? nextProjectPromptScheduleOccurrence({ ...validated, after: now })
        : schedule.nextRunAt
      : null;
    const [updatedSchedule] = await tx
      .update(schema.projectPromptSchedules)
      .set({
        cronExpression: validated.cronExpression,
        timeZone: validated.timeZone,
        prompt,
        modelId,
        enabled,
        pauseReason: enabled ? null : "manual",
        nextRunAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projectPromptSchedules.id, input.scheduleId),
          eq(
            schema.projectPromptSchedules.organizationId,
            input.organizationId,
          ),
        ),
      )
      .returning();
    if (!updatedSchedule) throw new Error("Schedule update failed.");
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: updatedSchedule.projectId,
      actorUserId: input.userId,
      action:
        input.enabled === false
          ? "project.schedule.paused"
          : input.enabled === true
            ? "project.schedule.enabled"
            : "project.schedule.updated",
      targetType: "project_prompt_schedule",
      targetId: updatedSchedule.id,
      createdAt: now,
    });
    return updatedSchedule;
  });
}

export async function deleteProjectPromptSchedule(input: {
  scheduleId: string;
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (tx) => {
    const [schedule] = await tx
      .select()
      .from(schema.projectPromptSchedules)
      .where(
        and(
          eq(schema.projectPromptSchedules.id, input.scheduleId),
          eq(schema.projectPromptSchedules.projectId, input.projectId),
          eq(
            schema.projectPromptSchedules.organizationId,
            input.organizationId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!schedule) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Schedule not found or unavailable.",
      );
    }
    const [access] = await tx
      .select({ role: schema.projectMembers.role })
      .from(schema.projects)
      .innerJoin(
        schema.projectMembers,
        eq(schema.projectMembers.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.members,
        and(
          eq(
            schema.members.id,
            schema.projectMembers.organizationMemberId,
          ),
          eq(schema.members.organizationId, input.organizationId),
          eq(schema.members.userId, input.userId),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!access) {
      throw new ProjectAccessError(
        "PROJECT_NOT_FOUND",
        "Schedule not found or unavailable.",
      );
    }
    if (
      schedule.createdByUserId !== input.userId &&
      access.role !== "owner"
    ) {
      throw new ProjectAccessError(
        "PROJECT_FORBIDDEN",
        "Only the schedule creator or a Project owner can delete it.",
      );
    }
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: schedule.projectId,
      actorUserId: input.userId,
      action: "project.schedule.deleted",
      targetType: "project_prompt_schedule",
      targetId: input.scheduleId,
      createdAt: now,
    });
    const [deleted] = await tx
      .delete(schema.projectPromptSchedules)
      .where(eq(schema.projectPromptSchedules.id, input.scheduleId))
      .returning();
    return deleted ?? null;
  });
}

async function pauseScheduleInTransaction(
  tx: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0],
  input: {
    scheduleId: string;
    projectId: string;
    reason: SchedulePauseReason;
    now: Date;
  },
) {
  await tx
    .update(schema.projectPromptSchedules)
    .set({
      enabled: false,
      pauseReason: input.reason,
      nextRunAt: null,
      updatedAt: input.now,
    })
    .where(eq(schema.projectPromptSchedules.id, input.scheduleId));
  await tx.insert(schema.projectAuditEvents).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    actorUserId: null,
    action: "project.schedule.paused",
    targetType: "project_prompt_schedule",
    targetId: input.scheduleId,
    metadata: { reason: input.reason },
    createdAt: input.now,
  });
}

export async function claimDueProjectPromptScheduleRuns(now = new Date()) {
  const due = await knowledgeDb
    .select({ id: schema.projectPromptSchedules.id })
    .from(schema.projectPromptSchedules)
    .where(
      and(
        eq(schema.projectPromptSchedules.enabled, true),
        isNotNull(schema.projectPromptSchedules.nextRunAt),
        lte(schema.projectPromptSchedules.nextRunAt, now),
      ),
    )
    .orderBy(asc(schema.projectPromptSchedules.nextRunAt))
    .limit(100);

  const runIds: string[] = [];
  for (const candidate of due) {
    const runId = await knowledgeDb.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(schema.projectPromptSchedules)
        .where(eq(schema.projectPromptSchedules.id, candidate.id))
        .limit(1)
        .for("update");
      if (!schedule) {
        return null;
      }
      if (!schedule.enabled) {
        return null;
      }
      if (!schedule.nextRunAt) {
        return null;
      }
      if (schedule.nextRunAt.getTime() > now.getTime()) {
        return null;
      }
      const [project] = await tx
        .select({ archivedAt: schema.projects.archivedAt })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, schedule.projectId),
            eq(schema.projects.organizationId, schedule.organizationId),
          ),
        )
        .limit(1);
      if (!project) return null;
      if (project.archivedAt) {
        await pauseScheduleInTransaction(tx, {
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          reason: "project_archived",
          now,
        });
        return null;
      }
      const creator = schedule.createdByUserId
        ? await tx
            .select({ id: schema.members.id })
            .from(schema.members)
            .innerJoin(
              schema.projectMembers,
              and(
                eq(
                  schema.projectMembers.organizationMemberId,
                  schema.members.id,
                ),
                eq(
                  schema.projectMembers.projectId,
                  schedule.projectId,
                ),
              ),
            )
            .where(
              and(
                eq(
                  schema.members.organizationId,
                  schedule.organizationId,
                ),
                eq(schema.members.userId, schedule.createdByUserId),
              ),
            )
            .limit(1)
        : [];
      if (!creator[0]) {
        await pauseScheduleInTransaction(tx, {
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          reason: "creator_access_lost",
          now,
        });
        return null;
      }
      const occurrence = latestDueProjectPromptScheduleOccurrence({
        cronExpression: schedule.cronExpression,
        timeZone: schedule.timeZone,
        firstDueAt: schedule.nextRunAt,
        now,
      });
      if (!occurrence) return null;
      const id = crypto.randomUUID();
      const [run] = await tx
        .insert(schema.projectPromptScheduleRuns)
        .values({
          id,
          scheduleId: schedule.id,
          scheduledFor: occurrence.scheduledFor,
          catchUpFrom: occurrence.catchUpFrom,
          promptSnapshot: schedule.prompt,
          modelIdSnapshot: schedule.modelId,
          threadId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          status: "queued",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            schema.projectPromptScheduleRuns.scheduleId,
            schema.projectPromptScheduleRuns.scheduledFor,
          ],
        })
        .returning({ id: schema.projectPromptScheduleRuns.id });
      await tx
        .update(schema.projectPromptSchedules)
        .set({ nextRunAt: occurrence.nextRunAt, updatedAt: now })
        .where(eq(schema.projectPromptSchedules.id, schedule.id));
      return run?.id ?? null;
    });
    if (runId) runIds.push(runId);
  }
  return runIds;
}

export async function listQueuedProjectPromptScheduleRunIds() {
  const runs = await knowledgeDb
    .select({ id: schema.projectPromptScheduleRuns.id })
    .from(schema.projectPromptScheduleRuns)
    .where(eq(schema.projectPromptScheduleRuns.status, "queued"))
    .orderBy(asc(schema.projectPromptScheduleRuns.createdAt))
    .limit(100);
  return runs.map((run) => run.id);
}

type ProjectPromptScheduleExecutionState = {
  run: typeof schema.projectPromptScheduleRuns.$inferSelect;
  schedule: typeof schema.projectPromptSchedules.$inferSelect;
  projectArchivedAt: Date | null;
  projectEnvironmentId: string;
  projectCurrentContextRevision: number;
};

export async function withLockedProjectPromptScheduleRun<T>(
  runId: string,
  execute: (input: {
    tx: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0];
    current: ProjectPromptScheduleExecutionState;
    cancel: (reason: SchedulePauseReason) => Promise<void>;
    complete: (turnId: string) => Promise<void>;
  }) => Promise<T>,
) {
  return knowledgeDb.transaction(async (tx): Promise<T | null> => {
    const [identity] = await tx
      .select({ scheduleId: schema.projectPromptScheduleRuns.scheduleId })
      .from(schema.projectPromptScheduleRuns)
      .where(eq(schema.projectPromptScheduleRuns.id, runId))
      .limit(1);
    if (!identity) return null;

    const [schedule] = await tx
      .select()
      .from(schema.projectPromptSchedules)
      .where(eq(schema.projectPromptSchedules.id, identity.scheduleId))
      .limit(1)
      .for("update");
    if (!schedule) return null;

    const [run] = await tx
      .select()
      .from(schema.projectPromptScheduleRuns)
      .where(eq(schema.projectPromptScheduleRuns.id, runId))
      .limit(1)
      .for("update");
    if (!run) return null;

    const [project] = await tx
      .select({
        archivedAt: schema.projects.archivedAt,
        currentContextRevision: schema.projects.currentContextRevision,
        environmentId: schema.projects.environmentId,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, schedule.projectId),
          eq(schema.projects.organizationId, schedule.organizationId),
        ),
      )
      .limit(1);
    if (!project) return null;

    const current: ProjectPromptScheduleExecutionState = {
      run,
      schedule,
      projectArchivedAt: project.archivedAt,
      projectEnvironmentId: project.environmentId,
      projectCurrentContextRevision: project.currentContextRevision,
    };
    const cancel = async (reason: SchedulePauseReason) => {
      const now = new Date();
      const [cancelled] = await tx
        .update(schema.projectPromptScheduleRuns)
        .set({
          status: "cancelled",
          failureCode: reason.toUpperCase(),
          failureMessage: "The scheduled occurrence was cancelled.",
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectPromptScheduleRuns.id, runId),
            eq(schema.projectPromptScheduleRuns.status, "queued"),
          ),
        )
        .returning({ id: schema.projectPromptScheduleRuns.id });
      if (cancelled && reason !== "manual") {
        await pauseScheduleInTransaction(tx, {
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          reason,
          now,
        });
      }
    };
    const complete = async (turnId: string) => {
      const now = new Date();
      const [completed] = await tx
        .update(schema.projectPromptScheduleRuns)
        .set({
          status: "materialized",
          turnId,
          finishedAt: now,
          updatedAt: now,
          failureCode: null,
          failureMessage: null,
        })
        .where(
          and(
            eq(schema.projectPromptScheduleRuns.id, runId),
            eq(schema.projectPromptScheduleRuns.status, "queued"),
          ),
        )
        .returning({ id: schema.projectPromptScheduleRuns.id });
      if (!completed) {
        throw Object.assign(
          new Error("The scheduled occurrence changed during materialization."),
          { code: "SCHEDULE_RUN_STATE_CONFLICT" },
        );
      }
    };
    return execute({ tx, current, cancel, complete });
  });
}

export async function failProjectPromptScheduleRun(input: {
  runId: string;
  code: string;
  message: string;
}) {
  await knowledgeDb
    .update(schema.projectPromptScheduleRuns)
    .set({
      status: "failed",
      failureCode: input.code.slice(0, 120),
      failureMessage: input.message.slice(0, 1000),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.projectPromptScheduleRuns.id, input.runId),
        inArray(schema.projectPromptScheduleRuns.status, ["queued", "failed"]),
      ),
    );
}

export function canCreateProjectPromptSchedule(role: ProjectRole) {
  return projectRoleAllows(role, "editor");
}
