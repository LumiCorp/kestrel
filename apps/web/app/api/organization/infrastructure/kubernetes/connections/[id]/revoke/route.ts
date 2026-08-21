import { NextResponse } from "next/server";
import { revokeKubernetesConnection } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const connectionId = routeIdSchema.parse((await context.params).id);
    const revoked = await revokeKubernetesConnection({
      organizationId,
      connectionId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ revoked: true });
  } catch (error) { return errorResponse(error, 400); }
}
