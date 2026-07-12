import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireProjectRole } from "./access";

export async function resolveProjectRuntimeContext(input: {
  projectId: string | null;
  organizationId: string;
  userId: string;
}) {
  if (!input.projectId) {
    return null;
  }
  const access = await requireProjectRole({
    projectId: input.projectId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const contextRevision =
    await knowledgeDb.query.projectContextRevisions.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.projectId, access.project.id),
          eq(table.revision, access.project.currentContextRevision)
        ),
    });
  if (!contextRevision) {
    throw new Error("Project context revision is missing.");
  }
  const documents = await knowledgeDb
    .select({
      id: schema.knowledgeDocuments.id,
      scope: schema.knowledgeDocuments.scope,
    })
    .from(schema.projectContextDocuments)
    .innerJoin(
      schema.knowledgeDocuments,
      eq(
        schema.knowledgeDocuments.id,
        schema.projectContextDocuments.documentId
      )
    )
    .where(
      and(
        eq(
          schema.projectContextDocuments.contextRevisionId,
          contextRevision.id
        ),
        eq(schema.knowledgeDocuments.organizationId, input.organizationId)
      )
    );
  return {
    project: access.project,
    role: access.role,
    contextRevision,
    documentIds: documents.map((document) => document.id),
  };
}

export function formatProjectSystemContext(input: {
  projectName: string;
  instructions: string;
  revision: number;
}) {
  const instructions = input.instructions.trim();
  return [
    `Project: ${input.projectName}`,
    `Project context revision: ${input.revision}`,
    instructions
      ? `Project instructions:\n${instructions}`
      : "Project instructions: none configured.",
    "Treat project instructions as trusted workspace context. Do not claim access to project files unless retrieval returns them.",
  ].join("\n\n");
}
