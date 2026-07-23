"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { organization, useListOrganizations } from "@/lib/auth-client";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

export function WelcomeWorkspaceSwitcher({
  activeOrganizationId,
}: {
  activeOrganizationId: string;
}) {
  const router = useRouter();
  const organizations = useListOrganizations();

  return (
    <Select
      onValueChange={async (organizationId) => {
        const result = await organization.setActive({ organizationId });
        if (result.error) {
          toast.error(
            result.error.message || "Organization could not be changed",
          );
          return;
        }
        router.refresh();
      }}
      value={activeOrganizationId}
    >
      <SelectTrigger className="w-full sm:w-56">
        <SelectValue placeholder="Switch workspace" />
      </SelectTrigger>
      <SelectContent>
        {organizations.data?.map((organization: any) => (
          <SelectItem key={organization.id} value={organization.id}>
            {isPersonalOrganization(organization)
              ? "Personal"
              : organization.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
