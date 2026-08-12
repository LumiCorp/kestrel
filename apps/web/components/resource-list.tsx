import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ResourceList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("divide-y border-y", className)}
      data-slot="resource-list"
      role="list"
    >
      {children}
    </div>
  );
}

export function ResourceRow({
  title,
  description,
  metadata,
  status,
  actions,
  href,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  metadata?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  href?: string;
  className?: string;
}) {
  const content = (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="truncate font-medium text-sm">{title}</div>
        {description ? (
          <div className="text-muted-foreground text-sm/5">{description}</div>
        ) : null}
        {metadata ? (
          <div className="text-muted-foreground text-xs/5">{metadata}</div>
        ) : null}
      </div>
      {status ? <div className="shrink-0 text-sm">{status}</div> : null}
    </div>
  );

  return (
    <div
      className={cn("flex min-w-0 items-center gap-3 py-3", className)}
      role="listitem"
    >
      {href ? (
        <Link
          className="flex min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          href={href}
        >
          {content}
        </Link>
      ) : (
        content
      )}
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

export function ResourceEmpty({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("py-8 text-center", className)}>
      <p className="font-medium text-sm">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-lg text-muted-foreground text-sm/6">
          {description}
        </p>
      ) : null}
    </div>
  );
}
