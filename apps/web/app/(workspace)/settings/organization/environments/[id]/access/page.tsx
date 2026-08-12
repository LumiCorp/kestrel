import { permanentRedirect } from "next/navigation";

export default async function LegacyOrganizationEnvironmentAccessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/organization/environments/${id}/access`);
}
