import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { enqueueKubernetesQualification } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const connectionId = routeIdSchema.parse((await context.params).id);
    const run = await enqueueKubernetesQualification({ organizationId, connectionId, actorUserId: session.user.id });
    await logAdminEvent({ organizationId, actorUserId: session.user.id, category: "environments", action: "kubernetes_connection.qualification.started", targetType: "provider-connection", targetId: connectionId, message: "Started active Kubernetes qualification.", metadata: { runId: run.runId, commandId: run.commandId } });
    return NextResponse.json(run, { status: 202 });
  } catch (error) { return errorResponse(error, 400); }
}
