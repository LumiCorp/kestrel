import { permanentRedirect } from "next/navigation";

export default async function LegacyEnvironmentActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/organization/environments/${id}/activity`);
}
