import {
  normalizeWorkspaceSkillSource,
  type InstalledWorkspaceSkillRevision,
  type WorkspaceSkillCatalogEntry,
  type WorkspaceSkillInstallation,
  type WorkspaceSkillSource,
  type WorkspaceSkillStatus,
} from "@kestrel-agents/workspace-skills";
import { and, eq, isNull } from "drizzle-orm";
import { createEnvironmentMachineRoute } from "@/lib/environments/execution-route";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const SKILL_STATUSES = new Set<WorkspaceSkillStatus>([
  "pending",
  "syncing",
  "ready",
  "stale",
  "failed",
  "removal_pending",
]);

export type ProjectSkill = Omit<WorkspaceSkillInstallation, "workspaceId">;

export class ProjectSkillError extends Error {
  readonly code:
    | "PROJECT_SKILL_CONFLICT"
    | "PROJECT_SKILL_NOT_FOUND"
    | "PROJECT_SKILL_SOURCE_INVALID";

  constructor(code: ProjectSkillError["code"], message: string) {
    super(message);
    this.name = "ProjectSkillError";
    this.code = code;
  }
}

export async function listProjectSkills(input: {
  organizationId: string;
  projectId: string;
}): Promise<ProjectSkill[]> {
  const rows = await knowledgeDb.query.projectSkillInstallations.findMany({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.projectId, input.projectId)
      ),
    orderBy: (table, { asc: ascending }) => [ascending(table.createdAt)],
  });
  return rows.map(rowToProjectSkill);
}

export async function createProjectSkill(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
  source: WorkspaceSkillSource;
}): Promise<ProjectSkill> {
  const source = normalizeSource(input.source);
  const now = new Date();
  const id = crypto.randomUUID();
  try {
    const [created] = await knowledgeDb.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(schema.projectSkillInstallations)
        .values({
          id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          createdByUserId: input.actorUserId,
          gitUrl: source.gitUrl,
          branch: source.branch,
          path: source.path ?? "",
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await transaction.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        action: "project.skill.added",
        targetType: "project_skill",
        targetId: id,
        metadata: { source },
        createdAt: now,
      });
      return inserted;
    });
    if (!created) throw new Error("Project skill creation failed.");
    return rowToProjectSkill(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectSkillError(
        "PROJECT_SKILL_CONFLICT",
        "This Git skill source is already installed in the Project."
      );
    }
    throw error;
  }
}

export async function updateProjectSkill(input: {
  organizationId: string;
  projectId: string;
  installationId: string;
  actorUserId: string;
  source: WorkspaceSkillSource;
}): Promise<ProjectSkill> {
  const source = normalizeSource(input.source);
  const now = new Date();
  try {
    return await knowledgeDb.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(schema.projectSkillInstallations)
        .set({
          gitUrl: source.gitUrl,
          branch: source.branch,
          path: source.path ?? "",
          status: "pending",
          lastSyncError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectSkillInstallations.id, input.installationId),
            eq(
              schema.projectSkillInstallations.organizationId,
              input.organizationId
            ),
            eq(schema.projectSkillInstallations.projectId, input.projectId)
          )
        )
        .returning();
      if (!updated) {
        throw new ProjectSkillError(
          "PROJECT_SKILL_NOT_FOUND",
          "Project skill installation was not found."
        );
      }
      await transaction.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        action: "project.skill.updated",
        targetType: "project_skill",
        targetId: input.installationId,
        metadata: { source },
        createdAt: now,
      });
      return rowToProjectSkill(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectSkillError(
        "PROJECT_SKILL_CONFLICT",
        "This Git skill source is already installed in the Project."
      );
    }
    throw error;
  }
}

export async function removeProjectSkill(input: {
  organizationId: string;
  projectId: string;
  installationId: string;
  actorUserId: string;
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    const [removed] = await transaction
      .delete(schema.projectSkillInstallations)
      .where(
        and(
          eq(schema.projectSkillInstallations.id, input.installationId),
          eq(
            schema.projectSkillInstallations.organizationId,
            input.organizationId
          ),
          eq(schema.projectSkillInstallations.projectId, input.projectId)
        )
      )
      .returning({ id: schema.projectSkillInstallations.id });
    if (!removed) {
      throw new ProjectSkillError(
        "PROJECT_SKILL_NOT_FOUND",
        "Project skill installation was not found."
      );
    }
    await transaction.insert(schema.projectAuditEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      action: "project.skill.removed",
      targetType: "project_skill",
      targetId: input.installationId,
      createdAt: now,
    });
  });
}

