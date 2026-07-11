import type { ReactNode } from "react";

export function AdminPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="space-y-2">
        {eyebrow ? (
          <div className="text-muted-foreground text-xs uppercase tracking-[0.2em]">
            {eyebrow}
          </div>
        ) : null}
        <div className="space-y-1">
          <h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
          {description ? (
            <p className="max-w-3xl text-muted-foreground text-sm">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
