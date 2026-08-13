"use client";

import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { Button } from "@/components/ui/button";

export default function AdminEnvironmentOperationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="The platform diagnostics query did not complete."
        eyebrow="Platform operations"
        title="Environment Operations"
      />
      <AdminStatusBanner
        description={
          error.digest
            ? `The failure was retained as error ${error.digest}.`
            : "Retry the diagnostics request or inspect the platform logs."
        }
        title="Environment diagnostics failed to load"
        variant="error"
      />
      <div className="flex gap-3">
        <Button onClick={() => reset()}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/platform/docs">Open platform docs</Link>
        </Button>
      </div>
    </div>
  );
}
