import { PageHeader } from "@/components/page-header";
import { TurnWorkerCapacityClient } from "@/components/platform/turn-worker-capacity-client";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function PlatformRuntimePage() {
  await requireAdmin();
  return (
    <div className="space-y-8">
      <PageHeader
        description="Set durable Thread execution capacity and inspect the Fly Turn Worker topology."
        eyebrow="Platform · Operate"
        title="Turn workers"
      />
      <TurnWorkerCapacityClient />
    </div>
  );
}
