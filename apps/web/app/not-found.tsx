import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-md space-y-4 border border-border/70 border-dashed bg-background/80 p-8 text-center">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          Not Found
        </p>
        <h1 className="font-semibold text-3xl">This page is unavailable.</h1>
        <p className="text-muted-foreground text-sm">
          The resource may have been removed, the link may be stale, or the URL
          may be incorrect.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Button asChild>
            <Link href="/">Go Home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/chat">Open Workspace</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
