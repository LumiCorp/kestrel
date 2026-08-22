"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PageContainer } from "@/components/app-page";
import { OrganizationNavigation } from "@/components/organization/organization-navigation";
import { cn } from "@/lib/utils";

export function OrganizationShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isModelsPage = pathname === "/organization/models";

  return (
    <div className="min-h-full border-t">
      <PageContainer
        className="py-0 sm:py-0 lg:py-0"
        contentClassName={cn(
          "flex flex-col lg:flex-row lg:gap-8",
          isModelsPage && "lg:max-w-none",
        )}
      >
        <OrganizationNavigation />
        <div className="min-w-0 flex-1 py-6 sm:py-7 lg:py-8">{children}</div>
      </PageContainer>
    </div>
  );
}
