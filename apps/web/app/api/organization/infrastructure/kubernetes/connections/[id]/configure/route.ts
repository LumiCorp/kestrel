import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { configureKubernetesConnection } from "@/lib/environments/kubernetes-connector";
import { requireKubernetesByocAdmission } from "@/lib/environments/config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    await requireKubernetesByocAdmission({ organizationId, requireLogicalRouting: false });
    const connectionId = routeIdSchema.parse((await context.params).id);
    const configured = await configureKubernetesConnection({
      organizationId,
      connectionId,
      actorUserId: session.user.id,
      value: await request.json(),
    });
    await logAdminEvent({ organizationId, actorUserId: session.user.id, category: "environments", action: "kubernetes_connection.configured", targetType: "provider-connection", targetId: connectionId, message: `Configured Kubernetes connection ${configured.connection.displayName}.`, metadata: { configRevision: configured.configRevision, infrastructureRevision: configured.infrastructureRevision, infrastructureChanged: configured.infrastructureChanged } });
    if (configured.defaultChanged) {
      await logAdminEvent({ organizationId, actorUserId: session.user.id, category: "environments", action: "kubernetes_connection.default.updated", targetType: "provider-connection", targetId: connectionId, message: `${configured.connection.isDefault ? "Set" : "Removed"} the default Kubernetes connection.`, metadata: { isDefault: configured.connection.isDefault } });
    }
    return NextResponse.json(configured);
  } catch (error) { return errorResponse(error, 400); }
}
