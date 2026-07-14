import { NextResponse } from "next/server";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    await requireActiveOrganization();

    return NextResponse.json({
      capabilities: ["searchKnowledgeDocuments"],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
