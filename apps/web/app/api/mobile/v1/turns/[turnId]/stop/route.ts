import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileTurnDto } from "@/lib/mobile/dto";
import { requestDurableTurnStop } from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function POST(
  _request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { turnId } = paramsSchema.parse(await context.params);
    const turn = await requestDurableTurnStop({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ turn: mobileTurnDto(turn) }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