export async function synchronizeProjectSkills(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
  route?: { baseUrl: string; authToken: string } | undefined;
}): Promise<{
  skills: ProjectSkill[];
  catalog: WorkspaceSkillCatalogEntry[];
  deferred: boolean;
}> {
  try {
    const route = input.route ?? (await resolveReadyWorkspaceRoute(input));
    if (!route) return deferredProjectSkills(input);
    const initialized = await adoptLegacyCatalog({ ...input, route });
    if (!initialized) return deferredProjectSkills(input);
    const desired = await listProjectSkills(input);
    const response = await fetch(new URL("/v1/skills/catalog", route.baseUrl), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${route.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        installations: desired.map((skill) => ({
          installationId: skill.installationId,
          source: skill.source,
        })),
      }),
      cache: "no-store",
    });
    if (response.status === 409 || response.status === 503) {
      return deferredProjectSkills(input);
    }
    if (!response.ok) {
      throw new Error(`Workspace skill reconciliation failed (${response.status}).`);
    }
    const body = (await response.json()) as { skills?: unknown };
    const synchronized = parseWorkspaceSkills(body.skills);
    await applyWorkspaceSkillResults({ ...input, skills: synchronized });
    const skills = await listProjectSkills(input);
    return {
      skills,
      catalog: verifiedCatalog(skills),
      deferred: false,
    };
  } catch (error) {
    console.warn("Project skill synchronization deferred", {
      projectId: input.projectId,
      message: error instanceof Error ? error.message : String(error),
    });
    return deferredProjectSkills(input);
  }
}

async function resolveReadyWorkspaceRoute(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
}) {
  const workspace = await knowledgeDb.query.environmentWorkspaces.findFirst({
    where: (table, { and: all, eq: equals, isNull: absent }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.projectId, input.projectId),
        equals(table.status, "ready"),
        absent(table.deletedAt)
      ),
  });
  if (!workspace?.flyMachineId) return null;
  const environment = await knowledgeDb.query.environments.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.id, workspace.environmentId),
        equals(table.organizationId, input.organizationId)
      ),
  });
  if (!(environment?.flyAppName && environment.routerUrl)) return null;
  return createEnvironmentMachineRoute({
    organizationId: input.organizationId,
    environmentId: environment.id,
    workspaceId: workspace.id,
    threadId: input.projectId,
    actorId: input.actorUserId,
    agentId: "kestrel-project-skills",
    flyAppName: environment.flyAppName,
    flyMachineId: workspace.flyMachineId,
    routerUrl: environment.routerUrl,
    capabilities: ["workspace.skills.read", "workspace.skills.write"],
  });
}

async function adoptLegacyCatalog(input: {
  organizationId: string;
  projectId: string;
  actorUserId: string;
  route: { baseUrl: string; authToken: string };
}) {
  const project = await knowledgeDb.query.projects.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.id, input.projectId),
        equals(table.organizationId, input.organizationId)
      ),
    columns: {
      id: true,
      createdByUserId: true,
      skillCatalogInitializedAt: true,
    },
  });
  if (!project) return false;
  if (project.skillCatalogInitializedAt) return true;
  const response = await fetch(new URL("/v1/skills", input.route.baseUrl), {
    headers: { authorization: `Bearer ${input.route.authToken}` },
    cache: "no-store",
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { skills?: unknown };
  const legacy = parseWorkspaceSkills(body.skills);
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    for (const skill of legacy) {
      await transaction
        .insert(schema.projectSkillInstallations)
        .values({
          id: skill.installationId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          createdByUserId: project.createdByUserId,
          gitUrl: skill.source.gitUrl,
          branch: skill.source.branch,
          path: skill.source.path ?? "",
          status: skill.status,
          revision: skill.revision ? revisionToJson(skill.revision) : null,
          lastSyncAttemptAt: parseDate(skill.lastSyncAttemptAt),
          lastSyncError: skill.lastSyncError ?? null,
          createdAt: parseDate(skill.createdAt) ?? now,
          updatedAt: parseDate(skill.updatedAt) ?? now,
        })
        .onConflictDoNothing();
    }
    await transaction
      .update(schema.projects)
      .set({ skillCatalogInitializedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.organizationId, input.organizationId),
          isNull(schema.projects.skillCatalogInitializedAt)
        )
      );
    if (legacy.length > 0) {
      await transaction.insert(schema.projectAuditEvents).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        actorUserId: project.createdByUserId,
        action: "project.skill.catalog_imported",
        targetType: "project",
        targetId: input.projectId,
        metadata: { installationCount: legacy.length },
        createdAt: now,
      });
    }
  });
  return true;
}

