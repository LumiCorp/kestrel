import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { createMcpServerInputSchema } from "@/lib/mcp/contracts";
import {
  installEnvironmentMcpServer,
  listEnvironmentMcpServers,
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
      servers: await listEnvironmentMcpServers({
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
    const server = createMcpServerInputSchema.parse(await request.json());
    const installed = await installEnvironmentMcpServer({
      organizationId,
      environmentId: id,
      actorUserId: session.user.id,
      server,
    });
    return NextResponse.json({ server: installed }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
