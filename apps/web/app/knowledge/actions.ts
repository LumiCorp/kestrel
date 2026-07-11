"use server";

import type { ActionResult } from "@/lib/actions";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  createKnowledgeSource,
  createSourceSchema,
  deleteKnowledgeDocumentForUser,
  deleteKnowledgeSource,
  reindexKnowledgeDocumentForUser,
  updateKnowledgeSource,
  updateSourceSchema,
  uploadKnowledgeDocumentForUser,
} from "@/lib/knowledge/mutations";

export async function createKnowledgeSourceAction(input: {
  branch?: string;
  channelId?: string;
  handle?: string;
  label: string;
  repo?: string;
  type: "github" | "youtube";
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const body = createSourceSchema.parse(input);

    await createKnowledgeSource({
      actorUserId: session.user.id,
      body,
      organizationId,
    });

    return {
      ok: true,
      message: `Added ${body.label}.`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to add source",
    };
  }
}

export async function updateKnowledgeSourceAction(input: {
  body: Record<string, unknown>;
  sourceId: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const body = updateSourceSchema.parse(input.body);

    await updateKnowledgeSource({
      actorUserId: session.user.id,
      body,
      organizationId,
      sourceId: input.sourceId,
    });

    return {
      ok: true,
      message: "Source updated.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to save source",
    };
  }
}

export async function deleteKnowledgeSourceAction(input: {
  sourceId: string;
}): Promise<ActionResult> {
  try {
    const { organizationId, session } = await requireActiveOrganization();

    await deleteKnowledgeSource({
      actorUserId: session.user.id,
      organizationId,
      sourceId: input.sourceId,
    });

    return {
      ok: true,
      message: "Source deleted.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to delete source",
    };
  }
}

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
