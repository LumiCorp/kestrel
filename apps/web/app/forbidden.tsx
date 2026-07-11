import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-md space-y-4 border border-border/70 border-dashed bg-background/80 p-8 text-center">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          Forbidden
        </p>
        <h1 className="font-semibold text-3xl">You do not have access.</h1>
        <p className="text-muted-foreground text-sm">
          Your account is authenticated, but it does not have permission to open
          this area.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Button asChild>
            <Link href="/dashboard">Open Dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Back Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
