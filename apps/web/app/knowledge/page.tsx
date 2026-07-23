import type { Session } from "@/lib/auth-types";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { getKnowledgeDocumentsPayload } from "@/lib/knowledge/page-data";
import { KnowledgeClient } from "./knowledge-client";

export default async function KnowledgePage() {
  const { organizationId, session } = await requireActiveOrganization();
  const documentsPayload = await getKnowledgeDocumentsPayload(
    organizationId,
    session.user.id
  );

  return (
    <KnowledgeClient
      initialDocuments={documentsPayload}
      session={session as Session}
    />
  );
}
