import { permanentRedirect } from "next/navigation";

export default async function LegacyOrganizationEnvironmentAppDetailPage({
  params,
}: {
  params: Promise<{ id: string; appKey: string }>;
}) {
  const { id, appKey } = await params;
  permanentRedirect(
    `/organization/environments/${id}/apps/${encodeURIComponent(appKey)}`,
  );
}
