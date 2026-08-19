import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { approveKubernetesConnectorEnrollment } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const approved = await approveKubernetesConnectorEnrollment({
      requestId: routeIdSchema.parse((await context.params).id),
      organizationId,
      actorUserId: session.user.id,
      approval: await request.json(),
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "environments",
      action: "kubernetes_connector.enrollment.approved",
      targetType: "provider-connection",
      targetId: approved.connection.id,
      message: `Approved Kubernetes connector ${approved.connection.displayName}.`,
      metadata: { fingerprint: approved.fingerprint },
    });
    return NextResponse.json(approved, { status: 201 });
  } catch (error) { return errorResponse(error, 400); }
}
