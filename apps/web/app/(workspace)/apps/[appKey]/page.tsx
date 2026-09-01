import { notFound } from "next/navigation";
import { AppDetail } from "@/components/apps/app-detail";
import { AppPage } from "@/components/app-page";
import { listHostedBrowserPersonalDomains } from "@/lib/apps/browser-domain-service";
import { getAppForOrganization } from "@/lib/apps/service";
import { listOrganizationEnvironments } from "@/lib/environments/store";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";

export default async function AppDetailPage({
  params,
}: {
  params: Promise<{ appKey: string }>;
}) {
  const { appKey } = await params;
  const decodedAppKey = decodeURIComponent(appKey);
  const { organizationId, session } = await requireActiveOrganization();
  const canManage = await canManageOrganization({
    organizationId,
    userId: session.user.id,
  });
  const app = await getAppForOrganization({
    organizationId,
    userId: session.user.id,
    canManageOrganization: canManage,
    appKey: decodedAppKey,
  });
  if (!app) notFound();
  const browserPersonalDomainEnvironments =
    decodedAppKey === "built_in.browser"
      ? await Promise.all(
          (await listOrganizationEnvironments(organizationId)).map(
            async (environment) => ({
              id: environment.id,
              name: environment.name,
              domains: (
                await listHostedBrowserPersonalDomains({
                  organizationId,
                  environmentId: environment.id,
                  userId: session.user.id,
                })
              ).map((domain) => ({
                ...domain,
                approvedAt: domain.approvedAt.toISOString(),
                revokedAt: domain.revokedAt?.toISOString() ?? null,
              })),
            }),
          ),
        )
      : [];
  return (
    <AppPage>
      <AppDetail
        app={app}
        browserPersonalDomainEnvironments={browserPersonalDomainEnvironments}
      />
    </AppPage>
  );
}