async function applyWorkspaceSkillResults(input: {
  organizationId: string;
  projectId: string;
  skills: WorkspaceSkillInstallation[];
}) {
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    for (const skill of input.skills) {
      await transaction
        .update(schema.projectSkillInstallations)
        .set({
          status: skill.status,
          ...(skill.revision
            ? { revision: revisionToJson(skill.revision) }
            : {}),
          lastSyncAttemptAt: parseDate(skill.lastSyncAttemptAt),
          lastSyncError: skill.lastSyncError ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.projectSkillInstallations.id, skill.installationId),
            eq(
              schema.projectSkillInstallations.organizationId,
              input.organizationId
            ),
            eq(schema.projectSkillInstallations.projectId, input.projectId),
            eq(schema.projectSkillInstallations.gitUrl, skill.source.gitUrl),
            eq(schema.projectSkillInstallations.branch, skill.source.branch),
            eq(
              schema.projectSkillInstallations.path,
              skill.source.path ?? ""
            )
          )
        );
    }
  });
}

async function deferredProjectSkills(input: {
  organizationId: string;
  projectId: string;
}) {
  const skills = await listProjectSkills(input);
  return { skills, catalog: verifiedCatalog(skills), deferred: true };
}

function verifiedCatalog(skills: readonly ProjectSkill[]) {
  return skills.flatMap((skill): WorkspaceSkillCatalogEntry[] => {
    const revision = parseRevision(skill.revision);
    return revision
      ? [{
          installationId: skill.installationId,
          name: revision.name,
          description: revision.description,
          commitSha: revision.commitSha,
          contentDigest: revision.contentDigest,
          skillFile: revision.skillFile,
        }]
      : [];
  });
}

function rowToProjectSkill(
  row: typeof schema.projectSkillInstallations.$inferSelect
): ProjectSkill {
  const revision = parseRevision(row.revision);
  return {
    installationId: row.id,
    source: {
      gitUrl: row.gitUrl,
      branch: row.branch,
      ...(row.path ? { path: row.path } : {}),
    },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(revision ? { revision } : {}),
    ...(row.lastSyncAttemptAt
      ? { lastSyncAttemptAt: row.lastSyncAttemptAt.toISOString() }
      : {}),
    ...(row.lastSyncError ? { lastSyncError: row.lastSyncError } : {}),
  };
}

function normalizeSource(source: WorkspaceSkillSource) {
  try {
    return normalizeWorkspaceSkillSource(source);
  } catch (error) {
    throw new ProjectSkillError(
      "PROJECT_SKILL_SOURCE_INVALID",
      error instanceof Error ? error.message : "Skill source is invalid."
    );
  }
}

function parseWorkspaceSkills(value: unknown): WorkspaceSkillInstallation[] {
  if (!Array.isArray(value)) throw new Error("Workspace skill response is invalid.");
  return value.map((candidate) => {
    if (!(candidate && typeof candidate === "object" && !Array.isArray(candidate))) {
      throw new Error("Workspace skill response is invalid.");
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.installationId !== "string" ||
      typeof record.workspaceId !== "string" ||
      typeof record.status !== "string" ||
      !SKILL_STATUSES.has(record.status as WorkspaceSkillStatus) ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string" ||
      !(record.source && typeof record.source === "object")
    ) {
      throw new Error("Workspace skill response is invalid.");
    }
    const source = normalizeSource(record.source as WorkspaceSkillSource);
    const revision = parseRevision(record.revision);
    return {
      installationId: record.installationId,
      workspaceId: record.workspaceId,
      source,
      status: record.status as WorkspaceSkillStatus,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(revision ? { revision } : {}),
      ...(typeof record.lastSyncAttemptAt === "string"
        ? { lastSyncAttemptAt: record.lastSyncAttemptAt }
        : {}),
      ...(typeof record.lastSyncError === "string"
        ? { lastSyncError: record.lastSyncError }
        : {}),
    };
  });
}

function parseRevision(value: unknown): InstalledWorkspaceSkillRevision | undefined {
  if (!(value && typeof value === "object" && !Array.isArray(value))) return;
  const record = value as Record<string, unknown>;
  const stringFields = [
    "installationId",
    "name",
    "description",
    "commitSha",
    "contentDigest",
    "relativeRoot",
    "skillFile",
    "installedAt",
  ] as const;
  if (stringFields.some((field) => typeof record[field] !== "string")) return;
  if (!(Number.isInteger(record.fileCount) && Number.isInteger(record.totalBytes))) return;
  return record as unknown as InstalledWorkspaceSkillRevision;
}

function revisionToJson(
  revision: InstalledWorkspaceSkillRevision
): Record<string, unknown> {
  return { ...revision };
}

function parseDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueViolation(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && String(current.code) === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
