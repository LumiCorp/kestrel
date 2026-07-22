import { redirect } from "next/navigation";
import {
  OrganizationSetupClient,
  type SetupGateway,
} from "@/components/settings/setup-client";
import { listAIGatewaysWithModels } from "@/lib/ai/gateways";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { getOrganizationChatReadiness } from "@/lib/organizations/chat-readiness";

export default async function OrganizationSetupPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const [readiness, gatewayRows] = await Promise.all([
    getOrganizationChatReadiness(organizationId),
    listAIGatewaysWithModels(organizationId),
  ]);
  if (!readiness.applicable) {
    redirect("/settings/organization/members");
  }
  const gateways: SetupGateway[] = gatewayRows.map(({ gateway, models }) => ({
    id: gateway.id,
    provider: gateway.provider,
    displayName: gateway.displayName,
    enabled: gateway.enabled,
    hasApiKey: gateway.hasApiKey,
    environmentId: gateway.environmentId,
    models: models.map((model) => ({
      id: model.id,
      gatewayId: model.gatewayId,
      rawModelId: model.rawModelId,
      alias: model.alias,
      modality: model.modality,
      approved: model.approved,
      isDefault: model.isDefault,
      description: model.description,
      metadata:
        model.metadata && typeof model.metadata === "object"
          ? (model.metadata as Record<string, unknown>)
          : null,
    })),
  }));
  return (
    <OrganizationSetupClient
      initialGateways={gateways}
      initialReadiness={readiness}
    />
  );
}
