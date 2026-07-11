import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-md space-y-4 border border-border/70 border-dashed bg-background/80 p-8 text-center">
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          Unauthorized
        </p>
        <h1 className="font-semibold text-3xl">Sign in to continue.</h1>
        <p className="text-muted-foreground text-sm">
          This area requires an authenticated session before the app can load
          workspace data.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <Button asChild>
            <Link href="/sign-in">Sign In</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Back Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
