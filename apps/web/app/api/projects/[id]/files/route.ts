import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  uploadKnowledgeDocumentForUser,
} from "@/lib/knowledge/mutations";
import { removeKnowledgeDocument } from "@/lib/knowledge/documents/runtime";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requireProjectRole } from "@/lib/projects/access";
import { getProjectDetail, updateProjectContext } from "@/lib/projects/store";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const detail = await getProjectDetail({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ documents: detail.documents });
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    await requireProjectRole({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
      return NextResponse.json(
        { error: "File size exceeds 32MB limit" },
        { status: 400 }
      );
    }
    const uploaded = await uploadKnowledgeDocumentForUser({
      organizationId,
      uploaderUserId: session.user.id,
      projectId: params.id,
      file,
    });

    try {
      const detail = await getProjectDetail({
        projectId: params.id,
        organizationId,
        userId: session.user.id,
      });
      const documentIds = [
        ...new Set([
          ...detail.documents.map((document) => document.id),
          uploaded.document.id,
        ]),
      ];
      const updated = await updateProjectContext({
        projectId: params.id,
        organizationId,
        userId: session.user.id,
        expectedRevision: detail.project.currentContextRevision,
        name: detail.project.name,
        description: detail.project.description,
        instructions: detail.contextRevision?.instructions ?? "",
        documentIds,
      });
      return NextResponse.json(
        { ...uploaded, contextRevision: updated.contextRevision },
        { status: 201 }
      );
    } catch (attachmentError) {
      if (!uploaded.deduped) {
        try {
          await removeKnowledgeDocument({
            organizationId,
            documentId: uploaded.document.id,
            actorUserId: session.user.id,
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [attachmentError, rollbackError],
            "Project context attachment and upload rollback both failed"
          );
        }
      }

      throw attachmentError;
    }
  } catch (error) {
    return errorResponse(error, 400);
  }
}
