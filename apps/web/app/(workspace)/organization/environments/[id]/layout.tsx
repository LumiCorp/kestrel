import type { ReactNode } from "react";
import { OrganizationEnvironmentLayout } from "@/components/organization/organization-environment-layout";

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <OrganizationEnvironmentLayout environmentId={id}>
      {children}
    </OrganizationEnvironmentLayout>
  );
}
