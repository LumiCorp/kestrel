import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  getAgentConfigForOrganization,
  upsertAgentConfigForOrganization,
} from "@/lib/agent/config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  additionalPrompt: z.string().nullable().optional(),
  responseStyle: z
    .enum(["concise", "detailed", "technical", "friendly"])
    .optional(),
  language: z.string().optional(),
  defaultModel: z.string().nullable().optional(),
  maxStepsMultiplier: z.number().min(0.5).max(3).optional(),
  temperature: z.number().min(0).max(2).optional(),
  searchInstructions: z.string().nullable().optional(),
  citationFormat: z.enum(["inline", "footnote", "none"]).optional(),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const config = await getAgentConfigForOrganization(organizationId);
    return NextResponse.json(config);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());
    const config = await upsertAgentConfigForOrganization(organizationId, body);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "agent",
      action: "update-config",
      targetType: "agent_config",
      targetId: config.id,
      message: "Updated agent configuration.",
      metadata: {
        responseStyle: config.responseStyle,
        defaultModel: config.defaultModel,
      },
    });
    return NextResponse.json(config);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
