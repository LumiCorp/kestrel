import type { ReactNode } from "react";
import { PageContainer } from "@/components/app-page";
import { OrganizationNavigation } from "@/components/organization/organization-navigation";

export default function OrganizationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-full border-t">
      <PageContainer
        className="py-0 sm:py-0 lg:py-0"
        contentClassName="flex flex-col lg:flex-row lg:gap-8"
      >
        <OrganizationNavigation />
        <div className="min-w-0 flex-1 py-6 sm:py-7 lg:py-8">
          {children}
        </div>
      </PageContainer>
    </div>
  );
}
