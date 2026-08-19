import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { getKubernetesConnection, kubernetesConnectorRuntime } from "@/lib/environments/kubernetes-connector";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const connectionId = routeIdSchema.parse((await context.params).id);
    const current = await getKubernetesConnection({ organizationId, connectionId });
    if (!current.connector) throw new Error("Kubernetes connector is unavailable.");
    await kubernetesConnectorRuntime.revoke({ organizationId, connectorId: current.connector.id });
    await knowledgeDb
      .update(schema.environmentProviderConnections)
      .set({ revokedByUserId: session.user.id, updatedAt: new Date() })
      .where(eq(schema.environmentProviderConnections.id, connectionId));
    await logAdminEvent({ organizationId, actorUserId: session.user.id, category: "environments", action: "kubernetes_connection.revoked", targetType: "provider-connection", targetId: connectionId, message: `Revoked Kubernetes connection ${current.connection.displayName}.` });
    return NextResponse.json({ revoked: true });
  } catch (error) { return errorResponse(error, 400); }
}
