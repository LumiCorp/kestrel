import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function AdminStatusBanner({
  variant = "info",
  title,
  description,
}: {
  variant?: "info" | "success" | "warning" | "error";
  title: string;
  description?: string;
}) {
  const palette =
    variant === "success"
      ? "border-emerald-300 text-emerald-800 dark:border-emerald-900 dark:text-emerald-300"
      : variant === "warning"
        ? "border-amber-300 text-amber-800 dark:border-amber-900 dark:text-amber-300"
        : variant === "error"
          ? "border-red-300 text-red-800 dark:border-red-900 dark:text-red-300"
          : "border-border text-foreground";

  return (
    <div className={cn("border-y py-3", palette)}>
      <div className="flex items-center gap-3">
        <Badge className="shrink-0 bg-background text-foreground" variant="outline">
          {variant}
        </Badge>
        <div>
          <div className="font-medium text-sm">{title}</div>
          {description ? (
            <div className="text-sm/6 opacity-80">{description}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
