import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeDesktopEnrollment } from "@/lib/environments/desktop";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({
  requestSecret: z.string().min(32).max(256),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const id = routeIdSchema.parse((await context.params).id);
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(
      await consumeDesktopEnrollment({
        requestId: id,
        requestSecret: body.requestSecret,
      }),
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
