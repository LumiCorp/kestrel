"use server";

import type { ActionResult } from "@/lib/actions";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  deleteKnowledgeDocumentForUser,
  reindexKnowledgeDocumentForUser,
  uploadKnowledgeDocumentForUser,
} from "@/lib/knowledge/mutations";

export async function uploadKnowledgeDocumentsAction(
  formData: FormData
): Promise<ActionResult<{ messages: string[] }>> {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const files = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File);

    if (files.length === 0) {
      return { ok: false, error: "No file provided" };
    }

    const messages: string[] = [];

    for (const file of files) {
      const { document, run, deduped } = await uploadKnowledgeDocumentForUser({
        file,
        organizationId,
        uploaderUserId: session.user.id,
      });

      const message = deduped
        ? run
          ? `Reused ${document.filename}. Reindexing has started on the existing document.`
          : `Reused ${document.filename}. This file already exists in the Knowledge Library.`
        : `Uploaded ${document.filename}. Indexing has started.`;

      messages.push(message);
    }

    return {
      ok: true,
      data: { messages },
      message: messages.at(-1) || "Document upload started.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
}

export async function reindexKnowledgeDocumentAction(input: {
  documentId: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const user = session.user as { id?: string | null; role?: string | null };
    const result = await reindexKnowledgeDocumentForUser({
      actorUser: user,
      documentId: input.documentId,
      organizationId,
      requestedByUserId: session.user.id,
    });

    return {
      ok: true,
      message: result.message,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to reindex document",
    };
  }
}

export async function deleteKnowledgeDocumentAction(input: {
  documentId: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const user = session.user as { id?: string | null; role?: string | null };

    await deleteKnowledgeDocumentForUser({
      actorUser: user,
      actorUserId: session.user.id,
      documentId: input.documentId,
      organizationId,
    });

    return {
      ok: true,
      message: "Document deleted.",
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to delete document",
    };
  }
}
