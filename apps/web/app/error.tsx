"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-md space-y-4 border border-border/70 border-dashed bg-background/80 p-8 text-center">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          Application Error
        </p>
        <h1 className="font-semibold text-3xl">Something went wrong.</h1>
        <p className="text-muted-foreground text-sm">
          The page could not finish rendering. Try the request again or return
          to a stable route.
        </p>
        {error.digest ? (
          <p className="font-mono text-muted-foreground text-xs">
            Error ID: {error.digest}
          </p>
        ) : null}
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => reset()}>Try Again</Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Open Dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
