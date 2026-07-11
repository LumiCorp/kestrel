import type { ReactNode } from "react";

export function AdminEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-muted/20 px-6 py-12 text-center">
      <div className="mx-auto max-w-md space-y-2">
        <h3 className="font-medium text-lg">{title}</h3>
        <p className="text-muted-foreground text-sm">{description}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  );
}
