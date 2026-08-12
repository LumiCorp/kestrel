import { AppsGallery } from "@/components/apps/apps-gallery";
import { AppPage } from "@/components/app-page";
import { listAppsForOrganization } from "@/lib/apps/service";
import { getDefaultOrganizationEnvironment } from "@/lib/environments/store";
import {
  canManageOrganization,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";

export default async function AppsPage() {
  const { organizationId, session } = await requireActiveOrganization();
  const canManage = await canManageOrganization({
    organizationId,
    userId: session.user.id,
  });
  const [overview, defaultEnvironment] = await Promise.all([
    listAppsForOrganization({
      organizationId,
      userId: session.user.id,
      canManageOrganization: canManage,
    }),
    canManage
      ? getDefaultOrganizationEnvironment(organizationId)
      : Promise.resolve(null),
  ]);
  return (
    <AppPage className="max-w-7xl">
      <AppsGallery
        addAppHref={
          defaultEnvironment
            ? `/organization/environments/${defaultEnvironment.id}/apps`
            : undefined
        }
        initial={overview}
      />
    </AppPage>
  );
}
