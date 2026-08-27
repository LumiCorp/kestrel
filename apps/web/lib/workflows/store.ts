import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
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
} from "@/lib/schedules/cron";
import {
  type WorkflowDefinition,
  validateWorkflowDefinition,
  workflowTrigger,
} from "./contracts";
import {
  assertWorkflowModelSupportedInTransaction,
  validateProjectWorkflowTools,
} from "./server-policy";

type WorkflowStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled";

function permissions(input: {
  creatorUserId: string | null;
  role: ProjectRole;
  userId: string;
}) {
  const creator = input.creatorUserId === input.userId;
  const owner = input.role === "owner";
  return {
    canEdit: creator,
    canRun: creator,
    canEnable: creator,
    canPause: creator || owner,
    canDelete: creator || owner,
  };
}

function scheduleFields(definition: WorkflowDefinition, enabled: boolean, now: Date) {
  const trigger = workflowTrigger(definition);
  if (trigger.kind !== "trigger" || trigger.config.mode !== "schedule") {
    return {
      enabled: false,
      cronExpression: null,
      timeZone: null,
      nextRunAt: null,
    };
  }
  const validated = validateProjectPromptSchedule({
    cronExpression: trigger.config.cronExpression!,
    timeZone: trigger.config.timeZone!,
  });
  return {
    enabled,
    cronExpression: validated.cronExpression,
    timeZone: validated.timeZone,
    nextRunAt: enabled
      ? nextProjectPromptScheduleOccurrence({ ...validated, after: now })
      : null,
  };
}

async function assertModelAvailable(
  tx: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0],
  input: { organizationId: string; environmentId: string; modelId: string },
) {
  await assertWorkflowModelSupportedInTransaction(tx, input);
}

function isWorkflowAdmissionError(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return [
    "WORKFLOW_MODEL_UNAVAILABLE",
    "WORKFLOW_MODEL_UNSUPPORTED",
    "WORKFLOW_TOOL_UNAVAILABLE",
  ].includes(code);
}

export async function listProjectWorkflowsForUser(input: {
  organizationId: string;
  userId: string;
  projectId?: string;
  workflowId?: string;
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
      workflow: schema.projectWorkflows,
      versionId: schema.projectWorkflowVersions.id,
      definition: schema.projectWorkflowVersions.definition,
      projectName: schema.projects.name,
      role: schema.projectMembers.role,
      creatorName: schema.users.name,
    })
    .from(schema.projectWorkflows)
    .innerJoin(
      schema.projectWorkflowVersions,
      and(
        eq(schema.projectWorkflowVersions.workflowId, schema.projectWorkflows.id),
        eq(schema.projectWorkflowVersions.version, schema.projectWorkflows.currentVersion),
      ),
    )
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectWorkflows.projectId))
    .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
    )
    .leftJoin(schema.users, eq(schema.users.id, schema.projectWorkflows.createdByUserId))
    .where(
      and(
        eq(schema.projectWorkflows.organizationId, input.organizationId),
        input.projectId ? eq(schema.projectWorkflows.projectId, input.projectId) : undefined,
        input.workflowId ? eq(schema.projectWorkflows.id, input.workflowId) : undefined,
      ),
    )
    .orderBy(asc(schema.projects.name), asc(schema.projectWorkflows.createdAt));

  const latestRuns = rows.length
    ? await knowledgeDb
      .selectDistinctOn([schema.projectWorkflowRuns.workflowId], {
        workflowId: schema.projectWorkflowRuns.workflowId,
        id: schema.projectWorkflowRuns.id,
        status: schema.projectWorkflowRuns.status,
        trigger: schema.projectWorkflowRuns.trigger,
        failureCode: schema.projectWorkflowRuns.failureCode,
        failureMessage: schema.projectWorkflowRuns.failureMessage,
        createdAt: schema.projectWorkflowRuns.createdAt,
        finishedAt: schema.projectWorkflowRuns.finishedAt,
      })
      .from(schema.projectWorkflowRuns)
      .where(
        inArray(
          schema.projectWorkflowRuns.workflowId,
          rows.map((row) => row.workflow.id),
        ),
      )
      .orderBy(
        schema.projectWorkflowRuns.workflowId,
        desc(schema.projectWorkflowRuns.createdAt),
      )
    : [];
  const latestRunByWorkflowId = new Map(
    latestRuns.map(({ workflowId, ...run }) => [workflowId, run]),
  );
  return rows.map((row) => {
    const latestRun = latestRunByWorkflowId.get(row.workflow.id) ?? null;
    return {
      ...row.workflow,
      project: { id: row.workflow.projectId, name: row.projectName },
      creator: row.workflow.createdByUserId
        ? { id: row.workflow.createdByUserId, name: row.creatorName ?? "Former member" }
        : null,
      definition: validateWorkflowDefinition(row.definition),
      versionId: row.versionId,
      permissions: permissions({
        creatorUserId: row.workflow.createdByUserId,
        role: row.role,
        userId: input.userId,
      }),
      latestRun,
    };
  });
}

