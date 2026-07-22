import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { createMcpCredentialInputSchema } from "@/lib/mcp/contracts";
import {
  createEnvironmentMcpCredential,
  listEnvironmentMcpCredentials,
} from "@/lib/mcp/control-plane";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    return NextResponse.json({
      credentials: await listEnvironmentMcpCredentials({
        organizationId,
        environmentId: id,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    const credential = createMcpCredentialInputSchema.parse(
      await request.json()
    );
    const created = await createEnvironmentMcpCredential({
      organizationId,
      environmentId: id,
      actorUserId: session.user.id,
      credential,
    });
    return NextResponse.json({ credential: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
