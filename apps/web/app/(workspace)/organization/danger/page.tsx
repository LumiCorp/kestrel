import { notFound } from "next/navigation";
import { OrganizationDeletePanel } from "@/components/organization/organization-delete-panel";
import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-section";
import { getOrganizationDeletionOperation } from "@/lib/organizations/deletion";
import { requireOrganizationOwner } from "@/lib/knowledge/auth";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";

export default async function OrganizationDangerPage() {
  const { organizationId, organization } = await requireOrganizationOwner({
    allowDeleting: true,
  });
  if (isPersonalOrganizationSlug(organization.slug)) notFound();
  const operation = await getOrganizationDeletionOperation({ organizationId });
  return (
    <SettingsPage width="narrow">
      <SettingsPageHeader
        description="Permanently remove this organization and its managed infrastructure."
        eyebrow="Danger zone"
        title={`Delete ${organization.name}`}
      />
      <OrganizationDeletePanel
        organizationName={organization.name}
        operation={
          operation
            ? {
                status: operation.status,
                stage: operation.stage,
                errorMessage: operation.errorMessage,
                inventory: operation.inventory,
              }
            : null
        }
      />
    </SettingsPage>
  );
}
