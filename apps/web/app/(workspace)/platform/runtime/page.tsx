import { AdminPageHeader } from "@/components/admin/admin-page-header";
import {
  getEnvironmentRuntimeChannel,
  getEnvironmentRuntimeCanary,
  listEnvironmentRuntimeCanaries,
} from "@/lib/environments/runtime-channel";
import { requireAdmin } from "@/lib/knowledge/auth";
import { RuntimeChannelClient } from "./runtime-channel-client";

export default async function PlatformRuntimePage() {
  await requireAdmin();
  const channel = await getEnvironmentRuntimeChannel();
  const [canaries, desiredOperation] = await Promise.all([
    listEnvironmentRuntimeCanaries(),
    channel.desiredVersion && channel.canaryEnvironmentId
      ? getEnvironmentRuntimeCanary(
          channel.desiredVersion.id,
          channel.updatedAt,
        )
      : null,
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
        desiredOperation={
          desiredOperation
            ? {
                id: desiredOperation.id,
                status: desiredOperation.status,
                stage: desiredOperation.stage,
                errorCode: desiredOperation.errorCode,
                errorMessage: desiredOperation.errorMessage,
              }
            : null
        }
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
          desiredVersion: channel.desiredVersion
            ? {
                id: channel.desiredVersion.id,
                runtimeImage: channel.desiredVersion.runtimeImage,
                routerImage: channel.desiredVersion.routerImage,
              }
            : null,
        }}
      />
    </div>
  );
}
