"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <main className="flex min-h-screen items-center justify-center px-6 py-16">
          <div className="w-full max-w-md space-y-4 border border-border/70 border-dashed bg-background/80 p-8 text-center">
            <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
              Global Error
            </p>
            <h1 className="font-semibold text-3xl">The app failed to load.</h1>
            <p className="text-muted-foreground text-sm">
              A top-level error interrupted the app shell before the current
              route could render.
            </p>
            {error.digest ? (
              <p className="font-mono text-muted-foreground text-xs">
                Error ID: {error.digest}
              </p>
            ) : null}
            <div className="flex justify-center gap-3 pt-2">
              <Button onClick={() => reset()}>Try Again</Button>
              <Button asChild variant="outline">
                <Link href="/">Go Home</Link>
              </Button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
