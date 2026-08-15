import { AdminPageHeader } from "@/components/admin/admin-page-header";
import {
  getEnvironmentRuntimeChannel,
  listEnvironmentRuntimeCanaries,
} from "@/lib/environments/runtime-channel";
import { requireAdmin } from "@/lib/knowledge/auth";
import { RuntimeChannelClient } from "./runtime-channel-client";

export default async function PlatformRuntimePage() {
  await requireAdmin();
  const [channel, canaries] = await Promise.all([
    getEnvironmentRuntimeChannel(),
    listEnvironmentRuntimeCanaries(),
  ]);
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Inspect the immutable production runtime pair and choose its canary Environment."
        eyebrow="Platform"
        title="Environment Runtime"
      />
      <RuntimeChannelClient
        canaries={canaries}
        channel={{
          generation: channel.generation,
          canaryEnvironmentId: channel.canaryEnvironmentId,
          currentVersion: channel.currentVersion
            ? {
                id: channel.currentVersion.id,
                runtimeImage: channel.currentVersion.runtimeImage,
                routerImage: channel.currentVersion.routerImage,
              }
            : null,
          previousVersion: channel.previousVersion
            ? {
                id: channel.previousVersion.id,
                runtimeImage: channel.previousVersion.runtimeImage,
                routerImage: channel.previousVersion.routerImage,
              }
            : null,
        }}
      />
    </div>
  );
}
