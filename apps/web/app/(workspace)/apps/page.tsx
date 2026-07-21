import { AppsGallery } from "@/components/apps/apps-gallery";
import { AppPage } from "@/components/app-page";
import { listAppsForOrganization } from "@/lib/apps/service";
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
  const overview = await listAppsForOrganization({
    organizationId,
    userId: session.user.id,
    canManageOrganization: canManage,
  });
  return (
    <AppPage className="max-w-7xl">
      <AppsGallery initial={overview} />
    </AppPage>
  );
}
