import { isAdminUser } from "@/lib/knowledge/auth";
import { getKnowledgeDocumentById } from "@/lib/knowledge/documents/store";
import { requireProjectRole } from "@/lib/projects/access";

export async function requireKnowledgeDocumentAccess(input: {
  organizationId: string;
  user: { id: string; role?: string | null };
  documentId: string;
  manage?: boolean;
}) {
  const document = await getKnowledgeDocumentById(
    input.organizationId,
    input.documentId
  );
  if (!document || document.archivedAt) {
    throw new Error("Knowledge document not found");
  }
  if (document.scope === "project") {
    if (!document.projectId) {
      throw new Error("Project document scope is invalid");
    }
    await requireProjectRole({
      projectId: document.projectId,
      organizationId: input.organizationId,
      userId: input.user.id,
      minimumRole: input.manage ? "editor" : "member",
    });
    return document;
  }
  if (
    input.manage &&
    document.uploaderUserId !== input.user.id &&
    !isAdminUser(input.user)
  ) {
    throw new Error("Forbidden");
  }
  return document;
}
