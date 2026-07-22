import { notFound } from "next/navigation";
import { EnvironmentAppSettings } from "@/components/apps/environment-apps-panel";
import { getEnvironmentAppConfiguration } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function EnvironmentAppDetailPage({
  params,
}: {
  params: Promise<{ id: string; appKey: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id, appKey } = await params;
  const decodedAppKey = decodeURIComponent(appKey);
  const configuration = await getEnvironmentAppConfiguration({
    organizationId,
    environmentId: id,
    appKey: decodedAppKey,
  }).catch(() => null);
  if (!configuration) notFound();

  return (
    <EnvironmentAppSettings
      environmentId={id}
      initialConfiguration={configuration}
    />
  );
}
