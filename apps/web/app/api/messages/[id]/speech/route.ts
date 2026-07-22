import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSpeechModelForLanguageSelection } from "@/lib/ai/gateways";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  getMessageSpeechAssetForUser,
  getOrCreateMessageSpeechAsset,
} from "@/lib/messages/speech";
import { getStorageAdapter } from "@/lib/storage";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const bodySchema = z.object({
  modelId: z.string().min(1).optional(),
  languageModelId: z.string().min(1).optional(),
  voice: z.string().min(1).optional(),
});

const querySchema = z.object({
  assetId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const resolvedSpeechModel =
      body.modelId ||
      (await getSpeechModelForLanguageSelection(
        body.languageModelId,
        organizationId
      ))?.id;
    const asset = await getOrCreateMessageSpeechAsset({
      messageId: params.id,
      userId: session.user.id,
      organizationId,
      modelId: resolvedSpeechModel,
      voice: body.voice,
    });

    if (!asset) {
      return NextResponse.json(
        { error: "Speech playback is not available for this message." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      assetId: asset.id,
      modelId: asset.modelId,
      voice: asset.voice,
      audioUrl: `/api/messages/${params.id}/speech?assetId=${asset.id}`,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const query = querySchema.parse({
      assetId:
        _request.nextUrl.searchParams.get("assetId") ||
        _request.nextUrl.searchParams.get("id"),
    });

    const asset = await getMessageSpeechAssetForUser({
      assetId: query.assetId,
      messageId: params.id,
      userId: session.user.id,
      organizationId,
    });

    if (!asset) {
      return NextResponse.json({ error: "Audio not found" }, { status: 404 });
    }

    const storage = getStorageAdapter();
    const buffer = await storage.getObjectBuffer(asset.storageKey);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": asset.mediaType,
        "content-length": String(buffer.length),
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
