import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "@/lib/knowledge/documents/shared";
import { getKnowledgeDocumentsPayload } from "@/lib/knowledge/page-data";
import { errorResponse } from "@/lib/knowledge/http";
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  uploadKnowledgeDocumentForUser,
} from "@/lib/knowledge/mutations";

const listQuerySchema = z.object({
  status: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const query = listQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );

    return NextResponse.json(
      await getKnowledgeDocumentsPayload(
        organizationId,
        session.user.id,
        query.status
      )
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const mediaType = normalizeMediaType(file.type, file.name);
    if (!isKnowledgeDocumentMediaTypeSupported(mediaType, file.name)) {
      return NextResponse.json(
        {
          error: `File type ${mediaType} is not supported for knowledge uploads`,
        },
        { status: 400 }
      );
    }

    const bytes = file.size;
    if (bytes > MAX_KNOWLEDGE_FILE_BYTES) {
      return NextResponse.json(
        { error: "File size exceeds 32MB limit" },
        { status: 400 }
      );
    }

    const { document, run, deduped } = await uploadKnowledgeDocumentForUser({
      organizationId,
      uploaderUserId: session.user.id,
      file,
    });

    const message = deduped
      ? run
        ? `Reused ${document.filename}. Reindexing has started on the existing document.`
        : `Reused ${document.filename}. This file already exists in the Knowledge Library.`
      : `Uploaded ${document.filename}. Indexing has started.`;

    return NextResponse.json(
      {
        document,
        run,
        deduped,
        message,
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
