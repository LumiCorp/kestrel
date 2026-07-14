import { NextResponse } from "next/server";
import { z } from "zod";
import { listEnvironmentOperations } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    return NextResponse.json({
      operations: await listEnvironmentOperations({
        organizationId,
        environmentId: id,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
