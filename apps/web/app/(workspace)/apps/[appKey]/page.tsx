import { notFound } from "next/navigation";
import { AppDetail } from "@/components/apps/app-detail";
import { AppPage } from "@/components/app-page";
import { getAppForOrganization } from "@/lib/apps/service";
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
  const { organizationId, session } = await requireActiveOrganization();
  const canManage = await canManageOrganization({
    organizationId,
    userId: session.user.id,
  });
  const app = await getAppForOrganization({
    organizationId,
    userId: session.user.id,
    canManageOrganization: canManage,
    appKey: decodeURIComponent(appKey),
  });
  if (!app) notFound();
  return (
    <AppPage className="mx-auto w-full max-w-6xl p-6 lg:p-8">
      <AppDetail app={app} />
    </AppPage>
  );
}
