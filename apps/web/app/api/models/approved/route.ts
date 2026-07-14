import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  GATEWAY_MODALITIES,
  getApprovedLanguageModels,
  getSpeechModelForLanguageSelection,
  listApprovedModels,
} from "@/lib/ai/gateways";
import {
  getDefaultOrganizationEnvironment,
  getOrganizationEnvironment,
  resolveThreadEnvironment,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { getProjectDetail } from "@/lib/projects/store";
import { getThreadForUser } from "@/lib/threads/store";

const querySchema = z.object({
  modality: z.enum(GATEWAY_MODALITIES).optional(),
  pairedWith: z.string().optional(),
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );

    let environment = await getDefaultOrganizationEnvironment(organizationId);
    if (query.threadId) {
      const thread = await getThreadForUser(
        query.threadId,
        session.user.id,
        organizationId
      );
      if (thread) {
        environment =
          (await resolveThreadEnvironment({
            organizationId,
            threadId: thread.id,
          })) ?? undefined;
      }
    } else if (query.projectId) {
      const project = await getProjectDetail({
        projectId: query.projectId,
        organizationId,
        userId: session.user.id,
      });
      if (!project) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 }
        );
      }
      environment =
        (await getOrganizationEnvironment({
          organizationId,
          environmentId: project.project.environmentId,
        })) ?? undefined;
    }
    if (!environment) {
      return NextResponse.json(
        { error: "No Environment is available for this request." },
        { status: 409 }
      );
    }

    if (query.modality === "language" || !query.modality) {
      const languageModels = await getApprovedLanguageModels(
        organizationId,
        environment.id
      );
      const pairedSpeech = await getSpeechModelForLanguageSelection(
        query.pairedWith,
        organizationId,
        environment.id
      );
      return NextResponse.json({
        models: languageModels,
        pairedSpeechModel: pairedSpeech,
        environment,
      });
    }

    if (query.modality === "image" || query.modality === "video") {
      return NextResponse.json({
        models: await listApprovedModels(
          query.modality,
          organizationId,
          environment.id
        ),
        environment,
      });
    }

    return NextResponse.json({
      models: await listApprovedModels(
        query.modality,
        organizationId,
        environment.id
      ),
      environment,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
