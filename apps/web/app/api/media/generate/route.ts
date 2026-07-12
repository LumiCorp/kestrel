import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createMediaGenerationJob } from "@/lib/ai/media";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  threadId: z.string().min(1).optional(),
  kind: z.enum(["image", "video"]),
  prompt: z.string().min(1).max(4000),
  modelId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const body = bodySchema.parse(await request.json());

    const job = await createMediaGenerationJob({
      organizationId,
      userId: session.user.id,
      threadId: body.threadId,
      kind: body.kind,
      prompt: body.prompt,
      modelId: body.modelId,
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
