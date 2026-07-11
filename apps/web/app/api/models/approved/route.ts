import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  GATEWAY_MODALITIES,
  getApprovedLanguageModels,
  getGenerationModelsByKind,
  getSpeechModelForLanguageSelection,
  listApprovedModels,
} from "@/lib/ai/gateways";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const querySchema = z.object({
  modality: z.enum(GATEWAY_MODALITIES).optional(),
  pairedWith: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireActiveOrganization();
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );

    if (query.modality === "language" || !query.modality) {
      const languageModels = await getApprovedLanguageModels();
      const pairedSpeech = await getSpeechModelForLanguageSelection(
        query.pairedWith
      );
      return NextResponse.json({
        models: languageModels,
        pairedSpeechModel: pairedSpeech,
      });
    }

    if (query.modality === "image" || query.modality === "video") {
      return NextResponse.json({
        models: await getGenerationModelsByKind(query.modality),
      });
    }

    return NextResponse.json({
      models: await listApprovedModels(query.modality),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
