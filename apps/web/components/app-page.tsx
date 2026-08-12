import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageContainer({
  children,
  className,
  contentClassName,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <div
      className={cn("w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8", className)}
      data-slot="page-container"
      {...props}
    >
      <div
        className={cn(
          "mx-auto w-full min-w-0 max-w-7xl",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function AppPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <PageContainer contentClassName={cn("space-y-6", className)}>
      {children}
    </PageContainer>
  );
}
