import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  status,
  actions,
  headingLevel = 1,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  status?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  return (
    <header className="flex w-full min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="w-full min-w-0 space-y-2 sm:flex-1">
        {eyebrow ? (
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
            {eyebrow}
          </p>
        ) : null}
        <div className="space-y-1">
          {headingLevel === 1 ? (
            <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">
              {title}
            </h1>
          ) : (
            <h2 className="font-semibold text-2xl tracking-tight sm:text-3xl">
              {title}
            </h2>
          )}
          {description ? (
            <p className="max-w-3xl text-muted-foreground text-sm/6">
              {description}
            </p>
          ) : null}
        </div>
        {status ? <div className="pt-1">{status}</div> : null}
      </div>
      {actions ? (
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
