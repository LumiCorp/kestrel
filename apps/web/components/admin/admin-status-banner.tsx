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
      ? "border-emerald-200 bg-emerald-50 text-emerald-950"
      : variant === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-950"
        : variant === "error"
          ? "border-red-200 bg-red-50 text-red-950"
          : "border-slate-200 bg-slate-50 text-slate-950";

  return (
    <div className={cn("rounded-xl border p-4", palette)}>
      <div className="flex items-center gap-3">
        <Badge className="bg-background/80 text-foreground" variant="outline">
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
