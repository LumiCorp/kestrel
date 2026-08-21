import { NextResponse } from "next/server";
import { z } from "zod";
import { initializeThreadFile } from "@/lib/files/service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  threadId: z.string().min(1),
  filename: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  declaredMediaType: z.string().min(1).max(255).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const body = bodySchema.parse(await request.json());
    const file = await initializeThreadFile({
      threadId: body.threadId,
      organizationId,
      userId: session.user.id,
      filename: body.filename,
      sizeBytes: body.sizeBytes,
      declaredMediaType: body.declaredMediaType,
    });
    return NextResponse.json({
      fileId: file.id,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      state: file.lifecycleState,
      uploadUrl: `/api/files/${encodeURIComponent(file.id)}?threadId=${encodeURIComponent(body.threadId)}`,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
