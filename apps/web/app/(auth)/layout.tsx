import type { ReactNode } from "react";
import { PageContainer } from "@/components/app-page";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <PageContainer
      className="min-h-screen"
      contentClassName="max-w-md"
    >
      {children}
    </PageContainer>
  );
}
