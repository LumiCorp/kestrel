import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export type ProjectRole = "owner" | "editor" | "member";

const ROLE_RANK: Record<ProjectRole, number> = {
  member: 1,
  editor: 2,
  owner: 3,
};

export class ProjectAccessError extends Error {
  readonly code: "PROJECT_NOT_FOUND" | "PROJECT_FORBIDDEN";

  constructor(code: ProjectAccessError["code"], message: string) {
    super(message);
    this.name = "ProjectAccessError";
    this.code = code;
  }
}

export async function getProjectAccess(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  includeArchived?: boolean;
}) {
  const [access] = await knowledgeDb
    .select({
      project: schema.projects,
      role: schema.projectMembers.role,
      organizationMemberId: schema.members.id,
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
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.organizationId, input.organizationId)
      )
    )
    .limit(1);

  if (!access) {
    return null;
  }
  if (!input.includeArchived && access.project.archivedAt) {
    return null;
  }
  return access;
}

export async function requireProjectRole(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  minimumRole?: ProjectRole;
  includeArchived?: boolean;
}) {
  const access = await getProjectAccess(input);
  if (!access) {
    throw new ProjectAccessError(
      "PROJECT_NOT_FOUND",
      "Project not found or unavailable."
    );
  }

  const minimumRole = input.minimumRole ?? "member";
  if (ROLE_RANK[access.role] < ROLE_RANK[minimumRole]) {
    throw new ProjectAccessError(
      "PROJECT_FORBIDDEN",
      `Project ${minimumRole} access is required.`
    );
  }
  return access;
}

export function projectRoleAllows(actual: ProjectRole, minimum: ProjectRole) {
  return ROLE_RANK[actual] >= ROLE_RANK[minimum];
}
