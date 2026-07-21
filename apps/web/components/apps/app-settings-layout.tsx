import Link from "next/link";
import type { ReactNode } from "react";
import { AppIcon } from "@/components/apps/app-icon";
import { Badge } from "@/components/ui/badge";

export function AppSettingsHeader({
  appKey,
  icon,
  name,
  description,
  backHref,
  backLabel,
  status,
  action,
}: {
  appKey: string;
  icon: string | null;
  name: string;
  description: string;
  backHref: string;
  backLabel: string;
  status: string;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <Link
        className="inline-flex text-muted-foreground text-sm hover:text-foreground"
        href={backHref}
      >
        ← {backLabel}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="flex min-w-0 items-start gap-4">
          <AppIcon appKey={appKey} className="size-12" icon={icon} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-semibold text-xl">{name}</h1>
              <Badge variant="outline">{status}</Badge>
            </div>
            <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
              {description}
            </p>
          </div>
        </div>
        {action}
      </div>
    </div>
  );
}

export function AppSettingsSection({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-start gap-2">
        {icon ? <span className="mt-0.5 text-muted-foreground">{icon}</span> : null}
        <div>
          <h2 className="font-medium text-sm">{title}</h2>
          {description ? (
            <p className="mt-1 text-muted-foreground text-xs">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 divide-y border-y">{children}</div>
    </section>
  );
}
