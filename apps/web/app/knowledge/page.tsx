import type { Session } from "@/lib/auth-types";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  getKnowledgeDocumentsPayload,
  getKnowledgeSourcesPayload,
} from "@/lib/knowledge/page-data";
import { KnowledgeClient } from "./knowledge-client";

export default async function KnowledgePage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [initialSources, documentsPayload] = await Promise.all([
    getKnowledgeSourcesPayload(organizationId),
    getKnowledgeDocumentsPayload(organizationId),
  ]);

  return (
    <KnowledgeClient
      initialDocuments={{
        documents: documentsPayload.documents,
        failedCount: documentsPayload.failedCount,
        partialCount: documentsPayload.partialCount,
        processingCount: documentsPayload.processingCount,
        readyCount: documentsPayload.readyCount,
        total: documentsPayload.total,
      }}
      initialRuntime={documentsPayload.runtime}
      initialSources={initialSources}
      session={session as Session}
    />
  );
}
