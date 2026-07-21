import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AppPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div
        className={cn("mx-auto w-full max-w-6xl space-y-6", className)}
      >
        {children}
      </div>
    </div>
  );
}
