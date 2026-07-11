import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteArtifactDocumentsByIdAfterTimestamp,
  getArtifactDocumentsById,
  saveArtifactDocument,
} from "@/lib/artifacts/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const bodySchema = z.object({
  title: z.string().min(1),
  content: z.string(),
  kind: z.enum(["text", "code", "image", "sheet", "video"]),
  chatId: z.string().optional(),
});

const deleteQuerySchema = z.object({
  timestamp: z.coerce.date(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const documents = await getArtifactDocumentsById({
      id: params.id,
      userId: session.user.id,
      organizationId,
    });

    if (documents.length === 0) {
      return NextResponse.json(
        { error: "Artifact not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(documents);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());

    const document = await saveArtifactDocument({
      id: params.id,
      title: body.title,
      content: body.content,
      kind: body.kind,
      userId: session.user.id,
      organizationId,
      chatId: body.chatId ?? null,
    });

    return NextResponse.json(document);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const query = deleteQuerySchema.parse({
      timestamp: request.nextUrl.searchParams.get("timestamp"),
    });

    const deleted = await deleteArtifactDocumentsByIdAfterTimestamp({
      id: params.id,
      timestamp: query.timestamp,
      userId: session.user.id,
      organizationId,
    });

    return NextResponse.json(deleted);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
