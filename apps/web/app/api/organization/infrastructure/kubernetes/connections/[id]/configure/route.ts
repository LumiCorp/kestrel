import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { configureKubernetesConnection } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const connectionId = routeIdSchema.parse((await context.params).id);
    const configured = await configureKubernetesConnection({
      organizationId,
      connectionId,
      actorUserId: session.user.id,
      value: await request.json(),
    });
    await logAdminEvent({ organizationId, actorUserId: session.user.id, category: "environments", action: "kubernetes_connection.configured", targetType: "provider-connection", targetId: connectionId, message: `Configured Kubernetes connection ${configured.connection.displayName}.`, metadata: { configRevision: configured.configRevision } });
    return NextResponse.json(configured);
  } catch (error) { return errorResponse(error, 400); }
}
