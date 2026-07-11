import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isOptimizableImage, optimizeImage } from "@/lib/files/image";
import { saveUpload } from "@/lib/files/storage";
import { buildUploadPath } from "@/lib/files/upload-path";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import {
  isKnowledgeDocumentMediaTypeSupported,
  normalizeMediaType,
} from "@/lib/knowledge/documents/shared";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  chatId: z.string().min(1),
});
const FILE_EXTENSION_REGEX = /\.[^.]+$/;

function isAllowedType(type: string, filename: string) {
  return isKnowledgeDocumentMediaTypeSupported(type, filename);
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ chatId: string }> }
) {
  try {
    const { session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);

    const formData = await request.formData();
    const file = (formData.get("files") ?? formData.get("file")) as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const normalizedType = normalizeMediaType(file.type, file.name);

    if (!isAllowedType(normalizedType, file.name)) {
      return NextResponse.json(
        { error: `File type ${normalizedType} is not allowed` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "File size exceeds 8MB limit" },
        { status: 400 }
      );
    }

    const processed = isOptimizableImage(normalizedType)
      ? await optimizeImage(buffer)
      : {
          buffer,
          contentType: normalizedType,
          extension: "",
        };

    const finalName = isOptimizableImage(normalizedType)
      ? `${file.name.replace(FILE_EXTENSION_REGEX, "") || "image"}${processed.extension}`
      : file.name;
    const pathnameParts = buildUploadPath({
      userId: session.user.id,
      chatId: params.chatId,
      filename: finalName,
    });
    const stored = await saveUpload({
      pathname: pathnameParts,
      buffer: processed.buffer,
      contentType: processed.contentType,
    });

    return NextResponse.json({
      pathname: stored.pathname,
      url: `/api/files/${stored.pathname}`,
      name: finalName,
      contentType: processed.contentType,
      size: processed.buffer.length,
      knowledgeEligible: isKnowledgeDocumentMediaTypeSupported(
        processed.contentType,
        finalName
      ),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