export async function getProjectWorkflowForUser(input: {
  workflowId: string;
  projectId?: string;
  organizationId: string;
  userId: string;
}) {
  const [workflow] = await listProjectWorkflowsForUser(input);
  if (!workflow) {
    throw new ProjectAccessError("PROJECT_NOT_FOUND", "Workflow not found or unavailable.");
  }
  return workflow;
}

export async function createProjectWorkflow(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  title: string;
  description?: string;
  modelId: string;
  enabled?: boolean;
  definition: unknown;
}) {
  const definition = validateWorkflowDefinition(input.definition);
  const title = input.title.trim();
  const description = input.description?.trim() ?? "";
  const modelId = input.modelId.trim();
  if (!title || title.length > 120) throw new Error("Enter a title up to 120 characters.");
  if (description.length > 2000) throw new Error("Description must be 2,000 characters or fewer.");
  if (!modelId) throw new Error("A model is required.");
  const now = new Date();
  return knowledgeDb.transaction(async (tx) => {
    const access = await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      minimumRole: "editor",
    });
    await validateProjectWorkflowTools({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      definition,
    });
    await assertModelAvailable(tx, {
      organizationId: input.organizationId,
      environmentId: access.project.environmentId,
      modelId,
    });
    const schedule = scheduleFields(definition, input.enabled ?? false, now);
    const workflowId = crypto.randomUUID();
    const [workflow] = await tx
      .insert(schema.projectWorkflows)
      .values({
        id: workflowId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        createdByUserId: input.userId,
        title,
        description,
        modelId,
        currentVersion: 1,
        ...schedule,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!workflow) throw new Error("Workflow creation failed.");
    await tx.insert(schema.projectWorkflowVersions).values({
      id: crypto.randomUUID(),
      workflowId,
      version: 1,
      definition,
      createdByUserId: input.userId,
      createdAt: now,
    });
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: "project.workflow.created",
      targetType: "project_workflow",
      targetId: workflowId,
      createdAt: now,
    });
    return workflow;
  });
}

export async function updateProjectWorkflow(input: {
  workflowId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  title: string;
  description?: string;
  modelId: string;
  enabled?: boolean;
  definition: unknown;
}) {
  const definition = validateWorkflowDefinition(input.definition);
  const title = input.title.trim();
  const description = input.description?.trim() ?? "";
  const modelId = input.modelId.trim();
  if (!title || title.length > 120) throw new Error("Enter a title up to 120 characters.");
  if (description.length > 2000) throw new Error("Description must be 2,000 characters or fewer.");
  if (!modelId) throw new Error("A model is required.");
  const now = new Date();
  return knowledgeDb.transaction(async (tx) => {
    const access = await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      minimumRole: "member",
      includeArchived: true,
    });
    await validateProjectWorkflowTools({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      definition,
    });
    const [current] = await tx
      .select()
      .from(schema.projectWorkflows)
      .where(
        and(
          eq(schema.projectWorkflows.id, input.workflowId),
          eq(schema.projectWorkflows.projectId, input.projectId),
          eq(schema.projectWorkflows.organizationId, input.organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) throw new ProjectAccessError("PROJECT_NOT_FOUND", "Workflow not found or unavailable.");
    if (current.createdByUserId !== input.userId) {
      throw new ProjectAccessError("PROJECT_FORBIDDEN", "Only the workflow creator can edit it.");
    }
    if (access.project.archivedAt) throw new Error("Restore the Project before editing this workflow.");
    await assertModelAvailable(tx, {
      organizationId: input.organizationId,
      environmentId: access.project.environmentId,
      modelId,
    });
    const nextVersion = current.currentVersion + 1;
    const schedule = scheduleFields(definition, input.enabled ?? current.enabled, now);
    await tx.insert(schema.projectWorkflowVersions).values({
      id: crypto.randomUUID(),
      workflowId: current.id,
      version: nextVersion,
      definition,
      createdByUserId: input.userId,
      createdAt: now,
    });
    const [updated] = await tx
      .update(schema.projectWorkflows)
      .set({
        title,
        description,
        modelId,
        currentVersion: nextVersion,
        ...schedule,
        updatedAt: now,
      })
      .where(eq(schema.projectWorkflows.id, current.id))
      .returning();
    return updated!;
  });
}

