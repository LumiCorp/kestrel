import { notFound } from "next/navigation";
import { OrganizationDeletePanel } from "@/components/organization/organization-delete-panel";
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
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-10">
      <div>
        <p className="font-medium text-destructive text-sm">Danger zone</p>
        <h1 className="mt-1 font-semibold text-3xl tracking-tight">
          Delete {organization.name}
        </h1>
      </div>
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
    </div>
  );
}
