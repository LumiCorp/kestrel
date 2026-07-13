import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { environmentLifecycleLockKey } from "@/lib/environments/lifecycle-lock";
import { getStorageAdapter } from "@/lib/storage";
import { type ProjectRole, requireProjectRole } from "./access";
import { cleanupProjectBlobKeys } from "./blob-cleanup";

export async function listProjectsForUser(input: {
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  return knowledgeDb
    .select({
      project: schema.projects,
      role: schema.projectMembers.role,
    })
    .from(schema.projects)
    .innerJoin(
      schema.projectMembers,
      eq(schema.projectMembers.projectId, schema.projects.id)
    )
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.id, schema.projectMembers.organizationMemberId),
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId)
      )
    )
    .where(
      and(
        eq(schema.projects.organizationId, input.organizationId),
        input.includeArchived ? undefined : isNull(schema.projects.archivedAt)
      )
    )
    .orderBy(desc(schema.projects.updatedAt), asc(schema.projects.id));
}

export async function createProject(input: {
  organizationId: string;
  userId: string;
  environmentId?: string;
  name: string;
  description?: string | null;
  instructions?: string;
}) {
  const organizationMember = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.userId, input.userId)
      ),
  });
  if (!organizationMember) {
    throw new Error("Active organization membership is required.");
  }

  const projectId = crypto.randomUUID();
  const contextRevisionId = crypto.randomUUID();
  const auditEventId = crypto.randomUUID();
  const now = new Date();

  return knowledgeDb.transaction(async (tx) => {
    const environment = await tx.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.organizationId, input.organizationId),
          input.environmentId
            ? eq(table.id, input.environmentId)
            : eq(table.isDefault, true),
          isNull(table.archivedAt),
          notInArray(table.status, ["deleting", "deleted"])
        ),
    });
    if (!environment) {
      throw Object.assign(
        new Error(
          input.environmentId
            ? "Selected Environment is unavailable."
            : "The organization default Environment is unavailable."
        ),
        { code: "ENVIRONMENT_NOT_FOUND" }
      );
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environment.id)}, 0))`
    );
    const currentEnvironment = await tx.query.environments.findFirst({
      where: (table, { and, eq, isNull, notInArray }) =>
        and(
          eq(table.id, environment.id),
          eq(table.organizationId, input.organizationId),
          isNull(table.archivedAt),
          notInArray(table.status, ["deleting", "deleted"])
        ),
      columns: { id: true },
    });
    if (!currentEnvironment) {
      throw Object.assign(new Error("Selected Environment is unavailable."), {
        code: "ENVIRONMENT_NOT_FOUND",
      });
    }
    const [project] = await tx
      .insert(schema.projects)
      .values({
        id: projectId,
        organizationId: input.organizationId,
        environmentId: environment.id,
        createdByUserId: input.userId,
        name: input.name,
        description: input.description ?? null,
        currentContextRevision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!project) {
      throw new Error("Project creation failed.");
    }

    await tx.insert(schema.projectMembers).values({
      projectId,
      organizationMemberId: organizationMember.id,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    const [contextRevision] = await tx
      .insert(schema.projectContextRevisions)
      .values({
        id: contextRevisionId,
        projectId,
        revision: 1,
        projectName: input.name,
        instructions: input.instructions ?? "",
        createdByUserId: input.userId,
        createdAt: now,
      })
      .returning();
    await tx.insert(schema.projectAuditEvents).values({
      id: auditEventId,
      projectId,
      actorUserId: input.userId,
      action: "project.created",
      targetType: "project",
      targetId: projectId,
      createdAt: now,
    });

    return { project, role: "owner" as const, contextRevision };
  });
}

export async function getProjectDetail(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  const access = await requireProjectRole(input);
  const [
    contextRevision,
    documents,
    members,
    organizationDocuments,
    organizationMembers,
    auditEvents,
  ] = await Promise.all([
    knowledgeDb.query.projectContextRevisions.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.projectId, access.project.id),
          eq(table.revision, access.project.currentContextRevision)
        ),
    }),
    listProjectContextDocuments({
      projectId: access.project.id,
      revision: access.project.currentContextRevision,
    }),
    listProjectMembers(access.project.id),
    listOrganizationDocuments(input.organizationId),
    access.role === "owner"
      ? listOrganizationMembers(input.organizationId)
      : Promise.resolve([]),
    knowledgeDb.query.projectAuditEvents.findMany({
      where: (table, { eq }) => eq(table.projectId, access.project.id),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      limit: 50,
    }),
  ]);

  return {
    project: access.project,
    role: access.role,
    contextRevision: contextRevision ?? null,
    documents,
    members,
    organizationDocuments,
    organizationMembers,
    auditEvents,
  };
}

export async function updateProjectContext(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  expectedRevision: number;
  name: string;
  description?: string | null;
  instructions: string;
  documentIds: string[];
}) {
  await requireProjectRole({ ...input, minimumRole: "editor" });
  const documentIds = [...new Set(input.documentIds)];
  const now = new Date();

  return knowledgeDb.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
          isNull(schema.projects.archivedAt)
        )
      )
      .for("update");
    if (!project) {
      throw new Error("Project not found.");
    }
    if (project.currentContextRevision !== input.expectedRevision) {
      throw Object.assign(new Error("Project context changed."), {
        code: "PROJECT_CONTEXT_CONFLICT",
        currentRevision: project.currentContextRevision,
      });
    }

    if (documentIds.length > 0) {
      const authorizedDocuments = await tx
        .select({ id: schema.knowledgeDocuments.id })
        .from(schema.knowledgeDocuments)
        .where(
          and(
            inArray(schema.knowledgeDocuments.id, documentIds),
            eq(schema.knowledgeDocuments.organizationId, input.organizationId),
            isNull(schema.knowledgeDocuments.archivedAt),
            sql`(
              (${schema.knowledgeDocuments.scope} = 'organization' and ${schema.knowledgeDocuments.projectId} is null)
              or ${schema.knowledgeDocuments.projectId} = ${input.projectId}
            )`
          )
        );
      if (authorizedDocuments.length !== documentIds.length) {
        throw new Error("One or more project context documents are invalid.");
      }
    }

    const revision = project.currentContextRevision + 1;
    const contextRevisionId = crypto.randomUUID();
    const [contextRevision] = await tx
      .insert(schema.projectContextRevisions)
      .values({
        id: contextRevisionId,
        projectId: project.id,
        revision,
        projectName: input.name,
        instructions: input.instructions,
        createdByUserId: input.userId,
        createdAt: now,
      })
      .returning();
    if (documentIds.length > 0) {
      await tx.insert(schema.projectContextDocuments).values(
        documentIds.map((documentId) => ({
          contextRevisionId,
          documentId,
          createdAt: now,
        }))
      );
    }
    const [updatedProject] = await tx
      .update(schema.projects)
      .set({
        name: input.name,
        description: input.description ?? null,
        currentContextRevision: revision,
        updatedAt: now,
      })
      .where(eq(schema.projects.id, project.id))
      .returning();
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      actorUserId: input.userId,
      action: "project.context.updated",
      targetType: "context_revision",
      targetId: contextRevisionId,
      metadata: { revision, documentCount: documentIds.length },
      createdAt: now,
    });
    return { project: updatedProject, contextRevision };
  });
}

export async function upsertProjectMember(input: {
  projectId: string;
  organizationId: string;
  actorUserId: string;
  organizationMemberId: string;
  role: ProjectRole;
}) {
  await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.actorUserId,
    minimumRole: "owner",
  });
  const member = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.id, input.organizationMemberId),
        eq(table.organizationId, input.organizationId)
      ),
  });
  if (!member) {
    throw new Error("Organization member not found.");
  }

  const now = new Date();
  return knowledgeDb.transaction(async (tx) => {
    const [existing] = await tx
      .select({ role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, input.projectId),
          eq(
            schema.projectMembers.organizationMemberId,
            input.organizationMemberId
          )
        )
      )
      .for("update");
    if (existing?.role === "owner" && input.role !== "owner") {
      const owners = await tx
        .select({ id: schema.projectMembers.organizationMemberId })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, input.projectId),
            eq(schema.projectMembers.role, "owner")
          )
        )
        .for("update");
      if (owners.length <= 1) {
        throw Object.assign(new Error("Every project must retain an owner."), {
          code: "PROJECT_LAST_OWNER",
        });
      }
    }
    const [projectMember] = await tx
      .insert(schema.projectMembers)
      .values({
        projectId: input.projectId,
        organizationMemberId: member.id,
        role: input.role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectMembers.projectId,
          schema.projectMembers.organizationMemberId,
        ],
        set: { role: input.role, updatedAt: now },
      })
      .returning();
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      action: "project.member.upserted",
      targetType: "organization_member",
      targetId: member.id,
      metadata: { role: input.role },
      createdAt: now,
    });
    return projectMember;
  });
}

export async function removeProjectMember(input: {
  projectId: string;
  organizationId: string;
  actorUserId: string;
  organizationMemberId: string;
}) {
  await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.actorUserId,
    minimumRole: "owner",
  });

  return knowledgeDb.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, input.projectId),
          eq(
            schema.projectMembers.organizationMemberId,
            input.organizationMemberId
          )
        )
      )
      .for("update");
    if (!target) {
      return null;
    }
    if (target.role === "owner") {
      const owners = await tx
        .select({ id: schema.projectMembers.organizationMemberId })
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, input.projectId),
            eq(schema.projectMembers.role, "owner")
          )
        )
        .for("update");
      if (owners.length <= 1) {
        throw Object.assign(new Error("Every project must retain an owner."), {
          code: "PROJECT_LAST_OWNER",
        });
      }
    }
    const [removed] = await tx
      .delete(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, input.projectId),
          eq(
            schema.projectMembers.organizationMemberId,
            input.organizationMemberId
          )
        )
      )
      .returning();
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      action: "project.member.removed",
      targetType: "organization_member",
      targetId: input.organizationMemberId,
      createdAt: new Date(),
    });
    return removed;
  });
}

export async function setProjectArchived(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  archived: boolean;
}) {
  await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.userId,
    minimumRole: "owner",
    includeArchived: true,
  });
  const now = new Date();
  return knowledgeDb.transaction(async (tx) => {
    const [project] = await tx
      .update(schema.projects)
      .set({
        archivedAt: input.archived ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.projects.id, input.projectId))
      .returning();
    await tx
      .update(schema.threads)
      .set({
        ...(input.archived
          ? {
              activeStreamId: null,
              isPublic: false,
              shareToken: null,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(schema.threads.projectId, input.projectId));
    await tx.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.userId,
      action: input.archived ? "project.archived" : "project.restored",
      targetType: "project",
      targetId: input.projectId,
      createdAt: now,
    });
    return project ?? null;
  });
}

export async function permanentlyDeleteProject(input: {
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  const access = await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.userId,
    minimumRole: "owner",
    includeArchived: true,
  });
  if (!access.project.archivedAt) {
    throw new Error("Project must be archived before permanent deletion.");
  }
  const deleted = await knowledgeDb.transaction(async (tx) => {
    const ownedDocuments = await tx
      .select({ storageKey: schema.knowledgeDocuments.storageKey })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.organizationId, input.organizationId),
          eq(schema.knowledgeDocuments.projectId, input.projectId),
          eq(schema.knowledgeDocuments.scope, "project")
        )
      );
    const [project] = await tx
      .delete(schema.projects)
      .where(eq(schema.projects.id, input.projectId))
      .returning();
    return {
      project: project ?? null,
      storageKeys: ownedDocuments.map((document) => document.storageKey),
    };
  });
  if (!deleted.project) {
    return null;
  }
  try {
    const storage = getStorageAdapter();
    const cleanup = await cleanupProjectBlobKeys(
      deleted.storageKeys,
      (storageKey) => storage.deleteObject(storageKey)
    );
    if (cleanup.failedCount > 0) {
      console.warn("Project metadata deleted with incomplete blob cleanup", {
        projectId: input.projectId,
        failedCount: cleanup.failedCount,
      });
    }
  } catch {
    console.warn("Project metadata deleted before blob cleanup could start", {
      projectId: input.projectId,
      failedCount: deleted.storageKeys.length,
    });
  }
  return deleted.project;
}

async function listProjectMembers(projectId: string) {
  return knowledgeDb
    .select({
      organizationMemberId: schema.members.id,
      userId: schema.members.userId,
      name: schema.users.name,
      email: schema.users.email,
      image: schema.users.image,
      role: schema.projectMembers.role,
      createdAt: schema.projectMembers.createdAt,
    })
    .from(schema.projectMembers)
    .innerJoin(
      schema.members,
      eq(schema.members.id, schema.projectMembers.organizationMemberId)
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.projectMembers.projectId, projectId))
    .orderBy(asc(schema.users.name), asc(schema.users.id));
}

async function listProjectContextDocuments(input: {
  projectId: string;
  revision: number;
}) {
  return knowledgeDb
    .select({
      id: schema.knowledgeDocuments.id,
      title: schema.knowledgeDocuments.title,
      filename: schema.knowledgeDocuments.filename,
      mediaType: schema.knowledgeDocuments.mediaType,
      status: schema.knowledgeDocuments.status,
      scope: schema.knowledgeDocuments.scope,
      projectId: schema.knowledgeDocuments.projectId,
    })
    .from(schema.projectContextDocuments)
    .innerJoin(
      schema.projectContextRevisions,
      eq(
        schema.projectContextRevisions.id,
        schema.projectContextDocuments.contextRevisionId
      )
    )
    .innerJoin(
      schema.knowledgeDocuments,
      eq(
        schema.knowledgeDocuments.id,
        schema.projectContextDocuments.documentId
      )
    )
    .where(
      and(
        eq(schema.projectContextRevisions.projectId, input.projectId),
        eq(schema.projectContextRevisions.revision, input.revision)
      )
    )
    .orderBy(asc(schema.knowledgeDocuments.filename));
}

async function listOrganizationDocuments(organizationId: string) {
  return knowledgeDb
    .select({
      id: schema.knowledgeDocuments.id,
      title: schema.knowledgeDocuments.title,
      filename: schema.knowledgeDocuments.filename,
      mediaType: schema.knowledgeDocuments.mediaType,
      status: schema.knowledgeDocuments.status,
    })
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.organizationId, organizationId),
        eq(schema.knowledgeDocuments.scope, "organization"),
        isNull(schema.knowledgeDocuments.projectId),
        isNull(schema.knowledgeDocuments.archivedAt)
      )
    )
    .orderBy(asc(schema.knowledgeDocuments.filename));
}

async function listOrganizationMembers(organizationId: string) {
  return knowledgeDb
    .select({
      organizationMemberId: schema.members.id,
      userId: schema.members.userId,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.members.organizationId, organizationId))
    .orderBy(asc(schema.users.name), asc(schema.users.id));
}