export async function deleteProjectWorkflow(input: {
  workflowId: string;
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const access = await requireProjectRole({ ...input, includeArchived: true });
  const [workflow] = await knowledgeDb
    .select()
    .from(schema.projectWorkflows)
    .where(
      and(
        eq(schema.projectWorkflows.id, input.workflowId),
        eq(schema.projectWorkflows.projectId, input.projectId),
        eq(schema.projectWorkflows.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!workflow) throw new ProjectAccessError("PROJECT_NOT_FOUND", "Workflow not found or unavailable.");
  if (!(workflow.createdByUserId === input.userId || access.role === "owner")) {
    throw new ProjectAccessError("PROJECT_FORBIDDEN", "Only the creator or a Project owner can delete this workflow.");
  }
  await knowledgeDb.delete(schema.projectWorkflows).where(eq(schema.projectWorkflows.id, workflow.id));
  return workflow;
}

export async function createProjectWorkflowRun(input: {
  workflowId: string;
  projectId: string;
  organizationId: string;
  userId: string;
  requestId: string;
  runInput?: Record<string, unknown>;
  trigger?: "manual" | "scheduled";
  scheduledFor?: Date | null;
}) {
  return knowledgeDb.transaction(async (tx) => {
    const access = await requireProjectRole({
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
    });
    const [workflow] = await tx
      .select()
      .from(schema.projectWorkflows)
      .where(
        and(
          eq(schema.projectWorkflows.id, input.workflowId),
          eq(schema.projectWorkflows.projectId, input.projectId),
          eq(schema.projectWorkflows.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!workflow) throw new ProjectAccessError("PROJECT_NOT_FOUND", "Workflow not found or unavailable.");
    if (workflow.createdByUserId !== input.userId) {
      throw new ProjectAccessError("PROJECT_FORBIDDEN", "Only the workflow creator can run it.");
    }
    if (access.project.archivedAt) throw new Error("Restore the Project before running this workflow.");
    await assertModelAvailable(tx, {
      organizationId: input.organizationId,
      environmentId: access.project.environmentId,
      modelId: workflow.modelId,
    });
    const [context] = await tx
      .select({ id: schema.projectContextRevisions.id })
      .from(schema.projectContextRevisions)
      .where(
        and(
          eq(schema.projectContextRevisions.projectId, workflow.projectId),
          eq(schema.projectContextRevisions.revision, access.project.currentContextRevision),
        ),
      )
      .limit(1);
    if (!context) throw new Error("Project context is unavailable.");
    const [version] = await tx
      .select()
      .from(schema.projectWorkflowVersions)
      .where(
        and(
          eq(schema.projectWorkflowVersions.workflowId, workflow.id),
          eq(schema.projectWorkflowVersions.version, workflow.currentVersion),
        ),
      )
      .limit(1);
    if (!version) throw new Error("Workflow version is unavailable.");
    const definition = validateWorkflowDefinition(version.definition);
    await validateProjectWorkflowTools({
      organizationId: input.organizationId,
      projectId: input.projectId,
      userId: input.userId,
      definition,
    });
    const existing = await tx.query.projectWorkflowRuns.findFirst({
      where: and(
        eq(schema.projectWorkflowRuns.workflowId, workflow.id),
        eq(schema.projectWorkflowRuns.requestId, input.requestId),
      ),
    });
    if (existing) return existing;
    const now = new Date();
    const runId = crypto.randomUUID();
    const [run] = await tx
      .insert(schema.projectWorkflowRuns)
      .values({
        id: runId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        actorUserId: input.userId,
        trigger: input.trigger ?? "manual",
        requestId: input.requestId,
        scheduledFor: input.scheduledFor ?? null,
        environmentIdSnapshot: access.project.environmentId,
        projectContextRevisionIdSnapshot: context.id,
        modelIdSnapshot: workflow.modelId,
        input: input.runInput ?? {},
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          schema.projectWorkflowRuns.workflowId,
          schema.projectWorkflowRuns.requestId,
        ],
      })
      .returning();
    if (!run) {
      const conflicted = await tx.query.projectWorkflowRuns.findFirst({
        where: and(
          eq(schema.projectWorkflowRuns.workflowId, workflow.id),
          eq(schema.projectWorkflowRuns.requestId, input.requestId),
        ),
      });
      if (!conflicted) throw new Error("Workflow run creation failed.");
      return conflicted;
    }
    await tx.insert(schema.projectWorkflowStepRuns).values(
      definition.nodes.map((node) => ({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        nodeId: node.id,
        attempt: 1,
        status: node.kind === "trigger" ? ("completed" as const) : ("pending" as const),
        input: node.kind === "trigger" ? (input.runInput ?? {}) : null,
        output: node.kind === "trigger" ? (input.runInput ?? {}) : null,
        startedAt: node.kind === "trigger" ? now : null,
        finishedAt: node.kind === "trigger" ? now : null,
        createdAt: now,
        updatedAt: now,
      })),
    );
    return run;
  });
}

export async function getProjectWorkflowRunForUser(input: {
  runId: string;
  organizationId: string;
  userId: string;
}) {
  const [row] = await knowledgeDb
    .select({
      run: schema.projectWorkflowRuns,
      workflow: schema.projectWorkflows,
      definition: schema.projectWorkflowVersions.definition,
      projectName: schema.projects.name,
      role: schema.projectMembers.role,
    })
    .from(schema.projectWorkflowRuns)
    .innerJoin(schema.projectWorkflows, eq(schema.projectWorkflows.id, schema.projectWorkflowRuns.workflowId))
    .innerJoin(schema.projectWorkflowVersions, eq(schema.projectWorkflowVersions.id, schema.projectWorkflowRuns.workflowVersionId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectWorkflows.projectId))
    .innerJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(schema.projectWorkflowRuns.id, input.runId),
        eq(schema.projectWorkflows.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new ProjectAccessError("PROJECT_NOT_FOUND", "Workflow run not found or unavailable.");
  const steps = await knowledgeDb
    .select({
      step: schema.projectWorkflowStepRuns,
      threadTitle: schema.threads.title,
      turnStatus: schema.threadTurns.status,
      turnFailureCode: schema.threadTurns.failureCode,
      turnFailureMessage: schema.threadTurns.failureMessage,
    })
    .from(schema.projectWorkflowStepRuns)
    .leftJoin(schema.threads, eq(schema.threads.id, schema.projectWorkflowStepRuns.threadId))
    .leftJoin(schema.threadTurns, eq(schema.threadTurns.id, schema.projectWorkflowStepRuns.turnId))
    .where(eq(schema.projectWorkflowStepRuns.workflowRunId, input.runId))
    .orderBy(asc(schema.projectWorkflowStepRuns.createdAt));
  return {
    ...row.run,
    workflow: {
      id: row.workflow.id,
      title: row.workflow.title,
      project: { id: row.workflow.projectId, name: row.projectName },
    },
    definition: validateWorkflowDefinition(row.definition),
    steps: steps.map(({ step, ...turn }) => ({ ...step, ...turn })),
  };
}

export async function listActiveProjectWorkflowRunIds() {
  const rows = await knowledgeDb
    .select({ id: schema.projectWorkflowRuns.id })
    .from(schema.projectWorkflowRuns)
    .where(inArray(schema.projectWorkflowRuns.status, ["queued", "running", "waiting_for_input"]))
    .orderBy(asc(schema.projectWorkflowRuns.updatedAt))
    .limit(100);
  return rows.map((row) => row.id);
}

export async function claimDueProjectWorkflowRuns(now = new Date()) {
  const due = await knowledgeDb
    .select({ id: schema.projectWorkflows.id })
    .from(schema.projectWorkflows)
    .where(
      and(
        eq(schema.projectWorkflows.enabled, true),
        isNotNull(schema.projectWorkflows.nextRunAt),
        lte(schema.projectWorkflows.nextRunAt, now),
      ),
    )
    .orderBy(asc(schema.projectWorkflows.nextRunAt))
    .limit(100);
  const runIds: string[] = [];
  for (const candidate of due) {
    const runId = await knowledgeDb.transaction(async (tx) => {
      const [workflow] = await tx
        .select()
        .from(schema.projectWorkflows)
        .where(eq(schema.projectWorkflows.id, candidate.id))
        .limit(1)
        .for("update");
      if (!(workflow?.enabled && workflow.nextRunAt && workflow.cronExpression && workflow.timeZone)) return null;
      if (workflow.nextRunAt.getTime() > now.getTime()) return null;
      const [project] = await tx
        .select({
          archivedAt: schema.projects.archivedAt,
          currentContextRevision: schema.projects.currentContextRevision,
          environmentId: schema.projects.environmentId,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, workflow.projectId),
            eq(schema.projects.organizationId, workflow.organizationId),
          ),
        )
        .limit(1);
      const creatorMembership = workflow.createdByUserId
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
                eq(schema.projectMembers.projectId, workflow.projectId),
              ),
            )
            .where(
              and(
                eq(schema.members.organizationId, workflow.organizationId),
                eq(schema.members.userId, workflow.createdByUserId),
              ),
            )
            .limit(1)
        : [];
      if (!(project && !project.archivedAt && creatorMembership[0])) {
        await tx
          .update(schema.projectWorkflows)
          .set({ enabled: false, nextRunAt: null, updatedAt: now })
          .where(eq(schema.projectWorkflows.id, workflow.id));
        return null;
      }
      try {
        await assertWorkflowModelSupportedInTransaction(tx, {
          organizationId: workflow.organizationId,
          environmentId: project.environmentId,
          modelId: workflow.modelId,
        });
      } catch (error) {
        if (!isWorkflowAdmissionError(error)) throw error;
        await tx
          .update(schema.projectWorkflows)
          .set({ enabled: false, nextRunAt: null, updatedAt: now })
          .where(eq(schema.projectWorkflows.id, workflow.id));
        return null;
      }
      const occurrence = latestDueProjectPromptScheduleOccurrence({
        cronExpression: workflow.cronExpression,
        timeZone: workflow.timeZone,
        firstDueAt: workflow.nextRunAt,
        now,
      });
      if (!(occurrence && workflow.createdByUserId)) return null;
      const version = await tx.query.projectWorkflowVersions.findFirst({
        where: and(
          eq(schema.projectWorkflowVersions.workflowId, workflow.id),
          eq(schema.projectWorkflowVersions.version, workflow.currentVersion),
        ),
      });
      const context = await tx.query.projectContextRevisions.findFirst({
        where: and(
          eq(schema.projectContextRevisions.projectId, workflow.projectId),
          eq(
            schema.projectContextRevisions.revision,
            project.currentContextRevision,
          ),
        ),
      });
      if (!(version && context)) {
        await tx
          .update(schema.projectWorkflows)
          .set({ enabled: false, nextRunAt: null, updatedAt: now })
          .where(eq(schema.projectWorkflows.id, workflow.id));
        return null;
      }
      const definition = validateWorkflowDefinition(version.definition);
      try {
        await validateProjectWorkflowTools({
          organizationId: workflow.organizationId,
          projectId: workflow.projectId,
          userId: workflow.createdByUserId,
          definition,
        });
      } catch (error) {
        if (!isWorkflowAdmissionError(error)) throw error;
        await tx
          .update(schema.projectWorkflows)
          .set({ enabled: false, nextRunAt: null, updatedAt: now })
          .where(eq(schema.projectWorkflows.id, workflow.id));
        return null;
      }
      await tx
        .update(schema.projectWorkflows)
        .set({ nextRunAt: occurrence.nextRunAt, updatedAt: now })
        .where(eq(schema.projectWorkflows.id, workflow.id));
      const [run] = await tx
        .insert(schema.projectWorkflowRuns)
        .values({
          id: crypto.randomUUID(),
          workflowId: workflow.id,
          workflowVersionId: version.id,
          actorUserId: workflow.createdByUserId,
          trigger: "scheduled",
          requestId: null,
          scheduledFor: occurrence.scheduledFor,
          environmentIdSnapshot: project.environmentId,
          projectContextRevisionIdSnapshot: context.id,
          modelIdSnapshot: workflow.modelId,
          input: {},
          status: "queued",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [schema.projectWorkflowRuns.workflowId, schema.projectWorkflowRuns.scheduledFor],
      })
        .returning();
      if (!run) return null;
      await tx.insert(schema.projectWorkflowStepRuns).values(
        definition.nodes.map((node) => ({
          id: crypto.randomUUID(),
          workflowRunId: run.id,
          nodeId: node.id,
          status: node.kind === "trigger" ? ("completed" as const) : ("pending" as const),
          input: node.kind === "trigger" ? {} : null,
          output: node.kind === "trigger" ? {} : null,
          startedAt: node.kind === "trigger" ? now : null,
          finishedAt: node.kind === "trigger" ? now : null,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return run.id;
    });
    if (runId) runIds.push(runId);
  }
  return runIds;
}

export function isTerminalWorkflowStatus(status: WorkflowStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function canCreateProjectWorkflow(role: ProjectRole) {
  return projectRoleAllows(role, "editor");
}
