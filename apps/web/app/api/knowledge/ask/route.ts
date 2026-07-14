import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { answerKnowledgeQuestion } from "@/lib/knowledge/documents/answer";
import { errorResponse } from "@/lib/knowledge/http";

const askKnowledgeSchema = z.object({
  question: z.string().trim().min(3).max(2000),
});

export async function POST(request: NextRequest) {
  try {
    const { organizationId } = await requireActiveOrganization();
    const input = askKnowledgeSchema.parse(await request.json());
    const response = await answerKnowledgeQuestion({
      organizationId,
      question: input.question,
    });

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
