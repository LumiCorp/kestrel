import type { ReactNode } from "react";
import { OrganizationShell } from "@/components/organization/organization-shell";

export default function OrganizationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <OrganizationShell>{children}</OrganizationShell>;
}
