import { redirect } from "next/navigation";
import { OrganizationEstateMap } from "@/components/estate-map/organization-estate-map";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { getOrganizationSystemsMapSnapshot } from "@/lib/organizations/systems-map";

export default async function OrganizationSystemsMapPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const snapshot = await getOrganizationSystemsMapSnapshot({ organizationId });
  if (!snapshot) redirect("/");
  return <OrganizationEstateMap snapshot={snapshot} />;
}
