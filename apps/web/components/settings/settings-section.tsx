import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "grid gap-5 border-t py-6 lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)] lg:gap-10",
        className
      )}
    >
      <div>
        <h2 className="font-semibold text-base tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-sm text-muted-foreground text-sm/6">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function SettingsRows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-y border-y", className)}>{children}</div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 py-4 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.4fr)] sm:items-center sm:gap-8",
        className
      )}
    >
      <div>
        <div className="font-medium text-sm">{label}</div>
        {description ? (
          <p className="mt-0.5 text-muted-foreground text-xs/5">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 sm:justify-self-stretch">{children}</div>
    </div>
  );
}
